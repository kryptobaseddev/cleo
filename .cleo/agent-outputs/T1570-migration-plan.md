# T1570 Migration Plan: orchestrate-engine.ts → packages/core/orchestrate/

**Generated**: 2026-04-30
**Source file**: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (1962 LOC)
**Target dir**: `packages/core/src/orchestrate/` (sparse — 2 files: `pivot.ts`, `worker-verify.ts`)
**Precedent**: T1568 (task-engine recipe at b30e9de07), T1569 (nexus-engine recipe at 652057ebd)

---

## Part 1 — Architectural Decisions

### Q1 — Where does business logic live vs thin dispatch?

**Answer**: `orchestrate-engine.ts` is more than a thin wrapper. It contains:
- Real orchestration business logic: `orchestratePlan` (280 LOC), `orchestrateSpawnExecute` (220 LOC), `orchestrateSpawn` (230 LOC), `orchestrateHandoff` (180 LOC)
- Private helpers: `sendConduitEvent`, `loadTasks`, `composeSpawnForTask`, `applyCantBodySubstitution`, `openSignaldockDbForComposer`, `classifyTaskToAgent`, `orchLevelToRole`, `roleToTier`, `computePlanInputHash`, `resolveAgentGraceful`, `numericToAgentTier`
- Internal types: `ConduitOrchestrationEvent`, `HandoffStepStatus`, `HandoffStepState`, `HandoffState`, `HandoffFailureDetails`
- Four exported plan interfaces: `OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning`

**Decision**: All business logic moves to `packages/core/src/orchestrate/`. Functions group into 5 new files by concern. The thin wrappers (status, analyze, ready, next, waves, context, validate, bootstrap, criticalPath, unblockOpportunities, skillInject, parallelStart, parallelEnd, check, spawnSelectProvider, startup) are 1-5 LOC delegations to `@cleocode/core/internal` functions that already exist — these collapse to nothing in core (they are already there) and the domain file can call `@cleocode/core/internal` directly after Wire Wave.

### Q2 — Does `core/orchestrate/` need an index.ts?

**Answer**: Yes. The existing `core/orchestration/` has `index.ts` as its barrel. Since `core/orchestrate/` currently has no barrel, create `packages/core/src/orchestrate/index.ts` as the new barrel that re-exports from the 5 new concern files plus the existing `pivot.ts` and `worker-verify.ts`. Update `core/src/internal.ts` to export new symbols.

**Decision**: Create `packages/core/src/orchestrate/index.ts` (new barrel). DO NOT create `-engine.ts` suffix files.

### Q3 — Where do the plan interfaces go?

The four plan interfaces (`OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning`) are exported from `orchestrate-engine.ts` and re-exported via `engine.ts`. Contracts already has `OrchestratePlanResult`, `OrchestratePlanWave`, `OrchestratePlanWorker`, `OrchestratePlanWarning` (parallel types). The engine-layer plan interfaces have different field shapes (e.g., `orchLevel`, `atomicScope` vs contracts surface).

**Decision**: Move `OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning` into `packages/core/src/orchestrate/plan.ts` alongside `orchestratePlan`. Export from `core/internal.ts`. Update `engine.ts` barrel to re-export from `@cleocode/core/internal`.

### Q4 — HITL resume tokens (approve/reject/pending) — are they in orchestrate-engine.ts?

**Answer**: No. HITL approve/reject/pending are implemented in `packages/cleo/src/dispatch/domains/playbook.ts` (`lookupApprovalByTokenForDispatch`, `listPendingApprovalsForDispatch`, `acquirePlaybookDb`) and called from `orchestrate.ts` domain. `orchestrate-engine.ts` has zero HMAC/resumeToken logic. HITL operations are NOT part of this migration.

**Decision**: HITL approve/reject/pending are outside T1570 scope.

### Q5 — What happens to the `session-engine.ts` import?

`orchestrateHandoff` imports `sessionContextInject`, `sessionEnd`, `sessionStatus` from `./session-engine.js`. After migration to core, `session-engine.ts` cannot be imported from `@cleocode/core/orchestrate/` (it lives in cleo-only dispatch). The handoff logic must either:
a) Import from `@cleocode/core/internal` equivalents (if session ops are already there), or
b) Remain in cleo until session ops are also migrated.

