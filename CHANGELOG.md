# Changelog

All notable changes to mcpconform are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security
- GitHub Action: inputs are passed to the run step via `env` instead of being
  interpolated into the script, closing a script-injection hole. `files`
  entries starting with `-`, or a leading `inspect`, are rejected.
- Workflows and `action.yml` pin third-party actions to full commit SHAs.

### Added
- `meta/unrecognized-artifact`: an artifact of unknown shape, one that doesn't
  match the forced `--type`, or a tools dump with zero tools (these passed clean).
- `meta/internal-error`: a crash while linting one artifact is reported, the
  rest are still linted, and the run exits 2.
- GitHub Action inputs `min-severity`, `config`, and `fail-on-error`
  (`fail-on-error: false` only passes when the SARIF report was written).
- Profiles (shipped and from `profilesDir`) are validated against `profile.schema.json` on load; an invalid one exits 2 naming the file, and a `profilesDir` profile overriding a shipped id warns.
- Previously documented but unimplemented checks: `inputSchema.allowsRecursion`, `maxProperties` (new warn-tier `provider/schema-max-properties`), `supportedStringFormats` (strict mode), `toolName.caseSensitive` (new `provider/name-case-collision`), `idempotentHint:false` + `readOnlyHint:true` in `tool/annotations-consistency`, and a long-hex pattern in `client-config/no-hardcoded-secrets`.

### Breaking (profiles)
- Profiles are now validated on load (see Added). A custom `profilesDir` profile that loaded before can now stop the run with exit 2 if it has unknown fields (other than `_`-prefixed comment keys such as `_comment`, which are allowed), lacks `kind` or `verified`, has `verified: true` without `source`/`lastVerified`, or has an uncompilable `toolName.pattern`. JSON files in `profilesDir` without an `id` (e.g. a `package.json`) are skipped with a warning rather than rejected.

### Breaking (Action)
Users on the floating `@v1` tag pick these up automatically:
- `files` entries starting with `-` are refused, so CLI flags can no longer be
  smuggled in through `files`. Use `portable: true` / `expand: true` in a config
  file (via the `config` input) instead of `--portable` / `--expand`; `--type`
  has no Action route now.
- `files: "inspect -- <cmd>"` is refused; the Action lints files only.
- `files` entries must be existing files, and a non-empty `config` must exist.
  Both now fail with exit 2.
- `files` paths are no longer glob-expanded by the shell (never documented).
- `mode` now defaults to empty, so a config file's `mode` is honored instead
  of being overridden with `default`.

### Changed
- **Exit codes are now 0 / 1 / 2.** `1` means error-tier findings only; `2` is a
  usage error or an internal failure (a crash used to exit `1`).
- **Usage mistakes exit 2 instead of being ignored:** unknown options, invalid
  `--format` / `--mode` / `--type` values, unknown `--target` profiles (the known
  ones are listed), a missing `--config`, unparseable config, and config `rules`
  severities outside `error|warn|info|off`. Value options accept `--opt=value`;
  target lists are trimmed (`"anthropic, openai"`).
- `inspect` labels the run by the command's basename (`inspect/node (+1 arg)`)
  instead of echoing the full command line, which can carry secrets.
- SARIF runs carry `properties.targets` and `properties.summaries`.
- README Action example uploads SARIF with `if: always()`, so findings that
  fail the step still reach code scanning.

### Fixed
- Crashes on malformed input (`null`, `{"tools":"x"}`, `{"packages":[null]}`,
  deeply nested schemas, an `inspect` server that emits `null` or closes stdin).
- Quadratic regexes on `$schema`, `${...}` refs, JWT detection, and identifier
  word-splitting for secret names / mutating verbs (300KB took 20–150s).
- Control characters from the input are escaped in the human report and SARIF.
- `Object.prototype` names (`constructor`) in `required`, `--target`,
  `--min-severity`, and as a `profilesDir` profile id.
- A UTF-8 BOM no longer fails parsing; config `mode` is no longer ignored;
  reports over 64KB are no longer truncated when piped.
- `generic-strict` was unsatisfiable: its keyword allowlist omitted `additionalProperties` (which its own strict block requires) and `title`, so even `examples/tools.good.json` failed it.
- `--portable` now checks every **verified** profile, including `generic-strict`; the unverified `mistral` stub is no longer included (previously the reverse).
- `inputSchema`s declaring draft 2019-09 or draft-06 were reported invalid ("no schema with key or ref"); they now validate. draft-04/03 and unrecognized `$schema` URIs, and schemas nested too deeply to compile, get the new `tool/input-schema-unchecked` warning instead of a false `tool/input-schema-valid` error.
- Schema validation reuses one Ajv instance per dialect (2000 tools: ~30s → ~2s).
- `server-json/env-secret-flag` no longer fires on `MAX_TOKENS`, `TOKEN_LIMIT`, `AUTHOR`, `PARTITION_KEY`, `SORT_KEY`, `STRIPE_PUBLISHABLE_KEY`, …: secret words match as whole words or run-together endings (`ACCESSTOKEN`, `CLIENTSECRET` still match), and `KEY` counts only with a secret-ish qualifier (`API_KEY`, `PRIVATE_KEY`).
- `tool/destructive-needs-annotation` also catches camelCase (`deleteUser`), suffixed two-word (`user_delete`) and bare (`delete`) verbs, without flagging field-like or compound-noun names (`reset_at`, `price_drop`, `status_update`, `suggest_move`).
- `tool/no-params-shape` also flags `{ "type": "object", "properties": {} }` without `additionalProperties: false`, but no longer flags map-style tools (`additionalProperties: <schema>` or `patternProperties`).
- A schema nested thousands deep no longer crashes the run when a provider target is set; it is reported as `tool/input-schema-unchecked`.

### Removed
- `client-config/valid-json` from `rules.json` (it was never emitted; parse failures are `meta/parse-error`). `inputSchema.rootMustBeObject` is deprecated and ignored (the core `tool/input-schema-root-object` rule already enforces it).

### Notes
- The OpenAI profile's strict-mode limits (`maxProperties: 100`, `maxNestingDepth: 5`, and `format`/`pattern` being rejected) should be re-verified against OpenAI's current structured-outputs docs, which may have raised them; until then `provider/schema-max-properties` is warn-tier so a stale number cannot newly fail a build. The profile numbers and `verified` flags were not changed.

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
