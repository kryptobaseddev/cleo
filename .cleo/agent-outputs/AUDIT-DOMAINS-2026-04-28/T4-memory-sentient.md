# Audit Report — Teammate 4: Memory-Sentient

**Auditor**: T1524 (CLEO task ID)
**Scope**: dispatch/memory.ts, dispatch/sentient.ts, core/memory/, core/gc/, core/sentient/, core/llm/
**Date**: 2026-04-28
**HEAD commit at audit start**: 73f0cad4a4c2dadf08370ca92718c4beffc00b16
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | Overall Verdict | Critical Findings |
|------|------|----------------|-------------------|
| dispatch/memory.ts | dispatch | RED | P0: 1, P1: 2, P2: 3 |
| dispatch/sentient.ts | dispatch | GREEN | P2: 1 |
| core/memory/ | core | YELLOW | P1: 1, P2: 3 |
| core/gc/ | core | GREEN | P2: 1 |
| core/sentient/ | core | YELLOW | P2: 2 |
| core/llm/ | core | YELLOW | P1: 1, P2: 2 |

**Totals: P0=1, P1=4, P2=12**

---

## Per-Area Findings

---

### dispatch/memory.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/memory.ts`
**Lines of code**: 2020
**Test files**: 5 tests at
- `packages/cleo/src/dispatch/domains/__tests__/memory-brain.test.ts` (35 tests — PASS)
- `packages/cleo/src/dispatch/domains/__tests__/memory-legacy-rejection.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/memory-llm-status.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/memory-promote-explain.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/memory-verify-pending.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | `MemoryHandler` uses raw `DomainHandler` interface with manual param casts (`paramStringRequired`, `paramNumber`, etc.) throughout. No `OpsFromCore<typeof coreOps>` inference. Sentient has fully migrated to typed adapter; memory.ts has not. |
| 2. Handler thinness | RED | 26 of 45 handlers exceed 5 LOC. Major offenders: `promote-explain` (266 lines, L1172), `verify` (123 lines, L1653), `recent` (125 lines, L846), `sweep` (113 lines, L502), `pending-verify` (99 lines, L659), `watch` (87 lines, L1048), `diary` (77 lines, L971), `digest` (88 lines, L758), `doctor` (69 lines, L433), `llm-status` (44 lines, L615). Business logic (SQL queries, looping, format logic) lives in dispatch, not Core. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, or `as unknown as` in this file. The `typedAll<T>` helper (T1434) is used at L1287/L1300 — correct pattern. |
| 4. Per-op imports | YELLOW | No per-op `*Params`/`*Result` imports from `@cleocode/contracts/operations/memory`. All op types are inferred from engine function signatures via inline `Parameters<typeof fn>` casts (L182-183, L520-522). Not the per-op import anti-pattern, but also not the `OpsFromCore` ADR-058 pattern. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/HACK/SSoT-EXEMPT markers in this file. |
| 6. Test coverage | GREEN | 5 test files, memory-brain.test.ts has 35 tests all passing. T1506's `it.skipIf(!CLEO_BIN_AVAILABLE)` is NOT in dispatch tests (only in core/memory/__tests__/brain-stdp-functional.test.ts, where it is correctly applied). |
| 7. Public surface | N/A | Dispatch domain — N/A for public surface criterion. |
| 8. Cross-domain coupling | GREEN | Imports are from `@cleocode/core`, `@cleocode/core/internal`, `@cleocode/core/memory/*` subpaths, `@cleocode/core/store/memory-sqlite.js`, and `../lib/engine.js`. No imports from other dispatch domains or unexpected namespaces. |
| 9. Dead code | GREEN | No `SSoT-EXEMPT`, `@deprecated`, or stale T-ref markers. T496-linked `'sweep'` operation appears in both `query` and `mutate` cases, with a delegation pattern (`case 'sweep': return this.query(operation, params)`) at L1930 — correct pattern per T1147 W7. |
| 10. Documentation | YELLOW | File-level JSDoc present. `memory-architecture.md` exists at `docs/architecture/`. No README in `packages/core/src/memory/`. No inline ADR-051/057/058/059 refs in the dispatch file. |

**T1496 verification (per scope instructions):**
- `'sweep'` added to `mutate[]` in `getSupportedOperations()` at L2011: CONFIRMED
- Registry entry `memory.sweep` mutate at line ~2729 in registry.ts: CONFIRMED

**P0 findings** (immediate action):
- `dispatch/memory.ts:ALL` — The entire `MemoryHandler` is the last major dispatch domain NOT migrated to the `OpsFromCore<typeof coreOps>` typed adapter (ADR-058). With 266-line handlers containing SQL queries and inline business logic, this represents an architectural debt accumulation. The `promote-explain` handler (266 lines), `verify` handler (123 lines), and `sweep` handler (113 lines) all contain imperative DB access that should be extracted to Core functions following the pattern sentient.ts established. File this as a dedicated migration epic.

**P1 findings** (high priority):
- `dispatch/memory.ts:659` (`pending-verify`), `L758` (`digest`), `L846` (`recent`), `L971` (`diary`), `L1048` (`watch`) — These 5 query handlers contain identical boilerplate: `getBrainDb(projectRoot)` + `getBrainNativeDb()` + null check + inline SQL preparation and result mapping (25-125 lines each). All five should be extracted to Core functions in `packages/core/src/memory/`. They represent 440+ lines of duplicated DB access pattern in the dispatch layer.
- `dispatch/memory.ts:1172` (`promote-explain`) — The 266-line handler executes 5 distinct SQL queries inline (typed tables scan, prune_candidate query, STDP weight query, retrieval log query, tier determination logic). This is the largest handler in the codebase by line count in the dispatch layer. Extraction to `packages/core/src/memory/brain-promote-explain.ts` (similar to `brain-doctor.ts`, `brain-sweep-executor.ts`) is P1.

**P2 findings** (cleanup):
- `dispatch/memory.ts:618-656` (`llm-status`) — 44-line handler directly accesses `getBrainNativeDb()` and runs a SQL query. A Core function `getLastExtractionRunAt(projectRoot)` in `packages/core/src/memory/` would thin this to 3 LOC.
- `dispatch/memory.ts:182-183`, `L520-522`, `L1520-1524` — Three occurrences of `paramString(params, 'type') as Parameters<typeof someCoreFn>[0]['type'] | undefined` inline type extraction. These are not the contracted `OpsFromCore` pattern; they manually reach into Core function signatures for type inference. Acceptable short-term but should go away with the migration epic.
- `dispatch/memory.ts:503` (`sweep` case) — `params?.['dry-run'] === true || params?.dryRun === true` dual-key access for the same parameter. Inconsistent naming convention; should standardize to `dryRun` only and handle CLI aliasing at the registry level.

---

### dispatch/sentient.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/sentient.ts`
**Lines of code**: 345
**Test files**: 1 test file at `packages/cleo/src/dispatch/domains/__tests__/sentient.test.ts` (16 tests — PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | Fully migrated. `type SentientOps = OpsFromCore<typeof coreOps>` at L81. `coreOps` registry at L58-79 maps all 10 operations. `defineTypedHandler<SentientOps>('sentient', {...})` at L87. Per ADR-058. |
| 2. Handler thinness | GREEN | All operation bodies are 6-11 lines (try/catch + single `coreOps[op](params)` call + `lafsSuccess`/`lafsError`). The largest is `propose.diff` at 10 lines (counting the try/catch shell), which is within acceptable bounds. |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, or `as unknown as` in production code. The single boundary cast `operation as keyof SentientOps & string` at L300, L331 is the documented single-trust-boundary per ADR-058. |
| 4. Per-op imports | GREEN | No per-op `*Params`/`*Result` imports from `@cleocode/contracts/operations/sentient`. All types inferred via `OpsFromCore`. Only wire-format types (`DispatchResponse`, `DomainHandler`) imported. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/HACK/SSoT-EXEMPT markers. |
| 6. Test coverage | GREEN | 16 tests all passing. Tests validate typed narrowing, unsupported-op guards, and getSupportedOperations declarations. |
| 7. Public surface | N/A | Dispatch domain — N/A. |
| 8. Cross-domain coupling | GREEN | Imports: `@cleocode/core` (getProjectRoot), `@cleocode/core/sentient` (all 10 op functions), `../adapters/typed.js`, `../types.js`, `./_base.js`. No unexpected cross-domain coupling. |
| 9. Dead code | GREEN | No stale annotations. The `envelopeToEngineResult` helper (L218) is a documented T1434 adapter for `string | number` code coercion. |
| 10. Documentation | YELLOW | JSDoc at file level with ADR-054/ADR-057 references. No README in `packages/core/src/sentient/`. |

**P0 findings**: None.

**P1 findings**: None.

**P2 findings**:
- `packages/contracts/src/operations/sentient.ts:3-5` — The header comment reads "Query operations: 2 (propose.list, allowlist.list)" and total "10 operations" but the actual count is: 3 query ops (propose.list, propose.diff, allowlist.list) + 4 mutate ops (propose.accept, propose.reject, propose.run, propose.enable, propose.disable — actually 5) + 2 allowlist mutations = 10. The comment omits `propose.diff` from the query ops list and the total math (2+5+2=9 ≠ 10) is internally inconsistent. Minor doc bug but creates confusion.

---

### core/memory/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/memory/`
**Lines of code**: ~70 source files, 59 test files
**Test files**: 59 tests at `packages/core/src/memory/__tests__/` — extensive coverage

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | YELLOW | Multiple `as unknown as T[]` casts in `brain-backfill.ts` (L639, L668, L724, L777, L823, L827), `brain-maintenance.ts` (L270), `observer-reflector.ts` (L340, L363, L748, L764), `sleep-consolidation.ts` (L1037), `surprisal.ts` (L174), `brain-stdp.ts` (L368, L411, L512). These are the node:sqlite `.all()` untyped return pattern — mitigated by the centralized `typedAll<T>` helper added in T1434. However `brain-backfill.ts` and others have NOT been migrated to use `typedAll<T>`, relying on direct `as unknown as` casts instead. 19 occurrences total across the namespace. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | YELLOW | 6 `TODO(T1082.followup)` markers confirmed: `session-narrative.ts:61`, `session-narrative.ts:256`, `dialectic-evaluator.ts:117`, `dialectic-evaluator.ts:183`, `dialectic-evaluator.ts:213` (5 confirmed, not 6 per T1518 scope note — one marker at dialectic-evaluator.ts:24 is in a class JSDoc comment, not inline code). T1518 (P2-NEW-3) was filed for these — they remain open. Additionally: 3 `@deprecated` markers in `engine-compat.ts` (L1580, L1586, L1592) for unused weight parameters in hybrid search. These are live-task-linked deprecations, not stale. |
| 6. Test coverage | GREEN | 59 test files with comprehensive coverage including STDP, backfill, lifecycle, retrieval, embeddings, sweep, etc. `brain-stdp-functional.test.ts` correctly applies `it.skipIf(!CLEO_BIN_AVAILABLE)` at L211 per T1506. All checked tests pass. |
| 7. Public surface | YELLOW | `memory/index.ts` is the research/manifest public surface (not cognitive brain ops). Cognitive brain ops are exported via `@cleocode/core/memory/<module>.js` subpath imports or `@cleocode/core/internal`. This creates a split public surface: `index.ts` exports research/manifest/contradiction logic; brain ops are accessed via subpaths or internal. The split is intentional (per T5241 cutover notes) but is not documented. No README for the memory namespace. |
| 8. Cross-domain coupling | GREEN | Memory namespace imports from `@cleocode/core/store/`, `@cleocode/core/paths.js`, `@cleocode/contracts`. No unexpected cross-domain coupling to sentient/gc/llm found. |
| 9. Dead code | GREEN | T1512 removal confirmed — no ADR-027 deprecated brain functions found in active use. The `@deprecated` markers in `engine-compat.ts` are legitimate in-progress deprecations (weight params for hybrid search). |
| 10. Documentation | YELLOW | `docs/architecture/memory-architecture.md` exists. No `README.md` in namespace directory. ADR-051/057/058/059 not referenced in namespace files. |

**P0 findings**: None.

**P1 findings**:
- `core/memory/brain-backfill.ts:639,668,724,777,823,827` and ~12 other files — Direct `as unknown as T[]` casts in SQLite query results instead of using the centralized `typedAll<T>` helper from `packages/core/src/store/typed-query.ts` (introduced in T1434). This is the identified anti-pattern. The `promote-explain` handler in dispatch already uses `typedAll<T>` correctly (memory.ts:L1287). Core memory files should be migrated to use the same helper. Creates divergent patterns for SQLite result typing.

**P2 findings**:
- `core/memory/session-narrative.ts:61,256` and `dialectic-evaluator.ts:117,183,213` — 5 `TODO(T1082.followup)` markers for embedding cosine similarity and telemetry. These are correctly linked to T1082 follow-up but T1518 was filed as a separate tracker. The parent T1082 status should be confirmed still open.
- `core/memory/index.ts` — The public surface of the memory namespace is actually the research/manifest module. Brain cognitive ops (observe, find, timeline, etc.) are not in `index.ts` but accessed via subpaths. This is undocumented. A brief `README.md` would clarify the intentional split.
- `core/memory/engine-compat.ts:1580,1586,1592` — Three `@deprecated` markers for `ftsWeight`, `vecWeight`, `graphWeight` params. The deprecation comment states "weight parameters are unused — hybrid search now uses adaptive weighting." No tasks linked. Consider removing the parameters and the `@deprecated` markers in a clean-forward pass.

---

### core/gc/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/gc/`
**Lines of code**: 4 source files (daemon.ts, runner.ts, state.ts, transcript.ts)
**Test files**: 3 tests at `packages/core/src/gc/__tests__/` (runner.test.ts, state.test.ts, transcript.test.ts — 42 tests passing per combined run)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | YELLOW | `gc/runner.ts:36` — `const checkDiskSpace = checkDiskSpaceModule as unknown as (path: string) => Promise<{...}>`. This is a module interop cast for `check-disk-space` (CommonJS module imported into ESM context). Justified and isolated. 1 occurrence. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/HACK/SSoT-EXEMPT markers across all gc source files. |
| 6. Test coverage | GREEN | 3 test files, 42 tests passing. |
| 7. Public surface | GREEN | `index.ts` cleanly re-exports from 4 modules. JSDoc present on all exported functions (daemon.ts checked — extensive JSDoc with ADR-047 references). |
| 8. Cross-domain coupling | GREEN | gc imports from `@cleocode/core/store/`, `@cleocode/core/paths.js`, `@cleocode/core/errors.js`. No coupling to sentient/memory/llm. |
| 9. Dead code | GREEN | No stale annotations. T1015 relocation from `cleo` to `core` is complete — gc is confirmed in `packages/core/src/gc/` (correct per package boundary table). |
| 10. Documentation | YELLOW | `index.ts` JSDoc references ADR-047. No `README.md` in namespace directory. Architecture docs directory has no `gc.md`. |

**P0 findings**: None.

**P1 findings**: None.

**P2 findings**:
- `core/gc/runner.ts:36` — `as unknown as` cast for `check-disk-space` CJS module. This is low-risk and isolated but could be replaced with a proper ESM import or a typed wrapper. Minor cleanup opportunity.

---

### core/sentient/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/sentient/`
**Lines of code**: ~18 source files + 3 ingesters
**Test files**: 17+ test files at `packages/core/src/sentient/__tests__/` (16 tests in daemon.test.ts — PASS; extensive test suite covers daemon, allowlist, baseline, ingesters, KMS, proposal-rate-limiter, propose-tick, revert-executor, state, tick, etc.)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | YELLOW | `sentient/ingesters/brain-ingester.ts:98` — `as unknown as BrainObservationRow[]`. `sentient/ingesters/nexus-ingester.ts:251,285,314,376,427` — 5 occurrences of `as unknown as <RowType>[]`. `sentient/ingesters/test-ingester.ts` — clean. These are the SQLite `.all()` untyped return pattern (same as memory namespace). 6 occurrences total — all in the `ingesters/` subdirectory. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/HACK/SSoT-EXEMPT markers across all sentient source files. |
| 6. Test coverage | GREEN | 17+ test files with comprehensive unit and integration tests. All checked tests pass. |
| 7. Public surface | GREEN | `index.ts` cleanly re-exports from all modules. `ops.ts` imports from `@cleocode/contracts` for all Params/Result types per ADR-057 D1. TSDoc on all exported ops. |
| 8. Cross-domain coupling | YELLOW | `sentient/ingesters/brain-ingester.ts` imports directly from `@cleocode/core/store/memory-sqlite.js` (the brain DB store). This is acceptable as sentient is a consumer of brain data, but it bypasses the Brain API layer. The same import pattern appears in `nexus-ingester.ts` for the nexus DB. These are documented ingester patterns, not unexpected coupling. |
| 9. Dead code | GREEN | No stale annotations. `ops.ts` explicitly imports from `@cleocode/contracts/operations/sentient` for all Params/Result types — clean ADR-057 compliance. |
| 10. Documentation | YELLOW | `index.ts` JSDoc references ADR-054. No `README.md` in namespace directory. |

**P0 findings**: None.

**P1 findings**: None.

**P2 findings**:
- `sentient/ingesters/brain-ingester.ts:98` and `sentient/ingesters/nexus-ingester.ts:251,285,314,376,427` — 6 `as unknown as <RowType>[]` casts in SQLite query results. Migrate to `typedAll<T>` helper per T1434 pattern.
- `packages/contracts/src/operations/sentient.ts:3-5` — Header comment lists "Query operations: 2" but handler has 3 (propose.diff is missing from the list). Doc inconsistency. (Same P2 noted under dispatch/sentient.ts above.)

---

### core/llm/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/llm/`
**Lines of code**: ~12 source files
**Test files**: 1 test file at `packages/core/src/llm/__tests__/llm-layer.test.ts` (52 tests — PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | YELLOW | `llm/api.ts:178` — `failedAttemptError as unknown as Error` (retry loop error coercion). `llm/backends/anthropic.ts:119,215` — `reqParams as unknown as Parameters<Anthropic['messages']['create']>[0]` and `...stream][0]` (Anthropic SDK boundary casts). `anthropic.ts:272` — `usage as unknown as Record<string, unknown>` (SDK response usage field). `anthropic.ts:391,397` — `responseFormat as unknown as Record<string, unknown>` and `as unknown as z.ZodTypeAny` (structured output boundary). `backends/openai.ts:45,69,89,163` — 4 similar SDK boundary casts. Total: 10 `as unknown as` occurrences across 3 backend files. These are justified SDK boundary casts where 3rd-party SDK types don't perfectly align. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | YELLOW | `llm/types.ts:144` — `/** @deprecated Use LLMCallResponse<T> */` on an unnamed legacy type. Stale deprecation — no task ID linked. |
| 6. Test coverage | YELLOW | Only 1 test file (`llm-layer.test.ts`, 52 tests passing) for a 12-file namespace with 3 provider backends (Anthropic, OpenAI, Gemini), caching, structured output, and tool loop. The backends/gemini.ts, backends/openai.ts, caching.ts, tool-loop.ts have no dedicated test files. Coverage appears to rely primarily on integration-level tests. |
| 7. Public surface | GREEN | `index.ts` is detailed and clean — 20+ named exports with scoped type re-exports. Explicit `IMPORTANT (R8)` note about Vercel AI SDK collision avoidance. TSDoc present on exported functions. |
| 8. Cross-domain coupling | GREEN | LLM namespace imports from `@anthropic-ai/sdk`, `openai`, `@google/generative-ai`, `zod`, `p-retry`. No unexpected coupling to other CLEO namespaces. |
| 9. Dead code | YELLOW | `llm/types.ts:144` — `@deprecated` without task linkage. The deprecated type appears to still be exported; checking if callers reference it would determine if it's safe to remove. |
| 10. Documentation | YELLOW | `index.ts` has good JSDoc with scoped export comments. No `README.md` in namespace directory. No ADR references in the namespace files beyond `@task T1400`. |

**P0 findings**: None.

**P1 findings**:
- `core/llm/` — Only 1 test file for a 12-module namespace with 3 provider backends. The `backends/openai.ts` (163+ lines) and `backends/gemini.ts` have zero dedicated tests. Given that LLM backends are critical-path infrastructure for BRAIN extraction, sentient proposals, and RCASD flows, this coverage gap is P1.

**P2 findings**:
- `llm/types.ts:144` — `@deprecated Use LLMCallResponse<T>` without task linkage. Either remove the deprecated type if it has no callers, or file a cleanup task.
- `llm/backends/anthropic.ts:119,215,272,391,397` and `openai.ts:45,69,89,163` — 9 `as unknown as` SDK boundary casts are justified by SDK type mismatches but should be consolidated into typed wrapper functions or documented as accepted-boundary patterns in a comment block, rather than scattered inline.

---

## Overall Recommendations

1. **[P0 — File Epic] dispatch/memory.ts OpsFromCore migration** — The `MemoryHandler` is the last major dispatch domain not migrated to the `OpsFromCore<typeof coreOps>` typed adapter. With 2020 lines, 45 case handlers (26 exceeding 5 LOC), and SQL queries executing directly in the dispatch layer, this is the most significant architectural debt in scope. Recommended approach: extract DB-querying operations (`pending-verify`, `digest`, `recent`, `diary`, `watch`, `llm-status`, `promote-explain`, `verify`) to Core functions in `packages/core/src/memory/`, then wire via `OpsFromCore`. Estimated effort: large. Parent: T1520 (or a new architecture epic).

2. **[P1] core/memory/ + core/sentient/ typedAll<T> migration** — 25+ `as unknown as T[]` direct SQLite casts across `brain-backfill.ts`, `observer-reflector.ts`, `sleep-consolidation.ts`, `surprisal.ts`, `brain-stdp.ts`, `brain-ingester.ts`, `nexus-ingester.ts`, `brain-maintenance.ts`. The `typedAll<T>` helper at `packages/core/src/store/typed-query.ts` (T1434) should be the standard; migrate remaining files. Medium effort; improves type safety and reduces inconsistency.

3. **[P1] core/llm/ backend test coverage** — `backends/openai.ts`, `backends/gemini.ts`, `caching.ts`, `tool-loop.ts` have no dedicated unit tests. File a follow-up task to add at least unit-level tests for the backend adapters.

4. **[P2] contracts/sentient.ts doc inconsistency** — Fix the header comment: "Query operations: 2" → "Query operations: 3 (propose.list, propose.diff, allowlist.list)". One-line fix, no runtime impact.

5. **[P2] core/memory/index.ts public surface clarity** — The memory namespace's `index.ts` is the research/manifest module, not the cognitive brain module. Add a brief `README.md` explaining the intentional split (research public via index.ts, brain ops via subpath imports).

6. **[P2] T1518 TODO markers** — 5 `TODO(T1082.followup)` markers in `session-narrative.ts` and `dialectic-evaluator.ts` remain open. Confirm T1082 parent is still open and that T1518 is active.

### Follow-up tasks to file

| Title | Parent | Acceptance |
|-------|--------|-----------|
| `dispatch/memory.ts: migrate MemoryHandler to OpsFromCore<coreOps> typed adapter (ADR-058)` | T1520 | Code placed in packages/cleo/ dispatch per boundary check; zero `as string` param casts in handler bodies; all DB query cases extracted to packages/core/src/memory/ functions |
| `core/memory + sentient: migrate direct SQLite .all() casts to typedAll<T> (T1434 pattern)` | T1520 | No `as unknown as T[]` remaining in brain-backfill.ts, observer-reflector.ts, sleep-consolidation.ts, surprisal.ts, brain-stdp.ts, brain-ingester.ts, nexus-ingester.ts |
| `core/llm: add unit tests for openai/gemini backends and tool-loop` | T1520 | At least 10 unit tests per backend file; tool-loop.ts has dedicated test file |

---

## Cross-References

- **ADR-058** (OpsFromCore inference): dispatch/sentient.ts GREEN, dispatch/memory.ts RED — migration incomplete
- **ADR-057** (Core API normalization): sentient/ops.ts fully compliant; memory namespace has no equivalent ops.ts
- **ADR-054** (Sentient Loop Tier-2): sentient namespace in good shape; see sentient/index.ts
- **ADR-047** (GC daemon): gc namespace clean; correctly placed in core per T1015
- **T1434** (typedAll helper): dispatch/memory.ts uses it correctly; many core files do not
- **T1492** (memory.ts handler thinning): confirmed partial — some handlers were thinned, but 26/45 still exceed 5 LOC. The large handlers (`promote-explain`, `verify`, `sweep`, `pending-verify`) were not addressed.
- **T1496** (sweep mutation + registry): CONFIRMED both parts present
- **T1506** (brain-stdp-functional skipIf guard): CONFIRMED correct at L211 of test file
- **T1512** (ADR-027 deprecated function removal): CONFIRMED — no deprecated ADR-027 brain functions found
- **T1518** (TODO(T1082.followup) markers): CONFIRMED — 5 markers present, T1518 still relevant

## Files Reviewed

- Dispatch (2): `packages/cleo/src/dispatch/domains/memory.ts`, `packages/cleo/src/dispatch/domains/sentient.ts`
- Registry (1): `packages/cleo/src/dispatch/registry.ts` (partial, memory+sentient sections)
- Core namespaces: `packages/core/src/memory/` (~70 files sampled), `packages/core/src/sentient/` (~18 files sampled), `packages/core/src/gc/` (4 files), `packages/core/src/llm/` (~12 files sampled)
- Contracts (1): `packages/contracts/src/operations/sentient.ts`
- Test files (7+ sampled): memory-brain.test.ts, sentient.test.ts, brain-stdp-functional.test.ts, brain-lifecycle-*.test.ts (various), gc runner.test.ts, llm-layer.test.ts
- Architecture docs: `docs/architecture/memory-architecture.md`

**Total area verdict tally**: GREEN=2 (gc, sentient), YELLOW=3 (memory core, llm, sentient core), RED=1 (dispatch/memory.ts)
**Total findings**: P0=1, P1=4, P2=12
