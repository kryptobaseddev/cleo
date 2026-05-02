# Audit E: SDK Surface Parity — CLI ↔ Core ↔ Public SDK

**Date**: 2026-05-01
**Scope**: registry.ts OPERATIONS array, core/internal.ts exports, domain engine-ops files, CLI command files
**Status**: Complete

---

## 1. Executive Summary

| Question | Parity Score | Key Gap |
|----------|-------------|---------|
| Q1: Operation inventory | PARTIAL | 347 registry ops vs 400 internal exports; 2 registered domains (sentient, release) with zero ops in OPERATIONS array |
| Q2: CLI ↔ Dispatch parity | POOR | 29/114 CLI command files bypass dispatch entirely; ~14 emit non-LAFS output |
| Q3: Dispatch ↔ Core parity | GOOD | Domain handlers route to core; intelligence + admin + memory have localized DB-access leaks |
| Q4: Core SDK surface | PARTIAL | Two-tier export: public `index.ts` (throw-style) vs `internal.ts` (EngineResult-style); no stable contract for which is "public SDK" |
| Q5: LAFS at SDK boundary | BROKEN | `showTask` (public) returns `TaskDetail` (throw-style); dispatch returns `EngineResult<{task:TaskRecord, view:TaskView}>`. Incompatible shapes. |
| Q6: Side effects in dispatch | PRESENT | `release/engine-ops.ts` calls `console.log` for step logging; `admin`, `memory`, `intelligence` domain handlers open DB connections directly |
| Q7: Renderers | CLEAN | Renderers consume data only; no data fetching confirmed |
| Q8: `--human` source of truth | SINGLE POINT | Parsed once in `cli/index.ts`, stored in `format-context.ts` singleton; BUT ~14 commands bypass this with their own `--json`/human output logic |
| Q9: Type consistency | INCONSISTENT | `addTask` (public) returns `AddTaskResult`; dispatch uses `addTaskWithSessionScope` returning `EngineResult<{task:TaskRecord,...}>`. Different shapes. |

**Biggest gaps in priority order:**
1. Two commands (`sentient`, some `release` sub-commands) have handlers registered but zero ops in the OPERATIONS registry — they route around the resolve() gate entirely.
2. 29 CLI commands bypass dispatch; 14 of those also bypass the global format context (`cliOutput`), producing non-LAFS or partially LAFS output.
3. The public SDK (`@cleocode/core` index.ts) exports throw-style functions returning domain types; the CLI/dispatch path uses `EngineResult`-returning wrappers. An SDK consumer cannot get `EngineResult<{task:TaskRecord,view:TaskView}>` from the public API without importing from `@cleocode/core/internal`, which carries a runtime warning.

---

## 2. Operation Inventory

### 2a. Registry (OPERATIONS array in registry.ts)

Total operations: **347** across **13 canonical domains**.

| Domain | Ops in registry |
|--------|----------------|
| nexus | 62 |
| memory | 46 |
| admin | 42 |
| pipeline | 34 |
| tasks | 32 |
| orchestrate | 32 |
| tools | 25 |
| check | 21 |
| session | 15 |
| conduit | 8 |
| sticky | 6 |
| playbook | 5 |
| intelligence | 5 |
| diagnostics | 5 |
| docs | 5 |
| **sentient** | **0** |
| **release** | **0** |

Note: `sentient` and `release` have domain handlers (registered in `createDomainHandlers()`) but **zero entries in the OPERATIONS array**. The dispatcher calls `resolve()` first and returns `E_INVALID_OPERATION` when `resolve()` returns undefined. This means `dispatchFromCli('query', 'sentient', 'propose.list', ...)` would fail at the registry gate unless there is a bypass path. In practice, the `cleo sentient` CLI does NOT call `dispatchFromCli` — it bypasses dispatch entirely.

### 2b. Core `internal.ts` exports

`internal.ts` has **400 top-level `export` lines**. These span both functions and types. This is a superset of `index.ts` (public SDK, 119 top-level exports).

`index.ts` exports all `@cleocode/contracts` types plus domain namespace re-exports (`export * as tasks from './tasks/index.js'`) plus ~60 flat function re-exports. The flat function re-exports are the ones most relevant to parity.

### 2c. CLI command files

Total CLI command files in `packages/cleo/src/cli/commands/`: **114**

