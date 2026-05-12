# V2 SDK Consumer Validation Report

**Date**: 2026-04-26  
**Agent**: Validation Team V2  
**Scope**: `@cleocode/core` SDK consumer surface validation  
**Project root**: `/mnt/projects/cleocode`  
**Consumer dir**: `/tmp/sdk-consumer-test` (fresh pnpm project, `type: "module"`)  
**Installed via**: `pnpm add /mnt/projects/cleocode/packages/core /mnt/projects/cleocode/packages/contracts`  
**Node**: v24.13.1 | **pnpm**: 10.30.0 | **tsx**: globally available  

---

## Summary

**9 PASS | 0 FAIL | 2 WARN** — Core SDK subpaths work; root barrel and /internal are broken for ESM consumers.

| Test | Status | Detail |
|------|--------|--------|
| T1a: `startSession` from `@cleocode/core/sessions` | PASS | Returns session with string id |
| T1b: `endSession` from `@cleocode/core/sessions` | PASS | Returns session object |
| T2a: `cleo.sessions.start` (Cleo facade) | PASS | Returns session with id |
| T2b: `cleo.sessions.end` (Cleo facade) | PASS | Returns session object |
| T3a: `cleo.tasks.add` (Cleo facade, enforcement off) | PASS | Returns `{ task: { id } }` |
| T3b: `cleo.tasks.find` (Cleo facade) | PASS | Returns results array |
| T4a: `addTask` from `@cleocode/core/tasks` | PASS | Returns `{ task: { id } }` |
| T4b: `findTasks` from `@cleocode/core/tasks` | PASS | Returns `FindTasksResult.results[]` |
| T5: Contract types from `@cleocode/core/contracts` | PASS | `TasksAddParams`, `SessionStartParams` compile |
| T6: `@cleocode/core/internal` subpath | WARN | BUG-2 (see below) |
| T7: Root barrel `@cleocode/core` | WARN | BUG-2 (see below) |

---

## Bug Findings

### BUG-1: `Cleo.tasks.add()` silently drops `acceptance` param (MEDIUM severity)

**Location**: `packages/core/src/cleo.ts` (facade) + `packages/contracts/src/facade.ts` (TasksAPI)

The `TasksAPI.add()` contract interface does not include `acceptance`. The facade's `tasks.add` implementation also does not forward `acceptance` to `addTask()`. This means:

- In default strict mode (`enforcement.acceptance.mode = "block"`), `cleo.tasks.add()` will always fail with "Task requires at least 3 acceptance criteria" because acceptance can never be passed.
- The only workaround is setting `enforcement.acceptance.mode = "off"` in config.
- The README quickstart example `await cleo.tasks.add({ title, type, priority })` will fail in a freshly initialized project without custom config.

**Fix needed**: Add `acceptance?: string[]` to `TasksAPI.add()` params in `packages/contracts/src/facade.ts` and forward it in the facade's `add` implementation.

---

### BUG-2: `@cleocode/core/internal` and root barrel `@cleocode/core` fail in ESM consumers (CRITICAL)

**Error**: `Error: Dynamic require of "stream" is not supported`

**Root cause**: `node-fetch` (a CommonJS module using `require("stream")`) is bundled into the ESM output for both `dist/internal.js` and `dist/index.js`. Pure-ESM consumers (`"type": "module"` package.json) cannot use these entry points.

**Affected entry points**:
- `@cleocode/core` (root barrel — `dist/index.js`)
- `@cleocode/core/internal` (`dist/internal.js`)

**Working entry points** (do NOT have this issue):
- `@cleocode/core/sdk` — `Cleo` facade ✓
- `@cleocode/core/sessions` — session lifecycle ✓
- `@cleocode/core/tasks` — task CRUD ✓
- `@cleocode/core/memory` — brain operations ✓
- `@cleocode/core/lifecycle` — gate verification ✓
- `@cleocode/core/contracts` — types re-export ✓

**Impact**: The README quickstart shows `import { startSession } from '@cleocode/core/sessions'` (which works) but also references `import { Cleo } from '@cleocode/core/sdk'` (which works). The main `@cleocode/core` import shown in the index.d.ts example comments does NOT work.

**Fix needed**: Exclude `node-fetch` from bundling, or replace with native `fetch` (available in Node 18+). The `@cleocode/core/sdk` build avoids this by not including the full node_modules chain.

---

### BUG-3: `conduit/ops.js` exports empty `{}` but `conduit/index.js` re-exports `conduitCoreOps` from it (WIP)

**Error** (would appear after BUG-2 is fixed): `The requested module './ops.js' does not provide an export named 'conduitCoreOps'`

