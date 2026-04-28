# Audit Report — Teammate 1: Tasks-Lifecycle Domains

**Auditor**: T1521 (CLEO task ID)
**Scope**: dispatch/domains/tasks.ts, dispatch/domains/ivtr.ts, dispatch/domains/check.ts + core namespaces: tasks, task-work, lifecycle, validation, check (no separate check dir — lives inside validation)
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | Overall Verdict | Critical Findings |
|------|------|----------------|-------------------|
| dispatch/tasks.ts | dispatch | YELLOW | 0 P0, 2 P1, 1 P2 |
| dispatch/ivtr.ts | dispatch | YELLOW | 0 P0, 1 P1, 0 P2 |
| dispatch/check.ts | dispatch | YELLOW | 0 P0, 2 P1, 1 P2 |
| core/tasks | core | GREEN | 0 P0, 0 P1, 0 P2 |
| core/task-work | core | GREEN | 0 P0, 0 P1, 1 P2 |
| core/lifecycle | core | GREEN | 0 P0, 0 P1, 0 P2 |
| core/validation | core | YELLOW | 0 P0, 1 P1, 1 P2 |

**Totals**: 0 P0, 6 P1, 4 P2

---

## Per-Area Findings

### dispatch/tasks.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/tasks.ts`
**Lines of code**: 700
**Test files**: 2 — `__tests__/tasks.test.ts`, `__tests__/tasks-opsfromcore.test.ts` (plus `tasks-filters.test.ts`)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | `type TasksOps = OpsFromCore<typeof coreTasks.tasksCoreOps>` at line 86. No per-op Params/Result imports from contracts. Comment at lines 79-83 documents the T1445 migration. Clean. |
| 2. Handler thinness | YELLOW | 20 of 29 handlers exceed 5 LOC. `restore` (29), `update` (28), `list` (27), `add` (26), `complete` (24) are the heaviest. However all excess lines are parameter-forwarding object literals with no business logic — this is thin-wrapper behavior, not fat dispatch. T1492 scoped out tasks.ts (focused on memory/sticky/orchestrate/release). No Core logic leaking into dispatch. |
| 3. Inline type leakage | GREEN | Zero `as any`, `as unknown as`, or `: any`. The `envelopeToEngineResult` adapter function uses explicit inline structural types (lines 487–508) but these are local bridge types with documented purpose, not leaked contracts. |
| 4. Per-op contract imports | GREEN | Zero imports from `@cleocode/contracts/operations/<file>`. Only imports: `@cleocode/core` (namespace reference for OpsFromCore), dispatch-layer internal types. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. Three SSoT-EXEMPT annotations at lines 333, 369, 415 — all have live task references (T994, T5615/T5671, T5149) or ADR references. No stale markers. |
| 6. Test coverage | GREEN | 3 test files pass. `tasks-opsfromcore.test.ts` (3 tests, all pass) verifies OpsFromCore conformance. `tasks.test.ts` broader behavioral tests (all pass). |
| 7. Public surface | N-A | Dispatch domain, not core namespace. |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/core`, `../adapters/typed.js`, `../lib/engine.js`, `../types.js`, `./_base.js`. No cross-domain imports from unexpected namespaces. |
| 9. Dead code / SSoT-EXEMPT | GREEN | Three SSoT-EXEMPT annotations — all with live task IDs or explained rationale. No `@deprecated`, no stale `TODO(T...)`. |
| 10. Documentation | YELLOW | File has TSDoc header at lines 1-21 referencing T4820/T4818/T1425/T1445. TasksHandler class has TSDoc. No README in dispatch domains (expected — not a core namespace). No explicit ADR-058/ADR-059 references in header. |

**P1 findings**:
- `tasks.ts:L264–288` — `add` handler body is 26 LOC. While not containing business logic (pure param forwarding), the body could be compressed with a single spread or helper. Low risk but worth tracking.
- `tasks.ts:L370–395` — `restore` handler (29 LOC) branches to three different engine functions based on `params.from` value. This branching is light business logic at the dispatch layer; arguably should live in Core. Flag for consideration under T-THIN-WRAPPER follow-up.

**P2 findings**:
- `tasks.ts` header references T4820/T4818/T1425/T1445 but does not reference ADR-058 or ADR-059. Minor documentation gap.

---

### dispatch/ivtr.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/ivtr.ts`
**Lines of code**: 536
**Test files**: 1 — `__tests__/ivtr.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | Does NOT use `OpsFromCore<typeof coreOps>`. No `TasksOps`-equivalent type. Params are extracted via raw `params?.['key'] as Type` casts throughout. Not on the T1445/ADR-058 OpsFromCore migration path. |
| 2. Handler thinness | RED | All 5 cases exceed 5 LOC heavily: `loop-back` (133 LOC), `status` (115 LOC), `next` (88 LOC), `release` (70 LOC), `start` (42 LOC). The `next` case contains significant business logic (autoRunTests branching, typedGates extraction, prompt resolution). The `release` case constructs a full `autoSuggest` block inline. The `loop-back` case contains retry-cap error handling, evidence extraction, phase validation, and prompt resolution. |
| 3. Inline type leakage | GREEN | Zero `as any` or `as unknown as`. Uses explicit typed locals. |
| 4. Per-op contract imports | YELLOW | Imports `IvtrPhase` and `IvtrPhaseEntry` from `@cleocode/core/internal` (line 23). These are structural types that could be inferred via OpsFromCore if IVTR had a coreOps registry. Not a violation per se since IVTR lacks a coreOps pattern, but it is an inconsistency with ADR-058. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. Task/epic references in header (T810/T811) are presumably still live. |
| 6. Test coverage | GREEN | `ivtr.test.ts` present and all 63 tests pass (confirmed in combined test run). |
| 7. Public surface | N-A | Dispatch domain. |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/core/internal` (IVTR ops) and `../lib/engine.js`. No cross-domain imports. |
| 9. Dead code / SSoT-EXEMPT | GREEN | No SSoT-EXEMPT, no deprecated annotations. |
| 10. Documentation | YELLOW | TSDoc on class and public methods. Header references T810/T811. No ADR-058/ADR-059 refs. |