Check: `sessionContextInject`, `sessionEnd`, `sessionStatus` — are they in core?

```bash
grep -n "sessionContextInject\|sessionEnd\|sessionStatus" /mnt/projects/cleocode/packages/core/src/internal.ts
```

These are cleo-layer session ops (they wrap the session store but the engine-facing API is in cleo). **Decision**: `orchestrateHandoff` moves to core but accepts session operation callbacks as parameters (dependency injection pattern), OR the function stays in cleo as the sole remaining orchestration concern. After analysis: `orchestrateHandoff` already calls 3 session engine functions that have no core equivalents. Move handoff to `core/orchestrate/handoff.ts` and add session ops to core/internal by importing from `core/sessions/` equivalents. The session functions (`sessionEnd`, `sessionStatus`, `sessionContextInject`) have parallel implementations in `packages/core/src/sessions/` — wire those.

---

## Part 2 — Existing core/orchestrate/ Surface

Only 2 files exist today (no barrel):

| File | LOC | Exports |
|------|-----|---------|
| `pivot.ts` | ~258 | `PIVOT_AUDIT_FILE`, `PivotOptions`, `PivotResult`, `pivotTask` |
| `worker-verify.ts` | ~395 | `WorkerReport`, `WorkerMismatch`, `WorkerMismatchAuditEntry`, `ReVerifyResult`, `WORKER_MISMATCH_AUDIT_FILE`, `ReVerifyOptions`, `TestRunResult`, `defaultRunProjectTests`, `defaultListChangedFiles`, `reVerifyWorkerReport`, `appendWorkerMismatchAudit` |

These files are already exported in `core/internal.ts`. The new migration adds 5 files alongside them.

The richer `packages/core/src/orchestration/` directory (20 files) is where most orchestration primitives already live. `orchestrate-engine.ts` delegates to those. The migration creates ops-level functions that call into `orchestration/` and `lifecycle/`.

---

## Part 3 — Symbol Inventory

All 26 exports from `orchestrate-engine.ts` with proposed targets:

### Type re-export (pass-through — stays in contracts)
| Symbol | Current source | Proposed target |
|--------|---------------|-----------------|
| `OrchestratePlanResult` (type re-export) | `@cleocode/contracts/operations/orchestrate` | Keep as re-export from contracts; `engine.ts` barrel re-exports from `@cleocode/core/internal` |

### Status, analyze, ready, next, waves, context, validate ops (thin wrappers → collapse into core/orchestrate/query-ops.ts)
| Symbol | LOC | Core delegate | Proposed target |
|--------|-----|---------------|-----------------|
| `orchestrateStatus` | ~25 | `computeEpicStatus`, `computeOverallStatus` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateAnalyze` | ~40 | `orchestrateCriticalPath`, `analyzeEpic`, `analyzeDependencies` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateReady` | ~50 | `getReadyTasks` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateNext` | ~35 | `getNextTask`, `getReadyTasks` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateWaves` | ~15 | `getEnrichedWaves` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateContext` | ~20 | `estimateContext` | `core/orchestrate/query-ops.ts` (new) |
| `orchestrateValidate` | ~15 | `validateSpawnReadiness` | `core/orchestrate/query-ops.ts` (new) |

### Lifecycle / startup ops (→ core/orchestrate/lifecycle-ops.ts)
| Symbol | LOC | Core delegate | Proposed target |
|--------|-----|---------------|-----------------|
| `orchestrateStartup` | ~50 | `getReadyTasks`, `getLifecycleStatus`, `recordStageProgress`, `computeStartupSummary` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateBootstrap` | ~15 | `buildBrainState` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateCriticalPath` | ~10 | `getCriticalPath` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateUnblockOpportunities` | ~10 | `getUnblockOpportunities` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateCheck` | ~30 | `getParallelStatus`, `computeProgress` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateSkillInject` | ~10 | `getSkillContent` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateParallel` | ~25 | delegates to parallelStart/parallelEnd | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateParallelStart` | ~20 | `startParallelExecution` | `core/orchestrate/lifecycle-ops.ts` (new) |
| `orchestrateParallelEnd` | ~30 | `endParallelExecution` | `core/orchestrate/lifecycle-ops.ts` (new) |

