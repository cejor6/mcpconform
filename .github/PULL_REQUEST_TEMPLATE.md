## Summary

<!-- What does this change do, and why? -->

## Type of change

- [ ] Bug fix
- [ ] New rule / provider profile
- [ ] Engine / CLI change
- [ ] Docs
- [ ] CI / build / dependencies

## Checklist

- [ ] `npm test` passes locally
- [ ] New/changed rules have tests and a `source` citation (spec section or provider doc)
- [ ] Provider profile changes keep `verified` honest — `true` only when sourced from the vendor's own docs
- [ ] The engine stays vendor-agnostic (no provider names in `src/`; new providers are a `profiles/*.json` file)
- [ ] No secrets or credentials introduced (including fixtures)
