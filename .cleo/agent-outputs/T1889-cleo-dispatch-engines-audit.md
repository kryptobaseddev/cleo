# T1889 — Cleo Dispatch Engines Audit & Relocation Plan

**Date**: 2026-05-05
**Task**: T1889
**Author**: cleo-prime (orchestrator read-only audit)
**Status**: Plan complete — no files moved, no source edited

---

## 1. Engine Source Inventory

All files under `packages/cleo/src/dispatch/engines/*.ts` (excluding `__tests__/`).

### Excluded from relocation scope (correct home: `packages/cleo/`)

| File | LOC | Classification | Rationale |
|------|-----|----------------|-----------|
| `_error.ts` | 404 | **CLI plumbing** | Imports `mapNumericExitCodeToString` from `../lib/exit-codes.js` (a cleo-internal lib). Contains `STRING_TO_EXIT` map that mirrors `ERROR_CODE_TO_EXIT` in `cli.ts`. The `cleoErrorToEngineError` export exists only here and is tested by `cleo-error-propagation.test.ts`. This is cleo-dispatch infrastructure — stays. |
| `template-parser.ts` | 146 | **Adapter shim with local logic** | Imports core and adapts `TemplateResult → EngineResult` using a local `adaptResult()` wrapper function. Logic is thin (no domain knowledge) but the adapter itself is cleo-specific. Stays in cleo. |

### Engine shim files (all re-export-only → candidates for cleanup)

| File | LOC | Classification | Re-exports from | Evidence (first ~10 lines) |
|------|-----|----------------|-----------------|---------------------------|
| `code-engine.ts` | 14 | **shim** | `@cleocode/core/internal` | `export { codeOutline, codeParse, codeSearch, codeUnfold } from '@cleocode/core/internal';` |
| `config-engine.ts` | 19 | **shim** | `@cleocode/core/internal` | Multi-name export from `@cleocode/core/internal`; migrated ENG-MIG-15/T1582 |
| `diagnostics-engine.ts` | 21 | **shim** | `@cleocode/core/internal` | Re-exports `EngineResult` type + diagnostics ops; migrated ENG-MIG-13/T1580 |
| `hooks-engine.ts` | 13 | **shim** | `@cleocode/core/internal` | `export type { HookMatrixResult … }; export { queryCommonHooks … }` |
| `init-engine.ts` | 19 | **shim** | `@cleocode/core/internal` | Exports `ensureInitialized` + companions; migrated ENG-MIG-14/T1581 |
| `lifecycle-engine.ts` | 28 | **shim** | `@cleocode/core/internal` | Re-exports `EngineResult` + lifecycle ops; migrated ENG-MIG-9/T1576 |
| `memory-engine.ts` | 41 | **shim** | `@cleocode/core/internal` | Pure re-export of ~35 `memory*` symbols from `@cleocode/core/internal` (see §1a) |
| `pipeline-engine.ts` | 24 | **shim** | `@cleocode/core/internal` | Re-exports pipeline ops; migrated ENG-MIG-11/T1578 |
| `release-engine.ts` | 29 | **shim** | `@cleocode/core/internal` | Re-exports `releaseCancel`, `releaseChangelog`, etc.; migrated ENG-MIG-5/T1572 |
| `session-engine.ts` | 45 | **shim** | `@cleocode/core/internal` | Re-exports all session ops; migrated ENG-MIG-6/T1573 |
| `sticky-engine.ts` | 26 | **shim** | `@cleocode/core/internal` | Re-exports sticky ops; migrated ENG-MIG-10/T1577 |
| `tools-engine.ts` | 45 | **shim** | `@cleocode/core/internal` | Re-exports tools ops; migrated ENG-MIG-8/T1575 |
| `validate-engine.ts` | 45 | **shim** | `@cleocode/core/internal` | Re-exports 14+ validate ops; migrated ENG-MIG-7/T1574 |

**Total shim files: 13** (all confirmed pure re-exports from `@cleocode/core/internal`).

### §1a — memory-engine.ts: Suspected outlier — RESOLVED

`memory-engine.ts` (41 lines) carries a misleading comment (`"Dispatch layer adapter"` + `"engine-compat.ts"` reference) in its JSDoc but the body is **100% re-export only**. No wrapper logic. No `import type`. No function body. The 41 lines are the doc block + export list. Classification: **shim**. No residual logic.