**Root cause**: `packages/core/src/conduit/ops.ts` contains only type declarations (`declare const conduitCoreOps`), so TypeScript compiles it to `export {}`. The `conduit/index.ts` re-exports `conduitCoreOps` from `./ops.js` but it's not a runtime value.

**Context**: This matches the last commit message `chore(T1451): WIP — recovered from crash`. The `conduitCoreOps` runtime implementation is not yet written. The `.d.ts` file exists but the `.js` has no implementation.

**Severity**: This only affects consumers of `conduit` namespace or the root barrel/internal. Core subpaths that don't transitively import conduit work fine.

---

### NOTE-1: Background `sleep-consolidation` SQL error on every `endSession`

**Error** (non-blocking, logged to stderr): `Error: no such column: e.observation_id`

**Location**: `src/memory/sleep-consolidation.ts` — SQL query joining `brain_embeddings e ON e.observation_id = o.id`

This runs asynchronously via `setImmediate` after every `endSession`. On a fresh brain.db (no embeddings column yet), the query fails. The error is caught and logged but does not propagate to the caller. Non-blocking for consumers.

---

### NOTE-2: Brain DB missing columns added at runtime via ALTER TABLE (non-blocking)

On fresh DB init, the following columns are added via `ALTER TABLE` at runtime:
- `brain_retrieval_log.retrieval_order`
- `brain_retrieval_log.delta_ms`
- `brain_observations.stability_score`
- `brain_patterns.provenance_class`
- `brain_learnings.provenance_class`
- `brain_observations.provenance_class`
- `brain_observations.times_derived`
- `brain_observations.level`
- `brain_observations.tree_id`

These emit `WARN` level structured log lines to stderr. Non-blocking. Indicates schema migrations are incomplete in the shipped dist.

---

### NOTE-3: README quickstart uses `tasksAddOp` which is in `/internal`, not exported from `/tasks`

The README shows:
```ts
import { tasksAddOp } from '@cleocode/core/tasks';
```
But `tasksAddOp` is **only exported from `@cleocode/core/internal`** (CLI-only per README). The `@cleocode/core/tasks` subpath exports `addTask` with a different signature:

| Import | Available | Signature |
|--------|-----------|-----------|
| `tasksAddOp` from `@cleocode/core/tasks` | ❌ NOT exported | `(projectRoot, params) => Promise<...>` |
| `addTask` from `@cleocode/core/tasks` | ✓ Works | `(options, cwd?, accessor?) => Promise<AddTaskResult>` |
| `tasksAddOp` from `@cleocode/core/internal` | ❌ BUG-2 blocks import | `(projectRoot, params) => Promise<...>` |

The README Quickstart section needs correction. Consumers should use `addTask` from `@cleocode/core/tasks` or the `Cleo` facade.

---

### NOTE-4: `tasks.add` requires active session (strict mode default)

In strict mode (`lifecycle.mode = "strict"`, the default), `addTask` throws "Operation 'tasks.add' requires an active session" if no session is active. The README quickstart does not show starting a session before adding tasks.

---

## Import Path Ergonomics Assessment

| Import Pattern | Works? | Notes |
|----------------|--------|-------|
| `import { startSession, endSession } from '@cleocode/core/sessions'` | ✓ | Recommended |
| `import { Cleo } from '@cleocode/core/sdk'` | ✓ | Recommended facade |
| `import { addTask, findTasks } from '@cleocode/core/tasks'` | ✓ | Note different signature from README |
| `import type { TasksAddParams } from '@cleocode/core/contracts'` | ✓ | Type-only, works |
| `import type { TasksAddParams } from '@cleocode/contracts'` | ✓ | Direct, also works |
| `import { startSession } from '@cleocode/core'` | ❌ | BUG-2: Dynamic require |
| `import { Cleo } from '@cleocode/core'` | ❌ | BUG-2: Dynamic require |
| `import { tasksAddOp } from '@cleocode/core/internal'` | ❌ | BUG-2: Dynamic require |

---

## Consumer Setup Notes

To use `@cleocode/core` in a fresh project without hitting validation errors:

1. Initialize `.cleo/config.json` with appropriate enforcement settings, or use default strict mode and provide all required fields (acceptance criteria, parent IDs, etc.)
2. Start a session before calling any mutation operations (`tasks.add`, etc.)
3. Use narrow subpaths (`/sessions`, `/sdk`, `/tasks`) — not the root barrel

---

## Test Script Location

`/tmp/sdk-consumer-test/test.ts` (ephemeral — deleted after test run)

The test script was run from `/tmp/sdk-consumer-test/` with:
```bash
pnpm add /mnt/projects/cleocode/packages/core /mnt/projects/cleocode/packages/contracts
tsx test.ts
```
