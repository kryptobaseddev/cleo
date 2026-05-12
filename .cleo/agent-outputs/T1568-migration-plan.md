# T1568 Migration Plan — ENG-MIG-1: task-engine.ts → packages/core/tasks/

**Epic**: T1566 (T-ENGINE-MIGRATION)
**Date**: 2026-04-30
**Explorer**: Subagent (research phase)
**Source file**: `packages/cleo/src/dispatch/engines/task-engine.ts` (2242 LOC)
**Target**: `packages/core/src/tasks/` (add sub-files; no modification to existing files unless extending ops.ts)

---

## 1. Symbol Inventory

Every exported symbol from `task-engine.ts` with its function's approximate line span, purpose, proposed target sub-file in `packages/core/tasks/`, and whether a Core helper already exists.

| Symbol | Lines (start→end) | LOC | Purpose | Target sub-file | Existing core helper? |
|--------|-------------------|-----|---------|-----------------|----------------------|
| `type MinimalTaskRecord` | 137 (re-export) | — | Re-export from contracts | Shim re-export only | `@cleocode/contracts` |
| `type TaskRecord` | 137 (re-export) | — | Re-export from contracts | Shim re-export only | `@cleocode/contracts` |
| `type CompactTask` | 140 (re-export) | — | Re-export from core/internal | Shim re-export only | `@cleocode/core/internal` |
| `type EngineResult` | 143 (re-export) | — | Re-export from _error.js | Shim re-export only | `@cleocode/core` (`engine-result.ts`) |
| `taskShow` | 184–197 | 14 | Fetch single task + compute TaskView | `engine-ops.ts` | `showTask` + `computeTaskView` (both in core) |
| `interface LifecycleStageEntry` | 208–219 | 12 | Type for lifecycle history entries | `engine-ops.ts` | None — needs new type |
| `taskShowWithHistory` | 249–285 | 37 | Fetch task + optional lifecycle history | `engine-ops.ts` | `showTask` + `getLifecycleStatus` (both in core) |
| `taskList` | 307–357 | 51 | List tasks with filters + pagination | `engine-ops.ts` | `listTasks` (core/tasks/list.ts) |
| `taskFind` | 380–454 | 75 | Fuzzy search tasks | `engine-ops.ts` | `findTasks` (core/tasks/find.ts) |
| `taskExists` | 478–489 | 12 | Check if task exists | `engine-ops.ts` | `accessor.taskExists` (DataAccessor) |
| `taskCreate` | 513–616 | 104 | Create task with session-scope parent resolution | `engine-ops.ts` | `addTask` (core/tasks/add.ts); session-scope logic is engine-level |
| `taskUpdate` | 636–710 | 75 | Update task fields | `engine-ops.ts` | `updateTask` (core/tasks/update.ts) |
| `taskComplete` | 738–786 | 49 | Complete task + stamp provenance | `engine-ops.ts` | `completeTask` (core/tasks/complete.ts) |
| `interface IvtrHistoryEntry` | 796–809 | 14 | Surface-safe IVTR phase entry type | `engine-ops.ts` | None — needs new type |
| `taskCompleteStrict` | 855–1050 | 196 | Complete with IVTR + evidence staleness enforcement | `engine-ops.ts` | `completeTask`, `getIvtrState`, `revalidateEvidence`, `loadConfig`, `getLifecycleStatus` (all in core) |
| `taskShowIvtrHistory` | 1073–1087 | 15 | Return IVTR phase history | `engine-ops.ts` | `getIvtrState` (core/lifecycle) |
| `taskDelete` | 1106–1134 | 29 | Delete task (optionally cascade) | `engine-ops.ts` | `deleteTask` (core/tasks/delete.ts) |
| `taskArchive` | 1154–1184 | 31 | Archive completed tasks | `engine-ops.ts` | `archiveTasks` (core/tasks/archive.ts) |
| `taskNext` | 1208–1233 | 26 | Suggest next task to work on | `engine-ops.ts` | `coreTaskNext` (core/tasks/task-ops.ts) |
| `taskBlockers` | 1255–1283 | 29 | Show blocked tasks + chains | `engine-ops.ts` | `coreTaskBlockers` (core/tasks/task-ops.ts) |
| `taskTree` | 1316–1327 | 12 | Build hierarchy tree | `engine-ops.ts` | `coreTaskTree` (core/tasks/task-ops.ts) |
| `taskDeps` | 1349–1367 | 19 | Show bidirectional deps | `engine-ops.ts` | `coreTaskDeps` (core/tasks/task-ops.ts) |
| `taskRelates` | 1389–1408 | 20 | List task relations | `engine-ops.ts` | `coreTaskRelates` (core/tasks/task-ops.ts) |
| `taskRelatesAdd` | 1431–1444 | 14 | Add relation between two tasks | `engine-ops.ts` | `coreTaskRelatesAdd` (core/tasks/task-ops.ts) |
| `taskAnalyze` | 1467–1495 | 29 | Analyze task quality + project health | `engine-ops.ts` | `coreTaskAnalyze` (core/tasks/task-ops.ts) |
| `taskImpact` | 1520–1531 | 12 | Predict downstream impact | `engine-ops.ts` | `predictImpact` (core/intelligence) |
| `taskRestore` | 1551–1562 | 12 | Restore cancelled task | `engine-ops.ts` | `coreTaskRestore` (core/tasks/task-ops.ts) |
| `taskUnarchive` | 1583–1594 | 12 | Move archived task back to active | `engine-ops.ts` | `coreTaskUnarchive` (core/tasks/task-ops.ts) |
| `taskReorder` | 1614–1627 | 14 | Change task position | `engine-ops.ts` | `coreTaskReorder` (core/tasks/task-ops.ts) |
| `taskReparent` | 1648–1667 | 20 | Move task under different parent | `engine-ops.ts` | `coreTaskReparent` (core/tasks/task-ops.ts) |
| `taskPromote` | 1686–1703 | 18 | Promote subtask to task | `engine-ops.ts` | `coreTaskPromote` (core/tasks/task-ops.ts) |
| `taskReopen` | 1724–1737 | 14 | Reopen completed task | `engine-ops.ts` | `coreTaskReopen` (core/tasks/task-ops.ts) |
| `taskCancel` | 1758–1771 | 14 | Cancel task (soft terminal) | `engine-ops.ts` | `coreTaskCancel` (core/tasks/task-ops.ts) |
| `taskComplexityEstimate` | 1793–1812 | 20 | Deterministic complexity scoring | `engine-ops.ts` | `coreTaskComplexityEstimate` (core/tasks/task-ops.ts) |
| `taskDepends` | 1820–1837 | 18 | List deps in given direction | `engine-ops.ts` | `coreTaskDepends` (core/tasks/task-ops.ts) |
| `taskDepsOverview` | 1843–1858 | 16 | Overview of all deps | `engine-ops.ts` | `coreTaskDepsOverview` (core/tasks/task-ops.ts) |
| `taskDepsCycles` | 1864–1876 | 13 | Detect circular deps | `engine-ops.ts` | `coreTaskDepsCycles` (core/tasks/task-ops.ts) |
| `taskStats` | 1884–1905 | 22 | Compute task statistics | `engine-ops.ts` | `coreTaskStats` (core/tasks/task-ops.ts) |
| `taskExport` | 1913–1927 | 15 | Export tasks as JSON/CSV | `engine-ops.ts` | `coreTaskExport` (core/tasks/task-ops.ts) |
| `taskHistory` | 1935–1946 | 12 | Get task history from log | `engine-ops.ts` | `coreTaskHistory` (core/tasks/task-ops.ts) |
| `taskLint` | 1954–1973 | 20 | Lint tasks for issues | `engine-ops.ts` | `coreTaskLint` (core/tasks/task-ops.ts) |
| `taskBatchValidate` | 1981–2011 | 31 | Validate multiple tasks | `engine-ops.ts` | `coreTaskBatchValidate` (core/tasks/task-ops.ts) |
| `taskImport` | 2017–2035 | 19 | Import tasks from JSON | `engine-ops.ts` | `coreTaskImport` (core/tasks/task-ops.ts) |
| `taskPlan` | 2042–2050 | 9 | Compute ranked work plan | `engine-ops.ts` | `coreTaskPlan` (core/tasks/plan.ts) |
| `taskRelatesFind` | 2056–2081 | 26 | Find related tasks (semantic/keyword) | `engine-ops.ts` | `suggestRelated` + `discoverRelated` (core/tasks/relates.ts) |
| `taskLabelList` | 2087–2098 | 12 | List all labels in use | `engine-ops.ts` | `listLabels` (core/tasks/labels.ts) |
| `taskLabelShow` | 2104–2116 | 13 | Show tasks for a label | `engine-ops.ts` | `showLabelTasks` (core/tasks/labels.ts) |
| `taskSyncReconcile` | 2125–2157 | 33 | Reconcile external tasks with CLEO | `engine-ops.ts` | `reconcile` (core/internal) |
| `taskSyncLinks` | 2162–2185 | 24 | List external task links | `engine-ops.ts` | `getLinksByProvider`/`getLinksByTaskId` (core/internal) |
| `taskSyncLinksRemove` | 2190–2201 | 12 | Remove all links for provider | `engine-ops.ts` | `removeLinksByProvider` (core/internal) |
| `taskClaim` | 2209–2223 | 15 | Atomically claim task for agent | `engine-ops.ts` | `accessor.claimTask` (DataAccessor) |
| `taskUnclaim` | 2230–2242 | 13 | Release agent's claim on task | `engine-ops.ts` | `accessor.unclaimTask` (DataAccessor) |

