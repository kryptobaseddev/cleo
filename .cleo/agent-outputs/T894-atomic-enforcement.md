# T894 — Atomic Task Enforcement: Worker Role File Scope Validation

**Status**: complete
**Date**: 2026-04-20

## Summary

Added V_ATOMIC_SCOPE_MISSING and V_ATOMIC_SCOPE_TOO_LARGE validation checks to `validate-spawn.ts`. Worker-role tasks must declare 1-3 files (MAX_WORKER_FILES=3) via `task.files`. Epic type and orchestrator/lead roles are exempt.

## Files Changed

- `packages/core/src/orchestration/validate-spawn.ts` — Added SpawnValidationContext, context param, V_ATOMIC checks
- `packages/core/src/orchestration/__tests__/validate-spawn.test.ts` — NEW: 14 tests

## Validation Rules Added

```
V_ATOMIC_SCOPE_MISSING  — worker + no files field (or empty) → error
V_ATOMIC_SCOPE_TOO_LARGE — worker + files.length > MAX_WORKER_FILES (3) → error
```

## Exemptions

- `role: 'orchestrator'` — exempt (broad scope by design)
- `role: 'lead'` — exempt (coordinates workers)
- `task.type === 'epic'` — exempt (epics span many files)
- No role supplied — checks skipped (backward compat for existing callers)

## API Change

`validateSpawnReadiness` gains an optional 4th param `context?: SpawnValidationContext`. Existing callers with 3 params are unaffected.

## Tests

14 new tests covering: no files, empty files, too many files, exact limit, 1 file, and all exemption cases.