**P1 findings**:
- `ivtr.ts:L245–328` — `next` case (88 LOC) contains autoRunTests branching, gate extraction, and prompt resolution directly in the dispatch layer. This logic belongs in a Core-layer ivtr-advance function. Flag as P1 for T-THIN-WRAPPER follow-up.
- `ivtr.ts` — No `OpsFromCore` inference applied. IVTR is the only domain in scope lacking the ADR-058 OpsFromCore migration. This is a structural inconsistency.

---

### dispatch/check.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/check.ts`
**Lines of code**: 984
**Test files**: 2 — `__tests__/check.test.ts`, `__tests__/check-ops.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | YELLOW | Uses `CheckOps` imported from `@cleocode/contracts` (line 19). This is NOT the `OpsFromCore<typeof coreCoreOps>` pattern — it imports the type directly from contracts instead of inferring from Core's ops registry. This is a partial migration state: the typed-handler pattern (T1423) is present but the type source is contracts-direct, not OpsFromCore. |
| 2. Handler thinness | YELLOW | The `protocol` op handler (lines 220–463) is ~243 LOC with a large switch over `protocolType` values, delegating to 12 different protocol validators. The `verify.explain` op (lines 486–701) is ~215 LOC with inline evidence normalization, atom rendering, and blocker-list construction logic that arguably belongs in Core. Most other ops are 3–15 LOC. |
| 3. Inline type leakage | YELLOW | Lines 502–516: inline interface with typed fields built from raw gateway data (`d.verification`, `d.requiredGates`, etc.) — this is a local structural type used within `verify.explain` only. Lines 539–565: inline `normaliseGateEvidence` function with an inline return type. Lines 567–577: inline `EvidenceEntry` interface. These are technically in-handler type definitions. Count: 3 instances, all contained within `verify.explain`. |
| 4. Per-op contract imports | YELLOW | Lines 18–41: imports 18 named `*Params` types from `@cleocode/contracts` plus `EvidenceAtom` and `GateEvidence`. Per ADR-058 the dispatch layer should infer from `OpsFromCore`, not import per-op params types. However `CheckOps` itself (line 19) replaces what would be `OpsFromCore<typeof checkCoreOps>`. This is a migration-in-progress state (T1423 used typed-handler but not OpsFromCore source). |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. Header references T1423/T975/T4820. |
| 6. Test coverage | GREEN | `check-ops.test.ts` (10 tests, all pass) + `check.test.ts` (pass). All 63 tests across both files pass. |
| 7. Public surface | N-A | Dispatch domain. |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/contracts`, `@cleocode/core/internal`, `../adapters/typed.js`, `../lib/engine.js`, `./_base.js`, `./_meta.js`, and local `./check/canon.js`. No unexpected cross-domain coupling. |
| 9. Dead code / SSoT-EXEMPT | GREEN | No SSoT-EXEMPT or deprecated annotations. |
| 10. Documentation | YELLOW | TSDoc on class. Header references T1423/T975. `test.coverage` op is implemented (line 806) and declared in `CheckOps` but is **missing from `getSupportedOperations()` query list** (line 963). The query list shows `'test'` but not `'test.coverage'`. |

