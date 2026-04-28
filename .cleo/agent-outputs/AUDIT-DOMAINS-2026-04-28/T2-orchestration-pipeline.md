# Audit Report — Teammate 2: Orchestration-Pipeline

**Auditor**: T1522 (CLEO task ID)
**Scope**: dispatch/orchestrate.ts, dispatch/pipeline.ts, core/orchestration/, core/spawn/, core/pipeline/, core/sequence/, core/phases/
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive summary

| Area | Type | Overall verdict | Critical findings |
|------|------|----------------|-------------------|
| dispatch/orchestrate.ts | dispatch | YELLOW | P1: OpsFromCore not adopted; P1: 18 handlers >5 LOC; P1: 38 `as string` param casts; P2: classify logic not delegating to core |
| dispatch/pipeline.ts | dispatch | GREEN | P2: 2 SSoT-EXEMPT comments (both valid) |
| core/orchestration/ | core | GREEN | P2: no README; orchestrateClassify in dispatch duplicates a different concern from classify.ts in core |
| core/spawn/ | core | GREEN | 0 issues |
| core/pipeline/ | core | YELLOW | RED: no tests |
| core/sequence/ | core | YELLOW | P2: `Record<string, unknown>` return types on 2 exports |
| core/phases/ | core | GREEN | 0 issues |

**Verdict summary**: 2 GREEN, 3 YELLOW, 0 RED areas overall.
**Totals**: P0: 0, P1: 3, P2: 6

---

## Per-area findings

