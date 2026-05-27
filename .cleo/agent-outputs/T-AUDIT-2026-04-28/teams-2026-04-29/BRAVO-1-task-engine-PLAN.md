# BRAVO-1 — task-engine.ts Migration Plan (T1568, ENG-MIG-1)

**Author:** Bravo-1 (planner) · **Date:** 2026-04-29 · **Source:** `packages/cleo/src/dispatch/engines/task-engine.ts` (2233 LOC, 47 exported functions, 5 exported types)

---

## 1. Executive Summary

`task-engine.ts` is a **thin delegation layer** that already calls into `@cleocode/core/internal` for ~92% of its logic. The migration is therefore *not* a logic-move but a **shim-collapse**: each engine function becomes (a) one core function (which already exists for most ops), plus (b) a CLI-shim wrapper that adapts `Task → TaskRecord` and core errors → `EngineResult`. The two adapter helpers (`taskToRecord`, `tasksToRecords`) are the *only* genuine new code that must move — they belong in `packages/contracts/src/` (or a sibling `packages/core/src/tasks/record-adapter.ts`).

Three functions carry **non-trivial enforcement logic** that lives only in the engine today and MUST move into core: `taskCompleteStrict` (evidence staleness + IVTR + lifecycle gate + verification-NULL guard, ~200 LOC), `taskShowWithHistory` (lifecycle status assembly), and `taskComplete` (post-complete `modifiedBy/sessionId` provenance write). All three are real business logic gated behind `loadConfig().lifecycle.mode` and MUST be in `@cleocode/core` per ADR-057/058.

- **Function count:** 47 exported async functions + 4 exported types/interfaces
- **Pure delegators (≤30 LOC, just call core + map):** 38 (~70%)
- **Real engine logic (must port):** 4 (`taskComplete`, `taskCompleteStrict`, `taskShowWithHistory`, `taskCreate` parent-resolution chain)
- **Target sub-files (proposed):** 6 new + extend 5 existing
- **Total LOC moving into core:** ~600 (the rest is shim-replacement, not move)

---

## 2. Function Catalog

