# T1568 Migration Plan v2 — Corrected: DELETE task-engine.ts Entirely

**Epic**: T1566 (T-ENGINE-MIGRATION)
**Date**: 2026-04-30
**Version**: v2 — corrected per operator directives (no shim, no backward-compat)
**Wave 1**: Already committed at sha `fd816a162` on branch `task/T1568`

---

## 1. Decisions (Q1–Q5)

### Q1 — EngineResult vs Core return shape

**Finding**: `EngineResult` lives canonically in `packages/core/src/engine-result.ts` (exported via `@cleocode/core`). Core task helpers (`showTask`, `coreTaskNext`, `completeTask`, etc.) do NOT return `EngineResult` — they throw `CleoError` on failure and return raw values on success. The engine layer currently wraps them in `try/catch` to produce `EngineResult`.

The domain handler in `tasks.ts` already calls `wrapCoreResult(engineResult, opName)` which converts `EngineResult → LafsEnvelope`. So the chain is:

```
core helper → throws CleoError | returns T
engine function → catches, wraps → EngineResult<T>
domain handler → wrapCoreResult → LafsEnvelope
```

**Decision: Option (A)** — Add `wrapCoreOp<T>(fn: () => Promise<T>, fallbackCode: string, fallbackMsg: string): Promise<EngineResult<T>>` as a private helper at the top of any new core file that needs it, or reuse `cleoErrorToEngineError` (already in `_error.ts`). Do NOT add a new exported helper to core just for this — domain handlers should call core directly and wrap at the dispatch boundary using the existing `wrapCoreResult`. For functions currently producing `EngineResult` that move into core (e.g., `taskCompleteStrict`), keep them returning `EngineResult` because `wrapCoreResult` in the domain handler already handles that shape correctly.

**Rationale**: `wrapCoreResult` in `typed.ts` already bridges `EngineResult → LafsEnvelope`. Keeping `EngineResult`-returning functions in core is established precedent (see `packages/core/src/caamp/adapter.ts`). No new wrapper type needed.

---

### Q2 — Domain handler call shape post-migration

**Current** — domain handler imports from engine barrel which re-exports from task-engine:

```typescript
// tasks.ts (current)
import { taskNext, taskBlockers, taskCreate } from '../lib/engine.js';

next: async (params) => {
  const projectRoot = getProjectRoot();
  return wrapCoreResult(await taskNext(projectRoot, params), 'next');
},

blockers: async (params) => {
  const projectRoot = getProjectRoot();
  return wrapCoreResult(await taskBlockers(projectRoot, params), 'blockers');
},

complete: async (params) => {
  const projectRoot = getProjectRoot();
  if (params.force !== undefined) {
    return lafsError('E_FLAG_REMOVED', '...', 'complete');
  }
  const result = await taskCompleteStrict(projectRoot, params.taskId, params.notes);
  setImmediate(async () => { /* fire-and-forget trackMemoryUsage */ });
  return wrapCoreResult(result, 'complete');
},
```

**Proposed** — domain handler imports directly from `@cleocode/core/internal`:

```typescript
// tasks.ts (post-migration)
import {
  coreTaskNext, coreTaskBlockers, completeTaskStrict,
  addTaskWithSessionScope, /* ... */
} from '@cleocode/core/internal';

next: async (params) => {
  const projectRoot = getProjectRoot();
  return wrapCoreResult(await coreTaskNext(projectRoot, params), 'next');
},

blockers: async (params) => {
  const projectRoot = getProjectRoot();
  return wrapCoreResult(await coreTaskBlockers(projectRoot, params), 'blockers');
},

complete: async (params) => {
  const projectRoot = getProjectRoot();
  if (params.force !== undefined) {
    return lafsError('E_FLAG_REMOVED', '...', 'complete');
  }
  const result = await completeTaskStrict(projectRoot, params.taskId, params.notes);
  setImmediate(async () => { /* fire-and-forget trackMemoryUsage */ });
  return wrapCoreResult(result, 'complete');
},
```

The handler bodies are identical in shape. The only change is the import source. `wrapCoreResult` handles both raw-value `EngineResult` shapes and LAFS envelope shapes transparently.

**Functions that return raw values from core** (throw on failure): `coreTaskNext`, `coreTaskBlockers`, `coreTaskTree`, all `coreTask*` ops — these already work with `wrapCoreResult` because `wrapCoreResult` accepts `{ success: boolean, data?, error? }`. Since core throws instead of returning failure, the domain handler would need a try/catch or the core functions must return EngineResult.

**Correction**: For the ~40 thin wrappers that currently do `try { ... return { success:true, data } } catch { return engineError(...) }` in task-engine.ts — these patterns MOVE INTO core as `EngineResult`-returning functions, keeping the same `try/catch` wrapping pattern. This is already the pattern in `packages/core/src/caamp/adapter.ts`. The domain handler continues to call `wrapCoreResult(await coreFunc(...), opName)`.