### dispatch/orchestrate.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/orchestrate.ts`
**Lines of code**: 1431
**Test files**: 3 tests at `packages/cleo/src/dispatch/domains/__tests__/orchestrate.test.ts`, `orchestrate-approval.test.ts`, `orchestrate-handoff.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | No `OpsFromCore` usage. Handlers extract params with `params?.field as Type` pattern throughout. 38 instances of `as string`/`as boolean`/`as number` casts. ADR-058 pattern not adopted here. |
| 2. Handler thinness | YELLOW | Mixed. Thin cases: `worktree.cleanup` (3 LOC), `worktree.prune` (3 LOC), `ivtr.*` (1 LOC each), `approve`/`reject` (1 LOC each delegate to helpers). Fat cases: `fanout.status` (44 LOC inline), `tessera.instantiate` (47 LOC inline), `parallel` (57 LOC inline), `plan` (21 LOC), `handoff` (38 LOC). Many fat cases delegate to standalone helper functions (acceptable ADR-058 workaround), but `parallel` has nested lambda bodies. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. All occurrences of `as any` in scope are inside string literals (documentation text in spawn-prompt.ts). |
| 4. Per-op imports | GREEN | No imports from `@cleocode/contracts/operations/*`. Imports from `@cleocode/contracts` are wire-format types (`GateResult`, `WarpChain`) only. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` in file. |
| 6. Test coverage | GREEN | 3 test files, all pass. orchestrate.test.ts (3 tests), orchestrate-approval.test.ts (13 tests), orchestrate-handoff.test.ts (3 tests). All 19 tests pass. |
| 7. Public surface | N-A | Dispatch domain, not a core namespace. |
| 8. Cross-domain coupling | YELLOW | Imports `IvtrHandler` from `./ivtr.js` (same dispatch layer, acceptable). Imports from `./playbook.js` for HITL gate helpers. `orchestrateClassify` inline function re-implements CANT file routing independently from `core/orchestration/classify.ts` (which does agent-based classification). These serve different concerns (CANT team routing vs agent persona routing) so no true duplication, but the inline impl is 116 LOC of business logic inside dispatch. |
| 9. Dead code | GREEN | No stale `SSoT-EXEMPT`, `@deprecated`, or `TODO(T...)` annotations. |
| 10. Documentation | YELLOW | File has a JSDoc block at the top referencing `@epic T4820` and `@epic T377`. No README. No explicit ADR-058 reference in the file (pipeline.ts has them, orchestrate.ts does not). |

**P1 findings** (high priority):
- `orchestrate.ts:74-308 (query), 311-625 (mutate)` — OpsFromCore inference not adopted. 38 `params?.x as string` param casts scattered across handler cases. This is the primary ADR-058 compliance gap for this domain. Recommend a Wave D–style migration like T1441/T1435 did for pipeline.ts.
- `orchestrate.ts:711-826` — `orchestrateClassify` is 116 LOC of business logic (file system I/O, CANT parsing, scoring) inside the dispatch layer. While it serves a different purpose from `core/orchestration/classify.ts`, this imperative logic violates the thin-dispatch principle. Should be extracted to `core/orchestration/cant-classify.ts` (or similar) and delegated.
- `orchestrate.ts:464-519` — `case 'parallel'` block contains 57 LOC of nested async lambdas with validation logic. Even though it delegates to engine functions, the routing complexity is above the dispatch layer's mandate. Should be extracted to a helper in `engine.ts` or `core`.

**P2 findings** (cleanup):
- `orchestrate.ts` — No ADR-058 reference in file header or inline. pipeline.ts explicitly calls out `@task T1441 — OpsFromCore inference migration`. A corresponding migration task for orchestrate.ts would improve traceability.
- `orchestrate.ts:892-968` — `orchestrateFanout` is 76 LOC of dispatch-layer business logic (Promise.allSettled + manifest store). Core has no equivalent. This should move to a core engine function.

---

### dispatch/pipeline.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/pipeline.ts`
**Lines of code**: 1054
**Test files**: 3 test files at `__tests__/pipeline.test.ts` (7 tests), `pipeline-opsfromcore.test.ts` (4 tests), `pipeline-manifest.test.ts` (multiple tests).

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | Full `OpsFromCore<typeof coreOps>` inference per ADR-058 (T1441). Exports `PipelineOps` type. The opsfromcore test confirms all 34 operations are covered and no per-op contract params are imported. |
| 2. Handler thinness | GREEN | All case bodies in `query()` and `mutate()` are ≤5 LOC. `typedDispatch` delegates all logic to inner handler. Post-dispatch helpers (`pipelinePhaseListResponse`, `pipelineChainListResponse`, `pipelineEnvelopeResponse`) extract fat transformation logic from the outer handler per ADR-058 T1492/P1-1. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. Two `as unknown` usages in `pipelineEnvelopeResponse` (line ~850) and in typed handler — but these are justified data-envelope destructures where the engine type differs from LAFS envelope, not shortcut casts. |
| 4. Per-op imports | GREEN | Zero imports from `@cleocode/contracts/operations/*`. Only wire-format types imported (`GateResult`, `WarpChain` from `@cleocode/contracts`). |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | GREEN | 3 test files. pipeline.test.ts (7 tests), pipeline-opsfromcore.test.ts (4 tests), pipeline-manifest.test.ts (multiple tests). All pass. |
| 7. Public surface | N-A | Dispatch domain. |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/core/internal`, `@cleocode/contracts`, and local dispatch helpers. No unexpected cross-domain imports. |
| 9. Dead code | GREEN | Two `SSoT-EXEMPT` annotations at lines 478 and 795 — both are valid and correctly documented: (1) sentinel-unwrap for `stage.guidance` (Core returns intermediate shape that dispatch must unwrap), (2) pagination/page-envelope lifting (LAFSPage type incompatibility). Neither references a closed task. |
| 10. Documentation | GREEN | File has inline JSDoc referencing `@epic T4820`, `@task T1441`, `@task T1435`. Explicit `ADR-058` reference at lines 480, 791, 932. |

**P2 findings** (cleanup):
- `pipeline.ts:99-168` — Inline `Type*Params` type aliases (e.g. `StageValidateParams`, `ReleaseListParams`, `ChainAddParams`) are defined in the dispatch file rather than being inferred from core op wrappers. While OpsFromCore inference is used for the handler, these local type aliases could be removed if the core op wrappers were exposed as typed interfaces — a minor cleanup opportunity.

---

### core/orchestration/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/orchestration/`
**Lines of code**: 6,739 total (20 files)
**Test files**: 16 test files in `__tests__/`, 337 tests total — all pass.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace (not dispatch). |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` in production files. The two grep matches are (1) a JSDoc phrase mentioning "any result" and (2) a spawn-prompt string literal quoting the anti-pattern rule — neither is actual type leakage. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK` across all 20 files. |
| 6. Test coverage | GREEN | 16 test files covering: orchestration, spawn, waves, spawn-prompt, classify, harness-hint, tier-selector, atomicity, protocol-validators, registry-resolver, thin-agent, validate-spawn, autonomous-spec, spawn-retrieval-parity, spawn-prompt-hoist, waves-enrichment, waves-status. All 337 tests pass. |
| 7. Public surface | YELLOW | `index.ts` has clean named exports and TSDoc on all exported interfaces and functions. Minor issue: `startOrchestration` has only a minimal `@task T4466` TSDoc — no `@param` / `@returns` documentation. Same for several other functions. Internals are not leaked. |
| 8. Cross-domain coupling | YELLOW | `orchestration/index.ts` imports `getExecutionWaves` from `../phases/deps.js` (cross-domain). `orchestration/spawn-prompt.ts` imports `resolveSkillPath` from `../skills/skill-paths.js`. Both are acceptable domain-level dependencies (phases and skills are sibling core namespaces), but they create coupling that should be documented. |
| 9. Dead code | GREEN | No stale `SSoT-EXEMPT`, `@deprecated`, or stale task references. |
| 10. Documentation | YELLOW | No `README.md` in namespace directory. `docs/architecture/orchestration-flow.md` exists (referenced in ADRs). ADR-055/058 referenced within code. Missing per-namespace README. |

**P2 findings** (cleanup):
- `orchestration/index.ts:154` — `startOrchestration` and several other exported functions lack full TSDoc `@param`/`@returns` documentation. With 26600+ indexed symbols in GitNexus, this reduces discoverability.
- `orchestration/` — no README.md. Pipeline, phases, sequence, and spawn all lack READMEs. A brief README per namespace explaining purpose and key exports would complete the documentation story.

---

### core/spawn/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/spawn/`
**Lines of code**: 1,148 total (3 files)
**Test files**: 2 test files — `adapter-registry.test.ts` (10 tests), `worktree-prune.test.ts` (10 tests). All 20 tests pass.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` in production files. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | GREEN | 2 test files, 20 tests, all pass. T1462 `pruneWorktree` specifically covered by `worktree-prune.test.ts` (6 dedicated tests for clean/dirty/error paths). T1118 `createAgentWorktree`/`completeAgentWorktree` are exercised via orchestration integration tests. |
| 7. Public surface | GREEN | Clean `index.ts` barrel with full TSDoc (`@task`, `@adr` annotations) on all exported functions. `PruneWorktreeResult` type exported explicitly. No internal implementation details leaked. |
| 8. Cross-domain coupling | GREEN | Only imports from `node:` built-ins and relative within-package paths. No cross-namespace core imports. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README.md. All exported functions have TSDoc including `@task T1462` and `@adr ADR-055` markers. `docs/architecture/` has no dedicated spawn document. |

**T1462 verification**: `pruneWorktree()` added at line 433 of `branch-lock.ts`. The dispatch `worktree.prune` handler at `orchestrate.ts:459-464` correctly delegates to this function. Six tests in `worktree-prune.test.ts` cover clean/dirty/missing/error paths. Verified clean.

---

### core/pipeline/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/pipeline/`
**Lines of code**: 76 total (2 files: `index.ts` 10 LOC, `phase.ts` 66 LOC)
**Test files**: NONE

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero type leakage. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | RED | Zero test files for this namespace. `listPhases` and `showPhase` are thin wrappers over `core/phases/index.ts` functions — the phases tests cover the underlying logic, but there are no dedicated `pipeline/` tests. |
| 7. Public surface | GREEN | `index.ts` re-exports `listPhases` and `showPhase` with TSDoc. `phase.ts` functions have TSDoc. Clean barrel export. |
| 8. Cross-domain coupling | YELLOW | `phase.ts` imports from `../phases/index.js` (cross-domain, intentional). The `core/pipeline/` namespace appears to be a thin adapter over `core/phases/` to provide a unified entry point for the dispatch pipeline domain. This is the intended relationship but creates layering: `dispatch/pipeline.ts` → `core/pipeline/phase.ts` → `core/phases/index.ts`. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README.md. Minimal JSDoc in index.ts (`@task T5709`, `@epic T5701`). Purpose of this namespace (thin adapter over phases) is not documented. |

**P1 findings** (high priority):
- `core/pipeline/` — Zero test coverage. While `listPhases`/`showPhase` are thin, the absence of any tests in a namespace with dispatch-facing exports is a gap.

**P2 findings** (cleanup):
- `core/pipeline/` — The purpose of this namespace vs `core/phases/` is unclear without a README. `pipeline/phase.ts` wraps `phases/listPhases` and `phases/showPhase` with identical signatures — if the abstraction layer isn't needed, consider consolidating.

---

### core/sequence/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/sequence/`
**Lines of code**: 374 (1 file: `index.ts`)
**Test files**: 1 test file — `__tests__/allocate.test.ts`. Tests pass (3 tests in the run).

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Uses `unknown` in three places: (1) `getMetaValue<unknown>` to safely read DB value before narrowing with `isValidSequenceState`, (2) `JSON.parse` result cast to `unknown` before narrowing — both are the correct defensive pattern. No `any` usage. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | YELLOW | 1 test file covering `allocateNextTaskId` only. `showSequence`, `checkSequence`, `repairSequence` lack direct test coverage (migration/repair logic is complex). |
| 7. Public surface | YELLOW | TSDoc comments are minimal (1-line summaries, no `@param`/`@returns`). `showSequence` and `checkSequence` return `Promise<Record<string, unknown>>` — these are weakly typed public API signatures. The internal `SequenceState` type is not exported but `RepairResult` is. |
| 8. Cross-domain coupling | GREEN | Imports only from `node:fs`, `node:path`, `@cleocode/contracts`, and `../store/` (local store access). Clean boundaries. |
| 9. Dead code | GREEN | No stale annotations. Legacy sequence migration functions (`readLegacySequenceFile`, `renameLegacyFile`) are internal helpers — appropriate to keep for backward compat. |
| 10. Documentation | YELLOW | No README.md. Brief module-level JSDoc (`@task T4538`, `@epic T4454`). |

**P2 findings** (cleanup):
- `sequence/index.ts:162,200` — `showSequence` and `checkSequence` return `Promise<Record<string, unknown>>`. These should return well-typed interfaces (e.g. `SequenceStatus`, `SequenceCheckResult`) consistent with the codebase's zero-`any` / typed-contracts pattern.
- `sequence/` — `showSequence`, `checkSequence`, and `repairSequence` lack dedicated tests. The `allocate.test.ts` only covers the happy-path allocation loop.

---

### core/phases/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/phases/`
**Lines of code**: 1,123 total (2 files: `index.ts` 604 LOC, `deps.ts` 519 LOC)
**Test files**: 2 test files — `__tests__/phases.test.ts` (10 tests), `__tests__/deps.test.ts` (multi-test). All pass.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero `TODO`, `FIXME`, `XXX`, `HACK`. |
| 6. Test coverage | GREEN | 2 test files. `phases.test.ts` covers `startPhase`, `completePhase`, `renamePhase`, `deletePhase` with boundary/error cases. `deps.test.ts` covers `detectCycles`, `getTaskTree`. All tests pass. |
| 7. Public surface | GREEN | Clean named exports from `index.ts`. All exported interfaces have single-line `/** ... */` JSDoc. All exported async functions have TSDoc with `@task`/`@epic` markers. `ListPhasesResult`, `SetPhaseOptions`, `SetPhaseResult`, `ShowPhaseResult`, etc. are well-typed. |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/contracts`, `../errors.js`, `../store/`, `../tasks/add.js` (logOperation). The `tasks/add.js` import for `logOperation` is a minor layering concern but follows the pattern used elsewhere. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README.md. Strong inline TSDoc. No docs/architecture file for the phases namespace specifically. |

