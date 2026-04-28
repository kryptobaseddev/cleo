# Audit Report — Teammate 5: Nexus-CodeIntel

**Auditor**: T1525 (CLEO task ID)
**Scope**: dispatch/nexus.ts, dispatch/intelligence.ts, core/nexus, core/code, core/codebase-map, core/research, core/intelligence
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive summary

| Area | Type | Overall verdict | Critical findings |
|------|------|----------------|-------------------|
| dispatch/nexus.ts | dispatch | YELLOW | 0 P0 / 2 P1 / 2 P2 |
| dispatch/intelligence.ts | dispatch | YELLOW | 0 P0 / 1 P1 / 1 P2 |
| core/nexus | core | YELLOW | 0 P0 / 2 P1 / 3 P2 |
| core/code | core | RED | 0 P0 / 1 P1 / 1 P2 |
| core/codebase-map | core | YELLOW | 0 P0 / 1 P1 / 1 P2 |
| core/research | core | RED | 1 P0 / 0 P1 / 0 P2 |
| core/intelligence | core | YELLOW | 0 P0 / 1 P1 / 2 P2 |

**Totals: 1 P0 / 8 P1 / 10 P2**

---

## Per-area findings

---

### dispatch/nexus.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/nexus.ts`
**Lines of code**: 1292
**Test files**: 5 tests at:
- `packages/cleo/src/dispatch/domains/__tests__/nexus.test.ts` (56 tests, all pass)
- `packages/cleo/src/dispatch/domains/__tests__/nexus-opsfromcore.test.ts` (8 tests, all pass)
- `packages/cleo/src/dispatch/domains/__tests__/nexus-code-intel-dispatch.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/nexus-contracts-ingestion-dispatch.test.ts`
- `packages/cleo/src/dispatch/domains/__tests__/nexus-living-brain-dispatch.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | `type NexusOps = OpsFromCore<typeof coreNexus.nexusCoreOps>` at line 99; zero inline Params/Result types |
| 2. Handler thinness | YELLOW | 47 of 48 ops are ≤5 LOC via `wrapCoreResult`. Two ops (`top-entries`, `impact`) bypass `typedDispatch` and route to `handleTopEntries`/`handleImpact` standalone helpers (280+ LOC each). The bypass is documented but these helpers contain imperative DB logic that should be in Core. |
| 3. Inline type leakage | YELLOW | 7 usages of `: unknown` (lines 124, 128, 175, 179, 556, 562, 568, 599) — all in the `nexusQueryEnvelopeToResponse`/`nexusMutateEnvelopeToResponse` helpers and the page-lifting logic. These are intentional structural casts on untyped envelope shapes; not `as any`. Count is borderline. |
| 4. Per-op imports | YELLOW | Line 22: `import type { NexusImpactResult } from '@cleocode/contracts/operations/nexus'`. This is a result shape used only for `satisfies NexusImpactResult` type assertions (lines 1109, 1177). ADR-058 states dispatch should only import wire-format types. `NexusImpactResult` is a result shape, not a Params type, so the use is defensible; but it is still a per-op contract import. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK markers. Three `SSoT-EXEMPT:page-envelope-lifting` annotations at lines 121, 173, 550 — all reference a live dispatch concern, not closed task IDs. |
| 6. Test coverage | GREEN | 5 test files, 64+ passing tests including OpsFromCore type-safety tests. Tests pass. |
| 7. Public surface | N-A | Dispatch domain (not core namespace) |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/contracts`, `@cleocode/core`, `@cleocode/core/internal`, `@cleocode/lafs`, and local dispatch infrastructure (`adapters/typed`, `engines/nexus-engine`, `types`, `_base`). All acceptable. |
| 9. Dead code | GREEN | SSoT-EXEMPT annotations reference live dispatch concerns. No closed-task TODOs found. No `@deprecated` markers. |
| 10. Documentation | YELLOW | File has a module-level TSDoc block (lines 1-20) with epic/task refs. No README in the dispatch/domains directory. ADR-058 is referenced by task T1440 in the header. |