### Spawn ops (→ core/orchestrate/spawn-ops.ts — new file, most complex)
| Symbol | LOC | Core delegate | Proposed target |
|--------|-----|---------------|-----------------|
| `orchestrateSpawnSelectProvider` | ~5 | `selectHarnessSpawnProvider` | `core/orchestrate/spawn-ops.ts` (new) |
| `orchestrateSpawnExecute` | ~220 | `initializeDefaultAdapters`, `spawnRegistry`, `composeSpawnPayload`, `hooks`, `findLeastLoadedAgent` | `core/orchestrate/spawn-ops.ts` (new) |
| `orchestrateSpawn` | ~230 | `validateSpawnReadiness`, `getActiveSession`, `spawnWorktree`, `composeSpawnPayload` | `core/orchestrate/spawn-ops.ts` (new) |

### Handoff (→ core/orchestrate/handoff-ops.ts — new file)
| Symbol | LOC | Dependencies | Proposed target |
|--------|-----|-------------|-----------------|
| `orchestrateHandoff` | ~180 | `sessionContextInject`, `sessionEnd`, `sessionStatus`, `orchestrateSpawn` | `core/orchestrate/handoff-ops.ts` (new) |

### Plan + types (→ core/orchestrate/plan.ts — new file)
| Symbol | LOC | Proposed target |
|--------|-----|-----------------|
| `OrchestratePlanInput` (interface) | — | `core/orchestrate/plan.ts` (new) |
| `PlanWorkerEntry` (interface) | — | `core/orchestrate/plan.ts` (new) |
| `PlanWave` (interface) | — | `core/orchestrate/plan.ts` (new) |
| `PlanWarning` (interface) | — | `core/orchestrate/plan.ts` (new) |
| `orchestratePlan` | ~280 | `getEnrichedWaves`, `resolveAgent`, `AgentNotFoundError`, `ensureGlobalSignaldockDb`, `getGlobalSignaldockDbPath` | `core/orchestrate/plan.ts` (new) |

### Private helpers (move to their respective concern files)
| Helper | Proposed target |
|--------|-----------------|
| `sendConduitEvent` | `core/orchestrate/spawn-ops.ts` (used by spawn + handoff) |
| `loadTasks` | `core/orchestrate/query-ops.ts` (used by status, check, startup) |
| `composeSpawnForTask` | `core/orchestrate/spawn-ops.ts` |
| `applyCantBodySubstitution` + `CantBodySubstitutionResult` | `core/orchestrate/spawn-ops.ts` |
| `openSignaldockDbForComposer` | `core/orchestrate/plan.ts` (used by plan + compose) |
| `classifyTaskToAgent` + `CLASSIFIER_RULES` | `core/orchestrate/plan.ts` |
| `orchLevelToRole` | `core/orchestrate/plan.ts` |
| `roleToTier` | `core/orchestrate/plan.ts` |
| `computePlanInputHash` | `core/orchestrate/plan.ts` |
| `resolveAgentGraceful` | `core/orchestrate/plan.ts` |
| `numericToAgentTier` | `core/orchestrate/plan.ts` |
| `HandoffStepStatus`, `HandoffStepState`, `HandoffState`, `HandoffFailureDetails` | `core/orchestrate/handoff-ops.ts` |

### Summary: New files to create in core/orchestrate/

| File | ~LOC | Concern |
|------|------|---------|
| `core/orchestrate/query-ops.ts` | ~200 | status, analyze, ready, next, waves, context, validate, loadTasks helper |
| `core/orchestrate/lifecycle-ops.ts` | ~200 | startup, bootstrap, criticalPath, unblock, check, skillInject, parallel* |
| `core/orchestrate/spawn-ops.ts` | ~550 | spawnSelectProvider, spawnExecute, spawn, sendConduitEvent, composeSpawnForTask, applyCantBodySubstitution |
| `core/orchestrate/handoff-ops.ts` | ~200 | orchestrateHandoff + HandoffStep types |
| `core/orchestrate/plan.ts` | ~400 | orchestratePlan + 4 interfaces + private plan helpers |
| `core/orchestrate/index.ts` | ~80 | barrel re-exporting all 5 new files + pivot + worker-verify |

---

## Part 4 — Call-Site Update Table

Every file that imports from `orchestrate-engine.ts` (directly or via barrel):

