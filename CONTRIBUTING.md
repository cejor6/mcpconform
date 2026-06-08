# Contributing

Thanks for your interest! mcpconform is a provider- and language-agnostic
static linter for MCP setups.

## Dev setup

```sh
npm ci
npm test
```

## Conventions

- **Rules are data + a check.** Every rule lives in `rules.json` with an
  `id`, a severity `tier`, and a `source` citation (spec section or provider
  doc). Add a test in `test/` for any new or changed rule.
- **Providers/hosts are data.** Constraints live in `profiles/*.json`, not
  code. Keep `verified` honest — `true` only when the numbers come from the
  consumer's own documentation (cited in `source`); otherwise `false`.
- **The engine stays vendor-agnostic.** No provider names in `src/`. A new
  provider or MCP host is a profile file, not an engine change.

## Pull requests

- Branch, then open a PR. CI (tests on Node 20 + 22) must pass.
- Keep `npm test` green and add tests for behavior changes.
