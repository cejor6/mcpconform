# mcpconform

A static linter for **MCP setup correctness**: tool definitions, the `server.json` registry manifest, and client config files (`.mcp.json` / `claude_desktop_config.json` / `mcpServers`). Think `shellcheck`/`hadolint`, but for the Model Context Protocol — and **provider-agnostic by design**.

It checks, statically and offline, that your MCP setup is **correct and portable**. It is intentionally *not* a security scanner and *not* a live conformance tester — it validates the shape and portability of your tool surface, the part nothing else checks.

Spec baseline: **MCP 2025-11-25**.

## Install

```sh
# one-off, no install
npx mcpconform path/to/server.json .mcp.json tools.json --target anthropic,openai

# or install the CLI
npm install -g mcpconform
mcpconform tools.json --target anthropic,openai
```

Requires Node ≥ 20.

## Usage

Point it at any MCP artifact — tool-definition dumps, `server.json`, or client config. The type is auto-detected by shape (override with `--type`), and you can pass several at once:

```sh
mcpconform server.json .mcp.json tools.json --target anthropic,openai
```

- `--target a,b` — provider profiles to check against. Empty = pure MCP-spec checks.
- `--portable` — must satisfy the strictest common denominator of every major provider.
- `--mode strict` — also apply each provider's strict-mode constraints.
- `--format sarif --out file.sarif` — emit SARIF for GitHub code scanning.
- `--min-severity error|warn|info` — report only findings at or above this tier. This is a **display filter**, not a fail-gate: the exit code is unaffected — only `error`-tier findings ever fail a run. Also settable as `minSeverity` in config. Handy in CI to drop info-tier noise without per-rule `off` suppressions.
- `--expand` — a few info rules flag framework-injected noise that repeats identically on every tool (e.g. FastMCP stamping a non-reverse-DNS `_meta` key on all of them). By default, when such a finding hits 3+ tools it collapses to a single line with a count — in the human report **and** in SARIF (one alert instead of N identical ones). `--expand` (or `expand` in config) lists every occurrence. Collapsing is display-only (never changes the exit code) and opt-in per rule (`aggregate: true` in `rules.json`): `warn`/`error` and per-tool-actionable info findings always stay itemized with their tool names.

### Lint a live server (any language)

When you can't get a static dump, `inspect` launches or connects to the server and pulls `tools/list` over the MCP stdio handshake — exactly what a client does — then lints it:

```sh
mcpconform inspect --target anthropic,openai -- python server.py
```

Servers that need env vars to start inherit your shell env, or pass `--env-file .env` / `--env KEY=VAL`. Tool listing rarely makes network calls, so **placeholder values are usually enough**. To avoid secrets in CI, capture a reusable dump once and commit it:

```sh
mcpconform inspect --dump tools.json -- <cmd>
```

In CI, add `--min-tools <n>` so a server that boots but registers too few tools fails the run (exit 2) instead of passing green having linted nothing — a broken tool import would otherwise go unnoticed:

```sh
mcpconform inspect --min-tools 1 -- <cmd>
```

### GitHub Action

Lint on every push and upload findings to the Security tab as SARIF:

```yaml
- uses: cejor6/mcpconform@v1
  id: mcpconform
  with:
    files: server.json .mcp.json
    targets: anthropic,openai
- uses: github/codeql-action/upload-sarif@v4
  with:
    sarif_file: ${{ steps.mcpconform.outputs.sarif }}
```

## Provider-agnostic architecture

The engine knows nothing about any specific LLM vendor. Every *consumer* of a tool definition — an LLM tool-use API **or** an MCP host — is described by a declarative **profile** (`profiles/*.json`, validated by `profiles/profile.schema.json`).

- **Core rules** (`tool/*`, `server-json/*`, `client-config/*`) are pure MCP-spec / JSON-Schema / registry correctness. They name no vendor and run by default.
- **`provider/*` rules** are a single *parameterized* family. They read whatever profile(s) you target and report which profile a finding violated. Adding a new provider is a **data** change (drop a JSON file), never a code change.

```
--target (none)                      -> pure MCP spec (default, fully agnostic)
--target anthropic                   -> one consumer
--target anthropic,openai            -> portable: tool must satisfy BOTH
--portable                           -> survives every major provider
```

### Shipped profiles

| id | kind | verified | name rule | notable |
|----|------|----------|-----------|---------|
| `anthropic` | llm-provider | ✅ | `^[a-zA-Z0-9_-]{1,64}$` | strict mode drops min/max/length + recursion |
| `openai` | llm-provider | ✅ | `^[a-zA-Z0-9_-]{1,64}$` | description ≤1024; strict = addlProps:false + all-required, depth ≤5 |
| `gemini` | llm-provider | ✅ | `^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$` | OpenAPI-3.0 subset (allowlist); no anyOf/$ref baseline |
| `mistral` | llm-provider | ⛔ stub | — | demonstrates the extension pattern |
| `generic-strict` | synthetic | ✅ | `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` | strictest common denominator (`--portable`) |

`verified: true` means every constraint was read from that consumer's own docs (cited in `source`). Findings from a `verified: false` profile are flagged by `meta/profile-unverified`, so a guessed number never reads as fact.

### The flagship divergence this catches

A name like `admin.tools.list` is **legal per the MCP spec** (dots allowed, up to 128 chars, only a SHOULD) but is **rejected by Anthropic and OpenAI** (`^[a-zA-Z0-9_-]{1,64}$`, no dots). `provider/name-pattern` catches exactly this class of "works in my host, breaks under that provider" portability bug.

## Language-agnostic: lints the wire, not the source

mcpconform never parses your server's source code, so it doesn't care whether the server is Python, Node, Go, Rust, or a compiled binary. MCP is a *wire protocol* — a Python server and a Node server emit byte-identical `tools/list` JSON — so the linter validates that protocol surface, not the implementation.

The launch command for `inspect` comes from the config, so `python server.py`, `node server.js`, `uvx foo`, `npx bar`, a binary, or a Docker image are all handled by one generic path.

Static *source* analysis — extracting tool decorators without running the server — is a deliberate **non-goal**: it would need a parser per framework (FastMCP, the TS SDK, mcp-go, …) and re-break on every framework change. Linting the wire keeps mcpconform both language- *and* framework-agnostic.

## Severity tiers

Every rule lives in `rules.json` with an `id`, a `tier`, and a `source` citation. Three tiers:

- **`error`** — spec MUST, or a provider would 400 the request.
- **`warn`** — spec SHOULD.
- **`info`** — opinionated quality and portability checks.

Targeting and per-rule severity overrides live in `mcpconform.config.json` (see `mcpconform.config.example.json`).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: providers and hosts are **data** (`profiles/*.json`), rules are **data + a check** (`rules.json` + `src/`), and the engine stays vendor-agnostic. Keep `verified` honest and add a test for any rule change.

## License

MIT