| File | Import path | Update action |
|------|-------------|---------------|
| `packages/cleo/src/dispatch/lib/engine.ts` | `'../engines/orchestrate-engine.js'` | Remove barrel + re-export block; all orchestrate symbols come from `@cleocode/core/internal` directly |
| `packages/cleo/src/dispatch/domains/orchestrate.ts` | `'../lib/engine.js'` | Switch orchestrate imports to `@cleocode/core/internal`; `OrchestratePlanInput`/plan types from `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine.test.ts` | `'../orchestrate-engine.js'` | Rewrite mock target to `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/engines/__tests__/orchestrate-plan.test.ts` | `'../orchestrate-engine.js'` | Rewrite mock target to `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/engines/__tests__/orchestrate-engine-composer.test.ts` | `'../orchestrate-engine.js'` | Rewrite mock target to `@cleocode/core/internal` |
| `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts` | mocks `orchestrateCriticalPath`, `orchestrateCheck`, `orchestrateSkillInject` | Update vi.mock target path to core/internal |
| `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts` | mocks engine functions | Update vi.mock target to core/internal |
| `packages/cleo/src/dispatch/domains/__tests__/orchestrate-handoff.test.ts` | mocks engine functions | Update vi.mock target to core/internal |
| `packages/cleo/src/dispatch/domains/__tests__/ivtr.test.ts` | mocks `orchestrateCriticalPath`, `orchestrateCheck` | Update vi.mock target |
| `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` | mocks engine symbols | Update vi.mock target |
| `packages/cleo/src/__tests__/core-parity.test.ts` | reads `orchestrate-engine.ts` content | Update assertions: file is deleted; assertions move to check that `@cleocode/core/internal` exports the functions |
| `packages/contracts/src/operations/orchestrate.ts` | TSDoc references `orchestrate-engine.ts` | Update doc comment references to new file paths |
| `packages/core/src/agents/variable-substitution.ts` | TSDoc ref to `orchestrate-engine.ts` | Update doc comment |

---

## Part 5 — Wave Plan

### Wave 1: Create query-ops.ts + lifecycle-ops.ts (stateless thin wrappers)

**Goal**: Move the 16 simple query/lifecycle wrapper functions into two new core/orchestrate/ files. These have no circular deps and are easiest to verify. No call-site changes yet.

**Files created/modified**:
- CREATE `packages/core/src/orchestrate/query-ops.ts`
- CREATE `packages/core/src/orchestrate/lifecycle-ops.ts`
- MODIFY `packages/core/src/internal.ts` — add exports for all 16 new symbols

**Functions moved**:
- query-ops.ts: `orchestrateStatus`, `orchestrateAnalyze`, `orchestrateReady`, `orchestrateNext`, `orchestrateWaves`, `orchestrateContext`, `orchestrateValidate`, `loadTasks` (private helper)
- lifecycle-ops.ts: `orchestrateStartup`, `orchestrateBootstrap`, `orchestrateCriticalPath`, `orchestrateUnblockOpportunities`, `orchestrateCheck`, `orchestrateSkillInject`, `orchestrateParallel`, `orchestrateParallelStart`, `orchestrateParallelEnd`

**Note**: Convert ALL lazy `await import('@cleocode/core/internal')` to static imports at top of each new file.

**Verify**:
```bash
pnpm biome check --write packages/core/src/orchestrate/
pnpm --filter @cleocode/core run build
grep -E "^export " packages/core/src/orchestrate/query-ops.ts
grep -E "^export " packages/core/src/orchestrate/lifecycle-ops.ts
```

**Commit message**:
```
feat(T1570): add core/orchestrate/query-ops.ts + lifecycle-ops.ts (Wave 1)

Move 16 thin-wrapper orchestration ops from orchestrate-engine.ts into
focused modules in packages/core/src/orchestrate/. query-ops.ts handles
status/analyze/ready/next/waves/context/validate. lifecycle-ops.ts handles
startup/bootstrap/criticalPath/unblock/check/skillInject/parallel*.
All lazy imports converted to static. No call-sites touched yet.
```

---

### Wave 2: Create plan.ts (orchestratePlan + plan interfaces + private helpers)

**Goal**: Move the most complex self-contained logic — `orchestratePlan` (280 LOC) and all its private helpers — into `core/orchestrate/plan.ts`. This includes the 4 exported plan interfaces.