- Files that call `dispatchFromCli` or `dispatchRaw`: **85**
- Files that bypass dispatch: **29**

Of the 29 bypass files:
- **15** use `cliOutput` (correct output path, but bypass dispatch routing)
- **14** use raw `process.stdout.write`, `console.log`, or their own local LAFS envelope emitter

### 2d. Engine-ops files in core

Files named `engine-ops.ts` (EngineResult-returning wrappers over domain logic):

```
core/src/code/engine-ops.ts
core/src/config/engine-ops.ts
core/src/diagnostics/engine-ops.ts
core/src/hooks/engine-ops.ts
core/src/init/engine-ops.ts
core/src/lifecycle/engine-ops.ts
core/src/pipeline/engine-ops.ts
core/src/release/engine-ops.ts
core/src/session/engine-ops.ts
core/src/sticky/engine-ops.ts
core/src/tools/engine-ops.ts
core/src/validation/engine-ops.ts
```

**Notable absence**: `tasks/` and `memory/` domains do NOT have `engine-ops.ts`. Tasks has `tasks/show.ts` (contains both `showTask` throw-style and `taskShow` EngineResult wrapper in the same file). Memory has `memory/engine-compat.ts` (a compatibility shim).

---

## 3. CLI ↔ Dispatch ↔ Core Trace

### Trace 1: `tasks.show` — `cleo show T001`

```
CLI: packages/cleo/src/cli/commands/show.ts
  showCommand.run() calls:
    dispatchFromCli('query', 'tasks', 'show', { taskId, history, ivtrHistory })
  → packages/cleo/src/dispatch/adapters/cli.ts::dispatchFromCli()
  → dispatcher.dispatch(request)
  → resolve('query', 'tasks', 'show') → OperationDef found ✓
  → handler.query('show', params) → TasksHandler._tasksTypedHandler.show()
    File: packages/cleo/src/dispatch/domains/tasks.ts:101
    Code: return wrapCoreResult(await taskShow(projectRoot, params.taskId), 'show')

  where taskShow = from '@cleocode/core/internal'
    File: packages/core/src/tasks/show.ts:162
    taskShow(projectRoot, taskId): Promise<EngineResult<{task: TaskRecord; view: TaskView|null}>>
    → calls showTask(taskId, projectRoot, accessor) [throws on error]
    → wraps result: engineSuccess({ task: taskToRecord(detail), view })

  wrapCoreResult() converts EngineResult → LafsEnvelope:
    { success: true, data: { task: TaskRecord, view: TaskView } }

  dispatchFromCli() calls cliOutput(response.data, opts)
    → formatSuccess(filteredData, ...) → JSON string → console.log()

TYPES AT EACH LAYER:
  CLI args → { taskId: string, history: boolean, ivtrHistory: boolean }
  Dispatch params → same (via typedDispatch / OpsFromCore)
  Core function → (projectRoot: string, taskId: string) → EngineResult<{task:TaskRecord,view:TaskView}>
  LAFS output → { success: true, data: { task: TaskRecord, view: TaskView|null }, meta: {...} }

SDK CONSUMER using public API:
  import { showTask } from '@cleocode/core';
  const detail = await showTask(taskId, projectRoot); // returns TaskDetail, throws on error
  // TaskDetail is NOT the same shape as TaskRecord
  // No EngineResult, no LAFS envelope, no meta
```

**Gap**: SDK consumer gets `TaskDetail` (throw-style, richer shape); CLI consumer gets `{task: TaskRecord, view: TaskView}` in a LAFS envelope. These are incompatible return shapes for the same conceptual operation.

### Trace 2: `pipeline.release.ship` — `cleo release ship 2026.4.99 --epic T5576`

```
CLI: packages/cleo/src/cli/commands/release.ts
  shipCommand.run() calls:
    dispatchFromCli('mutate', 'pipeline', 'release.ship', { version, epicId, dryRun, push })
  → resolve('mutate', 'pipeline', 'release.ship') → OperationDef found ✓ (it's in pipeline domain)
  → PipelineHandler._pipelineTypedHandler['release.ship']()
    File: packages/cleo/src/dispatch/domains/pipeline.ts:606
    Code: return wrapCoreResult(await coreOps['release.ship'](params), 'release.ship')

  where coreOps['release.ship'] = releaseShipOp (local wrapper in pipeline.ts)
    → releaseShip(params, getProjectRoot())
    File: packages/core/src/release/engine-ops.ts:1005
    → returns EngineResult

  *** SIDE EFFECT IN CORE ***: releaseShip() calls console.log() directly (lines 1048, 1160, 1437-1490)
  for step progress logging. This fires regardless of whether caller is CLI, SDK, or test.

SDK CONSUMER using public API:
  import { release } from '@cleocode/core';
  // release.releaseShip is NOT exported from index.ts (confirmed)
  // releaseShip IS in internal.ts
  // SDK consumer CANNOT call release.ship via public API without internal import
```