---

### Q3 — taskCreate session-scope: extract or inline?

**Finding**: `getActiveSession` is used in 4 other engine files:
- `lifecycle-engine.ts` — scope guard
- `orchestrate-engine.ts` — 2 call sites
- `session-engine.ts` — via `accessor.getActiveSession()`

So session-scope resolution is a cross-cutting concern, not unique to `taskCreate`.

**Decision: Option (A)** — Extract `resolveParentFromSession(projectRoot, params)` to `packages/core/src/tasks/session-scope.ts`. This function encapsulates the 3-mechanism parent resolution (explicit `--parent`, `--parent-search` fuzzy match, session-epic inheritance). The domain handler's `add` op calls `addTaskWithSessionScope` — one public core function that calls `resolveParentFromSession` then `addTask`.

**Rationale**: Extraction into a named focused module is cleaner than inlining in the domain handler (violates separation of concerns) and avoids creating an `addTaskWithSessionScope` that's a one-liner wrapper (per operator directive D3). The named `resolveParentFromSession` function is independently testable and could be reused if session-scope parent resolution is needed elsewhere. `addTask` itself does NOT get this logic — it stays pure.

---

### Q4 — taskCompleteStrict: IVTR + evidence enforcement location

**Finding**: `coreCompleteTask` (the non-strict version) is called by:
1. `taskCompleteStrict` in task-engine.ts (the only dispatch-layer caller)
2. `reconciliation-engine.ts` in core (internal, called with specific options)
3. `tasksCompleteOp` in `core/tasks/ops.ts` (normalized wrapper, also internal)
4. `cleo.ts` provider (internal)

The `complete` handler in `tasks.ts` ONLY calls `taskCompleteStrict` — it never calls non-strict `taskComplete` directly. The non-strict `taskComplete` in task-engine.ts is only exported so `taskCompleteStrict` can delegate to it at the end (line 1040: `return taskComplete(projectRoot, taskId, notes)`).

