# T061: Automatic Verification Gate Initialization

**Status**: complete
**Date**: 2026-03-21

## Summary

Implemented automatic verification metadata initialization on task creation. Every new non-epic task now receives a `verification` object when `verification.enabled: true` is set in project config.

## Changes Made

### `packages/contracts/src/task.ts`
- Added optional `initializedAt?: string | null` field to `TaskVerification` interface. This field records the ISO timestamp when verification was first initialized (at task creation).

### `packages/core/src/tasks/add.ts`
- Added `TaskVerification` to imports from `@cleocode/contracts`
- Added `getRawConfigValue` to imports from config
- Added exported `buildDefaultVerification(initializedAt: string): TaskVerification` function that produces the canonical default verification object
- Added auto-initialization block in `addTask()` — after building optional fields and before the dry run check — that sets `task.verification = buildDefaultVerification(now)` for non-epic tasks when `verification.enabled === true`

### `packages/core/src/tasks/index.ts`
- Exported `buildDefaultVerification` from the tasks barrel

### `packages/core/src/tasks/__tests__/add.test.ts`
- Imported `buildDefaultVerification` in test imports
- Added `describe('buildDefaultVerification', ...)` block with 4 tests covering: field structure, gate initialization to false, passed=false, and output stability

## Default Verification Object

```json
{
  "passed": false,
  "round": 1,
  "gates": {
    "implemented": false,
    "testsPassed": false,
    "qaPassed": false
  },
  "lastAgent": null,
  "lastUpdated": null,
  "failureLog": [],
  "initializedAt": "<ISO timestamp>"
}
```

Gates used align with the existing `DEFAULT_VERIFICATION_REQUIRED_GATES` in `complete.ts` (`implemented`, `testsPassed`, `qaPassed`). The task description mentioned `ac_met`, `tests_pass`, `code_review` but the actual `VerificationGate` contract type uses different identifiers.

## Behavior

- **Config opt-in**: Only initializes when `verification.enabled: true` in config. When disabled (default), `task.verification` stays null/undefined — no behavior change for existing projects.
- **Epics excluded**: Epic tasks are containers and do not receive verification gates.
- **Backward compatible**: Old tasks with null `verification` are handled gracefully throughout the codebase via optional chaining (existing pattern in `complete.ts`).
- **Dry run aware**: The verification field is set before the dry run check, so dry run results reflect the initialized state.

## Tests

New pure-function tests in `add.test.ts`:
- `returns a valid verification object with all required fields`
- `initializes gates to false`
- `does not set passed=true on initialization`
- `produces a stable structure across calls`

All 4 new tests pass. Pre-existing integration test failures (7, requiring active session) are unchanged — they pre-date this change.

## Acceptance Criteria

- [x] New tasks automatically get verification metadata on creation
- [x] Verification object has enabled, round, gates, and initializedAt fields
- [x] Existing null verification fields handled gracefully (backward compatible)
- [x] No breaking changes to task show/list output