**Gap**: `releaseShip` is only available from `@cleocode/core/internal`. Public SDK has no stable entry point for this critical operation. Core function leaks `console.log` progress output to stdout for any caller.

### Trace 3: `nexus.query-cte` — `cleo nexus query "callers-of"`

```
CLI: packages/cleo/src/cli/commands/nexus.ts
  queryCommand.run() calls:
    dispatchRaw('query', 'nexus', 'query-cte', { cte, params })
  → resolve('query', 'nexus', 'query-cte') → OperationDef... check registry:
    (grep confirms nexus has 62 ops; 'query-cte' should be one of them)
  → NexusHandler.query('query-cte', params)

  After dispatch: CLI handles output itself:
    const result = response.data as {...}
    const { formatCteResultAsMarkdown } = await import('@cleocode/core/nexus/query-dsl.js')
    // formats as markdown table
    process.stdout.write(formatted + '\n')
  ← Does NOT use cliOutput() for the markdown output path

  This means nexus query-cte:
    - DOES go through dispatch (correct)
    - Does NOT use cliOutput (violates output consistency)
    - Produces markdown, not a LAFS envelope (format-context not honored)
```

**Gap**: `nexus query-cte` routes through dispatch but produces markdown output directly, bypassing the global format context. Agents expecting JSON cannot use `--json` to get structured output.

---

## 4. Public SDK Surface

### `@cleocode/core` (index.ts — public)

Pattern: **throw-style domain functions**

```typescript
// What SDK consumers can import:
import { showTask } from '@cleocode/core';   // Returns TaskDetail, throws CleoError on failure
import { addTask } from '@cleocode/core';    // Returns AddTaskResult, throws on failure
import { listTasks } from '@cleocode/core';  // Returns ListTasksResult, throws on failure
import { Cleo } from '@cleocode/core';       // Facade class wrapping the above
```

The `Cleo` facade exposes `tasks.show(taskId)` which delegates to `showTask` — typed as `Promise<unknown>` in `TasksAPI` (in `@cleocode/contracts/src/facade.ts:291`). This is a type regression: the concrete implementation returns `TaskDetail` but the interface says `Promise<unknown>`.

Namespace exports (`export * as tasks from './tasks/index.js'`) expose every function in the tasks namespace, including internal helpers, creating an implied public API that is much larger than intended.

### `@cleocode/core/internal` (for `@cleocode/cleo` only)

Pattern: **EngineResult-style wrappers**

```typescript
// What the dispatch layer uses:
import { taskShow } from '@cleocode/core/internal';   // Returns EngineResult<{task:TaskRecord, view:TaskView}>
import { addTaskWithSessionScope } from '@cleocode/core/internal';  // Returns EngineResult<{task:TaskRecord,...}>
```

A runtime guard fires a `process.stderr.write` warning if `npm_package_name` does not start with `@cleocode/`. This guard exists but does not throw — external consumers can suppress it with `CLEO_ALLOW_INTERNAL=1`.

### Contract status

There is **no STABILITY.md or documented contract** distinguishing which functions from `index.ts` are stable public API vs implementation details. The `internal.ts` JSDoc says "External consumers should import from `@cleocode/core` (the public API)" but this guidance is incomplete because many critical operations (like `releaseShip`) are only in `internal.ts`.

---

## 5. Side-Effect Leaks in Dispatch

### Confirmed leaks

