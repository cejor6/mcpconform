# Claude Code / agent guidance

mcpconform is a provider- and language-agnostic static linter for MCP setups
(tool definitions, `server.json`, client config). See
[CONTRIBUTING.md](CONTRIBUTING.md) for conventions and [README.md](README.md)
for the architecture.

## Workflow

- **Never push to `main`.** Branch, open a PR, let CI pass, merge (squash).
- **Run reviews before opening a PR** on non-trivial changes — the relevant
  review personas as independent fresh-context agents (author and reviewer
  must differ). Trivial doc/dependency changes may skip, with a note.
- **Keep the engine vendor-agnostic** — no provider names in `src/`. A new
  provider/host is a `profiles/*.json` file, not code.
- **Keep `profiles/*.json` `verified` honest** — `true` only when the numbers
  come from the consumer's own docs (cited in `source`).

## Publishing

Published to npm as `mcpconform` (unscoped). `npm publish` requires the
maintainer's npm login + 2FA OTP, so the maintainer runs the publish itself;
an agent preps the version bump and confirms the `npm pack --dry-run`
contents first.
