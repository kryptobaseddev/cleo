# Audit Report — Teammate 9: Docs-Compliance-Agents-Skills

**Auditor**: T1529 (CLEO task ID)
**Scope**: dispatch/docs + core/adrs + core/compliance + core/issue + core/templates + core/agents + core/caamp + core/harness + core/skills
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | LOC | Overall Verdict | Critical Findings |
|------|------|-----|----------------|-------------------|
| dispatch/docs | dispatch | 630 | RED | 1 P0 (OpsFromCore not adopted), 1 P1 (all 5 handlers >>5 LOC) |
| core/adrs | core | 918 | YELLOW | 0 P0, 1 P1 (no unit tests), 1 P2 (no README) |
| core/compliance | core | 1935 | YELLOW | 0 P0, 1 P1 (minimal TSDoc), 1 P2 (no README) |
| core/issue | core | 552 | YELLOW | 1 P1 (DRY violation — duplicate parseIssueTemplates), 1 P2 (no tests) |
| core/templates | core | 367 | YELLOW | 1 P1 (DRY violation — duplicate of issue/template-parser), 1 P2 (no tests) |
| core/agents | core | 4305 | GREEN | 0 P0, 1 P1 (3× `any` in invoke-meta-agent.ts, biome-suppressed) |
| core/caamp | core | 411 | GREEN | 0 P0, 0 P1, 1 P2 (no tests, no README) |
| core/harness | core | 164 | GREEN | 0 P0, 0 P1, 0 P2 |
| core/skills | core | 5400+ | YELLOW | 1 P1 (research.ts @deprecated annotation — valid but SSoT ambiguous) |

**Totals**: 1 P0, 7 P1, 7 P2 across 9 areas.
**All tests pass**: 23 test files / 360 tests green (combined run).

---

## Per-Area Findings

---

