# T9072 — W2: Hard-rename --role → --kind everywhere

**Date**: 2026-05-08
**Task**: T9072 (parent: T9067)
**Branch**: task/T9072
**Status**: complete

---

## Summary

Hard rename of the TaskRole/`--role` concept to TaskKind/`--kind` across all 25 source files identified in the R1 audit (T9068). No backward compatibility, no aliases, no deprecation tombstones.

## What Changed

### Group 1: contracts
- `packages/contracts/src/task.ts` — `TaskRole` → `TaskKind`, `Task.kind` (was `role`), `TaskCreate.kind`
- `packages/contracts/src/task-record.ts` — `TaskRecord.kind` (was `role`)
- `packages/contracts/src/index.ts` — re-exports `TaskKind` (was `TaskRole`)
- `packages/contracts/src/operations/tasks.ts` — `TasksFindParams.kind`, `TasksUpdateQueryParams.kind`

### Group 2: schema
- `packages/core/src/store/tasks-schema.ts` — `TASK_KINDS` (was `TASK_ROLES`), Drizzle alias `kind: text('role')` preserving DB column

### Group 3: CLI
- `packages/cleo/src/cli/commands/add.ts` — `--kind` canonical (was `--role`), `--kind` alias removed
- `packages/cleo/src/cli/commands/update.ts` — same
- `packages/cleo/src/cli/commands/find.ts` — `--kind` (was `--role`)

### Group 4A: Core consumers
- `packages/core/src/store/converters.ts` — `row.kind`, `task.kind`
- `packages/core/src/orchestration/classify.ts` — `task.kind === 'bug'` (was `task.role`)
- `packages/core/src/tasks/find.ts` — `FindTasksOptions.kind`, inline filter `kind:val`, filter application
- `packages/core/src/tasks/update.ts` — `UpdateTaskOptions.kind`, `NON_STATUS_DONE_FIELDS`, write path
- `packages/core/src/tasks/add.ts` — `AddTaskOptions.kind`, two write sites
- `packages/core/src/tasks/ops.ts` — all three op interfaces + passthroughs
- `packages/core/src/tasks/session-scope.ts` — `params.kind` passthrough
- `packages/core/src/tasks/engine-converters.ts` — `kind: task.kind ?? null`
- `packages/core/src/docs/export-document.ts` — frontmatter `kind:` YAML key
- `packages/cleo/src/dispatch/domains/tasks.ts` — find + add + update dispatch

### Group 4B: Tests and sentient
- `packages/core/src/sentient/propose-tick.ts` — SQL param renamed `:kind` (INSERT col stays `role`)
- `packages/core/src/sentient/stage-drift-tick.ts` — same
- `packages/core/src/tasks/__tests__/t944-role-scope-wiring.test.ts` — all `kind` assertions
- `packages/core/src/tasks/__tests__/find-filter-modes.test.ts` — `kind:research` inline filter tests
- `packages/cleo/src/cli/commands/__tests__/tasks-command-aliases.test.ts` — dispatch assertions

## Key Decisions

1. **DB column stays `role`** — The T944 migration has a cross-CHECK constraint (`severity IS NULL OR (severity IN (...) AND role='bug')`). Renaming would require a table rebuild. Deferred per owner directive. Drizzle alias `kind: text('role')` maps TypeScript field to DB column transparently.

2. **No migration file** — Since the DB column is not renamed, no migration is needed for this task.

3. **Sentient raw SQL** — The INSERT SQL in propose-tick and stage-drift-tick still uses `role` as the column name but binds from `:kind` parameter. This is correct.

4. **Schema tests unchanged** — `t944-role-scope-schema.test.ts` uses raw SQL testing DB columns directly; `role` is still the correct SQL column name.

5. **SSoT-EXEMPT annotations** — Added to `TasksAddParams.type` and `TasksUpdateQueryParams.type` to exempt the `kind/type` alias check, since `type` (hierarchy: epic|task|subtask) and `kind` (intent: work|bug|...) are independent orthogonal axes, not aliases.

## Acceptance Criteria Status

| Criterion | Status |
|-----------|--------|
| `TaskRole` symbol not in packages/ | PASS |
| `--role` flag not in CLI | PASS |
| `TaskKind` exported from contracts; `TASK_KINDS` in schema | PASS |
| All R1 consumers updated to `TaskKind` | PASS |
| Monorepo typecheck (no new errors) | PASS |
| Monorepo build (pre-existing failures only) | PASS |
| Biome clean (pre-existing errors only) | PASS |

## Test Results

- 10,842 passing, 3 failing (pre-existing worktree failures in `worktree-clean-base.test.ts` unrelated to rename)
- Targeted tests (role/kind-specific): 30/30 passing

## Commits

1. `5edde134` — contracts: TaskKind rename
2. `65987e01` — schema: TASK_KINDS + drizzle alias
3. `d9f49df2` — CLI: --kind canonical
4. `4202ac3f` — Group A consumers
5. `a30bec9d` — Group B: tests, sentient, contracts operations