---

## 2. Test File Inventory

All 20 files under `packages/cleo/src/dispatch/engines/__tests__/`.

| # | File | LOC | Imports from shim | Canonical core path |
|---|------|-----|-------------------|---------------------|
| 1 | `cleo-error-propagation.test.ts` | 220 | `../_error.js` → `cleoErrorToEngineError` | `packages/cleo/src/dispatch/engines/_error.ts` (**stays in cleo** — tested symbol lives in cleo) |
| 2 | `code-engine.test.ts` | 255 | `../code-engine.js` → `codeOutline, codeParse, codeSearch, codeUnfold` | `packages/core/src/code/engine-ops.ts` |
| 3 | `gate-verify-hint.test.ts` | 155 | `../validate-engine.js` → `validateGateVerify`; also `@cleocode/core/internal` direct | `packages/core/src/validation/engine-ops.ts` |
| 4 | `hooks-engine.test.ts` | 67 | `../hooks-engine.js` → `queryCommonHooks, queryHookProviders` | `packages/core/src/hooks/engine-ops.ts` |
| 5 | `lifecycle-engine.test.ts` | 297 | `../lifecycle-engine.js` → `lifecyclePrerequisites, lifecycleProgress, lifecycleReset, lifecycleSkip, lifecycleStatus` | `packages/core/src/lifecycle/engine-ops.ts` |
| 6 | `lifecycle-scope-guard.test.ts` | 422 | `../../../../../core/src/lifecycle/engine-ops.js` (bypasses shim — imports core directly) | `packages/core/src/lifecycle/engine-ops.ts` |
| 7 | `loom-integration.test.ts` | 238 | None (pure mock — only `@cleocode/contracts` types, no engine imports) | `packages/core/src/tasks/__tests__/` (LOOM domain) — or possibly **delete** (see §2a) |
| 8 | `orchestrate-engine-composer.test.ts` | 199 | `@cleocode/core/internal` direct → `orchestrateSpawn` | `packages/core/src/orchestrate/__tests__/` |
| 9 | `orchestrate-engine.test.ts` | 497 | `@cleocode/core/internal` → orchestrate ops; `../session-engine.js` → `sessionContextInject, sessionEnd, sessionStart, sessionStatus` | `packages/core/src/orchestrate/__tests__/` |
| 10 | `orchestrate-plan.test.ts` | 262 | `@cleocode/core/internal` → `orchestratePlan, orchestrateReady` | `packages/core/src/orchestrate/__tests__/` |
| 11 | `release-engine.test.ts` | 228 | `../release-engine.js` → `releaseList, releasePrepare, releaseRollback, releaseShow, releaseTag` | `packages/core/src/release/__tests__/` |
| 12 | `release-push-guard.test.ts` | 135 | `../release-engine.js` → `releasePrepare, releasePush` | `packages/core/src/release/__tests__/` |
| 13 | `release-ship.test.ts` | 170 | `../release-engine.js` → `releaseShip` | `packages/core/src/release/__tests__/` |
| 14 | `session-engine-scope.test.ts` | 171 | `../session-engine.js` → `sessionStart` | `packages/core/src/sessions/__tests__/` |
| 15 | `session-handoff-fix.test.ts` | 165 | `../session-engine.js` → `sessionHandoff`; also mocks `core/src/sessions/handoff.js` | `packages/core/src/sessions/__tests__/` |
| 16 | `session-safety.test.ts` | 607 | `../session-engine.js` → `sessionFind, sessionList` | `packages/core/src/sessions/__tests__/` |
| 17 | `task-complete-lifecycle-gate.test.ts` | 325 | `../../../../../core/src/tasks/complete.js` → `completeTaskStrict` (bypasses shim entirely) | `packages/core/src/tasks/__tests__/` |
| 18 | `task-engine.test.ts` | 329 | `../../../../../core/src/tasks/complete.js` + `core/src/config.js` etc. (bypasses shim) | `packages/core/src/tasks/__tests__/` |
| 19 | `task-show-history.test.ts` | 247 | `../../../../../core/src/tasks/show.js` → `taskShowWithHistory` (bypasses shim) | `packages/core/src/tasks/__tests__/` |
| 20 | `validate-engine.test.ts` | 50 | `../validate-engine.js` → all 13 protocol validators | `packages/core/src/validation/__tests__/` |

