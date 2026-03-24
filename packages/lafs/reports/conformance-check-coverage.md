# Conformance Check Coverage Report

Generated: 2026-02-25

## Implemented checks

- `envelope_schema_valid`
- `envelope_invariants`
- `error_code_registered`
- `meta_mvi_present`
- `meta_strict_present`
- `strict_mode_behavior`
- `pagination_mode_consistent`
- `strict_mode_enforced`
- `transport_mapping_consistent`
- `context_mutation_failure`
- `context_preservation_valid`

## Test coverage mapping

- `tests/envelope.test.ts`
  - schema/invariants/error code checks
  - strict-mode checks
  - pagination checks
  - transport mapping checks
  - context mutation + context preservation checks
- `tests/conformanceProfiles.test.ts`
  - machine-readable profile validation
  - tier-filtered check-set validation (`core`, `standard`, `complete`)

## Validation commands

```bash
npm test
npm run typecheck
```

Result at generation time:

- test files: 13 passed
- tests: 272 passed
- typecheck: passed