### dispatch/docs — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/docs.ts`
**Lines of code**: 630
**Test files**: 2 — `packages/cleo/src/dispatch/domains/__tests__/docs.test.ts` (23 tests, PASS), `packages/cleo/src/cli/__tests__/docs.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | Implements raw `DomainHandler` interface — NOT migrated to `OpsFromCore<...>` or `TypedDomainHandler<DocsOps>`. `DocsOps` discriminated union exists in `@cleocode/contracts/operations/docs.ts` but is unused here. Other handlers (admin, conduit, nexus, sentient, session, tasks) have completed migration. |
| 2. Handler thinness | RED | ALL 5 cases exceed the 5 LOC threshold — list (~56 LOC), generate (~66 LOC), fetch (~87 LOC), add (~167 LOC), remove (~88 LOC). File contains imperative logic: file I/O, MIME detection, SHA-256 resolution, v2 mirror writes, llmtxt graph node population — all belong in Core. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains in source. ✓ |
| 4. Per-op contract imports | GREEN | No per-op contract imports (`DocsListParams`, `DocsFetchParams`, etc. are NOT imported). Handler uses raw `params?.field as string` extraction. Contract exists but is unused — not the per-op import anti-pattern, but not wired at all. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. Task refs (T947, T945) are live or archived. |
| 6. Test coverage | GREEN | 23 tests pass. Tests validate E_INVALID_INPUT paths and domain registry shape. Integration tests delegated to attachment-store tests per design note. |
| 7. Public surface | N-A | Dispatch domain — not a core public API. |
| 8. Cross-domain coupling | YELLOW | Imports directly from `@cleocode/core/internal` (createAttachmentStore, createAttachmentStoreV2, generateDocsLlmsTxt, resolveAttachmentBackend, getProjectRoot, getCleoDirAbsolute, ensureLlmtxtNode). This is expected at dispatch layer but the handler also calls `import('@cleocode/core/internal')` dynamically for fire-and-forget graph writes — a pattern that bypasses normal dependency tracking. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale deprecated annotations. |
| 10. Documentation | YELLOW | TSDoc on module-level (lines 1-19) and helper functions. No README. ADR refs: mentions `@epic T760` / `@task T797`. Does not reference ADR-058 migration status. |

**P0 findings**:
- `packages/cleo/src/dispatch/domains/docs.ts:110` — Handler implements `DomainHandler` (raw untyped interface) rather than `TypedDomainHandler<DocsOps>` with `OpsFromCore` inference per ADR-058. `DocsOps` discriminated union is defined in `@cleocode/contracts/operations/docs.ts` but never consumed by the dispatch handler. This is the only remaining unmitigated dispatch domain not on OpsFromCore.

**P1 findings**:
- `packages/cleo/src/dispatch/domains/docs.ts:353` — `add` handler is ~167 LOC. Contains: file I/O (`readFile`), MIME detection, `createAttachmentStore().put()`, v2 store mirror write, fire-and-forget dynamic import for graph node (`ensureLlmtxtNode`). This imperative logic belongs in Core.
- `packages/cleo/src/dispatch/domains/docs.ts:247` — `fetch` handler is ~87 LOC. Contains SHA-256 path derivation logic and inline `extMap` that duplicates MIME-detection logic already present in `mimeFromPath`.
- `packages/cleo/src/dispatch/domains/docs.ts:522` — `remove` handler is ~88 LOC. Contains v2 mirror remove logic inline.

**P2 findings**:
- Line 436–447, 480–487 — Dynamic `import('@cleocode/core/internal')` inside handler cases (fire-and-forget llmtxt graph writes). While guarded with `.catch()`, these deferred imports make the dependency graph opaque and bypass any static analysis. Should be a pre-resolved function reference.

---

### core/adrs — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/adrs/`
**Lines of code**: 918 (9 files)
**Test files**: 0 unit tests in namespace; `adrs` functions mocked in `dispatch/domains/__tests__/admin.test.ts` and `registry-parity.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace — not dispatch. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`, `unknown`, or cast chains. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME. Two `SSoT-EXEMPT` annotations in `sync.ts:73` and `validate.ts:41` — both are correctly justified (zero-params ops, ADR-057 D1). |
| 6. Test coverage | RED | No test files in `packages/core/src/adrs/`. Functions are only mocked (not called) in dispatch tests. `syncAdrsToDb`, `parseAdrFile`, `validateAllAdrs`, `findAdrs` have zero direct unit test coverage. |
| 7. Public surface | GREEN | Clean barrel export in `index.ts` — 12 named exports with types. TSDoc present on most exported types. |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/contracts` (typed params), `ajv` (JSON schema), and sibling `../store/tasks-schema.js`, `../pagination.js` — all expected. |
| 9. Dead code | GREEN | SSoT-EXEMPT annotations valid. No deprecated or stale markers. |
| 10. Documentation | YELLOW | ADR-017 referenced throughout (module header, function docs). No README file in namespace directory. Not covered in `docs/architecture/`. |

**P1 findings**:
- `packages/core/src/adrs/` — Zero unit tests for any of the 9 source files. Core ADR functions (`syncAdrsToDb`, `findAdrs`, `validateAllAdrs`, `parseAdrFile`) are called by production dispatch paths but only mocked in dispatch tests. Direct unit tests needed.

**P2 findings**:
- No `README.md` in namespace. Given this implements a full ADR registry per ADR-017, a brief README would help navigation.

---

### core/compliance — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/compliance/`
**Lines of code**: 1935 (5 source files + 1 test)
**Test files**: 1 — `__tests__/sync.test.ts` (6 tests, PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | YELLOW | `compliance/index.ts` uses `Record<string, unknown>` extensively (return types: lines 17, 59, 101, 144, 183, 275, 303). These are not `any` but represent loosely-typed shapes that could have proper interfaces. `protocol-enforcement.ts` uses `Record<string, unknown>` for manifest entries (lines 96, 97, 139, 140, 169). Total: ~14 occurrences, all rationale-justified (JSONL data from variable-schema source). |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | `sync.test.ts` covers `syncComplianceMetrics` (6 cases). But `getComplianceSummary`, `listComplianceViolations`, `getComplianceTrend`, `auditEpicCompliance`, `getSkillReliability`, `getValueMetrics`, and `protocol-enforcement.ts` have no tests. |
| 7. Public surface | YELLOW | Clean barrel export in `index.ts` re-exports all functions. TSDoc is minimal — single-line `/** Get compliance summary. */` style rather than full parameter documentation. `protocol-enforcement.ts` and `protocol-rules.ts` have no barrel exports — only used internally. |
| 8. Cross-domain coupling | GREEN | Imports from `../paths.js`, `../store/atomic.js`, sibling `./store.js` — all within expected bounds. `protocol-enforcement.ts` only imports from sibling files. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, deprecated, or stale markers. |
| 10. Documentation | YELLOW | Task references (`@task T4535`, `@epic T4454`). No README. Not in `docs/architecture/`. ADR-051/057/058/059 not referenced. |

**P1 findings**:
- `packages/core/src/compliance/index.ts` — 6 of 7 exported functions have no unit tests. Only `syncComplianceMetrics` is tested. The protocol-enforcement subsystem (`protocol-enforcement.ts`, `protocol-rules.ts`, `protocol-types.ts`) has zero test coverage.

**P2 findings**:
- TSDoc on exported functions is minimal (single-line comments). Functions like `getComplianceTrend`, `auditEpicCompliance`, `getValueMetrics` lack param-level documentation.
- No README in namespace directory.

---

### core/issue — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/issue/`
**Lines of code**: 552 (4 source files)
**Test files**: 0 unit tests in namespace

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | Zero unit tests in namespace. `addIssue` and template-parsing functions have no direct test coverage. |
| 7. Public surface | YELLOW | Clean barrel export. TSDoc on exported function types (`AddIssueParams`, `AddIssueResult`, `IssueTemplate`). Some exported functions lack TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports `ExitCode` from `@cleocode/contracts`, `BUILD_CONFIG` from `../config/build-config.js`, `CleoError` from `../errors.js`, `getCleoDir/getProjectRoot` from `../paths.js`. All within expected scope. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | Task references in headers. No README. |

**P1 findings**:
- `packages/core/src/issue/template-parser.ts:148` and `packages/core/src/templates/parser.ts:185` — **DRY VIOLATION**: Both files independently implement `parseIssueTemplates` and `getTemplateForSubcommand`. The `issue/template-parser.ts` version returns `IssueTemplate[]` and uses `.cleo/` cache path; the `templates/parser.ts` version returns `TemplateResult<TemplateConfig>` (different shape) with YAML-based parsing. Both are exported from their respective `index.ts` barrels AND both are imported from `@cleocode/core/internal`. This creates two parallel template-parsing surfaces that diverge in API and behavior. One of these modules should be the SSoT or clearly labelled as the legacy path.

**P2 findings**:
- Zero unit tests for `addIssue`, `buildIssueBody`, or `parseIssueTemplates` in the issue namespace.
- No README in namespace.

---

### core/templates — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/templates/`
**Lines of code**: 367 (2 source files)
**Test files**: 0 unit tests in namespace

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | Zero unit tests for `parseIssueTemplates`, `getTemplateForSubcommand`, `generateTemplateConfig`, or `validateLabels`. |
| 7. Public surface | GREEN | Clean barrel export. `IssueTemplate`, `TemplateConfig`, `TemplateResult`, `TemplateSection` types all exported. Functions have TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports from `fs`, `path`, `yaml`, and `../platform.js` — all expected. No cross-domain leakage. |
| 9. Dead code | GREEN | No stale annotations. `@task T5705` / `@epic T5701` are task-tagged. |
| 10. Documentation | YELLOW | Task references in header. No README. Not in `docs/architecture/`. |

**P1 findings**:
- `packages/core/src/templates/parser.ts` — The `templates` namespace implements `parseIssueTemplates` / `getTemplateForSubcommand` independently from `issue/template-parser.ts`. They have different return types (`TemplateResult<TemplateConfig>` vs `IssueTemplate[]`) and different storage mechanisms. Both appear in `@cleocode/core/internal`. The newer `templates/parser.ts` (task T5705 / epic T5701) appears to be the intended replacement for `issue/template-parser.ts` (task T4454) but this isn't documented and migration isn't complete. **This is a code-smell P1 tied to the same DRY violation noted in core/issue.**

**P2 findings**:
- Zero unit tests for any function in this namespace.
- No README documenting the relationship to `issue/template-parser.ts`.

---

### core/agents — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/agents/`
**Lines of code**: 4305 (12 source files)
**Test files**: 9 — agent-registry, capacity, execution-learning, health-monitor, registry, retry, seed-install-meta, seed-install, variable-substitution (188 tests, ALL PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | YELLOW | 3 occurrences in `invoke-meta-agent.ts` (lines 122, 157, 325): `nexusDb?: any` — all three annotated with `// biome-ignore lint/suspicious/noExplicitAny: nexusDb is a Drizzle database handle; typed as any to avoid circular imports`. The circular import justification is plausible (nexus package imports agents package), but a proper fix via `unknown` + type guard or a shared type from contracts would eliminate this. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK in source files. |
| 6. Test coverage | GREEN | 9 test files, 188 tests, all passing. Excellent coverage across registry, capacity, health, execution learning, retry, seed-install, and variable-substitution. `invoke-meta-agent.ts` and `resolveStarterBundle.ts` are the only files without dedicated tests. |
| 7. Public surface | GREEN | Extensive, well-documented barrel in `index.ts`. TSDoc present on all exported functions and types. Module-level docstring explains the dimension (Registry, Health, Self-Healing, Capacity). |
| 8. Cross-domain coupling | YELLOW | `invoke-meta-agent.ts` imports from `../nexus/user-profile.js` (line 159 — deferred dynamic import) and uses `@cleocode/contracts` types. `execution-learning.ts` imports `BrainDataAccessor` from `../store/memory-accessor.js`. `seed-install.ts` imports from `../skills/...` (indirect coupling). These are expected for the agents dimension but the dynamic import in invoke-meta-agent creates opacity. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no deprecated markers. |
| 10. Documentation | YELLOW | Excellent in-file TSDoc. No README in namespace. ADR-055 D034 referenced in `invoke-meta-agent.ts` header. |

**P1 findings**:
- `packages/core/src/agents/invoke-meta-agent.ts:122,157,325` — Three `nexusDb?: any` usages with biome-ignore suppressions. The justification (circular import avoidance) is valid but the anti-pattern exists. A forward-declared type in `@cleocode/contracts` for the Drizzle database handle shape would eliminate all three. Track as P1 per zero-tolerance policy in AGENTS.md.

**P2 findings**:
- No README in namespace.
- `invoke-meta-agent.ts` and `resolveStarterBundle.ts` lack direct unit tests.

---

### core/caamp — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/caamp/`
**Lines of code**: 411 (3 source files)
**Test files**: 0 in namespace; CAAMP package itself has 5 test files (`packages/caamp/tests/unit/`)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | No tests in `core/src/caamp/`. The `adapter.ts` wraps `@cleocode/caamp` functions into `EngineResult`-returning forms — those underlying functions are tested in `packages/caamp/tests/`. The wrapping layer itself (`batchInstallWithRollback`, `injectionCheck`, `injectionUpdate`, etc.) has no dedicated tests to verify the EngineResult envelope wrapping. |
| 7. Public surface | GREEN | Clean barrel export in `index.ts`. `adapter.ts` is the "SINGLE SOURCE OF TRUTH" per its header comment. Both files have TSDoc. `capability-check.ts` exported cleanly. |
| 8. Cross-domain coupling | GREEN | `adapter.ts` imports from `@cleocode/caamp` only. `capability-check.ts` imports from `@cleocode/caamp`. `adapter.ts` imports `EngineResult` from `../engine-result.js`. All expected. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | TSDoc present on functions. No README. ADR refs: `@task T4678` / `@epic T4663` but no ADR-051/057/058/059 references. |

**P2 findings**:
- No unit tests covering the `EngineResult` envelope wrapping in `adapter.ts`.
- No README in namespace.

---

### core/harness — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/harness/`
**Lines of code**: 164 (3 source files)
**Test files**: 1 — `__tests__/spawn-provider-selection.test.ts` (3 tests, PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | 3 tests pass. The `spawn-provider-selection.ts` is tested but only 3 cases — given the selection logic drives all multi-agent spawns, broader coverage of edge cases (all providers, fallback chains) would be appropriate. |
| 7. Public surface | GREEN | Minimal, focused barrel export (3 exports: 1 function + 2 types). TSDoc present on types. |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/contracts` (`CLEOSpawnAdapter`), `../engine-result.js`, `../spawn/adapter-registry.js` — all within expected SDK glue scope. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | Module-level TSDoc in `index.ts`. No README. No ADR references (relevant ADRs: ADR-035, ADR-049, ADR-055). |

**P2 findings**:
- No README.
- Spawn-provider-selection test coverage is sparse (3 cases) for a critical path component.

---

### core/skills — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/skills/`
**Lines of code**: 5400+ (23 source files across root + agents/ injection/ manifests/ orchestrator/ subdirs)
**Test files**: 11 — discovery, dispatch, dynamic-skill-generator, manifests, precedence, routing-table, skill-paths, test-utility, token, validation, version (140 tests, ALL PASS)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`/`unknown`/cast chains in production source files. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | YELLOW | `manifests/research.ts:6` — `@deprecated Use pipeline_manifest via cleo manifest CLI (ADR-027).` The ADR-027 file does not exist in `docs/adr/` (only ADR-051 through ADR-059 are present). T1119 (follow-up to migrate MANIFEST.jsonl entries) is `pending` status — so the deprecated annotation is live/valid but the reference ADR-027 cannot be verified from the codebase. |
| 6. Test coverage | GREEN | 11 test files, 140 tests, all passing. Strong coverage: discovery, dispatch, precedence, routing-table, skill-paths, token injection, validation, and version checking all tested. `manifests/research.ts` is not directly tested (deprecated) but is covered by `manifests.test.ts`. |
| 7. Public surface | GREEN | Large but clean barrel export in `index.ts` (207 LOC). All exported symbols have TSDoc. Types, functions, and re-exports are well organized. `SKILL_NAME_MAP` constant exported. |
| 8. Cross-domain coupling | YELLOW | `skills/routing-table.ts` imports from `../routing/capability-matrix.js` — an out-of-namespace import. `skills/index.ts` re-exports `catalog` from `@cleocode/caamp` (external package). `skills/dispatch.ts` imports `CtDispatchMatrix` and `catalog` from `@cleocode/caamp`. These cross-boundary imports are intentional by design (skills orchestrates CAAMP) but should be documented. |
| 9. Dead code | YELLOW | `manifests/research.ts` is marked `@deprecated` but still exported from `skills/index.ts` (lines 88-99) as the active research manifest API. The deprecated annotation says "Use pipeline_manifest via cleo manifest CLI" but no migration path is clearly documented within the code. T1119 is pending. This is a legitimate stale-ish annotation. |
| 10. Documentation | YELLOW | No README in skills namespace. ADR references are present in individual files (ADR-027 in research.ts). The skills system is large enough to warrant a README explaining the orchestrator/, injection/, manifests/, and agents/ subdirectories. |

**P1 findings**:
- `packages/core/src/skills/manifests/research.ts:6` — `@deprecated` annotation references ADR-027 which has no file in `docs/adr/`. The deprecated module is still actively exported and used. T1119 (migration task) is `pending`. This is an ambiguous SSoT state: the code is deprecated but the replacement is not complete. Should be tracked explicitly.

**P2 findings**:
- No README in skills namespace.
- `routing-table.ts` imports from `../routing/capability-matrix.js` — undocumented cross-namespace dependency.
- The `manifests/contribution.ts`, `manifests/resolver.ts`, `orchestrator/spawn.ts`, `orchestrator/startup.ts`, `orchestrator/validator.ts` subdirectories have no dedicated test files (though some are covered via integration).

---

## Cross-Cutting Issues

### DRY Violation: Issue + Templates Namespace Duplication (P1)

Both `core/issue/template-parser.ts` and `core/templates/parser.ts` implement `parseIssueTemplates` and `getTemplateForSubcommand`. They have different return types and different behavior. Both are exported from `@cleocode/core/internal`. This creates two competing template-parsing surfaces that will diverge and cause confusion.

**Evidence**:
- `packages/core/src/issue/template-parser.ts:148` — `function parseIssueTemplates(projectDir?: string): IssueTemplate[]`
- `packages/core/src/templates/parser.ts:185` — `function parseIssueTemplates(projectRoot: string): TemplateResult<TemplateConfig>`

**Recommendation**: File a cleanup task to designate one as SSoT (likely `templates/parser.ts` per its newer task ID T5705 vs T4454) and have `issue/template-parser.ts` delegate to it or be deprecated.

### docs.ts Dispatch Migration Gap (P0)

`dispatch/docs.ts` is the only dispatch domain handler in the codebase that has NOT migrated to `TypedDomainHandler<DocsOps>` / `OpsFromCore` pattern per ADR-058. The contracts file (`packages/contracts/src/operations/docs.ts`) exists and defines `DocsOps` with all 5 operations. The migration work exists for all other handlers but docs remains on raw `DomainHandler`. This blocks full type-safety at the dispatch boundary.

---

## Overall Recommendations

1. **File T1529-FU-1**: Migrate `dispatch/docs.ts` to `TypedDomainHandler<DocsOps>` per ADR-058. Move imperative logic (file I/O, MIME detection, v2 mirror writes, llmtxt graph calls) to Core. `add` handler (~167 LOC) has the most to extract.

2. **File T1529-FU-2**: Add unit tests for `core/adrs/` namespace. `syncAdrsToDb`, `findAdrs`, `validateAllAdrs`, `listAdrs` are called by production dispatch but only mocked. Direct unit tests for each function needed.

3. **File T1529-FU-3**: Resolve `issue/template-parser.ts` vs `templates/parser.ts` duplication. Designate canonical SSoT, deprecate the other, and add tests for whichever survives.

4. **File T1529-FU-4**: Fix `invoke-meta-agent.ts:122,157,325` — add a shared `DrizzleNexusDb` type to `@cleocode/contracts` to eliminate the three `any` biome-suppressed usages.

5. **File T1529-FU-5**: Add unit tests for `core/compliance/` (6 untested functions) and `core/caamp/` (EngineResult wrapping layer).

6. **File T1529-FU-6**: Add README files to all 8 core namespaces audited. They are large (skills: 5400+ LOC) and lack orientation documentation.

7. **File T1529-FU-7**: Fix `manifests/research.ts` @deprecated annotation — either link to ADR-027 (create the doc) or update to reference T1119 directly so the migration path is clear.

---

## Follow-Up Tasks Filed

Tasks filed to CLEO (`cleo add`) post-audit, parent T1520:

> Note: Tasks will be filed separately per workflow — listed here for tracking.

| Title | Priority | Parent | Acceptance |
|-------|----------|--------|------------|
| Migrate dispatch/docs.ts to TypedDomainHandler + thin handlers per ADR-058 | high | T1520 | handler ≤5 LOC per case; uses TypedDomainHandler<DocsOps>; tests pass |
| Add unit tests for core/adrs namespace (syncAdrsToDb, findAdrs, validateAllAdrs, listAdrs) | medium | T1520 | ≥1 test per exported function; all pass |
| Resolve issue/template-parser.ts vs templates/parser.ts DRY violation — designate SSoT | medium | T1520 | one module marked deprecated or removed; tests for surviving module |
| Add shared DrizzleNexusDb type to contracts to replace 3 `any` in invoke-meta-agent.ts | medium | T1520 | zero biome-suppress in invoke-meta-agent.ts; tsc passes |
| Add unit tests for core/compliance (6 untested functions + protocol-enforcement) | medium | T1520 | ≥1 test per function; protocol-enforcement covered |
| Add README files to adrs, compliance, issue, templates, agents, caamp, harness, skills namespaces | low | T1520 | README.md in each namespace dir; explains purpose and ADR refs |

---

## Cross-References

- **ADR-058**: Dispatch type inference — `dispatch/docs.ts` is NON-COMPLIANT (P0)
- **ADR-057**: Contracts Core SSoT — `core/adrs/` SSoT-EXEMPT annotations verified valid
- **ADR-017**: ADR registry spec — `core/adrs/` implements this; referenced throughout
- **ADR-055**: Agents architecture — `core/agents/invoke-meta-agent.ts` references D034
- **ADR-027**: Pipeline manifest — referenced in `skills/manifests/research.ts` but file not present in `docs/adr/`

**CLEO tasks linked**:
- T1529 (this audit)
- T1520 (audit epic, parent)
- T797 (docs dispatch implementation task, archived)
- T947 (llmtxt v2 adoption, archived — wave B comments in docs.ts)
- T945 (Universal Semantic Graph, pending — fire-and-forget ensureLlmtxtNode calls)
- T1119 (MANIFEST.jsonl migration, pending — validates research.ts @deprecated)

**Files reviewed**: 9 areas, ~15,000 LOC total
- 1 dispatch domain: `packages/cleo/src/dispatch/domains/docs.ts` (630 LOC)
- 8 core namespaces: adrs (918), compliance (1935), issue (552), templates (367), agents (4305), caamp (411), harness (164), skills (5400+)
- 1 contracts file: `packages/contracts/src/operations/docs.ts` (323 LOC)
- 3 supporting test/dispatch files reviewed for context

**Test run**: 23 test files, 360 tests, all green at HEAD `bc8730617ff5f83b0389b484d3edfc3e2c6f4291`