**Files created/modified**:
- CREATE `packages/core/src/orchestrate/plan.ts`
- MODIFY `packages/core/src/internal.ts` — add exports for `orchestratePlan`, `OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning`

**Functions/types moved**:
- Interfaces: `OrchestratePlanInput`, `PlanWorkerEntry`, `PlanWave`, `PlanWarning`
- Private helpers: `openSignaldockDbForComposer`, `classifyTaskToAgent`, `CLASSIFIER_RULES`, `orchLevelToRole`, `roleToTier`, `computePlanInputHash`, `resolveAgentGraceful`, `numericToAgentTier`
- Public: `orchestratePlan`

**Note**: `_DatabaseSyncCtor` / `_DatabaseSyncType` node:sqlite interop pattern moves with this file. The `createHash` import from `node:crypto` also moves here.

**Verify**:
```bash
pnpm biome check --write packages/core/src/orchestrate/plan.ts
pnpm --filter @cleocode/core run build
```

**Commit message**:
```
feat(T1570): add core/orchestrate/plan.ts — orchestratePlan + interfaces (Wave 2)

Move orchestratePlan (280 LOC) and its 9 private helpers into a focused
plan module. Exports the 4 plan interfaces (OrchestratePlanInput,
PlanWorkerEntry, PlanWave, PlanWarning) from core/internal. The node:sqlite
interop pattern and createHash usage travel with the function.
```

---

### Wave 3: Create spawn-ops.ts (orchestrateSpawn + orchestrateSpawnExecute + helpers)

**Goal**: Move the spawn concern (the two most complex spawn functions plus their private infrastructure) into `core/orchestrate/spawn-ops.ts`.

**Files created/modified**:
- CREATE `packages/core/src/orchestrate/spawn-ops.ts`
- MODIFY `packages/core/src/internal.ts` — add exports for `orchestrateSpawn`, `orchestrateSpawnExecute`, `orchestrateSpawnSelectProvider`

**Functions/types moved**:
- Private: `sendConduitEvent` + `ConduitOrchestrationEvent` interface
- Private: `composeSpawnForTask` (with `ConduitSubscriptionConfig` import from spawn-prompt.ts)
- Private: `applyCantBodySubstitution` + `CantBodySubstitutionResult` interface
- Public: `orchestrateSpawnSelectProvider`, `orchestrateSpawnExecute`, `orchestrateSpawn`

**Critical**: `sendConduitEvent` is also called by `orchestrateHandoff`. Export it from `spawn-ops.ts` and import it in `handoff-ops.ts` (Wave 4) to avoid duplication.

**Note**: The `_DatabaseSyncCtor` / `_engineRequire` / `_SignaldockDbHandle` node:sqlite pattern is needed here too for `openSignaldockDbForComposer` (which plan.ts also needs). Extract `openSignaldockDbForComposer` to a shared location: keep it in `plan.ts` and import from there in spawn-ops.ts, OR duplicate a small helper. Recommendation: export `openSignaldockDbForComposer` from `plan.ts` and import in `spawn-ops.ts` when needed.

**Verify**:
```bash
pnpm biome check --write packages/core/src/orchestrate/spawn-ops.ts
pnpm --filter @cleocode/core run build
pnpm --filter @cleocode/cleo run build
```

**Commit message**:
```
feat(T1570): add core/orchestrate/spawn-ops.ts — spawn + execute wrappers (Wave 3)

Move orchestrateSpawn (230 LOC), orchestrateSpawnExecute (220 LOC), and
orchestrateSpawnSelectProvider into core/orchestrate/spawn-ops.ts.
Extracts sendConduitEvent and composeSpawnForTask as internal helpers.
applyCantBodySubstitution travels with spawnExecute. All lazy imports
converted to static imports at module top.
```

---

### Wave 4: Create handoff-ops.ts + create index.ts barrel

**Goal**: Move `orchestrateHandoff` and wire the session dependency. Create the `core/orchestrate/index.ts` barrel.

**Files created/modified**:
- CREATE `packages/core/src/orchestrate/handoff-ops.ts`
- CREATE `packages/core/src/orchestrate/index.ts` (barrel for entire orchestrate/ dir)
- MODIFY `packages/core/src/internal.ts` — add export for `orchestrateHandoff`