| # | Function | LOC | Category | Target file (`packages/core/src/tasks/`) | CLI concerns? | Duplicates existing core? | Imports needed | Notes |
|---|---|---|---|---|---|---|---|---|
| 1 | `taskShow` | 14 | query | `show.ts` (extend) | No | Yes (`coreShowTask` + `computeTaskView` already exist) | — | Pure shim. Just collapses two existing core calls; expose new `showTaskWithView` from `show.ts`. |
| 2 | `taskShowWithHistory` | 37 | query+lifecycle | NEW `show-with-history.ts` | No | Partial (`getLifecycleStatus` exists in `@cleocode/core/internal`) | `getLifecycleStatus` from lifecycle module | The `LifecycleStageEntry` projection logic must move to core — this is real adapter logic. |
| 3 | `taskList` | 51 | query | `list.ts` (extend) | No | Yes (`coreListTasks` exists) | — | Just adds `compact` flag handling; push into `coreListTasks`. |
| 4 | `taskFind` | 75 | query | `find.ts` (extend) | No | Yes (`coreFindTasks` exists) | — | The `--verbose`/`--fields` post-load loop is real logic; move into `find.ts` as `findTasksDetailed`. |
| 5 | `taskExists` | 12 | query | `find.ts` (extend) | No | Partial (`accessor.taskExists` exists) | — | Trivial wrapper; new `taskExists(id, accessor)` export. |
| 6 | `taskCreate` | 104 | mutation | `add.ts` (extend) | No | Partial — parent-search/session-inheritance NOT in `coreAddTask` | `coreFindTasks`, `getActiveSession` | **Parent-resolution chain is real engine logic** — must move into a new `resolveTaskParent()` helper inside `add.ts`. |
| 7 | `taskUpdate` | 66 | mutation | `update.ts` (extend) | No | Yes (`coreUpdateTask` exists) | — | Pure delegation; signature already matches. |
| 8 | `taskComplete` | 49 | lifecycle | `complete.ts` (extend) | No | Partial (`coreCompleteTask` exists; provenance write does not) | `getActiveSession`, `accessor.updateTaskFields`, `process.env` | **Provenance write (T1222) is real logic** — move into `coreCompleteTask` post-step. `process.env['CLEO_AGENT_ID']` access must be parameterized via an options arg, not read directly in core. |
| 9 | `taskCompleteStrict` | 196 | lifecycle | NEW `complete-strict.ts` | No | NO — entire enforcement chain lives only in engine | `loadConfig`, `revalidateEvidence`, `getIvtrState`, `accessor.loadSingleTask`, `getLogger` | **Largest real logic in the file.** 4 enforcement gates: evidence-staleness, IVTR-released, parent-epic-stage, verification-NULL. ALL must move to core. |
| 10 | `taskShowIvtrHistory` | 15 | query | NEW `ivtr-history.ts` (or extend `show.ts`) | No | Partial (`getIvtrState` exists) | `getIvtrState` | `IvtrHistoryEntry` projection is real adapter logic. |
| 11 | `taskDelete` | 29 | mutation | `delete.ts` (extend) | No | Yes (`coreDeleteTask` exists) | — | Pure shim. |
| 12 | `taskArchive` | 31 | mutation | `archive.ts` (extend) | No | Yes (`coreArchiveTasks` exists) | — | Pure shim. |
| 13 | `taskNext` | 26 | query | `task-ops.ts` (extend) | No | Yes (`coreTaskNext` exists) | — | Pure shim. |
| 14 | `taskBlockers` | 29 | query | `task-ops.ts` (extend) | No | Yes (`coreTaskBlockers` exists) | — | Pure shim. |
| 15 | `taskTree` | 12 | query/relations | `task-ops.ts` or `hierarchy.ts` (extend) | No | Yes (`coreTaskTree` exists) | — | Pure shim. |
| 16 | `taskDeps` | 19 | relations | `task-ops.ts` (extend) | No | Yes (`coreTaskDeps` exists) | — | Pure shim. |
| 17 | `taskRelates` | 20 | relations | `relates.ts` (extend) | No | Yes (`coreTaskRelates` exists) | — | Pure shim. |
| 18 | `taskRelatesAdd` | 14 | relations | `relates.ts` (extend) | No | Yes (`coreTaskRelatesAdd` exists) | — | Pure shim. |
| 19 | `taskAnalyze` | 29 | query | `analyze.ts` (extend) | No | Yes (`coreTaskAnalyze` exists) | — | Pure shim. |
| 20 | `taskImpact` | 12 | query | NEW `impact.ts` (or `analyze.ts`) | No | Yes (`predictImpact` exists in intelligence module) | `predictImpact` | Pure shim. |
| 21 | `taskRestore` | 12 | mutation | `task-ops.ts` (extend) | No | Yes (`coreTaskRestore` exists) | — | Pure shim. |
| 22 | `taskUnarchive` | 12 | mutation | `archive.ts` (extend) | No | Yes (`coreTaskUnarchive` exists) | — | Pure shim. |
| 23 | `taskReorder` | 14 | mutation | `task-ops.ts` (extend) | No | Yes (`coreTaskReorder` exists) | — | Pure shim. |
| 24 | `taskReparent` | 20 | relations | `task-ops.ts` (extend) | No | Yes (`coreTaskReparent` exists) | — | Pure shim. |
| 25 | `taskPromote` | 18 | lifecycle | `task-ops.ts` (extend) | No | Yes (`coreTaskPromote` exists) | — | Pure shim. |
| 26 | `taskReopen` | 13 | lifecycle | `task-ops.ts` (extend) | No | Yes (`coreTaskReopen` exists) | — | Pure shim. |
| 27 | `taskCancel` | 13 | lifecycle | `task-ops.ts` (extend) | No | Yes (`coreTaskCancel` exists) | — | Pure shim. |
| 28 | `taskComplexityEstimate` | 19 | query | `task-ops.ts` (extend) | No | Yes (`coreTaskComplexityEstimate` exists) | — | Pure shim. |
| 29 | `taskDepends` | 17 | relations | `task-ops.ts` (extend) | No | Yes (`coreTaskDepends` exists) | — | Pure shim. |
| 30 | `taskDepsOverview` | 15 | relations | `task-ops.ts` (extend) | No | Yes (`coreTaskDepsOverview` exists) | — | Pure shim. |
| 31 | `taskDepsCycles` | 12 | relations | `task-ops.ts` (extend) | No | Yes (`coreTaskDepsCycles` exists) | — | Pure shim. |
| 32 | `taskStats` | 21 | query | `task-ops.ts` (extend) | No | Yes (`coreTaskStats` exists) | — | Pure shim. |
| 33 | `taskExport` | 14 | I/O | `task-ops.ts` (extend) | No | Yes (`coreTaskExport` exists) | — | Pure shim. |
| 34 | `taskHistory` | 11 | query | `task-ops.ts` (extend) | No | Yes (`coreTaskHistory` exists) | — | Pure shim. |
| 35 | `taskLint` | 18 | validation | `task-ops.ts` (extend) | No | Yes (`coreTaskLint` exists) | — | Pure shim. |
| 36 | `taskBatchValidate` | 28 | validation | `task-ops.ts` (extend) | No | Yes (`coreTaskBatchValidate` exists) | — | Pure shim. |
| 37 | `taskImport` | 17 | I/O | `task-ops.ts` (extend) | No | Yes (`coreTaskImport` exists) | — | Pure shim. |
| 38 | `taskPlan` | 9 | query | `plan.ts` (extend) | No | Yes (`coreTaskPlan` already in plan.ts) | — | Pure shim. Lazy-import collapse. |
| 39 | `taskRelatesFind` | 26 | relations | `relates.ts` (extend) | No | Yes (`suggestRelated`, `discoverRelated` exist) | — | Pure shim. Lazy-import collapse. |
| 40 | `taskLabelList` | 11 | query | `labels.ts` (extend) | No | Yes (`listLabels` exists) | — | Pure shim. |
| 41 | `taskLabelShow` | 12 | query | `labels.ts` (extend) | No | Yes (`showLabelTasks` exists) | — | Pure shim. |
| 42 | `taskSyncReconcile` | 31 | sync (NEW domain) | NEW `sync.ts` | No | Partial (`reconcile` exists in core but not in `tasks/`) | `reconcile`, `ExternalTask`, `ReconcileResult` from contracts | New sub-file. Re-export from `tasks/index.ts`. |
| 43 | `taskSyncLinks` | 24 | sync | NEW `sync.ts` | No | Partial (`getLinksByProvider`, `getLinksByTaskId` exist) | — | Same file as #42. |
| 44 | `taskSyncLinksRemove` | 12 | sync | NEW `sync.ts` | No | Partial (`removeLinksByProvider` exists) | — | Same file as #42. |
| 45 | `taskClaim` | 14 | claims (NEW domain) | NEW `claims.ts` | No | Partial (`accessor.claimTask` exists) | — | New sub-file for atomic claim/unclaim. |
| 46 | `taskUnclaim` | 12 | claims | NEW `claims.ts` | No | Partial (`accessor.unclaimTask` exists) | — | Same file as #45. |
| 47 | `taskToRecord` / `tasksToRecords` (helpers) | 53 | adapter | NEW `record-adapter.ts` | No | NO | `Task`, `TaskRecord`, `TaskRecordRelation` from contracts | **Real new code.** Must live in core because every shim needs it. |