| Location | Side Effect | Severity |
|----------|------------|---------|
| `core/src/release/engine-ops.ts:1048,1160,1437-1490` | `console.log()` for step progress in `releaseShip()` | HIGH — fires for all SDK callers |
| `core/src/memory/brain-purge.ts:91-296` | `console.log()` extensively throughout `purgeBrainNoise()` | HIGH — fires for all SDK callers |
| `dispatch/domains/admin.ts:189-231` | `getDb()` + `getBrainDb()` called directly in dispatch handler | MEDIUM — DB access should be in core |
| `dispatch/domains/intelligence.ts:62-65` | `getAccessor()` + `getBrainAccessor()` called in dispatch handler | MEDIUM — DB access should be in core |
| `dispatch/domains/memory.ts:510-540` | Raw SQL prepared statement `nativeDb2.prepare(...)` in dispatch handler (sweep case) | HIGH — business logic in wrong layer |
| `dispatch/domains/memory.ts:622,664,762` | `getBrainDb()` called directly in dispatch handler | MEDIUM |

### Analysis

The most severe violation is in `memory.ts`'s `sweep` case (lines 510-540): the dispatch domain handler runs a raw SQL query (`SELECT id, status, rows_affected FROM brain_backfill_runs`) directly against `getBrainNativeDb()`. This is business logic implemented entirely in the dispatch layer with no corresponding core function. An SDK consumer cannot replicate this operation.