---

## Overall recommendations

1. **File follow-up task**: Migrate `dispatch/orchestrate.ts` to OpsFromCore pattern (T1441-equivalent, parent T4820). This is the largest compliance gap — 38 param casts vs zero in pipeline.ts after T1441. Estimated size: large.

2. **File follow-up task**: Extract `orchestrateClassify` (116 LOC) and `orchestrateFanout` (76 LOC) from dispatch into `core/orchestration/cant-classify.ts` and `core/orchestration/fanout.ts` respectively. These contain business logic that violates the thin-dispatch principle. Parent: T4820.

3. **File follow-up task**: Add tests to `core/pipeline/` namespace. Even if `listPhases`/`showPhase` are thin wrappers, dispatch-facing exports need dedicated coverage. Parent: T5701.

4. **File follow-up task**: Strengthen `sequence/` public API — replace `Record<string, unknown>` return types on `showSequence` and `checkSequence` with typed interfaces, and add tests for `checkSequence`/`repairSequence`. Parent: T4538.

5. **Low-priority cleanup**: Add README.md files to all 5 core namespaces in scope (orchestration, spawn, pipeline, sequence, phases). These are currently undocumented at the namespace level. A single follow-up task covering all 5 is appropriate.

6. **Observation**: `pipeline.integration.test.ts` is excluded from root `pnpm run test` by the vitest config (`**/*.integration.test.ts` exclusion pattern). Running `pnpm run test:integration` in `packages/core` executes it. The 48 pipeline integration tests all pass (confirmed by running via core package vitest). No gap exists — T1497 fix is verified clean.