**Key observation:** zero functions touch citty options, console output, or `process.argv`. The only "CLI concern" anywhere is `process.env['CLEO_AGENT_ID']` / `CLEO_SESSION_ID` reads in `taskComplete` — which is environment, not CLI, and must be threaded as an `ExecutionContext` argument into core.

---

## 3. Target File Structure (proposed)

```
packages/core/src/tasks/
├── add.ts                    # (extend +~80 LOC) parent-resolution chain → resolveTaskParent()
├── analyze.ts                # (extend +12 LOC) absorb taskImpact wrapper
├── archive.ts                # (extend +20 LOC) absorb taskUnarchive
├── claims.ts                 # NEW ~80 LOC — taskClaim / taskUnclaim
├── complete.ts               # (extend +40 LOC) absorb provenance-write (T1222)
├── complete-strict.ts        # NEW ~220 LOC — taskCompleteStrict full enforcement chain
├── delete.ts                 # (no change — just expose via index)
├── find.ts                   # (extend +60 LOC) verbose/fields detail loop, taskExists alias
├── ivtr-history.ts           # NEW ~50 LOC — getIvtrHistory + IvtrHistoryEntry projection
├── labels.ts                 # (no change — re-export listLabels/showLabelTasks)
├── list.ts                   # (extend +20 LOC) compact flag handling
├── plan.ts                   # (no change)
├── record-adapter.ts         # NEW ~70 LOC — taskToRecord / tasksToRecords (THE adapter)
├── relates.ts                # (extend +30 LOC) absorb taskRelatesFind dispatcher
├── show.ts                   # (extend +15 LOC) showTaskWithView convenience
├── show-with-history.ts      # NEW ~60 LOC — taskShowWithHistory + LifecycleStageEntry projection
├── sync.ts                   # NEW ~120 LOC — reconcile + links read/remove
└── task-ops.ts               # (extend +200 LOC) absorbs all small shims (next, blockers, tree, deps, stats, export, history, lint, etc.)
```