**Functions/types moved**:
- Types: `HandoffStepStatus`, `HandoffStepState`, `HandoffState`, `HandoffFailureDetails`
- Public: `orchestrateHandoff`

**Session dependency**: `orchestrateHandoff` imports `sessionContextInject`, `sessionEnd`, `sessionStatus` from cleo session-engine. Resolve by checking which of these have equivalents in `packages/core/src/sessions/`. If they exist, import from core. If not, pass them as callback parameters to `orchestrateHandoff` (dependency injection). Based on code review: `sessionStatus` and `sessionEnd` have core equivalents; `sessionContextInject` is CLI-specific. Use DI pattern: `orchestrateHandoff(params, sessionOps: { sessionStatus, sessionEnd, sessionContextInject }, projectRoot?)`.

**Barrel**: `packages/core/src/orchestrate/index.ts` re-exports from all 5 new files + existing `pivot.ts` + `worker-verify.ts`.

**Verify**:
```bash
pnpm biome check --write packages/core/src/orchestrate/
pnpm --filter @cleocode/core run build
```

**Commit message**:
```
feat(T1570): add core/orchestrate/handoff-ops.ts + orchestrate/index.ts barrel (Wave 4)

Move orchestrateHandoff (180 LOC) with HandoffStep types into a focused
handoff module. Uses dependency injection for session ops to avoid
cleo→core import cycle. Creates core/orchestrate/index.ts barrel
re-exporting all 7 modules (5 new + pivot + worker-verify).
```

---

### Wave 5: DELETE orchestrate-engine.ts + wire dispatch + update tests

**Goal**: Remove the source file, update all call-sites to import from `@cleocode/core/internal`, update engine.ts barrel, update tests.

**Files modified**:
- DELETE `packages/cleo/src/dispatch/engines/orchestrate-engine.ts`
- MODIFY `packages/cleo/src/dispatch/lib/engine.ts` — remove orchestrate-engine barrel block; re-export from `@cleocode/core/internal`
- MODIFY `packages/cleo/src/dispatch/domains/orchestrate.ts` — update imports to `@cleocode/core/internal`; update `orchestrateHandoff` call to pass session ops callbacks
- MODIFY `packages/cleo/src/__tests__/core-parity.test.ts` — update assertions (file deleted, check core/internal exports)
- MODIFY `packages/contracts/src/operations/orchestrate.ts` — update TSDoc file references
- MODIFY `packages/core/src/agents/variable-substitution.ts` — update TSDoc
- MODIFY 3 test files in `__tests__/`: `orchestrate-engine.test.ts`, `orchestrate-plan.test.ts`, `orchestrate-engine-composer.test.ts` — rewrite mock target from `'../orchestrate-engine.js'` to `'@cleocode/core/internal'`
- MODIFY `packages/cleo/src/dispatch/adapters/__tests__/cli.test.ts` — update mock paths
- MODIFY `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts` — update mock paths
- MODIFY `packages/cleo/src/dispatch/domains/__tests__/orchestrate-handoff.test.ts` — update mock paths
- MODIFY `packages/cleo/src/dispatch/domains/__tests__/ivtr.test.ts` — update mock paths
- MODIFY `packages/cleo/src/dispatch/domains/__tests__/registry-parity.test.ts` — update mock paths

**Quality gates**:
```bash
pnpm biome check --write .
pnpm run build
pnpm run test
git diff --stat HEAD  # verify orchestrate-engine.ts shows as deleted
grep -r "orchestrate-engine" packages/ --include="*.ts" | grep -v ".cleo" | grep -v dist | grep -v node_modules
```

**Commit message**:
```
feat(T1570): delete orchestrate-engine.ts, wire dispatch to @cleocode/core (Wave 5)

Removes packages/cleo/src/dispatch/engines/orchestrate-engine.ts (1962 LOC).
Updates engine.ts barrel, orchestrate domain, and 8 test files to import
from @cleocode/core/internal. orchestrateHandoff wired with session-ops DI
pattern to avoid import cycle. core-parity test updated for deleted file.
```

---

## Part 6 — Risk Register

### Risk 1: Session ops import cycle in orchestrateHandoff