**P1 findings**:
- `check.ts:L961–983` — `getSupportedOperations()` query list is missing `'test.coverage'`. The op is implemented in the typed handler (line 806, T1434) and declared in `CheckOps`, but `getSupportedOperations()` returns only `'test'`. This means introspection and any registry-parity check will not surface `test.coverage` as a declared operation. Bug — callers relying on `getSupportedOperations()` will be unaware of this op.
- `check.ts:L486–701` — `verify.explain` op contains 215 LOC of evidence normalization, atom rendering, blocker construction, and human-readable explanation generation directly in the dispatch handler. This is business logic that should live in Core.

**P2 findings**:
- `check.ts:L18–41` — 18 per-op `*Params` imports from `@cleocode/contracts`. Migrate to `OpsFromCore<typeof checkCoreOps>` pattern per ADR-058. Currently using `CheckOps` from contracts as a workaround.
- `check.ts:L502–577` — inline type definitions (`d: {...}`, `normaliseGateEvidence`, `EvidenceEntry`) inside `verify.explain` handler. These should be extracted to Core or contracts.

---

### core/tasks — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/tasks/`
**Lines of code**: ~40 files, totaling several thousand LOC (add.ts alone is >1200 LOC)
**Test files**: 42 test files in `__tests__/`, all 656 tests pass

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 3. Inline type leakage | GREEN | Zero `as any`, `as unknown as`. One `Promise<unknown>` return type at `task-ops.ts:1865` — this is a structural necessity for a polymorphic internal function (not a leak per se). |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK found in non-test source files. Comment at `complete.ts:23` mentions `T719` — confirmed live. |
| 6. Test coverage | GREEN | 42 test files covering all major ops. All 656 tests pass. Includes T1404 epic-closure-enforcement tests (16 tests, all pass). |
| 7. Public surface | GREEN | `index.ts` exports a well-organized public API with explicit named exports. TSDoc present on exported functions (`/** ... */`). |
| 8. Cross-domain coupling | GREEN | `tasks/infer-add-params.ts` imports `currentTask` from `../task-work/index.js` (expected — infer-add needs session context). No unexpected imports from lifecycle or validation in task core files. |
| 9. Dead code / SSoT-EXEMPT | GREEN | No stale SSoT-EXEMPT or deprecated annotations found. |
| 10. Documentation | YELLOW | No standalone README in `packages/core/src/tasks/`. ADR refs present in source comments (ADR-051 in complete.ts, ADR-057 in add.ts). Architecture docs at `docs/architecture/TYPE-CONTRACTS.md` reference task types but no dedicated tasks-namespace architecture doc exists. |

**Specific verification — T1404 (parent-closure-without-atom)**:
- `complete.ts:L266–287`: Epic closure enforcement block present and correct. Checks `enforcement.verificationEnabled && enforcement.lifecycleMode === 'strict' && task.type === 'epic'`. Calls `verifyEpicHasEvidence()` and throws `CleoError(ExitCode.LIFECYCLE_GATE_FAILED)` on failure. Tests in `epic-closure-enforcement.test.ts` (16 tests, all pass). **CONFIRMED WIRED CORRECTLY.**

---

