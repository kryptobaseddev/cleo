# T10574 acceptance_json deprecation/removal policy

## Summary

`tasks.acceptance_json` is no longer a completion source of truth after the task acceptance criteria migration. Completion readiness, `cleo complete` AC coverage, and validator evidence must read canonical `task_acceptance_criteria` rows plus `evidence_ac_bindings` only.

## Retention policy

Keep `tasks.acceptance_json` temporarily for:

1. Legacy import and one-time migration/backfill from pre-AC-table projects.
2. Historical migration fixtures and rollback tests that assert old schemas survive.
3. Studio/API display fallback during the dual-read window for projects not yet backfilled.

Do not use it for:

1. `readyToComplete` or `nextAction` derivation.
2. `cleo complete` preconditions.
3. AC coverage, validator, or evidence binding checks.
4. New write paths for task creation/update after canonical AC rows exist.

## Removal trigger

The column may be removed only after all of these are true:

1. Legacy import/backfill can rebuild canonical rows without reading a live task completion path.
2. Studio/API readers no longer need an `acceptance_json` display fallback.
3. Historical migration/revert tests are either pinned to old migration files or updated to assert the new schema boundary.
4. CI has a regression guard blocking completion-critical source files from mentioning `acceptance_json` or `acceptanceJson`.

## CI guard

`packages/core/src/tasks/__tests__/acceptance-json-deprecation.test.ts` blocks `acceptance_json`/`acceptanceJson` in completion-critical files:

- `packages/core/src/tasks/complete.ts`
- `packages/core/src/tasks/compute-task-view.ts`
- `packages/core/src/tasks/ac-coverage-gate.ts`

The same test asserts that schema comments preserve this retention/removal policy.