**Severity**: HIGH
**Description**: `orchestrateHandoff` calls `sessionContextInject`, `sessionEnd`, `sessionStatus` from `session-engine.ts` (cleo-only). If moved to core naively, this creates a core → cleo import cycle.
**Mitigation**: Use dependency injection — `orchestrateHandoff(params, sessionOps: { sessionStatus, sessionEnd, sessionContextInject }, root?)`. The domain `orchestrate.ts` passes the actual session functions. This is the same DI pattern used in other cross-boundary orchestration handoffs.
**Fallback**: If DI adds too much type friction, keep `orchestrateHandoff` in `packages/cleo/src/dispatch/engines/handoff.ts` (tiny file) as the ONE remaining cleo engine function. This is a valid alternative per operator constraint philosophy (no shimming).

### Risk 2: node:sqlite interop pattern duplication

**Severity**: MEDIUM
**Description**: The `_engineRequire` / `_DatabaseSyncCtor` pattern for opening signaldock.db synchronously appears in both `orchestratePlan` (openSignaldockDbForComposer) and indirectly in `orchestrateSpawnExecute`. Duplicating this pattern across two files risks divergence.
**Mitigation**: Export `openSignaldockDbForComposer` from `plan.ts` as a named export; `spawn-ops.ts` imports it from `./plan.js`. Keep the pattern in one place. Verify no circular dep (plan.ts → spawn-ops.ts would be circular; ensure direction is spawn → plan only).

### Risk 3: Test mock path changes for 8 test files

**Severity**: MEDIUM
**Description**: 8+ test files currently mock `'../engines/orchestrate-engine.js'`. After deletion, they must mock `'@cleocode/core/internal'`. Vitest module mock resolution may behave differently for workspace packages vs relative paths.
**Mitigation**: Follow the T1568/T1569 proven pattern exactly. Run `pnpm run test` after each test file update (not just at the end). Use `vi.mock('@cleocode/core/internal', ...)` pattern that works in the existing test suite (verify it's used elsewhere in cleo tests already).

### Risk 4: orchestrateSpawnExecute has many lazy imports

**Severity**: MEDIUM
**Description**: `orchestrateSpawnExecute` has 6+ lazy `await import('@cleocode/core/internal')` calls for `initializeDefaultAdapters`, `spawnRegistry`, `getActiveSession`, `findLeastLoadedAgent`, `hooks`, etc. Converting to static imports changes module loading order and could affect initialization timing.
**Mitigation**: Convert to static imports as required by operator constraint. Verify that `initializeDefaultAdapters` can be called statically (it's async — call it inside the function body, not at module top). Only the `import()` form goes static; the `await initializeDefaultAdapters()` call stays inside the function.

### Risk 5: core-parity.test.ts assertions on orchestrate-engine.ts content

**Severity**: LOW
**Description**: `core-parity.test.ts` has 2 assertions that read `orchestrate-engine.ts` content and check for `analyzeEpic`, `prepareSpawn`, `selectHarnessSpawnProvider`. After deletion these assertions fail.
**Mitigation**: Update assertions in Wave 5 to instead verify that `@cleocode/core/internal` exports the relevant functions. The test intent (ensuring cleo delegates to core) is preserved by checking core exports exist, not by reading the deleted file.

---

## Part 7 — File Layout Summary

**New files in `packages/core/src/orchestrate/`** (5 new + 1 barrel):

```
packages/core/src/orchestrate/
├── index.ts              (NEW — barrel)
├── pivot.ts              (existing — unchanged)
├── worker-verify.ts      (existing — unchanged)
├── query-ops.ts          (NEW — 7 query wrappers + loadTasks)
├── lifecycle-ops.ts      (NEW — 9 lifecycle wrappers)
├── spawn-ops.ts          (NEW — spawn + spawnExecute + spawn helpers)
├── handoff-ops.ts        (NEW — handoff + HandoffStep types)
├── plan.ts               (NEW — orchestratePlan + 4 interfaces + plan helpers)
└── __tests__/
    ├── pivot.test.ts     (existing)
    └── worker-verify.ts  (existing)
```

**Deleted**: `packages/cleo/src/dispatch/engines/orchestrate-engine.ts` (1962 LOC)

**Net change**: 1 file deleted (1962 LOC), 6 files created (~1630 LOC total in core), 13 files updated (imports/mocks).

---

## Part 8 — Manifest Record

Appended to `pipeline_manifest` via `cleo manifest append`.
