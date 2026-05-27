# T9074 — W7: TaskScope Deletion (R2 Verdict)

**Date**: 2026-05-08
**Task**: W7 — Delete TaskScope per R2 verdict
**Epic**: T9067 — Taxonomy Rationalization
**Branch**: task/T9074

## Summary

TaskScope (`'project' | 'feature' | 'unit'`) deleted across the entire codebase per the R2 verdict from T9069 audit. The field was found to be 100% redundant with TaskType, had no consumers that branched on its value, and had an orphaned index.

## Commits (task/T9074 branch)

1. `91d111f6f` feat(T9074): remove TaskScope from contracts + schema re-exports
2. `808bc189a` refactor(T9074): drop TaskScope from all 13 source consumers
3. `575249b85` feat(T9074): DB migration drops scope column + update role-only tests
4. `7ef763b7f` test(T9074): update sentient + schema tests — drop scope from SQL fixtures

## Files Changed

### Contracts (3 files)
- `packages/contracts/src/task.ts` — removed TaskScope type, scope from Task + CreateTaskInput
- `packages/contracts/src/task-record.ts` — removed scope from TaskRecord
- `packages/contracts/src/index.ts` — removed TaskScope from re-exports

### Core Store (2 files)
- `packages/core/src/store/tasks-schema.ts` — removed TASK_SCOPES const, scope column, idx_tasks_scope
- `packages/core/src/store/converters.ts` — removed scope from rowToTask + taskToRow

### Core Tasks (5 files)
- `packages/core/src/tasks/add.ts` — removed scope from AddTaskOptions + wiring
- `packages/core/src/tasks/update.ts` — removed scope from UpdateTaskOptions + NON_STATUS_DONE_FIELDS + wiring
- `packages/core/src/tasks/ops.ts` — removed scope from both add/update param types
- `packages/core/src/tasks/session-scope.ts` — removed scope from params + addTask call
- `packages/core/src/tasks/engine-converters.ts` — removed scope from taskToRecord

### Core Other (2 files)
- `packages/core/src/docs/export-document.ts` — removed scope from YAML frontmatter
- `packages/core/src/sentient/propose-tick.ts` — removed scope from SQL INSERT + params
- `packages/core/src/sentient/stage-drift-tick.ts` — removed scope from SQL INSERT + params

### CLI (3 files)
- `packages/cleo/src/cli/commands/add.ts` — removed --scope flag
- `packages/cleo/src/cli/commands/update.ts` — removed --scope flag
- `packages/cleo/src/dispatch/domains/tasks.ts` — removed scope from add dispatch

### DB Migration (1 file)
- `packages/core/migrations/drizzle-tasks/20260508000000_t9074-drop-scope-column/migration.sql` — table-rebuild drops scope column + idx_tasks_scope

### Tests (5 files)
- `packages/core/src/tasks/__tests__/t944-role-scope-wiring.test.ts` — role-only assertions; scope removed
- `packages/core/src/store/__tests__/t944-role-scope-schema.test.ts` — asserts scope column absent; idx_tasks_scope absent
- `packages/core/src/sentient/__tests__/stage-drift.test.ts` — removed scope from in-memory fixture DDL + INSERTs
- `packages/core/src/sentient/__tests__/propose-tick.test.ts` — removed scope from in-memory fixture DDL + INSERTs
- `packages/core/src/sentient/__tests__/proposal-rate-limiter.test.ts` — removed scope from in-memory fixture DDL + INSERTs

## Test Results
- 2197 passed / 2 failed (pre-existing: captureBaseline E_NOT_INITIALIZED worktree constraint)
- Biome CI: clean
- Build: passes (26s full monorepo)

## Quality Gates
All gates passed: implemented, testsPassed, qaPassed, cleanupDone, securityPassed, documented
