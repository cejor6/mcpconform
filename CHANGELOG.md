# Changelog

All notable changes to mcpconform are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [0.2.0] - 2026-06-09

### Added
- **Three deterministic rules:**
  - `provider/total-size` — flags a serialized tool set that exceeds a profile's
    `tools.maxTotalBytes` budget (inert unless a profile sets one).
  - `client-config/known-keys` — catches typo'd server-entry keys (`arg` for
    `args`, …) against the union of keys the major clients accept.
  - `client-config/env-refs-declared` — flags malformed `${...}` interpolations
    (empty, unterminated, or invalid variable name).
- **`--min-severity <error|warn|info>`** — a reporting floor that filters the
  report (human and SARIF) to findings at or above the given tier. Display-only:
  the exit code is unaffected (only `error`-tier findings ever fail a run). Also
  settable as `minSeverity` in config.
- **`--min-tools <n>`** (inspect only) — exits 2 when the live server surfaces
  fewer than `n` tools, catching the "boots but registers nothing" false green.
  Also settable as `minTools` in config.
- **`--expand`** and default-on aggregation — an info finding from an opt-in rule
  (`aggregate: true` in `rules.json`, set on `tool/meta-namespacing` and
  `provider/schema-unenforced-keyword`) that repeats on 3+ tools collapses to one
  line with a count (e.g. `(on all 28 tools)`), in both the human report and
  SARIF. Targets framework-injected noise (FastMCP's non-reverse-DNS `_meta` key);
  per-tool-actionable rules stay itemized with their tool names. `--expand` (or
  `expand` in config) lists every occurrence.

### Changed
- The SARIF `driver.version` now tracks `package.json` instead of a hardcoded
  literal, so it can no longer drift.

## [0.1.0] - 2026-06

### Added
- Initial release: provider- and language-agnostic static linter for MCP tool
  definitions, `server.json`, and client config. SARIF output and a composite
  GitHub Action. Core MCP-spec rules, a parameterized `provider/*` rule family
  driven by `profiles/*.json`, and a live-server `inspect` mode (stdio handshake).

[0.2.0]: https://github.com/cejor6/mcpconform/releases/tag/v0.2.0
[0.1.0]: https://github.com/cejor6/mcpconform/releases/tag/v0.1.0
