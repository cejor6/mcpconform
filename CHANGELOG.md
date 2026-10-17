# Changelog

All notable changes to mcpconform are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed
- `generic-strict` was unsatisfiable: its keyword allowlist omitted `additionalProperties` (which its own strict block requires) and `title`, so even `examples/tools.good.json` failed it.
- `--portable` now checks every **verified** profile, including `generic-strict`; the unverified `mistral` stub is no longer included (previously the reverse).
- `inputSchema`s declaring draft 2019-09 or draft-06 were reported invalid ("no schema with key or ref"); they now validate. draft-04/03 and unrecognized `$schema` URIs, and schemas nested too deeply to compile, get the new `tool/input-schema-unchecked` warning instead of a false `tool/input-schema-valid` error.
- Schema validation reuses one Ajv instance per dialect (2000 tools: ~30s → ~2s).
- `server-json/env-secret-flag` no longer fires on `MAX_TOKENS`, `TOKEN_LIMIT`, `AUTHOR`, …: secret words now match as whole words.
- `tool/destructive-needs-annotation` also catches camelCase (`deleteUser`), suffixed (`user_delete`) and bare (`delete`) verbs.
- `tool/no-params-shape` also flags `{ "type": "object", "properties": {} }` without `additionalProperties: false`.

### Added
- Profiles (shipped and from `profilesDir`) are validated against `profile.schema.json` on load; an invalid one exits 2 naming the file, and a `profilesDir` profile overriding a shipped id warns.
- Previously documented but unimplemented checks: `inputSchema.allowsRecursion`, `maxProperties` (new `provider/schema-max-properties`), `supportedStringFormats` (strict mode), `toolName.caseSensitive` (new `provider/name-case-collision`), `idempotentHint:false` + `readOnlyHint:true` in `tool/annotations-consistency`, and a long-hex pattern in `client-config/no-hardcoded-secrets`.

### Removed
- `client-config/valid-json` from `rules.json` (it was never emitted; parse failures are `meta/parse-error`). `inputSchema.rootMustBeObject` is deprecated and ignored (the core `tool/input-schema-root-object` rule already enforces it).

## [0.2.1] - 2026-07-12

Docs / packaging release — no behavior change; republished so the refreshed
README (badges, a "lint in 30 seconds" quickstart, real example output, and a
prominent npm link) reaches the npm package page.

### Changed
- README curb-appeal pass for public visibility.

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

[0.2.1]: https://github.com/cejor6/mcpconform/releases/tag/v0.2.1
[0.2.0]: https://github.com/cejor6/mcpconform/releases/tag/v0.2.0
[0.1.0]: https://github.com/cejor6/mcpconform/releases/tag/v0.1.0