**Decision: Option (B)** — Add `completeTaskStrict` as a new exported function in `packages/core/src/tasks/complete.ts`. This function performs the full enforcement chain (evidence staleness, IVTR, lifecycle gate, verification_json null check) and then delegates to `completeTask` at the end. The non-strict `completeTask` remains unchanged (it's used internally by reconciliation and provider).

The enforcement logic is non-trivial business logic (196 LOC) — it belongs in core, not in the dispatch layer. It is NOT a wrapper — it contains real validation state machine logic.

**Rationale**: Single-responsibility — `completeTaskStrict` IS a distinct operation (strict-mode completion with multi-step enforcement). It delegates to `completeTask` at the end, but that delegation is intentional (the last step of enforcement is the actual completion). No "wrapper whose body is one line" — the function has 196 LOC of real logic.

---

### Q5 — All call sites of task-engine.ts exports

**Direct imports from `task-engine.ts` (7 callsites)**:

| File | Imports | Category |
|------|---------|----------|
| `packages/cleo/src/dispatch/lib/engine.ts` | All 48+ symbols (re-export barrel) | Type-only barrel — **remove task-engine block** |
| `packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts` | `taskFind`, `taskList` | Test — **update to import from `@cleocode/core/internal`** |
| `packages/cleo/src/dispatch/engines/__tests__/cleo-error-propagation.test.ts` | `taskComplete`, `taskShow` | Test — **rewrite to import from `@cleocode/core/internal`** |
| `packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts` | `taskComplete`, `taskCompleteStrict` | Test — **rewrite to import from `@cleocode/core/internal`** |
| `packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts` | `taskShowWithHistory` | Test — **rewrite to import from `@cleocode/core/internal`** |
| `packages/cleo/src/dispatch/engines/__tests__/task-complete-lifecycle-gate.test.ts` | `taskCompleteStrict` | Test — **rewrite to import from `@cleocode/core/internal`** |
| `packages/cleo/src/dispatch/engines/system-engine.ts` | `type TaskRecord` (type-only import) | Production — **update to `import type { TaskRecord } from '@cleocode/contracts'`** |

**Secondary callsites (import via `lib/engine.ts` barrel — tasks domain & tests)**:

These files mock `'../../lib/engine.js'` and will continue to work after the barrel is updated to re-export from `@cleocode/core/internal`. The mock boundary is the barrel, not task-engine, so no changes needed:
- `packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts`
- `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts`
- `packages/cleo/src/__tests__/core-parity.test.ts` — **must be updated**: asserts `task-engine.ts` exists + reads its content. Post-migration this test must be updated or deleted (the file won't exist).

**Additional call site from `core-parity.test.ts`**:

```
packages/cleo/src/__tests__/core-parity.test.ts
  Lines 97-109: reads task-engine.ts source via readFile, asserts it imports from @cleocode/core
  Lines 309, 333, 350, 376, 395, 418, 789: dynamic import('../dispatch/engines/task-engine.js')
```

This test will BREAK when task-engine.ts is deleted. It must be rewritten to import from `@cleocode/core/internal` or deleted if the tested behavior is now covered by core unit tests.

**Complete call site update table**:

| File | Change Required | Wave |
|------|----------------|------|
| `packages/cleo/src/dispatch/lib/engine.ts` | Remove task-engine.ts block; re-export all task symbols from `@cleocode/core/internal` | Wave 5 |
| `packages/cleo/src/dispatch/domains/tasks.ts` | Update import from `'../lib/engine.js'` task symbols to `'@cleocode/core/internal'` | Wave 5 |
| `packages/cleo/src/dispatch/engines/system-engine.ts` | `import type { TaskRecord } from './task-engine.js'` → `import type { TaskRecord } from '@cleocode/contracts'` | Wave 2 |
| `packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts` | Change `import { taskFind, taskList } from '../../engines/task-engine.js'` to `@cleocode/core/internal` | Wave 5 |
| `packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts` | Rewrite: mock `@cleocode/core/internal` functions directly; import `completeTaskStrict`, `taskComplete` from `@cleocode/core/internal` | Wave 4 |
| `packages/cleo/src/dispatch/engines/__tests__/cleo-error-propagation.test.ts` | Rewrite mocks for `@cleocode/core/internal`; import `taskComplete`, `taskShow` from `@cleocode/core/internal` | Wave 4 |
| `packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts` | Import `taskShowWithHistory` from `@cleocode/core/internal` (rename to `showTaskWithHistory` if renamed in core) | Wave 3 |
| `packages/cleo/src/dispatch/engines/__tests__/task-complete-lifecycle-gate.test.ts` | Import `completeTaskStrict` from `@cleocode/core/internal` | Wave 4 |
| `packages/cleo/src/__tests__/core-parity.test.ts` | Remove/rewrite all sections that `readFile` task-engine.ts or dynamic-import it; replace with tests against `@cleocode/core/internal` exports | Wave 5 |

**Files with NO changes needed** (mock the barrel, not task-engine directly):
- `packages/cleo/src/dispatch/domains/__tests__/tasks.test.ts`
- `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts`

---

## 2. Updated Symbol Inventory

For every exported symbol from `task-engine.ts`, the post-migration target. "→" means "moves to".

### Type re-exports (currently re-exported from contracts/core in task-engine.ts)

| Symbol | Current source in task-engine.ts | Post-migration: import from |
|--------|----------------------------------|----------------------------|
| `type MinimalTaskRecord` | re-export from `@cleocode/contracts` | `@cleocode/contracts` directly |
| `type TaskRecord` | re-export from `@cleocode/contracts` | `@cleocode/contracts` directly |
| `type CompactTask` | re-export from `@cleocode/core/internal` | `@cleocode/core/internal` directly |
| `type EngineResult` | re-export from `_error.js` / `@cleocode/core` | `@cleocode/core` directly |

### Converter types (Wave 1 — ALREADY COMMITTED at sha fd816a162)

| Symbol | Post-migration target |
|--------|-----------------------|
| `interface LifecycleStageEntry` | `packages/core/src/tasks/engine-converters.ts` (committed) |
| `interface IvtrHistoryEntry` | `packages/core/src/tasks/engine-converters.ts` (committed) |
| `taskToRecord(task)` (private) | `packages/core/src/tasks/engine-converters.ts` (committed) |
| `tasksToRecords(tasks)` (private) | `packages/core/src/tasks/engine-converters.ts` (committed) |
| `toHistoryEntry(e)` (private) | `packages/core/src/tasks/engine-converters.ts` (committed) |

### Query operations (Wave 2)

| Symbol | Post-migration target | Notes |
|--------|-----------------------|-------|
| `taskShow` | `packages/core/src/tasks/show-engine.ts` | Wraps `showTask` + `computeTaskView` in try/catch → EngineResult |
| `taskShowWithHistory` | `packages/core/src/tasks/show-engine.ts` | Wraps `showTask` + `getLifecycleStatus` → EngineResult |
| `taskShowIvtrHistory` | `packages/core/src/tasks/show-engine.ts` | Wraps `getIvtrState` → EngineResult |
| `taskList` | `packages/core/src/tasks/list-engine.ts` | Wraps `listTasks` → EngineResult |
| `taskFind` | `packages/core/src/tasks/find-engine.ts` | Wraps `findTasks` → EngineResult |
| `taskExists` | `packages/core/src/tasks/show-engine.ts` | Wraps `accessor.taskExists` → EngineResult |
| `taskPlan` | `packages/core/src/tasks/plan.ts` | Wraps `coreTaskPlan` → EngineResult (add to existing file) |
| `taskLabelList` | `packages/core/src/tasks/labels.ts` | Wraps `listLabels` → EngineResult (add to existing file) |
| `taskLabelShow` | `packages/core/src/tasks/labels.ts` | Wraps `showLabelTasks` → EngineResult (add to existing file) |

### Non-CRUD operation wrappers (Wave 2)

These all follow the pattern: `try { return engineSuccess(await coreTask*(projectRoot, params)) } catch { return cleoErrorToEngineResult(...) }`.

| Symbol | Core function called | Post-migration target |
|--------|---------------------|-----------------------|
| `taskNext` | `coreTaskNext` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskBlockers` | `coreTaskBlockers` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskTree` | `coreTaskTree` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskDeps` | `coreTaskDeps` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskRelates` | `coreTaskRelates` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskRelatesAdd` | `coreTaskRelatesAdd` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskRelatesFind` | `suggestRelated` + `discoverRelated` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskAnalyze` | `coreTaskAnalyze` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskImpact` | `predictImpact` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskRestore` | `coreTaskRestore` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskUnarchive` | `coreTaskUnarchive` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskReorder` | `coreTaskReorder` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskReparent` | `coreTaskReparent` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskPromote` | `coreTaskPromote` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskReopen` | `coreTaskReopen` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskCancel` | `coreTaskCancel` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskComplexityEstimate` | `coreTaskComplexityEstimate` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskDepends` | `coreTaskDepends` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskDepsOverview` | `coreTaskDepsOverview` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskDepsCycles` | `coreTaskDepsCycles` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskStats` | `coreTaskStats` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskExport` | `coreTaskExport` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskHistory` | `coreTaskHistory` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskLint` | `coreTaskLint` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskBatchValidate` | `coreTaskBatchValidate` | `packages/core/src/tasks/task-ops-engine.ts` |
| `taskImport` | `coreTaskImport` | `packages/core/src/tasks/task-ops-engine.ts` |

### Sync sub-domain (Wave 3)

| Symbol | Core function called | Post-migration target |
|--------|---------------------|-----------------------|
| `taskSyncReconcile` | `reconcile` | `packages/core/src/tasks/sync-engine.ts` |
| `taskSyncLinks` | `getLinksByProvider`, `getLinksByTaskId` | `packages/core/src/tasks/sync-engine.ts` |
| `taskSyncLinksRemove` | `removeLinksByProvider` | `packages/core/src/tasks/sync-engine.ts` |

### Complex mutations (Wave 4)

| Symbol | Post-migration target | Notes |
|--------|-----------------------|-------|
| `taskCreate` | DELETED — replaced by new core function | See below |
| `resolveParentFromSession` (new, extracted) | `packages/core/src/tasks/session-scope.ts` | Session-scope parent resolution extracted here |
| `addTaskWithSessionScope` (new public export) | `packages/core/src/tasks/session-scope.ts` | Calls `resolveParentFromSession` then `addTask` |
| `taskUpdate` | `packages/core/src/tasks/update-engine.ts` | Wraps `updateTask` → EngineResult |
| `taskDelete` | `packages/core/src/tasks/delete-engine.ts` | Wraps `deleteTask` → EngineResult |
| `taskArchive` | `packages/core/src/tasks/archive.ts` | Wraps `archiveTasks` → EngineResult (add to existing file) |
| `taskComplete` | `packages/core/src/tasks/complete.ts` | Wraps `completeTask` + provenance stamp → EngineResult (add to existing file) |
| `taskCompleteStrict` → renamed `completeTaskStrict` | `packages/core/src/tasks/complete.ts` | Full enforcement chain; delegates to `taskComplete` at end |
| `taskClaim` | `packages/core/src/tasks/task-ops-engine.ts` | Wraps `accessor.claimTask` → EngineResult |
| `taskUnclaim` | `packages/core/src/tasks/task-ops-engine.ts` | Wraps `accessor.unclaimTask` → EngineResult |

### File plan summary

| New/Modified file | Purpose | Wave |
|-------------------|---------|------|
| `packages/core/src/tasks/engine-converters.ts` | Converter types + fns (DONE) | 1 |
| `packages/core/src/tasks/show-engine.ts` | `taskShow`, `taskShowWithHistory`, `taskShowIvtrHistory`, `taskExists` | 2 |
| `packages/core/src/tasks/list-engine.ts` | `taskList` (with pagination) | 2 |
| `packages/core/src/tasks/find-engine.ts` | `taskFind` | 2 |
| `packages/core/src/tasks/task-ops-engine.ts` | 26 non-CRUD ops + claim/unclaim | 2 |
| `packages/core/src/tasks/plan.ts` (extend) | Add `taskPlan` EngineResult wrapper | 2 |
| `packages/core/src/tasks/labels.ts` (extend) | Add `taskLabelList`, `taskLabelShow` wrappers | 2 |
| `packages/core/src/tasks/sync-engine.ts` | `taskSyncReconcile`, `taskSyncLinks`, `taskSyncLinksRemove` | 3 |
| `packages/core/src/tasks/session-scope.ts` | `resolveParentFromSession`, `addTaskWithSessionScope` | 4 |
| `packages/core/src/tasks/update-engine.ts` | `taskUpdate` EngineResult wrapper | 4 |
| `packages/core/src/tasks/delete-engine.ts` | `taskDelete` EngineResult wrapper | 4 |
| `packages/core/src/tasks/complete.ts` (extend) | Add `taskComplete` + `completeTaskStrict` | 4 |
| `packages/core/src/tasks/archive.ts` (extend) | Add `taskArchive` EngineResult wrapper | 4 |
| `packages/core/src/tasks/index.ts` (extend) | Export all new public symbols | Each wave |
| `packages/core/src/internal.ts` (extend) | Export all new public symbols | Each wave |
| `packages/cleo/src/dispatch/engines/system-engine.ts` (patch) | Fix `TaskRecord` import | 2 |
| `packages/cleo/src/dispatch/engines/task-engine.ts` | **DELETED** | 5 |
| `packages/cleo/src/dispatch/lib/engine.ts` (patch) | Remove task-engine block; add core/internal re-exports | 5 |
| `packages/cleo/src/dispatch/domains/tasks.ts` (patch) | Update task imports to `@cleocode/core/internal` | 5 |
| Test files (4) | Rewrite mocks + imports | 4–5 |
| `core-parity.test.ts` | Remove task-engine.ts file assertions | 5 |

---

## 3. Call Site Update Table

All files that need an import change when `task-engine.ts` is deleted:

| # | File | Current import | Post-migration import | Wave |
|---|------|---------------|----------------------|------|
| 1 | `packages/cleo/src/dispatch/lib/engine.ts` | `} from '../engines/task-engine.js'` (all task symbols) | `} from '@cleocode/core/internal'` (all task symbols) | 5 |
| 2 | `packages/cleo/src/dispatch/domains/tasks.ts` | task symbols from `'../lib/engine.js'` | task symbols from `'@cleocode/core/internal'` | 5 |
| 3 | `packages/cleo/src/dispatch/engines/system-engine.ts` | `import type { TaskRecord } from './task-engine.js'` | `import type { TaskRecord } from '@cleocode/contracts'` | 2 |
| 4 | `packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts` | `import { taskFind, taskList } from '../../engines/task-engine.js'` | `import { taskFind, taskList } from '@cleocode/core/internal'` | 5 |
| 5 | `packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts` | `import { taskComplete, taskCompleteStrict } from '../task-engine.js'` | `import { taskComplete, completeTaskStrict } from '@cleocode/core/internal'` (rewrite mocks) | 4 |
| 6 | `packages/cleo/src/dispatch/engines/__tests__/cleo-error-propagation.test.ts` | `import { taskComplete, taskShow } from '../task-engine.js'` | `import { taskComplete, taskShow } from '@cleocode/core/internal'` (rewrite mocks) | 4 |
| 7 | `packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts` | `import { taskShowWithHistory } from '../task-engine.js'` | `import { taskShowWithHistory } from '@cleocode/core/internal'` (rewrite mocks) | 3 |
| 8 | `packages/cleo/src/dispatch/engines/__tests__/task-complete-lifecycle-gate.test.ts` | `import { taskCompleteStrict } from '../task-engine.js'` | `import { completeTaskStrict } from '@cleocode/core/internal'` (rewrite mocks) | 4 |
| 9 | `packages/cleo/src/__tests__/core-parity.test.ts` | Multiple dynamic imports + readFile of task-engine.ts | Remove task-engine.ts file checks; replace dynamic imports with `@cleocode/core/internal` | 5 |

---

## 4. Corrected Wave Plan (Waves 2–5)

Wave 1 is already committed at `fd816a162`. Waves 2–5 replace the original plan's Waves 2–5 entirely.

### Wave 1: Converters and types — ALREADY COMMITTED (sha fd816a162)

Files: `packages/core/src/tasks/engine-converters.ts` (created), `core/tasks/index.ts` (patched), `core/internal.ts` (patched).
Keep as-is. Do not modify.

---

### Wave 2: Query wrappers + non-CRUD ops + system-engine patch (~400 LOC, medium)

**Goal**: Move all read-only operations and non-CRUD task ops into core. Fix `system-engine.ts` type import. No mutation logic yet.

**Files created**:
- `packages/core/src/tasks/show-engine.ts` — `taskShow`, `taskShowWithHistory`, `taskShowIvtrHistory`, `taskExists`
- `packages/core/src/tasks/list-engine.ts` — `taskList` (preserves pagination: `result.page` forwarding)
- `packages/core/src/tasks/find-engine.ts` — `taskFind`
- `packages/core/src/tasks/task-ops-engine.ts` — 26 non-CRUD ops (next, blockers, tree, deps, relates, relatesAdd, relatesFind, analyze, impact, restore, unarchive, reorder, reparent, promote, reopen, cancel, complexityEstimate, depends, depsOverview, depsCycles, stats, export, history, lint, batchValidate, import, claim, unclaim)

**Files modified**:
- `packages/core/src/tasks/plan.ts` — add `taskPlan` EngineResult wrapper export
- `packages/core/src/tasks/labels.ts` — add `taskLabelList`, `taskLabelShow` EngineResult wrapper exports
- `packages/core/src/tasks/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols
- `packages/cleo/src/dispatch/engines/system-engine.ts` — fix `import type { TaskRecord }` to use `@cleocode/contracts`

**Files NOT touched yet**: `task-engine.ts`, `lib/engine.ts`, `tasks.ts`

**Commit message**:
```
feat(T1568): move query ops + non-CRUD wrappers to core/tasks (Wave 2)

Adds taskShow, taskShowWithHistory, taskShowIvtrHistory, taskExists to
show-engine.ts; taskList to list-engine.ts; taskFind to find-engine.ts;
26 non-CRUD ops to task-ops-engine.ts. Extends plan.ts, labels.ts.
Fixes system-engine.ts TaskRecord import to use @cleocode/contracts.
task-engine.ts still exists — wire-up in Wave 5.

Refs: T1568, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 3: Sync sub-domain + task-show-history test update (~120 LOC, small)

**Goal**: Move the sync reconciliation operations into core. Update the test that imports `taskShowWithHistory` directly from task-engine.

**Files created**:
- `packages/core/src/tasks/sync-engine.ts` — `taskSyncReconcile`, `taskSyncLinks`, `taskSyncLinksRemove`

**Implementation notes for sync-engine.ts**:
- Import `reconcile` from `'../reconciliation/index.js'` (direct file path, avoids barrel cycles)
- Import `getLinksByProvider`, `getLinksByTaskId`, `removeLinksByProvider` from `'../reconciliation/link-store.js'`
- Use the same try/catch → EngineResult pattern as all other wrappers

**Files modified**:
- `packages/core/src/tasks/index.ts` — export new sync-engine symbols
- `packages/core/src/internal.ts` — export new sync-engine symbols
- `packages/cleo/src/dispatch/engines/__tests__/task-show-history.test.ts` — update import to `@cleocode/core/internal`; update mocks from relative core file paths to `@cleocode/core/internal`

**Files NOT touched yet**: `task-engine.ts`, `lib/engine.ts`, `tasks.ts`

**Commit message**:
```
feat(T1568): move sync sub-domain to core/tasks/sync-engine.ts (Wave 3)

Adds taskSyncReconcile, taskSyncLinks, taskSyncLinksRemove to core using
direct file imports (no barrel) to avoid cycles. Updates task-show-history
test to import from @cleocode/core/internal.

Refs: T1568, T1566, ADR-057
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 4: Complex mutations + strict completion + test rewrites (~600 LOC, large)

**Goal**: Move `taskCreate`, `taskUpdate`, `taskComplete`, `completeTaskStrict`, `taskDelete`, `taskArchive` and the session-scope extraction into core. Rewrite the 3 test files that import directly from task-engine.

**Files created**:
- `packages/core/src/tasks/session-scope.ts` — `resolveParentFromSession`, `addTaskWithSessionScope`
  - `resolveParentFromSession(projectRoot, params)`: 3-mechanism resolution (explicit parent, parentSearch fuzzy, session-epic inheritance)
  - `addTaskWithSessionScope(projectRoot, params)`: calls `resolveParentFromSession`, then `addTask`; returns `EngineResult<{ task: TaskRecord; duplicate: boolean; dryRun?: boolean; warnings?: string[] }>`
- `packages/core/src/tasks/update-engine.ts` — `taskUpdate` EngineResult wrapper
- `packages/core/src/tasks/delete-engine.ts` — `taskDelete` EngineResult wrapper

**Files modified**:
- `packages/core/src/tasks/complete.ts` — add `taskComplete` (provenance-stamping EngineResult wrapper) and `completeTaskStrict` (full 196-LOC enforcement chain, delegates to `taskComplete` at end). Remove lazy `import('@cleocode/core/internal')` for `revalidateEvidence` — use direct import from `'./evidence.js'`.
- `packages/core/src/tasks/archive.ts` — add `taskArchive` EngineResult wrapper export
- `packages/core/src/tasks/index.ts` — export all new symbols
- `packages/core/src/internal.ts` — export all new symbols

**Test files rewritten**:
- `packages/cleo/src/dispatch/engines/__tests__/task-engine.test.ts` — rewrite to mock `@cleocode/core/internal`; import `taskComplete`, `completeTaskStrict` from `@cleocode/core/internal`. The test content (what is being tested) is preserved; only the import paths and mock targets change.
- `packages/cleo/src/dispatch/engines/__tests__/cleo-error-propagation.test.ts` — rewrite mocks from relative core file paths to `vi.mock('@cleocode/core/internal', ...)`. Import `taskComplete`, `taskShow` from `@cleocode/core/internal`.
- `packages/cleo/src/dispatch/engines/__tests__/task-complete-lifecycle-gate.test.ts` — update import from `'../task-engine.js'` to `@cleocode/core/internal`; rename `taskCompleteStrict` → `completeTaskStrict` in import.

**Commit message**:
```
feat(T1568): move complex mutations + strict completion to core (Wave 4)

Adds session-scope.ts (resolveParentFromSession, addTaskWithSessionScope),
update-engine.ts, delete-engine.ts. Extends complete.ts with taskComplete
+ completeTaskStrict (full 196-LOC enforcement, no lazy imports). Extends
archive.ts. Rewrites 3 engine test files to import from @cleocode/core/internal.
task-engine.ts still exists — deleted in Wave 5.

Refs: T1568, T1566, ADR-057, ADR-051
```

**Verify**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test  # zero new failures
```

---

### Wave 5: Delete task-engine.ts + wire dispatch layer (~50 LOC changed, medium)

**Goal**: Delete `task-engine.ts`. Update `lib/engine.ts` barrel to re-export task symbols from `@cleocode/core/internal`. Update `tasks.ts` domain handler imports. Update `core-parity.test.ts`. Update `tasks-filters.test.ts`.

**Files DELETED**:
- `packages/cleo/src/dispatch/engines/task-engine.ts` — **DELETED** (2242 LOC removed)

**Files modified**:
- `packages/cleo/src/dispatch/lib/engine.ts` — Remove the entire `// Task engine (CRUD + non-CRUD operations)` block (lines 250–302). Add a new block:
  ```typescript
  // Task operations (moved to core — T1568)
  export {
    type IvtrHistoryEntry,
    type LifecycleStageEntry,
    taskShow, taskShowWithHistory, taskShowIvtrHistory, taskExists,
    taskList, taskFind, taskPlan,
    taskLabelList, taskLabelShow,
    taskNext, taskBlockers, taskTree, taskDeps, taskRelates, taskRelatesAdd,
    taskRelatesFind, taskAnalyze, taskImpact, taskRestore, taskUnarchive,
    taskReorder, taskReparent, taskPromote, taskReopen, taskCancel,
    taskComplexityEstimate, taskDepends, taskDepsOverview, taskDepsCycles,
    taskStats, taskExport, taskHistory, taskLint, taskBatchValidate, taskImport,
    taskClaim, taskUnclaim,
    taskSyncReconcile, taskSyncLinks, taskSyncLinksRemove,
    addTaskWithSessionScope as taskCreate,
    taskUpdate, taskDelete, taskArchive,
    taskComplete, completeTaskStrict as taskCompleteStrict,
  } from '@cleocode/core/internal';
  // Note: MinimalTaskRecord, TaskRecord, CompactTask, EngineResult imported
  // from contracts/core directly by consumers (no longer re-exported via this barrel)
  ```
  Note: The `taskCreate` alias and `taskCompleteStrict` alias preserve the external name contract so that the `tasks.ts` domain handler needs minimal changes and the mocked test barrel (`'../../lib/engine.js'`) continues to work unchanged.

- `packages/cleo/src/dispatch/domains/tasks.ts` — The import from `'../lib/engine.js'` continues to work since the barrel re-exports everything. **No changes required** to tasks.ts if the barrel aliases are correct.

- `packages/cleo/src/dispatch/domains/__tests__/tasks-filters.test.ts` — Update import from `'../../engines/task-engine.js'` to `'../../lib/engine.js'` (the barrel now re-exports from core; same symbols available) OR import directly from `@cleocode/core/internal`.

- `packages/cleo/src/__tests__/core-parity.test.ts` — Remove/update:
  - Lines 97–109: delete the `it('task-engine.ts imports core CRUD functions...')` test (the file no longer exists; behavior is verified by build)
  - Lines 309, 333, 350, 376, 395, 418, 789: replace `import('../dispatch/engines/task-engine.js')` with `import('@cleocode/core/internal')` (same functions, new location)

**Commit message**:
```
feat(T1568)!: delete task-engine.ts — all task ops now live in core (Wave 5)

Removes packages/cleo/src/dispatch/engines/task-engine.ts (2242 LOC).
Updates lib/engine.ts barrel to re-export task symbols from @cleocode/core/internal.
Updates core-parity.test.ts and tasks-filters.test.ts.
tasks.ts domain handler requires no import changes (barrel preserves names).
Full quality gates: biome + build + test pass.

BREAKING CHANGE: internal dispatch — no user-facing API change.
Refs: T1568, T1566, ADR-057, ADR-058
```

**Verify** (full quality gates, order matters):
```bash
# 1. Format and lint (repo-wide, CI-strict)
pnpm biome check --write .
pnpm biome ci .

# 2. Build (full dep graph)
pnpm run build

# 3. Tests (zero new failures)
pnpm run test

# 4. Confirm file is gone
test ! -f packages/cleo/src/dispatch/engines/task-engine.ts && echo "CONFIRMED: deleted"

# 5. Confirm no stray imports
grep -rn "from.*task-engine" packages/cleo/src/ --include="*.ts" | grep -v "node_modules"
# Expected: zero output

# 6. Confirm build artifact exports are intact
grep -rn "taskCompleteStrict\|taskShow\|taskCreate" packages/cleo/src/dispatch/lib/engine.ts
# Expected: all symbols re-exported from @cleocode/core/internal
```

---

### Wave summary

| Wave | Description | LOC delta | Risk |
|------|-------------|-----------|------|
| 1 (committed) | Converters + types in core | +164 | None |
| 2 | Query wrappers + 26 non-CRUD ops + system-engine fix | +400 in core, −2 in cleo | Low |
| 3 | Sync sub-domain + task-show-history test | +120 in core, test rewrite | Low |
| 4 | Complex mutations + strict completion + 3 test rewrites | +600 in core, test rewrites | Medium |
| 5 | DELETE task-engine.ts + wire dispatch | −2242 in cleo, +~50 barrel patch | Low (if Wave 4 passes) |
| **Net** | | **−1908 LOC in cleo, +1284 LOC in core** | |

---

## 5. Risk Register

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **`completeTaskStrict` lazy import becomes a static import** — Task-engine uses `const { revalidateEvidence } = await import('@cleocode/core/internal')` inside the function body to avoid cycles during dispatch tests. Moving the function into core means `revalidateEvidence` (in `tasks/evidence.ts`) must be a static import. Verify no circular path: `tasks/complete.ts` → `tasks/evidence.ts` — `evidence.ts` does NOT import from `complete.ts` (confirmed: evidence.ts imports only from store, contracts, errors). The lazy import was a dispatch-layer concern; inside core it's safe to use static imports. | Medium | Before Wave 4: run `grep -rn "from.*complete" packages/core/src/tasks/evidence.ts` to confirm no back-reference. If a cycle is detected, extract the `revalidateEvidence` call into an injected async function parameter. |
| 2 | **`core-parity.test.ts` reads task-engine.ts source via `readFile`** — Lines 97–109 assert the file exists and contains specific strings. After deletion this test crashes. The test also contains 6 dynamic imports from task-engine.js. If the test is in a CI-required suite, it will block the build until Wave 5 updates are complete. | High | Wave 5 MUST include updating `core-parity.test.ts` as part of the same commit as the deletion. Do not delete task-engine.ts in one commit and fix the test in a follow-up — the build must stay green between commits. Treat test update as non-optional scope within Wave 5. |
| 3 | **`lib/engine.ts` aliasing: `addTaskWithSessionScope as taskCreate` and `completeTaskStrict as taskCompleteStrict`** — If the barrel re-export alias is wrong (wrong name, wrong function), all 3 test files that mock `'../../lib/engine.js'` will receive `undefined` for the aliased symbol without a TypeScript error. This could produce silent test failures. | Medium | After Wave 5, run the tasks domain test suite explicitly: `pnpm --filter @cleocode/cleo vitest run --reporter=verbose src/dispatch/domains/__tests__/tasks.test.ts`. If any test passes because it's testing a `vi.fn()` that returns undefined on an aliased symbol, the alias is wrong. Confirm by checking the mock returns match expected shapes. |

---

## Anti-patterns found in original plan (v1)

The following patterns from the original plan (v1) were rejected per operator directive:

| Pattern found | Location in v1 plan | Why rejected |
|---------------|---------------------|--------------|
| "Shim re-export only" for type re-exports | §1 Symbol Inventory, 4 rows | Creates backward-compat shim layer — violates operator directive D1 |
| Wave 5 creates a shim file | §6 Wave 5 description | Explicitly prohibited: "NO SHIMS, NO BACKWARDS COMPAT" |
| "Handler body signatures after migration... remain IDENTICAL — no changes needed" | §4 Handler-Shim Mapping | The domain handler DID need import changes; this was obscured by the shim |
| `wc -l < 100` acceptance criterion on task-engine.ts | Wave 5 verify | A 60-LOC shim is not deletion; criterion was wrong |
| Proposed `export {} from './task-engine'` shim as "backward-compat barrel" | Wave 5, ~60 LOC shim | Deprecated wrapper pattern — violates operator directive D1 |