All new files target ≤300 LOC. `task-ops.ts` is already 2401 LOC and adding 200 LOC pushes it to ~2600 — **flag for future split** (not in scope for this migration).

After migration, `packages/cleo/src/dispatch/engines/task-engine.ts` collapses from **2233 LOC → ~150 LOC** and contains ONLY:
- The `taskToRecord` re-export (or removed entirely if domain handler imports directly from core)
- `EngineResult` error mapping helpers (`cleoErrorToEngineError`, `engineError`)
- A barrel of re-exports so `dispatch/domains/tasks.ts` keeps working unchanged

---

## 4. Migration Wave Plan (4 waves)

### Wave 1 — Bravo-2: Adapter + Pure Delegators (foundation)

**Functions migrated:** `taskToRecord`, `tasksToRecords`, `taskShow`, `taskList`, `taskFind`, `taskExists`, `taskUpdate`, `taskDelete`, `taskArchive`, `taskUnarchive`, `taskRestore`, `taskNext`, `taskBlockers`, `taskTree`, `taskStats`, `taskExport`, `taskHistory`, `taskLint`, `taskBatchValidate`, `taskImport`, `taskPlan`, `taskComplexityEstimate` (22 functions)

**New files in core:** `record-adapter.ts`

**Files extended in core:** `add.ts` (export adapter dep), `find.ts`, `list.ts`, `show.ts`, `task-ops.ts`

**Functions removed from `task-engine.ts`:** all 22 above (replace each with a one-line `export { … } from '@cleocode/core/internal';` re-export, OR remove entirely and update domain handler).

**Domain handler updates (`cleo/dispatch/domains/tasks.ts`):** Update imports to pull from `@cleocode/core/internal` directly OR keep going through the engine barrel (PREFERRED — minimizes diff and lets us delete the engine file in Wave 4). All 27 call sites stay intact.

**Tests that may need updating:** `packages/core/src/tasks/__tests__/*` (likely no changes — these test core directly). `packages/cleo/src/dispatch/__tests__/task-engine.test.ts` may exist — if so, the tests should still pass because the engine functions remain callable as re-exports.

### Wave 2 — Bravo-3: Mutation + Lifecycle Gates (the dangerous one)

**Functions migrated:** `taskCreate` (parent-resolution chain), `taskComplete` (provenance write), `taskCompleteStrict` (full enforcement chain), `taskShowIvtrHistory`, `taskShowWithHistory`, `taskReopen`, `taskCancel`, `taskPromote`, `taskReorder`, `taskReparent` (10 functions)

**New files in core:** `complete-strict.ts`, `show-with-history.ts`, `ivtr-history.ts`

**Files extended in core:** `add.ts` (parent-resolution), `complete.ts` (provenance), `task-ops.ts`

**Functions removed from `task-engine.ts`:** all 10 above

**Domain handler updates:** `taskCompleteStrict` is the active call-site at line 331 — it MUST still receive same return shape (`EngineResult<{task, autoCompleted, unblockedTasks}>`). Wave 3 must guarantee the new `coreCompleteTaskStrict` returns that shape OR the engine wrapper does the conversion.

**Tests:** `packages/cleo/src/dispatch/__tests__/task-engine.test.ts` likely has dedicated tests for `taskCompleteStrict` evidence-staleness path — these MUST continue to pass. New tests in `packages/core/src/tasks/__tests__/complete-strict.test.ts` should mirror them.