### core/task-work — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/task-work/`
**Lines of code**: 260 (single file: `index.ts`)
**Test files**: 1 — `__tests__/start-deps.test.ts` (6 tests, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 3. Inline type leakage | GREEN | Zero `as any` or `as unknown as`. Uses contracts-imported `TaskWorkState`. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK. Comment at `index.ts:22` mentions `cleo start TXXX` (not a task reference). |
| 6. Test coverage | YELLOW | Only 1 test file with 6 tests covering dependency-blocking behavior. No tests for `currentTask()`, `stopTask()`, or `getWorkHistory()` functions. Start and stop hooks are fire-and-forget and trigger an `EnvironmentTeardownError` warning in the test environment (benign — hooks are best-effort). |
| 7. Public surface | GREEN | Single `index.ts` exports 5 functions and 3 interfaces with TSDoc. `getTaskHistory` alias for `getWorkHistory` is documented. |
| 8. Cross-domain coupling | YELLOW | `index.ts` imports `logOperation` from `../tasks/add.js`, `getUnresolvedDeps` from `../tasks/dependency-check.js`, and `isValidPipelineStage` from `../tasks/pipeline-stage.js`. These are expected cross-namespace imports within core (task-work is a thin complement to tasks). The `startTask` function also triggers lazy `import('../hooks/registry.js')` for best-effort hook dispatch — acceptable. |
| 9. Dead code / SSoT-EXEMPT | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No standalone README. TSDoc present on all exported symbols. |

**P2 findings**:
- `task-work/__tests__/` — only `startTask` dependency-blocking is tested. `currentTask`, `stopTask`, and `getWorkHistory` have zero test coverage. Low-risk but a gap.

---

### core/lifecycle — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/lifecycle/`
**Lines of code**: `index.ts` alone is 1186 LOC; plus ~15 supporting files
**Test files**: 14 test files in `__tests__/`, 220 tests, all pass

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 3. Inline type leakage | GREEN | No `as any` or `as unknown as` found in `index.ts` or other non-test lifecycle files. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK in non-test lifecycle source files. |
| 6. Test coverage | GREEN | 14 test files, 220 tests, all pass. Includes RCASD pipeline, stage transitions, gate operations, consolidation, frontmatter, tessera-engine, and rollup tests. |
| 7. Public surface | GREEN | `index.ts` provides a well-structured barrel export with canonical re-exports from `stages.js`. Types, enums, and functions have TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports from contracts, core lib utilities, store, and sibling lifecycle files. No unexpected imports from tasks or validation. |
| 9. Dead code / SSoT-EXEMPT | GREEN | No stale annotations. T4798 RCASD rename comments are informational. |
| 10. Documentation | YELLOW | No standalone README for the lifecycle namespace. Architecture doc at `docs/architecture/orchestration-flow.md` covers high-level pipeline but not the SQLite-native lifecycle implementation. ADR-053 referenced in comments. |

**Specific verification — T1497 (gateName defensive guards)**:
- `index.ts:L1066–1067`: `passGate` — `if (!gateName) { throw new CleoError(ExitCode.INVALID_INPUT, 'gateName is required for passGate'); }` — **PRESENT.**
- `index.ts:L1123–1124`: `failGate` — `if (!gateName) { throw new CleoError(ExitCode.INVALID_INPUT, 'gateName is required for failGate'); }` — **PRESENT.**
- Both defensive guards are wired correctly per T1497.

---

### core/validation — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/validation/`
**Lines of code**: ~7838 total (validate-ops.ts: 1231 LOC, verification.ts: 459 LOC, operation-gate-validators.ts: prominent)
**Test files**: 11 test files in `__tests__/`, 235 tests, all pass

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 3. Inline type leakage | GREEN | Zero `as any` or `as unknown as` found in non-test validation source files. |
| 5. Behavior markers | GREEN | `architecture-decision.md:96,109,138` contains `ADR-XXX` placeholder text. This is a markdown template file in `protocols/protocols-markdown/` — expected template placeholder, not a stale code comment. `validation/operation-gate-validators.ts:337` — `"global" or "epic:TXXX"` is a fix string in an error message (TXXX is literal example text, not a task ref). |
| 6. Test coverage | GREEN | 11 test files, 235 tests, all pass. Covers engine, schema-integrity, compliance, verification, manifest, doctor, and chain-validation. |
| 7. Public surface | YELLOW | `index.ts` provides extensive exports. `param-utils.ts` exports a `@deprecated buildMcpInputSchema` (line 126–127) which is a backward-compat alias for `buildDispatchInputSchema`. The deprecated alias is still re-exported from `packages/core/src/internal.ts:998`. No callers in source (only dist files), suggesting it's safe for removal. |
| 8. Cross-domain coupling | GREEN | Imports from contracts, core lib, and store. No unexpected cross-domain imports. |
| 9. Dead code / SSoT-EXEMPT | YELLOW | `param-utils.ts:L126–127`: `@deprecated buildMcpInputSchema` alias is live in internal exports. No task ID attached to removal. This is a mild dead-code risk. |
| 10. Documentation | YELLOW | No standalone README. Protocol markdown files in `protocols/protocols-markdown/` provide guidance for validation protocols. No ADR direct references in `index.ts` header. |

**P1 findings**:
- `validation/param-utils.ts:L126–127` — `@deprecated buildMcpInputSchema` is still exported in `internal.ts:998` with no removal task attached. Should be removed or tracked with a cleanup task.

**P2 findings**:
- `validation/index.ts` — no TSDoc header comment explaining the namespace purpose. Minor doc gap given this is one of the largest core namespaces.

---

## Overall Recommendations

1. **check.ts — missing `test.coverage` in getSupportedOperations (P1 bug)**: The `test.coverage` op (T1434) is implemented in the typed handler but absent from the `getSupportedOperations()` query list. File a follow-up task to add it. This is a behavioral regression risk for registry introspection callers.

2. **ivtr.ts — OpsFromCore migration not applied (P1 structural gap)**: IVTR is the only dispatch domain in scope without `OpsFromCore` inference. The `next` case (88 LOC) and `loop-back` case (133 LOC) contain Core-layer logic inline. Consider filing a T-THIN-WRAPPER subtask for IVTR.

3. **check.ts `verify.explain` business logic (P1)**: 215 LOC of evidence normalization and explanation generation in a dispatch handler. This belongs in a `explainVerification()` Core function. File as P1 cleanup.

4. **tasks.ts `restore` branching (P1 low-priority)**: The `restore` op has 3-way conditional routing (done/archived/default) at the dispatch layer. This routing belongs in Core. Low urgency but should be tracked.

5. **deprecated `buildMcpInputSchema` removal (P1)**: The deprecated alias remains in exports with no removal task. Safe to remove — no production callers found.

6. **task-work test coverage gap (P2)**: `currentTask`, `stopTask`, `getWorkHistory` have no tests. File a P2 test task.

7. **No README files in any audited core namespace (P2)**: tasks, task-work, lifecycle, validation all lack namespace-level README documentation. Low urgency given TSDoc coverage.

### Follow-up tasks to file (parent T1520):

1. **"Fix: add `test.coverage` to CheckHandler.getSupportedOperations() query list"** — parent T1520, size small, acceptance: `test.coverage` appears in query array; registry-parity test passes.
2. **"IVTR dispatch: apply OpsFromCore migration + extract next/loop-back Core helpers"** — parent T1520, size large, acceptance: `IvtrOps = OpsFromCore<typeof ivtrCoreOps>`; handler cases ≤5 LOC.
3. **"Extract verify.explain logic to Core checkExplainVerification()"** — parent T1520, size medium, acceptance: check.ts `verify.explain` handler body ≤5 LOC; Core function has unit tests.
4. **"Remove deprecated `buildMcpInputSchema` alias"** — parent T1520, size small, acceptance: not exported from internal.ts; biome passes.
5. **"Add tests for currentTask/stopTask/getWorkHistory in task-work namespace"** — parent T1520, size small, acceptance: ≥3 tests per function; all pass.

---

## Cross-References

- **ADR-051**: Referenced in `tasks.ts` (complete --force removal) and `check.ts` (ADR-051 §11.1 lock).
- **ADR-057**: Referenced in `tasks.ts` (role canonical wire field D2) and indirectly in `check-ops.test.ts` header.
- **ADR-058**: NOT referenced in any dispatch domain file headers. Tasks.ts uses OpsFromCore (compliant) but does not cite ADR-058. ivtr.ts does not use OpsFromCore (non-compliant). check.ts uses contracts-imported CheckOps (partial compliance).
- **ADR-059**: No references found in audited scope.
- **T1404**: Confirmed wired — `packages/core/src/tasks/complete.ts:L266–287`. 16 tests pass.
- **T1492**: Scoped to memory/sticky/orchestrate/release — tasks.ts fat handlers are intentionally out of scope for T1492.
- **T1497**: Confirmed wired — `packages/core/src/lifecycle/index.ts:L1066–1067` (passGate), `L1123–1124` (failGate).

## Files Reviewed (counts)

- Dispatch domains: 3 files, 2220 total LOC
- Core tasks namespace: 42 source files
- Core task-work namespace: 1 source file (260 LOC)
- Core lifecycle namespace: ~16 source files (index.ts: 1186 LOC)
- Core validation namespace: ~20 source files (~7838 LOC)
- Test files run: 42 (tasks) + 1 (task-work) + 14 (lifecycle) + 11 (validation) + 3 (dispatch) = 71 test files
- Total tests verified: 656 + 6 + 220 + 235 + 63 = 1180 tests, all passing