7. **Observation**: T1462 `pruneWorktree()` and the `worktree.prune` dispatch handler are verified clean. The spawn/branch-lock.ts function has full TSDoc with `@task T1462` and `@adr ADR-055` markers. 6 dedicated tests cover clean/dirty/error paths.

8. **Observation**: The `orchestration/` and `spawn/` namespaces have potential overlap noted in scope. After review, they are complementary, not duplicated: `orchestration/` contains the high-level spawn workflow (spawn-prompt composition, tier selection, protocol validation), while `spawn/` contains the execution primitives (adapter registry, git worktree management). No actual logic duplication found.

## New follow-up tasks

1. **`cleo add "Migrate dispatch/orchestrate.ts to OpsFromCore pattern (ADR-058 compliance)" --parent T4820`** — Medium/Large. Acceptance: zero `params?.x as Type` casts, `OpsFromCore<typeof coreOps>` inference, all tests pass.

2. **`cleo add "Extract orchestrateClassify and orchestrateFanout from dispatch to core" --parent T4820`** — Medium. Acceptance: dispatch case bodies ≤5 LOC, business logic in core, covered by tests.

3. **`cleo add "Add tests for core/pipeline/ namespace" --parent T5701`** — Small. Acceptance: test file for listPhases/showPhase, passes vitest.