**Total: 20 test files, 5,039 lines.**

### §2a — loom-integration.test.ts: Special case

This test file has **zero engine imports**. It uses only `@cleocode/contracts` types (`Task`) and defines all mock state inline using a `MockLoomState` interface. It does not test any engine, shim, or core function. It is self-contained mock-only scaffolding. Classification: **orphan test** — tests invented mock logic, not a real production symbol.

**Recommendation**: Move to `packages/core/src/tasks/__tests__/loom-integration.test.ts` (LOOM domain lives there at `backfill-epic-loom.ts`), but flag the worker to evaluate whether the test has value or should be deleted. The test is harmless but adds noise.

### §2b — cleo-error-propagation.test.ts: Stays in cleo

`cleoErrorToEngineError` is defined in `packages/cleo/src/dispatch/engines/_error.ts` and is not exported from any core package. The test correctly lives beside its tested symbol. **Do NOT move** this test.

### §2c — Vitest leak smell (process.cwd() without cwd param)

`code-engine.test.ts` (line 22) uses `const projectRoot = process.cwd();` to derive a project root. The comment in that file even notes this is intentional dogfooding (it tests against the live codebase). After relocation this test will still reference `process.cwd()` — since `packages/core` is also in the monorepo, the resolved path will be different depending on how vitest is invoked. Worker MUST replace `process.cwd()` with an explicit absolute path derived from `import.meta.url` or a stable fixture path. The T9031 `openNativeDatabase` guard will catch any DB writes, but the cwd-relative file resolution is a separate latent issue.

**Tests with latent vitest leak — guard will catch post-relocation if not fixed:**
- `code-engine.test.ts` — uses `process.cwd()` as `projectRoot` for file lookups

---

## 3. Relocation Map

### Files that stay in `packages/cleo/`

| File | Reason |
|------|--------|
| `cleo-error-propagation.test.ts` | Tests `cleoErrorToEngineError` from `_error.ts` — a cleo-only symbol |

### Files to move → `packages/core/`

| Source | Target |
|--------|--------|
| `__tests__/release-engine.test.ts` | `packages/core/src/release/__tests__/release-engine.test.ts` |
| `__tests__/release-push-guard.test.ts` | `packages/core/src/release/__tests__/release-push-guard.test.ts` |
| `__tests__/release-ship.test.ts` | `packages/core/src/release/__tests__/release-ship.test.ts` |
| `__tests__/orchestrate-engine.test.ts` | `packages/core/src/orchestrate/__tests__/orchestrate-engine.test.ts` |
| `__tests__/orchestrate-engine-composer.test.ts` | `packages/core/src/orchestrate/__tests__/orchestrate-engine-composer.test.ts` |
| `__tests__/orchestrate-plan.test.ts` | `packages/core/src/orchestrate/__tests__/orchestrate-plan.test.ts` |
| `__tests__/lifecycle-engine.test.ts` | `packages/core/src/lifecycle/__tests__/lifecycle-engine.test.ts` |
| `__tests__/lifecycle-scope-guard.test.ts` | `packages/core/src/lifecycle/__tests__/lifecycle-scope-guard.test.ts` |
| `__tests__/session-engine-scope.test.ts` | `packages/core/src/sessions/__tests__/session-engine-scope.test.ts` |
| `__tests__/session-handoff-fix.test.ts` | `packages/core/src/sessions/__tests__/session-handoff-fix.test.ts` |
| `__tests__/session-safety.test.ts` | `packages/core/src/sessions/__tests__/session-safety.test.ts` |
| `__tests__/task-engine.test.ts` | `packages/core/src/tasks/__tests__/task-engine.test.ts` |
| `__tests__/task-complete-lifecycle-gate.test.ts` | `packages/core/src/tasks/__tests__/task-complete-lifecycle-gate.test.ts` |
| `__tests__/task-show-history.test.ts` | `packages/core/src/tasks/__tests__/task-show-history.test.ts` |
| `__tests__/loom-integration.test.ts` | `packages/core/src/tasks/__tests__/loom-integration.test.ts` (flag for deletion review) |
| `__tests__/hooks-engine.test.ts` | `packages/core/src/hooks/__tests__/hooks-engine.test.ts` |
| `__tests__/code-engine.test.ts` | `packages/core/src/code/__tests__/code-engine.test.ts` (**fix cwd leak**) |
| `__tests__/gate-verify-hint.test.ts` | `packages/core/src/validation/__tests__/gate-verify-hint.test.ts` |
| `__tests__/validate-engine.test.ts` | `packages/core/src/validation/__tests__/validate-engine.test.ts` |