**P1 findings**:
- `nexus.ts:638-646` — `top-entries` and `impact` operations bypass `typedDispatch` and route to standalone helpers (`handleTopEntries`, `handleImpact`) containing 280+ LOC of imperative DB query logic. Per ADR-058, this logic should live in Core (e.g. `packages/core/src/nexus/`). The dispatch layer should delegate via `wrapCoreResult`. Comment documents this as "legacy" but no follow-up task is filed.
- `nexus.ts:22` — `NexusImpactResult` imported from `@cleocode/contracts/operations/nexus` for use in `handleImpact` helper. While used only as a `satisfies` type guard (not param extraction), it is still a direct per-op contract import in the dispatch layer. Should be eliminated when `handleImpact` is moved to Core.

**P2 findings**:
- `nexus.ts:706-1292` — `handleTopEntries`, `handleTopEntriesFromBrain`, `handleTopEntriesFromNexus`, `handleImpact` (587 LOC total) are duplicating Core concerns. This contributes to `nexus.ts` remaining at 1292 LOC post-T1492. Flag as a sizing concern but no functional regression.
- `nexus.ts:1091-1092` — Dynamic import: `await import('@cleocode/core/store/nexus-sqlite' as string)`. The `as string` cast is an unusual pattern used to suppress static-analysis bundling. Low risk but non-standard.

---