**Special concern:** the `process.env['CLEO_AGENT_ID']` read in `taskComplete` (line 748) MUST be moved out — core code MUST NOT read env vars. Thread an `ExecutionContext { agentId, sessionId }` arg through `coreCompleteTask` and have the engine shim read env once and pass the context.

### Wave 3 — Bravo-4: Relations + Sync + Claims

**Functions migrated:** `taskDeps`, `taskDepsOverview`, `taskDepsCycles`, `taskDepends`, `taskRelates`, `taskRelatesAdd`, `taskRelatesFind`, `taskAnalyze`, `taskImpact`, `taskLabelList`, `taskLabelShow`, `taskSyncReconcile`, `taskSyncLinks`, `taskSyncLinksRemove`, `taskClaim`, `taskUnclaim` (16 functions)

**New files in core:** `claims.ts`, `sync.ts` (and consider `impact.ts` if `analyze.ts` doesn't fit)

**Files extended in core:** `analyze.ts`, `relates.ts`, `labels.ts`, `task-ops.ts`

**Functions removed from `task-engine.ts`:** all 16 above

**Domain handler updates:** verify the `cleo task sync …` and `cleo task claim …` subcommands still resolve to engine wrappers (these are likely called from `dispatch/domains/sync.ts` not `tasks.ts`). Audit cross-domain call sites first.

**Tests:** `reconcile`, `ExternalTask`, `ReconcileResult` types must still resolve cleanly through `@cleocode/core/internal`. Bravo-2 (Alpha-2) re-exports must include them.

### Wave 4 — Bravo-5: Engine Collapse + Cleanup

**Functions migrated:** none (all already in core after waves 1-3)

**Action:** Collapse `packages/cleo/src/dispatch/engines/task-engine.ts` from 2233 LOC to ~150 LOC. Final shape:

```typescript
// task-engine.ts (post-collapse)
// Pure barrel re-export — ALL business logic lives in @cleocode/core.
// This file exists ONLY to preserve the dispatch layer's import surface.

export {
  taskToRecord, tasksToRecords,                            // adapters
  taskShow, taskShowWithHistory, taskList, taskFind, taskExists,
  taskCreate, taskUpdate, taskComplete, taskCompleteStrict,
  taskShowIvtrHistory, taskDelete, taskArchive, taskUnarchive,
  taskRestore, taskNext, taskBlockers, taskTree, taskDeps,
  taskRelates, taskRelatesAdd, taskRelatesFind, taskAnalyze,
  taskImpact, taskReorder, taskReparent, taskPromote, taskReopen,
  taskCancel, taskComplexityEstimate, taskDepends, taskDepsOverview,
  taskDepsCycles, taskStats, taskExport, taskHistory, taskLint,
  taskBatchValidate, taskImport, taskPlan, taskLabelList, taskLabelShow,
  taskSyncReconcile, taskSyncLinks, taskSyncLinksRemove,
  taskClaim, taskUnclaim,
  type LifecycleStageEntry, type IvtrHistoryEntry,
} from '@cleocode/core/internal';
export type { MinimalTaskRecord, TaskRecord, CompactTask } from '@cleocode/contracts';
export type { EngineResult } from './_error.js';
```

If audit confirms NO external consumer outside `dispatch/domains/tasks.ts`, **delete the engine file entirely** and update the domain handler to import from `@cleocode/core/internal`. Final goal per ADR-057/058 is zero engine layer.

**Tests:** full `pnpm run test` repo-wide. Validate dispatch error paths still return correct envelope.

**Domain handler updates:** none (transparent collapse).

---

## 5. Pre-Execution Blockers

### Must finish BEFORE Wave 1

1. **Alpha-2 contract re-exports.** All these contract types are imported inline today via `import('@cleocode/contracts').XxxYyy` and MUST be available as named exports from `@cleocode/core/internal`:
   - `TaskStatus`, `TaskPriority`, `TaskType`, `TaskSize`, `TaskRole`, `TaskScope`, `TaskSeverity`
   - `ExternalTask`, `ReconcileResult`, `ConflictPolicy`, `ExternalTaskLink`
   - `MinimalTaskRecord`, `TaskRecord`, `TaskRecordRelation`

2. **Alpha-1 red→green.** `pnpm run test` MUST be green at HEAD before Wave 1 lands; otherwise we cannot distinguish migration-induced failures from pre-existing breakage. Bravo-1 will not start until Alpha-1 confirms green.

3. **Confirm `@cleocode/core/internal` already re-exports** `getAccessor`, `getActiveSession`, `getIvtrState`, `getLifecycleStatus`, `loadConfig`, `revalidateEvidence`, `predictImpact`, `computeTaskView`, `toCompact`. Spot-check confirms all are importable today.

### Must finish BEFORE Wave 2

4. **`ExecutionContext` design decision.** Wave 2 needs a typed object to thread `agentId` + `sessionId` from CLI shim into core (replacing `process.env` reads). Either reuse an existing `ExecutionContext` in core, or define one in `packages/contracts/src/execution-context.ts`. **Block — owner / Alpha-2 must decide.**

### New core abstractions discovered

5. **`resolveTaskParent(params, accessor) → string | null`** — extract the 3-tier parent resolution (`--parent` → `--parent-search` → session-scoped) from `taskCreate`. Belongs in `add.ts` and is reusable from any future bulk-add flow.

6. **`stampCompletionProvenance(taskId, ctx, accessor)`** — extract the `modifiedBy/sessionId` writeback (T1222) from `taskComplete`. Belongs in `complete.ts`.

7. **No core abstraction needed for `cleoErrorToEngineError`** — that's a CLI-shim concern (mapping core errors to engine envelopes) and stays in `packages/cleo/src/dispatch/engines/_error.js` per ADR-057.

---

## 6. Risk Register

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **`taskCompleteStrict` evidence-staleness check uses dynamic `await import('@cleocode/core/internal')` (line 870) to "avoid cycles during dispatch tests".** Moving this into core may re-trigger the cycle. | Medium | High — broken test setup blocks the wave | Wave 2 first lands `complete-strict.ts` with a static import; run dispatch tests in CI; if cycle reappears, refactor `revalidateEvidence` out of `internal.ts` into a leaf module before completing Wave 2. |
| R2 | **`process.env['CLEO_AGENT_ID']` reads in `taskComplete` (lines 748-753).** ADR-057 forbids env reads in core. Threading an `ExecutionContext` arg is a breaking signature change. | High | Medium — every caller of `coreCompleteTask` must update | Add the ctx arg as **optional** in Wave 2 with a deprecation comment. CLI shim populates it; existing core callers (e.g. tests, sentient) get null fallback. Schedule mandatory-arg flip for a follow-up task. |
| R3 | **`task-ops.ts` is already 2401 LOC; absorbing 200 more LOC pushes it past 2600.** Owner rule: "Each file ≤500 LOC ideally." | High (will happen) | Low (cosmetic) | File a follow-up cleanup task `T1568-followup-task-ops-split` to slice `task-ops.ts` by category (next/blockers/tree → `queries.ts`; reorder/reparent/promote/reopen/cancel → `lifecycle-ops.ts`). Do NOT block T1568 on this. |
| R4 | **`TaskRecord` vs `Task` divergence: 18 explicit field mappings in `taskToRecord`** (lines 89-122) including blockedBy `string` ↔ `string[]`, status union widening, severity (T944), epicLifecycle. Any contract drift since this was last audited could silently break consumers. | Medium | High — silent shape regressions | Wave 1 lands `record-adapter.ts` WITH a `__tests__/record-adapter.test.ts` containing fixture-based round-trip tests for every field, including all T944 axes (role/scope/severity). Snapshot must match current TaskRecord shape exactly. |
| R5 | **Domain handler `dispatch/domains/tasks.ts` directly imports 13 named functions from the engine** (lines 39-72). After Wave 4 collapse, the barrel re-export must export EVERY named symbol the handler imports — a single typo silently fails as `undefined` at runtime, not a TS error. | Low | High | Wave 4 generates the barrel re-export from a script that diffs `grep "^export" task-engine.ts` against the post-migration core exports. CI gate: `pnpm tsc --noEmit` on `packages/cleo` after collapse. Plus assertion test that imports every name from the barrel and asserts `typeof === 'function'`. |

---

**End of plan. Total: 47 functions catalogued, 4 waves planned, 5 risks registered, 7 pre-execution blockers identified.**