**Private symbols** (not exported, must move with the functions that use them):

| Symbol | Lines | Used By | Notes |
|--------|-------|---------|-------|
| `taskToRecord(task)` | 80–123 | taskShow, taskList, taskFind, taskCreate, taskUpdate, taskComplete, taskCompleteStrict, taskDelete | Critical converter Task→TaskRecord. Must move to core. |
| `tasksToRecords(tasks)` | 131–133 | taskList | Thin wrapper over taskToRecord. |
| `toHistoryEntry(e)` | 814–823 | taskCompleteStrict, taskShowIvtrHistory | Projects IvtrPhaseEntry → IvtrHistoryEntry. |

---

## 2. Existing core/tasks/ Surface

The Worker MUST NOT duplicate any of the following. All 47 files in `packages/core/src/tasks/`:

| File | LOC | Key Exports | Status |
|------|-----|-------------|--------|
| `ac-immutability.ts` | 243 | AC immutability guard | Existing — do not touch |
| `add.ts` | 1247 | `addTask`, `normalizePriority`, validators | Existing — do not touch |
| `analyze.ts` | 110 | Task analysis logic | Existing — do not touch |
| `archive.ts` | 204 | `archiveTasks` | Existing — do not touch |
| `atomicity.ts` | 117 | Atomic task ops helpers | Existing — do not touch |
| `cancel-ops.ts` | 115 | Cancel operations | Existing — do not touch |
| `complete.ts` | 607 | `completeTask` | Existing — do not touch |
| `compute-task-view.ts` | 627 | `computeTaskView`, `TaskView` | Existing — do not touch |
| `crossref-extract.ts` | 106 | Cross-ref extraction | Existing — do not touch |
| `delete-preview.ts` | 274 | Delete preview logic | Existing — do not touch |
| `delete.ts` | 162 | `deleteTask` | Existing — do not touch |
| `deletion-strategy.ts` | 248 | Deletion strategy | Existing — do not touch |
| `dependency-check.ts` | 343 | `validateDependencies`, `detectCircularDeps`, etc. | Existing — do not touch |
| `deps-ready.ts` | 34 | Deps readiness check | Existing — do not touch |
| `enforcement.ts` | 115 | Enforcement helpers | Existing — do not touch |
| `epic-enforcement.ts` | 364 | Epic lifecycle enforcement | Existing — do not touch |
| `evidence.ts` | 1056 | `revalidateEvidence`, `parseEvidence`, gate helpers | Existing — do not touch |
| `find.ts` | 356 | `findTasks` | Existing — do not touch |
| `gate-audit.ts` | 344 | Gate audit trail | Existing — do not touch |
| `gate-runner.ts` | 774 | Gate runner | Existing — do not touch |
| `graph-cache.ts` | 161 | Graph caching | Existing — do not touch |
| `graph-ops.ts` | 201 | Graph operations | Existing — do not touch |
| `graph-rag.ts` | 383 | RAG-based graph search | Existing — do not touch |
| `hierarchy-policy.ts` | 204 | Hierarchy policy | Existing — do not touch |
| `hierarchy.ts` | 232 | Hierarchy helpers | Existing — do not touch |
| `id-generator.ts` | 67 | Task ID generation | Existing — do not touch |
| `index.ts` | 143 | Barrel export for tasks package | **Needs new exports added** |
| `infer-add-params.ts` | 205 | `inferTaskAddParams` | Existing — do not touch |
| `labels.ts` | 77 | `listLabels`, `showLabelTasks` | Existing — reuse directly |
| `list.ts` | 151 | `listTasks` | Existing — do not touch |
| `nexus-impact-gate.ts` | 172 | Nexus impact gate | Existing — do not touch |
| `nexus-risk-audit.ts` | 66 | Nexus risk audit | Existing — do not touch |
| `ops.ts` | 405 | `tasksCoreOps` registry + 8 normalized op wrappers | **Extend with new wrapper fns** |
| `phase-tracking.ts` | 193 | Phase tracking | Existing — do not touch |
| `pipeline-stage.ts` | 336 | Pipeline stage transitions | Existing — do not touch |
| `plan.ts` | 366 | `coreTaskPlan` | Existing — reuse directly |
| `relates.ts` | 137 | `suggestRelated`, `discoverRelated` | Existing — reuse directly |
| `req.ts` | 363 | Requirements management | Existing — do not touch |
| `show.ts` | 117 | `showTask` | Existing — do not touch |
| `size-weighting.ts` | 100 | Size weighting | Existing — do not touch |
| `staleness.ts` | 136 | Staleness detection | Existing — do not touch |
| `task-ops.ts` | 2401 | All `coreTask*` non-CRUD functions | Existing — reuse all directly |
| `tool-cache.ts` | 559 | Evidence tool cache | Existing — do not touch |
| `tool-resolver.ts` | 467 | Tool resolution | Existing — do not touch |
| `tool-semaphore.ts` | 278 | Tool concurrency semaphore | Existing — do not touch |
| `update.ts` | 473 | `updateTask` | Existing — do not touch |