**Total to move: 19 test files** (1 stays, `cleo-error-propagation.test.ts`).

---

## 4. Import-Rewrite Contract

### Rewrite rule: shim path → core path

For every test that imports via `../some-engine.js`, the rewrite is:

```
from '../<name>-engine.js'  →  from '@cleocode/core/internal'
```

The shims are 1:1 re-exports of `@cleocode/core/internal`. All symbols are available from `@cleocode/core/internal` directly. No other rewrite variants are needed.

For tests that already bypass the shim (import from `../../../../../core/src/...`), the path depth changes. The `../../../../` prefix should become a local import relative to the new location, or preferably an `@cleocode/core/internal` package import.

### Wave-by-wave before/after examples

**Wave 1 (Release):**
```typescript
// BEFORE (packages/cleo/src/dispatch/engines/__tests__/release-engine.test.ts)
import {
  releaseList,
  releasePrepare,
  releaseRollback,
  releaseShow,
  releaseTag,
} from '../release-engine.js';

// AFTER (packages/core/src/release/__tests__/release-engine.test.ts)
import {
  releaseList,
  releasePrepare,
  releaseRollback,
  releaseShow,
  releaseTag,
} from '@cleocode/core/internal';
```

Also: relative paths like `'../../../../../core/src/store/__tests__/test-db-helper.js'` become
`'../../store/__tests__/test-db-helper.js'` (from `core/src/release/__tests__/`).

**Wave 2 (Orchestrate):**
```typescript
// BEFORE (orchestrate-engine.test.ts)
import {
  sessionContextInject,
  sessionEnd,
  sessionStart,
  sessionStatus,
} from '../session-engine.js';

// AFTER (packages/core/src/orchestrate/__tests__/orchestrate-engine.test.ts)
import {
  sessionContextInject,
  sessionEnd,
  sessionStart,
  sessionStatus,
} from '@cleocode/core/internal';
```

**Wave 3 (Lifecycle):**
```typescript
// BEFORE (lifecycle-engine.test.ts)
import {
  lifecyclePrerequisites,
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
  lifecycleStatus,
} from '../lifecycle-engine.js';

// AFTER (packages/core/src/lifecycle/__tests__/lifecycle-engine.test.ts)
import {
  lifecyclePrerequisites,
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
  lifecycleStatus,
} from '@cleocode/core/internal';
```

`lifecycle-scope-guard.test.ts` already bypasses the shim:
```typescript
// BEFORE
import { ... } from '../../../../../core/src/lifecycle/engine-ops.js';

// AFTER (packages/core/src/lifecycle/__tests__/lifecycle-scope-guard.test.ts)
import { ... } from '../engine-ops.js';
```

**Wave 4 (Session + Task):**
```typescript
// BEFORE (session-safety.test.ts)
import { sessionFind, sessionList } from '../session-engine.js';

// AFTER (packages/core/src/sessions/__tests__/session-safety.test.ts)
import { sessionFind, sessionList } from '@cleocode/core/internal';
```

```typescript
// BEFORE (task-complete-lifecycle-gate.test.ts)
import { completeTaskStrict } from '../../../../../core/src/tasks/complete.js';

// AFTER (packages/core/src/tasks/__tests__/task-complete-lifecycle-gate.test.ts)
import { completeTaskStrict } from '../complete.js';
```

**Wave 5 (Hooks + Code + Validate):**
```typescript
// BEFORE (hooks-engine.test.ts)
import { queryCommonHooks, queryHookProviders } from '../hooks-engine.js';

// AFTER (packages/core/src/hooks/__tests__/hooks-engine.test.ts)
import { queryCommonHooks, queryHookProviders } from '@cleocode/core/internal';
```