4. **`cleo add "Type-harden sequence/ public API (showSequence, checkSequence return types)" --parent T4538`** — Small. Acceptance: no `Record<string, unknown>` returns, typed interfaces exported.

## Cross-references

- ADR-058 (dispatch type inference) — full compliance in pipeline.ts, partial in orchestrate.ts
- ADR-055 (agents architecture/worktree) — T1462 worktree.prune verified
- ADR-051 (evidence gates) — N/A (no gate violations in scope)
- ADR-057 (contracts/core SSoT) — no violations in scope

## Files reviewed

| File | LOC |
|------|-----|
| packages/cleo/src/dispatch/domains/orchestrate.ts | 1,431 |
| packages/cleo/src/dispatch/domains/pipeline.ts | 1,054 |
| packages/core/src/orchestration/ (20 files) | 6,739 |
| packages/core/src/spawn/ (3 files) | 1,148 |
| packages/core/src/pipeline/ (2 files) | 76 |
| packages/core/src/sequence/ (1 file) | 374 |
| packages/core/src/phases/ (2 files) | 1,123 |
| **Total** | **11,945** |

Test runs confirmed:
- dispatch/orchestrate: 19 tests across 3 files — all pass
- dispatch/pipeline: 11+ tests across 3 files — all pass
- core/orchestration: 337 tests across 16 files — all pass
- core/spawn: 20 tests across 2 files — all pass
- core/pipeline: 0 tests — RED gap
- core/sequence: 3 tests (allocate only) — pass; other functions untested
- core/phases: 14+ tests across 2 files — all pass
- pipeline.integration.test.ts (lifecycle): 48 tests — all pass (T1497 fix verified)