**Key insight**: `ops.ts` already has 8 normalized wrappers (`tasksShowOp`, `tasksListOp`, `tasksFindOp`, `tasksAddOp`, `tasksUpdateOp`, `tasksCompleteOp`, `tasksDeleteOp`, `tasksArchiveOp`) plus the `tasksCoreOps` type registry. This covers the 8 basic CRUD operations. All `coreTask*` non-CRUD functions are already in `task-ops.ts`.

---

## 3. Sub-File Layout Proposal

Given that `packages/core/src/tasks/` already has 47 files including all Core logic, the migration strategy is to add **one new file** that concentrates the engine-layer adapter logic (EngineResult wrapping, converters, and the few functions that do non-trivial orchestration like `taskCompleteStrict` and `taskCreate`'s session-scope resolution).

### Proposed new file

**`packages/core/src/tasks/engine-ops.ts`** (~550 LOC estimated)

This is the only new file needed. It contains:

1. **Private converters** (moved from engine, ~50 LOC):
   - `taskToRecord(task: Task): TaskRecord` — Task → TaskRecord conversion
   - `tasksToRecords(tasks: Task[]): TaskRecord[]` — array wrapper
   - `toHistoryEntry(e: IvtrPhaseEntry): IvtrHistoryEntry` — IVTR entry projection

2. **New interface types** (~30 LOC):
   - `LifecycleStageEntry` — lifecycle history entry type
   - `IvtrHistoryEntry` — IVTR phase entry type

3. **All engine-wrapped functions** (~470 LOC):
   - All 48 exported functions from task-engine.ts, now wrapping Core directly
   - Each follows the pattern: call existing core helper, wrap in `engineSuccess`/`engineError`

### File size analysis

All current task-engine logic fits comfortably within one 550 LOC file because:
- 24 of the 48 functions are pure thin wrappers (5–20 LOC each): `taskNext`, `taskBlockers`, `taskTree`, `taskDeps`, `taskRelates`, `taskRelatesAdd`, `taskAnalyze`, `taskRestore`, `taskUnarchive`, `taskReorder`, `taskReparent`, `taskPromote`, `taskReopen`, `taskCancel`, `taskComplexityEstimate`, `taskDepends`, `taskDepsOverview`, `taskDepsCycles`, `taskStats`, `taskExport`, `taskHistory`, `taskLint`, `taskBatchValidate`, `taskImport`
- 10 functions have moderate complexity (20–50 LOC): `taskShow`, `taskShowWithHistory`, `taskList`, `taskFind`, `taskDelete`, `taskArchive`, `taskComplete`, `taskImpact`, `taskPlan`, `taskRelatesFind`
- 4 functions have substantial complexity (50–200 LOC): `taskCreate` (session scope resolution ~100 LOC), `taskCompleteStrict` (IVTR/evidence enforcement ~196 LOC), `taskSyncReconcile` (~33 LOC), `taskSyncLinks` (~24 LOC)

If the Worker finds `engine-ops.ts` will exceed 500 LOC, it SHOULD split by natural grouping:

| Sub-file | Contents | Est. LOC |
|----------|----------|----------|
| `engine-converters.ts` | `taskToRecord`, `tasksToRecords`, `toHistoryEntry`, `LifecycleStageEntry`, `IvtrHistoryEntry` | ~80 |
| `engine-ops.ts` | All thin-wrapper ops (show, list, find, exists, CRUD basics, non-CRUD thin wrappers) | ~350 |
| `engine-complete.ts` | `taskComplete`, `taskCompleteStrict`, `taskShowIvtrHistory` | ~270 |
| `engine-sync.ts` | `taskSyncReconcile`, `taskSyncLinks`, `taskSyncLinksRemove` | ~80 |

Single-file is preferred if it stays under 500 LOC. Worker decides based on actual count.

### `ops.ts` extension

The Worker MUST extend `packages/core/src/tasks/ops.ts` to add normalized wrappers for all ops currently missing from the `tasksCoreOps` registry. The current registry only covers 8 CRUD ops + 16 query ops (as type declarations). The Worker adds runtime implementations for the remaining ops (non-CRUD) so the dispatch domain can use `OpsFromCore<typeof tasksCoreOps>` inference for ALL ops.

### `index.ts` extension

Add exports for `engine-ops.ts` (and sub-files if split) from `packages/core/src/tasks/index.ts`.

---

## 4. Handler-Shim Mapping

The current `packages/cleo/src/dispatch/domains/tasks.ts` already uses `OpsFromCore<typeof coreTasks.tasksCoreOps>` inference and delegates all logic to engine functions. After migration, the engine import path changes from `task-engine.ts` to `@cleocode/core/internal` (or `packages/core/src/tasks/engine-ops.ts`). The handler bodies themselves do NOT change — only the import source changes.

The `packages/cleo/src/dispatch/engines/task-engine.ts` becomes a shim of <100 LOC that re-exports everything from Core:

```typescript
// task-engine.ts (shim — <100 LOC after migration)
// Re-export all task engine functions from @cleocode/core
// This file exists only for backward-compat with the lib/engine.ts barrel.

export type { MinimalTaskRecord, TaskRecord } from '@cleocode/contracts';
export type { CompactTask } from '@cleocode/core/internal';
export type { EngineResult } from '@cleocode/core';
export type {
  LifecycleStageEntry,
  IvtrHistoryEntry,
} from '@cleocode/core/internal';
export {
  taskShow,
  taskShowWithHistory,
  taskList,
  taskFind,
  taskExists,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskCompleteStrict,
  taskShowIvtrHistory,
  taskDelete,
  taskArchive,
  taskNext,
  taskBlockers,
  taskTree,
  taskDeps,
  taskRelates,
  taskRelatesAdd,
  taskAnalyze,
  taskImpact,
  taskRestore,
  taskUnarchive,
  taskReorder,
  taskReparent,
  taskPromote,
  taskReopen,
  taskCancel,
  taskComplexityEstimate,
  taskDepends,
  taskDepsOverview,
  taskDepsCycles,
  taskStats,
  taskExport,
  taskHistory,
  taskLint,
  taskBatchValidate,
  taskImport,
  taskPlan,
  taskRelatesFind,
  taskLabelList,
  taskLabelShow,
  taskSyncReconcile,
  taskSyncLinks,
  taskSyncLinksRemove,
  taskClaim,
  taskUnclaim,
} from '@cleocode/core/internal';
```

The shim above is ~60 LOC (well within the `wc -l < 100` acceptance criterion).

### Handler body signatures after migration

The `tasks.ts` dispatch domain handler bodies remain IDENTICAL — they already call through to engine functions which will now live in Core. The only change is the import source in `lib/engine.ts` (which re-exports from `task-engine.ts`), which now transparently re-exports from Core.

For reference, the current handler shape (unchanged after migration):

```typescript
// packages/cleo/src/dispatch/domains/tasks.ts — NO CHANGES NEEDED
// All handlers remain ≤5 LOC bodies calling through engine barrel:

show: async (params) => {
  // Routing within show (ivtrHistory vs history vs plain show) — 5 LOC
  return wrapCoreResult(await taskShow(projectRoot, params.taskId), 'show');
},

add: async (params) => {
  return wrapCoreResult(await taskCreate(projectRoot, { ...params }), 'add');
  // (actual body is larger due to explicit field spread — but logic stays identical)
},

complete: async (params) => {
  if (params.force !== undefined) {
    return lafsError('E_FLAG_REMOVED', '...', 'complete');
  }
  return wrapCoreResult(await taskCompleteStrict(projectRoot, params.taskId, params.notes), 'complete');
},
```

**Note**: The `complete` handler already delegates `taskCompleteStrict` (not `taskComplete`). The fire-and-forget `trackMemoryUsage` side-effect that calls `@cleocode/core/internal` is in the domain handler body — this stays in the dispatch layer (SSoT-EXEMPT annotation already present).

---

## 5. Risk Register

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **`taskToRecord` has inline `import('@cleocode/contracts')` type casts** — The converter uses inline `import()` in function bodies for `TaskStatus`, `TaskPriority`, etc. Moving to Core means these must use static imports from `@cleocode/contracts` which is already a Core dependency. | Low | Replace inline `import()` casts with static imports at the top of `engine-ops.ts`. The Core package already depends on `@cleocode/contracts` (confirmed in ops.ts). No new dependency. |
| 2 | **`taskCompleteStrict` uses lazy `import('@cleocode/core/internal')`** for `revalidateEvidence` (line 879). This pattern exists to avoid cycles during dispatch tests. Moving the function INTO Core means the lazy import becomes unnecessary (same package) — but the Worker must verify no circular path within Core exists (`tasks/engine-ops.ts` → `tasks/evidence.ts` is fine; `tasks/evidence.ts` → `tasks/engine-ops.ts` would be a cycle). | Medium | `revalidateEvidence` lives in `tasks/evidence.ts` which does NOT import from any `engine-*` file. `engine-ops.ts` imports `evidence.ts` — one-directional, no cycle. Worker MUST verify with `pnpm run build` after placing the file. |
| 3 | **`taskCreate` uses `getActiveSession(projectRoot)` from core/store/session-store** — This function is in `packages/core/src/store/session-store.ts` and is already accessible from within Core. However, session-store is in a separate sub-directory. Confirm no circular path: `tasks/engine-ops.ts` → `store/session-store.ts` → (does it import from tasks?). | Medium | Run `pnpm run build` after Wave 1. If a cycle is detected, extract the session-scope resolution logic into a separate thin helper that can be injected. As a fallback, mark with `// SSoT-EXEMPT: session-scope parent resolution` and keep this one function's session lookup in a dedicated wrapper. |
| 4 | **`taskSyncReconcile` and `taskSyncLinks` use lazy imports from `@cleocode/core/internal`** — The reconcile/link functions (`reconcile`, `getLinksByProvider`, etc.) live in Core's internal barrel. When `engine-ops.ts` moves INTO Core, these become same-package imports and must use direct file paths (`./sync.js` etc.) or be verified they won't create cycles. | Medium | Identify the source files for `reconcile`, `getLinksByProvider`, `getLinksByTaskId`, `removeLinksByProvider` in Core's sync sub-domain. Use direct file imports rather than barrel imports within Core to avoid circular paths. Worker must trace these before writing `engine-ops.ts`. |
| 5 | **`lib/engine.ts` barrel** re-exports every function from `task-engine.ts`. After migration the shim re-exports everything from Core. Any callers that import directly from `task-engine.ts` (not via the barrel) will still work. The test file `__tests__/tasks-filters.test.ts` imports directly: `import { taskFind, taskList } from '../../engines/task-engine.js'`. | Low | The shim exports these identically. The test will continue to work. Worker MUST verify with `pnpm run test` after creating the shim that no import resolution errors occur. |

---

## 6. Wave Plan

Recommended implementation order for the Worker. Each wave is independently buildable and testable.

### Wave 1: Converters and types (~80 LOC, ~30 min)

**Goal**: Establish the converter functions and interface types in Core. No functional change yet.

Files touched:
- Create `packages/core/src/tasks/engine-ops.ts` with only:
  - `taskToRecord(task: Task): TaskRecord`
  - `tasksToRecords(tasks: Task[]): TaskRecord[]`
  - `toHistoryEntry(e: IvtrPhaseEntry): IvtrHistoryEntry`
  - `interface LifecycleStageEntry`
  - `interface IvtrHistoryEntry`
- Add exports to `packages/core/src/tasks/index.ts`
- Add exports to `packages/core/src/internal.ts`

**Verify**: `pnpm run build` — confirm no circular import errors.

LOC: ~80 in engine-ops.ts, ~15 added to index.ts/internal.ts.

### Wave 2: Thin CRUD and non-CRUD wrappers (~250 LOC, ~45 min)

**Goal**: Add all functions that are pure `try/catch` wrappers around existing `coreTask*` helpers. These are the simplest functions — 5–20 LOC each with no branching logic.

Functions added to `engine-ops.ts`:
- `taskNext`, `taskBlockers`, `taskTree`, `taskDeps`, `taskRelates`, `taskRelatesAdd`
- `taskAnalyze`, `taskRestore`, `taskUnarchive`, `taskReorder`, `taskReparent`
- `taskPromote`, `taskReopen`, `taskCancel`, `taskComplexityEstimate`
- `taskDepends`, `taskDepsOverview`, `taskDepsCycles`, `taskStats`
- `taskExport`, `taskHistory`, `taskLint`, `taskBatchValidate`, `taskImport`
- `taskImpact`, `taskPlan`, `taskRelatesFind`, `taskLabelList`, `taskLabelShow`

All call existing `coreTask*` or core-internal functions that are already reachable.

Also add basic CRUD wrappers (wrapping existing ops.ts normalized fns with EngineResult):
- `taskShow`, `taskList`, `taskFind`, `taskExists`, `taskDelete`, `taskArchive`

**Verify**: `pnpm run build` + `pnpm run test` (zero new failures).

LOC added: ~250 to engine-ops.ts.

### Wave 3: Sync sub-domain wrappers (~70 LOC, ~30 min)

**Goal**: Move `taskSyncReconcile`, `taskSyncLinks`, `taskSyncLinksRemove` to Core. These require tracing the lazy imports (`reconcile`, `getLinksByProvider`, etc.) to their source files within Core.

Files touched:
- Add 3 functions to `packages/core/src/tasks/engine-ops.ts`
- Verify direct file imports (no barrel imports within Core) to avoid cycles

**Verify**: `pnpm run build` + `pnpm run test`.

LOC added: ~70 to engine-ops.ts.

### Wave 4: Complex mutation wrappers (~200 LOC, ~60 min)

**Goal**: Move the complex functions — `taskCreate`, `taskUpdate`, `taskComplete`, `taskCompleteStrict`, `taskShowIvtrHistory`, `taskClaim`, `taskUnclaim`.

`taskCreate` requires:
- Session-scope parent resolution (calls `getActiveSession`)
- `coreFindTasks` for `--parent-search`
- `coreAddTask`

`taskCompleteStrict` requires:
- `loadConfig`, `getAccessor`, `getIvtrState`, `revalidateEvidence`
- All already in Core — remove the lazy `import('@cleocode/core/internal')` pattern

Also add `taskCompleteStrict`'s IVTR enforcement, lifecycle gate enforcement, and evidence staleness checks (they stay in the function — they are Core-level concerns).

**Verify**: `pnpm run build` + `pnpm run test`. This wave has the highest regression risk.

LOC added: ~200 to engine-ops.ts.

### Wave 5: Shim + wire-up (~60 LOC, ~20 min)

**Goal**: Replace `task-engine.ts` with the shim and confirm the end-to-end wire works.

Files touched:
- Replace `packages/cleo/src/dispatch/engines/task-engine.ts` with shim (~60 LOC)
- Verify `lib/engine.ts` barrel still works (no changes needed)
- Verify `packages/cleo/src/dispatch/domains/tasks.ts` still compiles (no changes needed)

**Verify**: Full quality gates in order:
1. `pnpm biome check --write .`
2. `pnpm run build`
3. `pnpm run test`
4. `wc -l packages/cleo/src/dispatch/engines/task-engine.ts` (must be < 100)

LOC: shim is ~60 LOC, removing ~2180 LOC from task-engine.ts.

### Wave summary

| Wave | Description | Est. LOC delta in engine-ops.ts | Risk |
|------|-------------|--------------------------------|------|
| 1 | Converters + types | +80 | Low |
| 2 | Thin CRUD + non-CRUD wrappers | +250 | Low |
| 3 | Sync sub-domain | +70 | Medium (lazy import tracing) |
| 4 | Complex mutations | +200 | High (session scope, IVTR) |
| 5 | Shim + wire-up | (replaces 2180 LOC in cleo) | Medium |

Total estimated `engine-ops.ts` size: ~600 LOC. If this exceeds 500 LOC the Worker SHOULD split Wave 1 output to `engine-converters.ts` and keep Wave 2+ in `engine-ops.ts`. Final decision is the Worker's.

---

## 7. Open Questions for Orchestrator

1. **`taskComplete` vs `taskCompleteStrict`**: The dispatch domain's `complete` handler calls `taskCompleteStrict`, not `taskComplete`. `taskComplete` (the non-strict version) is exported from `task-engine.ts` and used internally by `taskCompleteStrict`. After migration, `taskComplete` (non-strict) should become a private helper in `engine-ops.ts` — NOT exported. Confirm: is `taskComplete` (non-strict) used by any caller outside the task domain? The `lib/engine.ts` barrel currently re-exports it. If external callers depend on it, it must remain exported.

2. **`taskDeps` vs `taskDepends`**: The engine exports BOTH `taskDeps` (bidirectional show, lines 1349–1367) and `taskDepends` (directional with tree flag, lines 1820–1837). The `tasks.ts` domain handler uses `taskDepends` only; `taskDeps` is in the barrel but not clearly used by the domain handler. Is `taskDeps` called externally? If not, it can become a private helper folded into `taskDepends`.

3. **`taskExists`**: Not in the `tasks.ts` domain handler's supported ops list (`QUERY_OPS`). It is exported via the barrel. Is it called by other domains or the CLI directly? If no other caller, it can be moved to Core without the engine-level wrapper.

4. **`taskStats`, `taskExport`, `taskImport`, `taskBatchValidate`, `taskLint`**: Not in the `tasks.ts` domain handler's QUERY_OPS or MUTATE_OPS sets. They are exported via barrel. Are these called from non-dispatch code (e.g., CLI commands directly)? This affects whether they need EngineResult wrapping in Core or can be raw Core functions.

5. **ADR-057 D1 compliance for `engine-ops.ts`**: Should the Worker normalize ALL functions in `engine-ops.ts` to the `(projectRoot: string, params: <Op>Params): Promise<EngineResult<T>>` shape? Some current functions use positional args (e.g., `taskDelete(projectRoot, taskId, force?)`). For the shim to work transparently, positional signatures must be preserved. The Worker can add normalized wrappers in `ops.ts` separately and leave `engine-ops.ts` with the original positional signatures — confirm this is acceptable per ADR-057.