```typescript
// BEFORE (code-engine.test.ts)
import { codeOutline, codeParse, codeSearch, codeUnfold } from '../code-engine.js';
const projectRoot = process.cwd();  // ← MUST FIX

// AFTER (packages/core/src/code/__tests__/code-engine.test.ts)
import { codeOutline, codeParse, codeSearch, codeUnfold } from '@cleocode/core/internal';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../../../../../../');  // monorepo root
```

**Wave 6 (Aux / Loom):**
```typescript
// BEFORE (validate-engine.test.ts)
import {
  validateGateVerify,
  validateProtocolConsensus,
  // ...
} from '../validate-engine.js';

// AFTER (packages/core/src/validation/__tests__/validate-engine.test.ts)
import {
  validateGateVerify,
  validateProtocolConsensus,
  // ...
} from '@cleocode/core/internal';
```

`loom-integration.test.ts` has no engine imports — move as-is, no import rewrites needed.

---

## 5. Source-Side Cleanup Decision

### Current state of shim usage

After test relocation, remaining non-test importers of the shims are:

| Shim | Non-test importers |
|------|--------------------|
| `session-engine.ts` | `packages/cleo/src/dispatch/domains/session.ts` (comment-only reference — domain uses `@cleocode/core/internal` directly), `packages/cleo/src/dispatch/lib/engine.ts` (not found — session not in engine.ts) |
| `validate-engine.ts` | `packages/cleo/src/dispatch/lib/engine.ts` (re-exports to dispatch surface), `packages/cleo/src/dispatch/domains/check.ts` |
| `memory-engine.ts` | `packages/cleo/src/dispatch/lib/engine.ts` (re-exports to dispatch surface) |
| `template-parser.ts` | `packages/cleo/src/dispatch/lib/engine.ts` (re-exports to dispatch surface) |
| All others | No non-test, non-dist importers found |

### Recommendation: Option (b) — Add `@deprecated` JSDoc + scheduled removal

**Rationale:**

- `validate-engine.ts`, `memory-engine.ts`, and `template-parser.ts` have live non-test production importers (via `dispatch/lib/engine.ts`). These cannot be deleted without updating the dispatch surface.
- The remaining 10 pure shims (`code-engine.ts`, `config-engine.ts`, `diagnostics-engine.ts`, `hooks-engine.ts`, `init-engine.ts`, `lifecycle-engine.ts`, `pipeline-engine.ts`, `release-engine.ts`, `sticky-engine.ts`, `tools-engine.ts`) have no non-test, non-dist importers. They can be targeted for deletion after test relocation confirms nothing breaks.
- Rather than deleting immediately (which risks unfound importers in built artifacts), mark all 13 shims with `@deprecated` + a removal target version in a single cleanup task after the test relocation waves complete.

**Deprecation template:**
```typescript
/**
 * @deprecated Shim kept for backward compatibility (ENG-MIG-X / T15XX).
 * Use `@cleocode/core/internal` directly.
 * Scheduled for removal: v2026.7.0
 */
```

A follow-on task should be filed as a child of T1889: "Remove engine shims marked @deprecated after T1889 test relocation complete."

---

## 6. Wave Plan

Parent epic: **T1889**. CLEO atomicity gate caps each worker at ≤3 files. Each wave = one atomic child task.

