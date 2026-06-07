# mcplint *(working name — pending availability check)*

A static linter for **MCP setup correctness**: tool definitions, the `server.json` registry manifest, and client config files (`.mcp.json` / `claude_desktop_config.json` / `mcpServers`). Think `shellcheck`/`hadolint`, but for Model Context Protocol — and **provider-agnostic by design**.

It is *not* a security scanner (that lane is crowded) and *not* a live conformance tester (mcpjam owns that). It checks, statically and offline, that your MCP setup is **correct and portable**.

## Provider-agnostic architecture

The engine knows nothing about any specific LLM vendor. Every *consumer* of a tool definition — an LLM tool-use API **or** an MCP host — is described by a declarative **profile** (`profiles/*.json`, validated by `profiles/profile.schema.json`).

- **Core rules** (`tool/*`, `server-json/*`, `client-config/*`) are pure MCP-spec / JSON-Schema / registry correctness. They name no vendor and run by default.
- **`provider/*` rules** are a single *parameterized* family. They read whatever profile(s) `config.targets` declares and report which profile a finding violated. Adding a new provider is a **data** change (drop a JSON file), never a code change.

```
targets: []                          -> pure MCP spec (default, fully agnostic)
targets: ["anthropic"]               -> one consumer
targets: ["anthropic","openai"]      -> portable: tool must satisfy BOTH
portable: true  (or target generic-strict) -> survives every major provider
```

### Shipped profiles

| id | kind | verified | name rule | notable |
|----|------|----------|-----------|---------|
| `anthropic` | llm-provider | ✅ | `^[a-zA-Z0-9_-]{1,64}$` | strict mode drops min/max/length + recursion |
| `openai` | llm-provider | ✅ | `^[a-zA-Z0-9_-]{1,64}$` | description ≤1024; strict = addlProps:false + all-required, depth ≤5 |
| `gemini` | llm-provider | ✅ | `^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$` | OpenAPI-3.0 subset (allowlist); no anyOf/$ref baseline |
| `mistral` | llm-provider | ⛔ stub | — | demonstrates the extension pattern; fill from docs |
| `generic-strict` | synthetic | ✅ | `^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$` | strictest common denominator (`--portable`) |

`verified:true` means every constraint was read from that consumer's own docs (cited in `source`). Findings from a `verified:false` profile are flagged by `meta/profile-unverified` so a guessed number never reads as fact.

### The flagship divergence this catches

A name like `admin.tools.list` is **legal per the MCP spec** (dots allowed, up to 128 chars, only a SHOULD) but is **rejected by Anthropic and OpenAI** (`^[a-zA-Z0-9_-]{1,64}$`, no dots). No existing tool flags that. `provider/name-pattern` does.

## Language-agnostic: lints the wire, not the source

mcplint never parses your server's source code, so it does not care whether the server is Python, Node, Go, Rust, or a compiled binary. MCP is a *wire protocol* — a Python server and a Node server emit byte-identical `tools/list` JSON — so the linter validates that protocol surface, not the implementation. (Same root decision as provider-agnostic: operate on the protocol surface, not the internals.)

Two ways to feed it tool definitions:

- **Static (no execution, CI-safe):** lint JSON files directly — `server.json`, client configs, or a captured `tools/list` dump committed to the repo. Zero runtime, offline, deterministic. The default for manifests and configs.
- **Introspection (any language):** launch or connect to the server and call `tools/list` over stdio/HTTP — exactly what a client does. The launch command (`command` + `args`) comes from the config, so `python server.py`, `node server.js`, `uvx foo`, `npx bar`, a binary, or a Docker image are all handled by one generic path.

Static *source* analysis — extracting tool decorators without running the server — is a deliberate **non-goal**: it would need a parser per framework (FastMCP, the TS SDK, mcp-go, ...) and re-break on every framework change. Linting the wire keeps mcplint both language- *and* framework-agnostic.

## Files

- `profiles/profile.schema.json` — the meta-schema every profile validates against.
- `profiles/*.json` — one consumer per file.
- `rules.json` — the full rule catalog (id, tier, source citation, bad/good). Three tiers: `error` (spec MUST / 400), `warn` (spec SHOULD), `info` (opinionated; AI-judged rules land here later).
- `mcplint.config.example.json` — targeting + per-rule severity overrides.

## Status

Phase 0: spec + ruleset + provider profiles (this directory). Phase 1 (next): the CLI engine — ajv for the schema-shaped rules, custom rule fns for cross-file/semantic/provider checks, SARIF output, GitHub Action.

Spec baseline: **MCP 2025-11-25**.