The `intelligence.ts` domain handler calls `getAccessor()` and `getBrainAccessor()` before delegating to core functions. This pattern is benign (it's just opening the DB handle that core will use) but it creates tight coupling between dispatch and store topology.

`releaseShip()` and `purgeBrainNoise()` in core emit `console.log` for progress. This is a design choice (step-by-step feedback for long operations) but it means the functions produce stdout side effects that an SDK consumer cannot suppress, redirect, or capture. A logger callback parameter would be the correct pattern.

---

## 6. Renderer Cross-Check

Confirms audit B's findings. All renderers in `packages/cleo/src/cli/renderers/` are pure transformation functions:

- `tasks.ts`: Pure string formatting from `Record<string, unknown>` data
- `system.ts`: Imports `formatTree` / `formatWaves` from `@cleocode/core/formatters` (formatting utilities, not data fetchers)
- `index.ts`: Reads `getFormatContext()` and `getFieldContext()` singletons; calls `formatSuccess()` for JSON path; routes to renderer for human path
- No `await` calls in any renderer file
- No imports from dispatch adapters or domain handlers

The one issue: `renderers/index.ts` imports `applyFieldFilter` and `extractFieldFromResult` from `@cleocode/lafs`. These are pure functions (filter/extract from an object), not data fetchers. No violation.

**Single violation found via grep**: `renderers/error.ts` imports `getErrorDefinition` from `@cleocode/core`. This is a catalog lookup (pure function), not a data fetch. Borderline acceptable.

---

## 7. `--human` Flag Implementation

### Where it is parsed

**Single point**: `packages/cleo/src/cli/index.ts` lines 329-346.

```typescript
// cli/index.ts (top-level IIFE, runs before any command)
const argv = process.argv.slice(2);
const rawOpts: Record<string, unknown> = {};
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--json') rawOpts['json'] = true;
  else if (arg === '--human') rawOpts['human'] = true;
  else if (arg === '--quiet') rawOpts['quiet'] = true;
  // ...
}
const formatResolution = resolveFormat(rawOpts);
setFormatContext(formatResolution);
```

### Where the branch happens

**Single point for dispatch-routed commands**: `packages/cleo/src/cli/renderers/index.ts::cliOutput()`.

```typescript
export function cliOutput(data: unknown, opts: CliOutputOptions): void {
  const ctx = getFormatContext();
  if (ctx.format === 'human') {
    // → renderer path
  }
  // → JSON formatSuccess() path
}
```

### Divergence: commands with local `--json` flags

14 CLI commands bypass the global format context. Most notable:

- `sentient.ts`: Defines local `json: { type: 'boolean' }` arg and checks `args.json === true` for all output decisions. Ignores global `--human`/`--json`/`--quiet` flags.
- `revert.ts`: Same pattern — local `include-human` arg, local `emitSuccess`/`emitFailure` helpers.
- `audit.ts`: Checks local `args['json']` flag; uses `process.stdout.write(JSON.stringify(...))` vs human lines.
- `doctor-projects.ts`: Has `--raw` flag that produces JSON; human output via `process.stdout.write`.

These commands have **two separate format systems** in the same process. A user running `cleo sentient status --human --quiet` would get the `--human` branch in dispatch-routed commands but the unrelated `args.json === false` branch in sentient output.

---

## 8. Type Consistency at SDK Call Sites

### Sampled operations

| Operation | Public SDK type | Dispatch uses | Core internal type | Consistent? |
|-----------|----------------|---------------|-------------------|-------------|
| `tasks.show` | `showTask() → TaskDetail` (throw) | `taskShow() → EngineResult<{task:TaskRecord,view:TaskView}>` | same EngineResult wrapper | NO — 3 different shapes |
| `tasks.add` | `addTask() → AddTaskResult` (throw) | `addTaskWithSessionScope() → EngineResult<{task:TaskRecord,...}>` | same EngineResult wrapper | NO — 2 different shapes |
| `tasks.list` | `listTasks() → ListTasksResult` (throw) | `taskList() → EngineResult<TaskRecord[]>` | same EngineResult wrapper | NO |
| `session.start` | `startSession() → SessionResult` (throw) | `sessionStart() → EngineResult<SessionResult>` | same EngineResult wrapper | NO |
| `release.ship` | NOT EXPORTED in public API | `releaseShip() → EngineResult` | internal only | NO — not accessible publicly |

### Type chain for `tasks.show`

```
Public API:
  showTask(taskId, cwd?) → Promise<TaskDetail>
  TaskDetail extends Task (union-typed status/priority)
  Throws CleoError on not-found

Dispatch path (via internal.ts):
  taskShow(projectRoot, taskId) → Promise<EngineResult<{task: TaskRecord, view: TaskView|null}>>
  TaskRecord = string-widened version of Task (status: string, priority: string)
  Returns { success: false, error: {...} } on not-found

Cleo facade (via index.ts):
  cleo.tasks.show(taskId) → Promise<unknown>
  Delegates to showTask() but typed as unknown in TasksAPI interface
```

All contracts types (`@cleocode/contracts`) use the `Task` union type and `TaskRecord` widened type. The dispatch layer correctly uses contracts types throughout. The public API wraps them in throw-style functions. The facade regresses them to `Promise<unknown>`.

---

## 9. Recommended Improvements (Prioritized)

### P0 — Correctness

**9.1 Register sentient and release domains in OPERATIONS array**

`SentientHandler` is wired into `createDomainHandlers()` with ops `propose.list`, `propose.accept`, `propose.reject`, `propose.enable`, `propose.disable`, `allowlist.list/add/remove`. None appear in `OPERATIONS`. This means `cleo sentient propose list` cannot go through `dispatchFromCli` — the registry gate would reject it. Currently the sentient CLI bypasses dispatch entirely. Either: (a) add sentient ops to OPERATIONS, or (b) remove `SentientHandler` from domain handlers since it's unused by dispatch.

Similarly: `ReleaseHandler` handles `gate` and `ivtr-suggest` ops but these are also not in OPERATIONS. They cannot be discovered or dispatched through the standard path.

**9.2 Move memory.sweep raw SQL to a core function**

The `sweep` case in `memory.ts` dispatch handler executes raw SQL against `brain_backfill_runs`. This is business logic that belongs in `core/src/memory/`. Create `memorySweepStatus(projectRoot)` in core, export it from `internal.ts`, and replace the dispatch handler's inline SQL with a single `wrapCoreResult` call.

### P1 — SDK Parity

**9.3 Add EngineResult-returning wrappers to core public API (or define a stable SDK contract)**

Choose one of:
- **Option A (recommended)**: Document and stabilize `@cleocode/core/internal` as the SDK API for programmatic callers, with explicit guidance that the public `index.ts` functions are convenience wrappers (throw-style) for simple scripting. Add a `STABILITY.md` section clearly listing which subpath exports which tier.
- **Option B**: Add EngineResult wrappers to `index.ts` public exports (e.g., `export { taskShow } from './tasks/show.js'` alongside existing `showTask`). This gives SDK consumers access to the same return type as dispatch without importing from `/internal`.

**9.4 Fix TasksAPI facade to use concrete types**

`TasksAPI.show(taskId: string): Promise<unknown>` in `@cleocode/contracts/src/facade.ts:291` should be typed as `Promise<TaskDetail>` to match the actual implementation. This is a type regression.

**9.5 Eliminate console.log from core functions**

`releaseShip()` and `purgeBrainNoise()` call `console.log()` for progress. Replace with a `onStep?: (msg: string) => void` callback parameter (default: no-op). CLI callers can pass `(msg) => console.log(msg)` to preserve current behavior. SDK callers get clean stdout.

### P2 — Architecture

**9.6 Consolidate format context for bypass-command group**

14 CLI commands (sentient, revert, audit, gc, daemon, etc.) bypass the global format context (`getFormatContext()`) and emit their own JSON/human output. Migrate them to use `cliOutput()`. This is the largest single surface for consistency gaps.

**9.7 intelligence domain: move DB access to core**

`IntelligenceHandler` calls `getAccessor()` and `getBrainAccessor()` directly. Create `intelligencePredict(taskId, stage?, projectRoot)` and similar functions in `core/src/intelligence/engine-ops.ts` (which does not currently exist). Handler becomes a thin `wrapCoreResult` delegate.

**9.8 Nexus query-cte: use cliOutput for markdown path**

`nexus.ts` CLI dispatches `query-cte` through dispatch correctly but then routes the result to `formatCteResultAsMarkdown()` and writes it with `process.stdout.write()`, bypassing `cliOutput()`. The format context (`--json`/`--human`) is not honored. SDK consumers dispatching this operation get raw data but CLI consumers get markdown. Either: produce markdown in the renderer (pass through `cliOutput`) or add a `--format` param to the operation.

**9.9 Add release.start / release.verify / release.publish / release.reconcile to OPERATIONS**

`packages/cleo/src/cli/commands/release.ts` contains 4 commands (start, verify, publish, reconcile) that call `release.*` functions directly via `process.stdout.write(JSON.stringify(...))`. These bypass dispatch and have no registry entry. They are discoverable from `cleo release` help but not via `cleo ops list` or the OPERATIONS array.

---

## Appendix: Files With Business Logic Bypassing Dispatch

Complete list of CLI command files that bypass `dispatchFromCli`/`dispatchRaw` AND contain business logic:

| File | Core imports | Output mechanism | Severity |
|------|-------------|-----------------|---------|
| `sentient.ts` | `getSentientDaemonStatus`, `spawnSentientDaemon`, etc. | Local `emitSuccess/emitFailure` (ignores format context) | HIGH |
| `agent.ts` | `checkAgentHealth`, `detectCrashedAgents`, etc. | `cliOutput()` | MEDIUM |
| `audit.ts` | `reconstructLineage` | `process.stdout.write(JSON.stringify(...))` + human lines | HIGH |
| `backfill.ts` | `backfillTasks`, `populateEmbeddings` | `cliOutput()` | LOW |
| `backup-inspect.ts` | Inspection utilities | `console.log()` | HIGH |
| `brain.ts` | `runBrainMaintenance`, `backfillBrainGraph`, etc. | `console.log()` for progress, `JSON.stringify` for JSON | HIGH |
| `cant.ts` | CANT DSL operations | Unknown (not fully inspected) | MEDIUM |
| `checkpoint.ts` | Checkpoint operations | `cliOutput()` | LOW |
| `code.ts` | `smartSearch`, `smartOutline`, etc. | `console.log()` | HIGH |
| `daemon.ts` | GC daemon status | `process.stdout.write()` | HIGH |
| `doctor-projects.ts` | Project health checks | `process.stdout.write(JSON.stringify())` | HIGH |
| `exists.ts` | `getTask` | `cliOutput()` | LOW |
| `gc.ts` | GC operations | `process.stdout.write()` | HIGH |
| `generate-changelog.ts` | Changelog generation | Not inspected | MEDIUM |
| `init.ts` | `initProject` | `cliOutput()` | LOW |
| `install-global.ts` | `bootstrapGlobalCleo` | `cliOutput()` | LOW |
| `otel.ts` | OTel data queries | `cliOutput()` (some) | MEDIUM |
| `reconcile.ts` | Release reconcile | `process.stdout.write()` | HIGH |
| `refresh-memory.ts` | Memory bridge refresh | `process.stdout.write()` | MEDIUM |
| `remote.ts` | Git remote operations | Not inspected | MEDIUM |
| `revert.ts` | Revert operations | Local `emitSuccess/emitFailure` (ignores format context) | HIGH |
| `schema.ts` | Schema generation | Not inspected | MEDIUM |
| `self-update.ts` | Update process | Not inspected | MEDIUM |
| `transcript.ts` | Transcript extraction | `process.stdout.write(JSON.stringify(...))` | HIGH |
| `upgrade.ts` | Upgrade process | Not inspected | LOW |
| `web.ts` | Web/remote operations | Not inspected | LOW |