| Wave | Child task title | Files in scope | Source paths (relative to `packages/cleo/src/dispatch/engines/__tests__/`) | Target paths (relative to `packages/core/src/`) |
|------|-----------------|----------------|----------------------------------------------------------------------------|--------------------------------------------------|
| W1 | T1889-W1: Move release engine tests to core/release/__tests__ | 3 | `release-engine.test.ts`, `release-push-guard.test.ts`, `release-ship.test.ts` | `release/__tests__/release-engine.test.ts`, `release/__tests__/release-push-guard.test.ts`, `release/__tests__/release-ship.test.ts` |
| W2 | T1889-W2: Move orchestrate engine tests to core/orchestrate/__tests__ | 3 | `orchestrate-engine.test.ts`, `orchestrate-engine-composer.test.ts`, `orchestrate-plan.test.ts` | `orchestrate/__tests__/orchestrate-engine.test.ts`, `orchestrate/__tests__/orchestrate-engine-composer.test.ts`, `orchestrate/__tests__/orchestrate-plan.test.ts` |
| W3 | T1889-W3: Move lifecycle engine tests to core/lifecycle/__tests__ | 2 | `lifecycle-engine.test.ts`, `lifecycle-scope-guard.test.ts` | `lifecycle/__tests__/lifecycle-engine.test.ts`, `lifecycle/__tests__/lifecycle-scope-guard.test.ts` |
| W4 | T1889-W4: Move session engine tests to core/sessions/__tests__ | 3 | `session-engine-scope.test.ts`, `session-handoff-fix.test.ts`, `session-safety.test.ts` | `sessions/__tests__/session-engine-scope.test.ts`, `sessions/__tests__/session-handoff-fix.test.ts`, `sessions/__tests__/session-safety.test.ts` |
| W5 | T1889-W5: Move task engine tests to core/tasks/__tests__ | 3 | `task-engine.test.ts`, `task-complete-lifecycle-gate.test.ts`, `task-show-history.test.ts` | `tasks/__tests__/task-engine.test.ts`, `tasks/__tests__/task-complete-lifecycle-gate.test.ts`, `tasks/__tests__/task-show-history.test.ts` |
| W6 | T1889-W6: Move hooks/code/validate engine tests to core + fix code-engine cwd leak | 3 | `hooks-engine.test.ts`, `code-engine.test.ts`, `gate-verify-hint.test.ts` | `hooks/__tests__/hooks-engine.test.ts`, `code/__tests__/code-engine.test.ts`, `validation/__tests__/gate-verify-hint.test.ts` |
| W7 | T1889-W7: Move validate shim test + loom orphan test; evaluate loom deletion | 2 | `validate-engine.test.ts`, `loom-integration.test.ts` | `validation/__tests__/validate-engine.test.ts`, `tasks/__tests__/loom-integration.test.ts` |
| W8 | T1889-W8: Add @deprecated JSDoc to all 13 engine shims; file removal epic | 13 shim files | (source-side only — no test moves) | N/A |

### Acceptance criteria template (per wave W1–W7)

```
- [ ] Each file in scope is DELETED from packages/cleo/src/dispatch/engines/__tests__/
- [ ] Each file is CREATED at its target path under packages/core/src/
- [ ] All import paths updated per §4 contract (shim → @cleocode/core/internal; relative depth-5 paths → package-relative)
- [ ] code-engine.test.ts (W6): process.cwd() replaced with import.meta.url-derived root
- [ ] pnpm run test (from monorepo root) exits 0 with zero new failures
- [ ] pnpm biome check --write . (from monorepo root) exits 0
- [ ] git diff --stat confirms: only expected deletions in packages/cleo/... and additions in packages/core/...
- [ ] cleo verify T1889-Wx --gate implemented --evidence "commit:<sha>;files:<list>"
- [ ] cleo verify T1889-Wx --gate testsPassed --evidence "tool:test"
- [ ] cleo verify T1889-Wx --gate qaPassed --evidence "tool:lint;tool:typecheck"
```

### Acceptance criteria for W8 (shim deprecation)

```
- [ ] All 13 shim files have @deprecated JSDoc added (no functional change)
- [ ] Each @deprecated comment names the ENG-MIG task, the canonical import, and a removal target version
- [ ] A child task is filed under T1889 titled "Remove @deprecated engine shims post-T1889 relocation"
- [ ] pnpm run build exits 0
- [ ] pnpm biome check --write . exits 0
```

---

## Appendix: File LOC Summary

| Domain | Test files | Total LOC |
|--------|-----------|-----------|
| Release | 3 | 533 |
| Orchestrate | 3 | 958 |
| Lifecycle | 2 | 719 |
| Session | 3 | 943 |
| Task | 3 | 901 |
| Hooks / Code / Validate-hint | 3 | 477 |
| Validate-shim / Loom | 2 | 288 |
| **Stays in cleo** | 1 | 220 |
| **Total** | **20** | **5,039** |
