# T066: Backfill Existing Tasks with AC

**Date**: 2026-03-21
**Status**: complete
**Epic**: T056 (Task System Hardening)

## Summary

Implemented a backfill module and CLI command that retroactively adds
acceptance criteria and verification metadata to all existing tasks that
pre-date T058 (AC enforcement) and T061 (verification gate auto-init).

## Files Created

- `packages/core/src/backfill/index.ts` — Core backfill logic module
- `packages/cleo/src/cli/commands/backfill.ts` — CLI command registration

## Files Modified

- `packages/core/src/internal.ts` — Added backfill exports
- `packages/cleo/src/cli/index.ts` — Registered `registerBackfillCommand`

## Command Interface

```
cleo backfill             -- apply backfill to all tasks needing it
cleo backfill --dry-run   -- preview changes without writing
cleo backfill --rollback  -- revert a previous backfill
cleo backfill --rollback --dry-run  -- preview rollback
cleo backfill --tasks T001,T002     -- restrict to specific task IDs
```

## AC Generation Heuristic

Generates 3 acceptance criteria per task using verb-pattern matching:
- Pattern-specific criterion based on the primary action verb (implement, fix, migrate, etc.)
- Two universal safety criteria:
  - "No breaking changes introduced to dependent code or workflows"
  - "Changes verified manually or via automated tests"

## Verification Default

Initializes with `buildDefaultVerification()` from `tasks/add.ts` (T061):
```json
{
  "passed": false,
  "round": 1,
  "gates": { "implemented": false, "testsPassed": false, "qaPassed": false },
  "lastAgent": null,
  "lastUpdated": null,
  "failureLog": [],
  "initializedAt": "<timestamp>"
}
```

## Backfill Marker

Each backfilled task gets a note: `[T066-backfill] auto-backfilled at <timestamp>: ac, verification`
This marker enables targeted rollback.

## Verification Results

- Dry-run mode: correctly shows 89 tasks to be changed without writing
- Apply mode: writes AC + verification + backfill note to all 89 active tasks
- Rollback dry-run: correctly identifies all 89 backfilled tasks
- Rollback apply: clears AC, verification, and notes from 89 tasks
- Idempotent: second run shows 0 tasks to change
- Archived tasks (9): not touched (correctly excluded by queryTasks)

## Acceptance Criteria Check

- [x] Dry-run mode shows changes without applying
- [x] All existing tasks get AC if missing (89 active tasks)
- [x] All existing tasks get verification metadata if missing (89 active tasks)
- [x] Backfilled tasks marked with a note (`[T066-backfill]`)
- [x] Dry-run validates against T033 schema (uses updateTaskFields)