### dispatch/intelligence.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/intelligence.ts`
**Lines of code**: 262
**Test files**: 0 dedicated dispatch-level test files found (no `intelligence.test.ts` in `dispatch/domains/__tests__/`). Intelligence is covered indirectly through the registry-derivation and pipeline-manifest tests.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | No `OpsFromCore<...>` inference used. `IntelligenceHandler` uses raw `Record<string, unknown>` params with manual `as string` casts (`params?.taskId as string | undefined`) throughout all 5 operations. Does not use `defineTypedHandler`. |
| 2. Handler thinness | RED | All 5 case blocks exceed 5 LOC significantly: `predict` (42 LOC), `suggest` (27 LOC), `learn-errors` (16 LOC), `confidence` (52 LOC), `match` (27 LOC). All contain orchestration logic (param validation, accessor construction, conditional dispatch) that should be in Core or a thin adapter. `confidence` at 52 LOC is the worst offender — it reconstructs a verification object inline. |
| 3. Inline type leakage | YELLOW | Multiple `as string \| undefined` casts on params (lines 51, 67, 101, 148, 178, 204). These are runtime string narrowings from `Record<string, unknown>`, which is the expected pattern without typed dispatch. Not `as any`, but indicates the absence of typed inference. Count: ~6 occurrences. |
| 4. Per-op imports | GREEN | No imports from `@cleocode/contracts/operations/*`. All types come from `@cleocode/core` and `@cleocode/core/internal`. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK markers. |
| 6. Test coverage | RED | No dedicated dispatch-level test file for `intelligence`. Core intelligence tests cover the underlying functions (98 tests pass), but the dispatch handler itself has no unit or integration tests. |
| 7. Public surface | N-A | Dispatch domain (not core namespace) |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/core`, `@cleocode/core/internal`, and local dispatch infrastructure only. |
| 9. Dead code | GREEN | Zero stale annotations. `@task T549`, `@epic T5149` references in header. |
| 10. Documentation | YELLOW | Module-level TSDoc block with task/epic refs. No README. No ADR-058 reference in the header despite the file not using OpsFromCore. |

**P1 findings**:
- `intelligence.ts:35-261` — `IntelligenceHandler` does not use `OpsFromCore` / `defineTypedHandler`. All 5 operations are implemented as fat switch-case branches with manual `Record<string, unknown>` extraction and inline logic. This is the pre-T1424 pattern. No follow-up task filed to migrate `intelligence` to typed-dispatch. File as follow-up (parent T1520).

**P2 findings**:
- `intelligence.ts:176-185` — `confidence` operation reconstructs a default `verification` object inline (7 lines of manual struct construction) when `task.verification` is null. This inline default belongs in Core, not in the dispatch handler.

---

### core/nexus — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/nexus/`
**Lines of code**: 11,572 LOC across 36 files (including subdirs)
**Test files**: 20 test files in `__tests__/` (19 passed, 1 skipped, 300+ tests, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace |
| 2. Handler thinness | N-A | Core namespace |
| 3. Inline type leakage | YELLOW | `workspace.ts:159` — `(config as unknown as Record<string, unknown>)?.authorizedAgents`. One occurrence; config type is dynamically loaded from JSON. Defensible but flagged. |
| 4. Per-op imports | N-A | Core namespace |
| 5. Behavior markers | YELLOW | `route-analysis.ts:162` — `T1XXX (future AST-based shape inference epic)` placeholder. T1519 (P2-NEW-4) was filed for this but it still exists. 12 `@deprecated` annotations across `discover.ts`, `deps.ts`, `permissions.ts`, `registry.ts`, `query.ts` — all reference new ADR-057 D1 function signatures. Not stale; they document the migration path. |
| 6. Test coverage | GREEN | 20 test files, 304 total tests (300 passed, 4 skipped). Tests cover: augment, deps, living-brain, permissions, plasticity-queries, query-dsl, query, reconcile, registry, route-analysis, sigil-sync, task-sweeper, tasks-bridge, transfer, user-profile, wiki-index plus 4 e2e tests. Full pass. |
| 7. Public surface | YELLOW | `index.ts` has a comprehensive export list covering all sub-modules. Module-level TSDoc block present (lines 1-9). TSDoc coverage on individual exported functions is mixed: `registry.ts` has 35 TSDoc comments for 32 exports (good), but some files like `embeddings.ts`, `living-brain.ts` have TSDoc on key functions but not all. `ops.ts` is well-documented with examples. |
| 8. Cross-domain coupling | GREEN | No unexpected cross-domain imports. `nexus` imports from `@cleocode/contracts`, `@cleocode/core/store/*`, and sibling nexus files. The sigil-sync imports from CANT (`cant-registry`) which is expected for sigil canon sync. |
| 9. Dead code | YELLOW | `route-analysis.ts:162` — `T1XXX` placeholder confirmed present (flagged by T1519 but not yet resolved). All 12 `@deprecated` annotations reference live migration paths (ADR-057), not closed tasks. |
| 10. Documentation | YELLOW | No `README.md` in `packages/core/src/nexus/`. ADR references exist in file headers (ADR-057 in deps.ts, query.ts, registry.ts). No architecture doc for nexus found in `docs/architecture/`. |

**P1 findings**:
- `route-analysis.ts:162` — `T1XXX` placeholder for future AST-based shape inference epic. This is an unresolved stub that was supposed to be tracked by T1519 (P2-NEW-4). Confirm T1519 is live and linked to the correct follow-up epic. If T1519 is closed without an epic ID assigned, this is a documentation hole.
- `living-brain.ts` (1211 LOC) — The single largest file in the namespace at 1211 lines. No dedicated test file for `living-brain.ts` exists outside the `__tests__/living-brain.test.ts`. This is a high-complexity single file; T1473 decomposed other files but `living-brain.ts` remains monolithic. Flag as P1 for decomposition consideration.

**P2 findings**:
- `workspace.ts:159` — `as unknown as Record<string, unknown>` for dynamic JSON config access. Should use a proper typed loader or a typed config schema.
- 12 `@deprecated` legacy function wrappers (in `discover.ts`, `deps.ts`, `permissions.ts`, `registry.ts`, `query.ts`) are retained for backward compat per ADR-057 D1. No cleanup task filed for their eventual removal once callers are migrated.
- No `README.md` in `packages/core/src/nexus/`. The namespace is large (11,572 LOC across 36 files) and would benefit from a README mapping sub-modules to capabilities.

---

### core/code — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/code/`
**Lines of code**: 26 LOC (index.ts is a deprecated shim barrel; actual implementation lives in `packages/nexus/src/code/` at 1238 LOC)
**Test files**: 0 test files directly for `packages/core/src/code/`. Tests for the actual implementation are in `packages/nexus/src/__tests__/` (6 test files).

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace |
| 2. Handler thinness | N-A | Core namespace |
| 3. Inline type leakage | GREEN | Zero. The shim is a 26-line pure re-export. |
| 4. Per-op imports | N-A | Core namespace |
| 5. Behavior markers | GREEN | Zero TODO/FIXME. |
| 6. Test coverage | YELLOW | No tests in `packages/core/src/code/`. Tests exist in `packages/nexus/src/__tests__/` which covers the real implementation. Coverage is indirect but real. |
| 7. Public surface | RED | `packages/core/src/code/index.ts` is marked `@deprecated` with a note to "import directly from `@cleocode/nexus` instead." The module exists purely as a backward-compatibility shim. Its `@deprecated` status means it has no meaningful public surface documentation. The canonical implementation is in `packages/nexus`, not `packages/core/src/code/`. This namespace is effectively a shell. |
| 8. Cross-domain coupling | YELLOW | The shim re-exports from `@cleocode/nexus`, creating a dependency from `packages/core` on `packages/nexus`. This is an inverted package dependency (core depending on a downstream package). The shim exists for backward-compat but this cross-boundary import is architecturally concerning per the package boundary contract (AGENTS.md). |
| 9. Dead code | YELLOW | The entire `packages/core/src/code/` namespace is deprecated. No cleanup task filed for its eventual removal. |
| 10. Documentation | RED | The only documentation is the `@deprecated` warning. No README. No ADR reference. No architecture doc. |

**P1 findings**:
- `packages/core/src/code/index.ts` — The entire namespace is `@deprecated` with its implementation migrated to `packages/nexus`. `packages/core` importing from `packages/nexus` violates the package boundary hierarchy (core is upstream; nexus should depend on core, not vice versa). File a cleanup task to either (a) remove the `code/` shim after auditing all callers, or (b) move code/nexus to a shared layer. This is an architectural inversion.

**P2 findings**:
- No follow-up task filed to remove the deprecated shim. This should be filed as a cleanup task with an explicit migration checklist.

---

### core/codebase-map — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/codebase-map/`
**Lines of code**: 451 LOC (index.ts + store.ts + summary.ts) + 955 LOC in `analyzers/` = 1406 LOC total
**Test files**: 0 test files. No `*.test.ts` found in `packages/core/src/codebase-map/`.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace |
| 2. Handler thinness | N-A | Core namespace |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` in the namespace. |
| 4. Per-op imports | N-A | Core namespace |
| 5. Behavior markers | GREEN | Only occurrence is in `analyzers/concerns.ts:39` — a `TODO_PATTERN` regex definition that scans source code for TODO markers. This is a scanner, not a stale annotation. |
| 6. Test coverage | RED | Zero test files. `mapCodebase`, `storeMapToBrain`, `generateCodebaseMapSummary` — all untested. This is a notable gap for a namespace that reads the filesystem and writes to brain.db. |
| 7. Public surface | YELLOW | `index.ts` exports interfaces and `mapCodebase`. Module-level TSDoc block (lines 1-4). `mapCodebase` function has no TSDoc comment (`export async function mapCodebase` with no `/** ... */` preceding it). Store and summary modules also lack function-level TSDoc. |
| 8. Cross-domain coupling | GREEN | Only internal imports (`./analyzers/...`, `./store.js`, `../store/project-detect.js`). No unexpected cross-domain coupling. |
| 9. Dead code | GREEN | Zero stale annotations. |
| 10. Documentation | RED | No README. No ADR references. Not documented in `docs/architecture/`. The namespace is self-contained but undocumented for agents consuming it. |

**P1 findings**:
- `packages/core/src/codebase-map/` — Zero test coverage. `mapCodebase` orchestrates 7 async analyzer imports, writes to brain.db via `storeMapToBrain`, and is the primary entry point for the ct-codebase-mapper skill. No tests = no regression protection. File a task to add at minimum a unit test with a real project directory fixture.

**P2 findings**:
- `codebase-map/index.ts:86` — `export async function mapCodebase(...)` has no TSDoc comment. Given this is the primary public API of the namespace, it should be documented.

---

### core/research — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/research/`
**Lines of code**: 1 LOC (`export * from '../memory/index.js';`)
**Test files**: 0

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace |
| 2. Handler thinness | N-A | Core namespace |
| 3. Inline type leakage | GREEN | N/A — 1-line barrel |
| 4. Per-op imports | N-A | Core namespace |
| 5. Behavior markers | GREEN | None |
| 6. Test coverage | RED | 0 tests. The re-exported memory symbols are tested in `packages/core/src/memory/__tests__/` but `research/index.ts` itself is untested as a barrel. |
| 7. Public surface | RED | `packages/core/src/research/index.ts` is a 1-line barrel that re-exports `../memory/index.js`. This is semantically confusing: a namespace named "research" re-exporting the entire "memory" module creates ambiguity about which domain owns these symbols. The `research` namespace appears to be a vestigial alias or a planned namespace that was never implemented. |
| 8. Cross-domain coupling | RED | The entire namespace is a re-export of `memory`. This is a namespace with no independent identity — it is 100% dependent on a sibling namespace. If the intent was to expose a distinct "research" surface, it is not implemented. If it is an alias, it should be `@deprecated`. |
| 9. Dead code | RED | `research/index.ts` is effectively dead namespace infrastructure. It adds no value beyond the memory module's own exports. No task filed for its resolution. |
| 10. Documentation | RED | No README. No TSDoc. No ADR references. No architecture doc. The 1-line file has no module docblock. |

**P0 findings**:
- `packages/core/src/research/index.ts` — The entire namespace is a 1-line re-export of `../memory/index.js` with no module documentation, no independent implementation, and no tests. This creates a confusing SSoT ambiguity: is `research` a domain or a memory alias? Either (a) the namespace should be developed into an actual research domain with its own types and functions, or (b) it should be `@deprecated` and removed, with callers redirected to `packages/core/src/memory`. As-is it is an undocumented dead namespace. File a task (parent T1520) to resolve this.

---

### core/intelligence — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/intelligence/`
**Lines of code**: 3262 LOC (6 files: adaptive-validation.ts 764, impact.ts 841, index.ts 66, patterns.ts 621, prediction.ts 621, types.ts 349)
**Test files**: 4 test files in `__tests__/` (98 tests, all pass):
- `adaptive-validation.test.ts`
- `impact.test.ts`
- `patterns.test.ts`
- `prediction.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace |
| 2. Handler thinness | N-A | Core namespace |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. Strict TypeScript throughout. |
| 4. Per-op imports | N-A | Core namespace |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK markers in the namespace. |
| 6. Test coverage | GREEN | 4 test files, 98 tests, all pass. Every major module (adaptive-validation, impact, patterns, prediction) has a dedicated test file. |
| 7. Public surface | YELLOW | `index.ts` has a comprehensive TSDoc block (lines 1-13) with task/epic refs. All major exports are individually re-exported with explicit type/value separation. `prediction.ts` has TSDoc on `calculateTaskRisk` (line 63) and `predictValidationOutcome` (line 123+) but `gatherLearningContext` (line 532) has only a minimal comment. `impact.ts` and `adaptive-validation.ts` have good TSDoc coverage overall. |
| 8. Cross-domain coupling | YELLOW | `intelligence/impact.ts:17-18` imports from `../tasks/graph-ops.js` and `../tasks/hierarchy.js`. This is an intra-core cross-namespace import (intelligence → tasks), which is architecturally expected since impact analysis inherently depends on the task graph. Flagged for awareness but not a violation. |
| 9. Dead code | GREEN | No stale annotations. `@task Wave3A` and `@epic T5149` references appear live. |
| 10. Documentation | RED | No README in `packages/core/src/intelligence/`. The CLAUDE.md project context file explicitly notes: "11 in code (10 canonical + intelligence undocumented)". This confirms the namespace is identified as undocumented. No ADR references in file headers beyond task/epic tags. Not in `docs/architecture/`. |

**P1 findings**:
- `packages/core/src/intelligence/` — The namespace is documented as undocumented in CLAUDE.md ("11 in code (10 canonical + intelligence undocumented)"). Despite 3262 LOC and 4 test files, there is no README, no ADR, and no architecture doc. Given the intelligence namespace is the foundation for the dispatch layer's quality-prediction features, this is a notable gap. File a task to add a README and, if warranted, an ADR covering the intelligence subsystem's design decisions.

**P2 findings**:
- `intelligence/impact.ts:17-18` — Cross-namespace coupling to `../tasks/graph-ops.js` and `../tasks/hierarchy.js`. Not a violation (intelligence depends on task graph by design) but worth documenting in a README or ADR so future agents understand the intentional coupling.
- `intelligence/prediction.ts:532` — `gatherLearningContext` has only a stub comment (`/**`). Should be fully documented with parameter descriptions and return type explanation given it is exported from the public surface.

---

## Overall recommendations

1. **P0: Resolve `core/research` namespace** — The namespace is a 1-line re-export of memory with no identity. Either implement it as a genuine research domain or deprecate and remove it. File as new task (parent T1520).

2. **P1: Migrate `intelligence` dispatch to OpsFromCore** — `IntelligenceHandler` is the only major dispatch domain not using `defineTypedHandler`/`OpsFromCore`. All 5 case branches are fat (42–52 LOC) and contain orchestration logic that should be in Core. File a typed-dispatch migration task for intelligence (parent T1520, mirroring T1424 Wave D approach).

3. **P1: Move `handleTopEntries` and `handleImpact` from nexus.ts dispatch to Core** — 587 LOC of imperative DB logic lives in the dispatch layer, bypassing typed dispatch. These should be encapsulated in `packages/core/src/nexus/` functions and called via `wrapCoreResult`. The bypasses were documented as "legacy" in T1492 comments but no follow-up task was filed.

4. **P1: Resolve `core/code` architectural inversion** — `packages/core` importing from `packages/nexus` (a downstream package) violates the package hierarchy. The deprecated shim in `packages/core/src/code/` needs a cleanup task with a caller audit before removal.

5. **P1: Add test coverage for `core/codebase-map`** — Zero tests for a namespace with filesystem I/O and brain.db writes. File a task for basic unit tests.

6. **P1: Document `core/intelligence` namespace** — Create a README and file at minimum a lightweight ADR covering the intelligence subsystem's design. CLAUDE.md already identifies this gap.

7. **P2: File cleanup task for 12 `@deprecated` legacy wrappers in `core/nexus`** — `discover.ts`, `deps.ts`, `permissions.ts`, `registry.ts`, `query.ts` each have deprecated functions retained for ADR-057 backward compatibility. These should be removed once all callers migrate. File a cleanup task with a staleness deadline.

8. **P2: Add README to `packages/core/src/nexus/`** — 11,572 LOC across 36 files is the largest namespace in scope. A README mapping sub-modules to capabilities would significantly aid onboarding agents.

9. **P2: Confirm T1519 is live for `route-analysis.ts:162` `T1XXX` placeholder** — The placeholder was flagged by T1519 (P2-NEW-4). Verify T1519 is open and linked to the AST-based shape inference epic.

## New follow-up tasks to file

| Title | Parent | Acceptance |
|-------|--------|------------|
| Resolve core/research namespace: implement or deprecate+remove | T1520 | Namespace either has own types/functions or is removed; no bare re-export of memory |
| Migrate IntelligenceHandler to OpsFromCore typed-dispatch (ADR-058) | T1520 | All 5 operations use defineTypedHandler; no manual `as string` casts |
| Move handleTopEntries/handleImpact from nexus.ts dispatch to Core nexus | T1520 | nexus.ts dispatch ≤800 LOC; both ops route via wrapCoreResult |
| Add test coverage for packages/core/src/codebase-map | T1520 | ≥1 test file covering mapCodebase with a fixture directory |
| Document intelligence namespace: README + ADR | T1520 | README present in packages/core/src/intelligence/; ADR filed |
| Cleanup core/code deprecated shim + architectural inversion audit | T1520 | packages/core has no import from packages/nexus |
| File cleanup task for @deprecated ADR-057 D1 legacy wrappers in core/nexus | T1520 | Task filed with caller-audit checklist and staleness deadline |

---

## Cross-references

- **ADR-057** (`docs/adr/ADR-057-contracts-core-ssot.md`) — Referenced in `core/nexus` deprecated function annotations.
- **ADR-058** (`docs/adr/ADR-058-dispatch-type-inference.md`) — Governs dispatch handler thinness, OpsFromCore inference, and per-op import restrictions. Nexus dispatch GREEN; Intelligence dispatch RED on criteria 1 & 2.
- **ADR-059** (`docs/adr/ADR-059-override-pumps.md`) — Not directly referenced in scope files; no violations found.
- **T1424** — Wave D typed-dispatch migration that produced `nexus.ts`'s current architecture.
- **T1440** — OpsFromCore migration for nexus dispatch.
- **T1473** — Nexus decomposition (5366 → 4084 LOC in dispatch; 9 new core/nexus files). `living-brain.ts` (1211 LOC) was not decomposed.
- **T1492** — Further dispatch thinning. `top-entries` and `impact` noted as bypasses.
- **T1519** — P2-NEW-4: T1XXX placeholder in `route-analysis.ts:162`.
- **T1525** — This audit task.

## Files reviewed (counts)

| Package | Files | LOC |
|---------|-------|-----|
| `packages/cleo/src/dispatch/domains/nexus.ts` | 1 | 1,292 |
| `packages/cleo/src/dispatch/domains/intelligence.ts` | 1 | 262 |
| `packages/core/src/nexus/` (all .ts, excl. tests) | ~34 | ~11,572 |
| `packages/core/src/code/` | 1 | 26 |
| `packages/core/src/codebase-map/` (all .ts) | 10 | ~1,406 |
| `packages/core/src/research/` | 1 | 1 |
| `packages/core/src/intelligence/` (all .ts, excl. tests) | 6 | 3,262 |
| **Total** | **~54** | **~17,821** |
