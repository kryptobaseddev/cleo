# Audit Report — Teammate 10: Foundation-Crosscutting Namespaces

**Auditor**: T1530 (CLEO task ID)
**Scope**: 10 core namespaces — adapters, context, inject, lib, migration, reconciliation, routing, snapshot, security, coreHooks (hooks/)
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive summary

| Area | Type | Overall verdict | Critical findings |
|------|------|----------------|-------------------|
| adapters | core | YELLOW | 1 P2 |
| context | core | RED | 1 P0, 1 P2 |
| inject | core | YELLOW | 1 P2 |
| lib | core | YELLOW | 2 P2 (justified `any`) |
| migration | core | YELLOW | 1 P1, 1 P2 |
| reconciliation | core | RED | 1 P0 |
| routing | core | YELLOW | 1 P2 |
| snapshot | core | YELLOW | 1 P2 |
| security | core | GREEN | 0 |
| coreHooks (hooks/) | core | YELLOW | 1 P1, 1 P2 |

**Summary**: 0 areas RED-critical (security is fully GREEN), 2 areas RED due to zero test coverage (context, reconciliation), 7 YELLOW, 1 GREEN. Total: 2 P0, 1 P1, 9 P2 findings.

---

## Per-area findings

---

### adapters — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/adapters/`
**Files**: `adapter-registry.ts` (72 LOC), `discovery.ts` (86 LOC), `index.ts` (10 LOC), `manager.ts` (298 LOC) — 466 total
**Test files**: 2 tests at `__tests__/discovery.test.ts`, `__tests__/manager.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` in source files |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | GREEN | 2 test files, all pass (144 tests in combined run) |
| 7. Public surface | YELLOW | `index.ts` exports clean named API with TSDoc; module-level TSDoc references `@task T5240` but no ADR reference in the index |
| 8. Cross-domain coupling | GREEN | Only expected imports: `../hooks/registry.js`, `../hooks/types.js`, `../logger.js` — all infrastructure |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale task references |
| 10. Documentation | YELLOW | No README.md; TSDoc on exported items present but sparse |

**P2 findings** (cleanup):
- `packages/core/src/adapters/index.ts` — Missing README.md for namespace; no ADR reference in module docs. Consider adding `@see ADR-055` given adapter sovereignty relates to that ADR.

---

### context — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/context/`
**Files**: `index.ts` (159 LOC)
**Test files**: 0 — no test files found anywhere for `getContextStatus`, `checkContextThreshold`, `listContextSessions`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Return types declared as `Record<string, unknown>` which is appropriate for the opaque state file format; no `: any` or `as any` |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | RED | **No test files exist** for context module. Three exported functions (`getContextStatus`, `checkContextThreshold`, `listContextSessions`) are untested. The staleness logic (`staleAfterMs` check) and exit-code mapping are load-bearing runtime behaviors with zero automated coverage. |
| 7. Public surface | YELLOW | Three clean exported functions with `/** ... */` TSDoc; no `@task` or `@epic` on the functions themselves (only on the module header). Return types use `Record<string, unknown>` which loses structural typing — callers cannot statically validate the shape. |
| 8. Cross-domain coupling | GREEN | Zero cross-domain imports; only Node `fs` and `path` builtins |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations |
| 10. Documentation | RED | No README.md; no ADR reference; docs/architecture/ has no context-module doc |

**P0 findings** (immediate action):
- `packages/core/src/context/index.ts` — **Zero test coverage** for all three exported functions. The `checkContextThreshold` exit-code map (ok→0, warning→50, caution→51, critical→52, emergency→53, stale→54) is especially fragile — a one-off integer change would be undetected. File new test task with `vitest run` gate.

**P2 findings** (cleanup):
- `packages/core/src/context/index.ts:37,77` — Return type `Record<string, unknown>` loses structural typing. Consider defining `ContextStatus` and `ThresholdCheckResult` interface types in `@cleocode/contracts` and returning those instead.

---

### inject — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/inject/`
**Files**: `index.ts` (111 LOC)
**Test files**: 0 — no dedicated test files; `injection-shared.test.ts` and `injection-chain.test.ts` in parent `__tests__/` cover the injection chain but not `injectTasks` directly

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | YELLOW | No dedicated test for `injectTasks`. Parent `injection-shared.test.ts` and `injection-chain.test.ts` cover injection at the CLI layer but not the `selectTasksForInjection` sort/filter logic or `formatForInjection` output format directly |
| 7. Public surface | YELLOW | Single exported function `injectTasks` has TSDoc. Internal helpers `selectTasksForInjection` and `formatForInjection` are not exported (correct). Module header contains an ARCHITECTURE NOTE about CAAMP delegation, which is a valuable live design decision — not stale. |
| 8. Cross-domain coupling | GREEN | Only imports `../store/data-accessor.js` (expected infrastructure) and `@cleocode/contracts` |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations. ARCHITECTURE NOTE in header is a live design TODO (CAAMP integration) not a stale FIXME |
| 10. Documentation | YELLOW | No README.md; ARCHITECTURE NOTE functions as lightweight doc |

**P2 findings** (cleanup):
- `packages/core/src/inject/index.ts` — Add a unit test for `selectTasksForInjection` (especially priority sort and focusedOnly filter) and `formatForInjection` (prefix format). The filtering logic is not covered by any test found in the codebase.

---

### lib — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/lib/`
**Files**: `index.ts` (24 LOC), `retry.ts` (224 LOC), `suppress-sqlite-warning.ts` (32 LOC), `tree-sitter-languages.ts` (92 LOC)
**Test files**: 2 tests at `__tests__/retry.test.ts`, `__tests__/suppress-sqlite-warning.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | YELLOW | 2 `any` usages in `suppress-sqlite-warning.ts:21,31` — BOTH have `biome-ignore` suppressions with explicit justification ("process.emitWarning has complex overloads that cannot be matched by a single function type"; "forwarding to original emitWarning overloads"). These are the only workaround possible for Node.js process type monkeypatching. Justified — not actionable. |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | GREEN | 2 test files pass; retry and suppress-sqlite-warning both covered |
| 7. Public surface | GREEN | `index.ts` exports `withRetry`, `computeDelay`, `detectLanguage`, `SUPPORTED_EXTENSIONS` etc. with TSDoc. Module header clearly states "dependency-free" constraint. `tree-sitter-languages.ts` is NOT exported through `index.ts` — it appears to be exported directly from `packages/core/src/index.ts` — this is consistent |
| 8. Cross-domain coupling | GREEN | Zero external domain imports; only `node:` builtins |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations |
| 10. Documentation | YELLOW | No README.md; module-level TSDoc in `index.ts` serves as docs |

**P2 findings** (cleanup):
- `packages/core/src/lib/suppress-sqlite-warning.ts:21,31` — `any` usage is justified by biome-ignore comments. These will remain flagged by any generic audit script but are not actionable. Consider adding a note to the lib README (once created) explaining this intentional exception.

---

### migration — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/migration/`
**Files**: `agent-outputs.ts` (387 LOC), `checksum.ts` (114 LOC), `index.ts` (405 LOC), `logger.ts` (474 LOC), `preflight.ts` (10 LOC), `state.ts` (539 LOC), `validate.ts` (292 LOC) — 2221 total
**Test files**: 5 tests at `__tests__/checksum.test.ts`, `__tests__/logger.test.ts`, `__tests__/migration-failure.integration.test.ts`, `__tests__/migration.test.ts`, `__tests__/state.test.ts`, `__tests__/validate.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | YELLOW | `migration/index.ts` lines 130-132, 148-149, 163-164, 178-180, 198-201: uses `data as Record<string, unknown>` and `tasks as Array<Record<string, unknown>>` in migration transform functions. These are structurally appropriate — migration data is genuinely opaque at the boundary. `MigrationFn = (data: unknown) => unknown` at line 87 is the correct type for a generic migration function. Not actionable but worth noting. |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK in source files (checked, none found) |
| 6. Test coverage | GREEN | 5 test files (plus 1 integration test), all 109 pass |
| 7. Public surface | YELLOW | `index.ts` exports main migration entry points with TSDoc. `preflight.ts` is a forwarding shim for `../system/storage-preflight.js` — this boundary-crossing is intentional (marked with `@task T5305`) but creates a cross-namespace dependency |
| 8. Cross-domain coupling | YELLOW | `migration/preflight.ts` re-exports from `../system/storage-preflight.js`. This is a shim for backward compat (annotated with task ref) but `system/` is not an expected dependency of `migration/`. `migration/index.ts` imports `../errors.js`, `../paths.js`, `../store/json.js` — all infrastructure, acceptable. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations |
| 10. Documentation | YELLOW | No README.md; no ADR reference in module headers |

**P1 findings** (high priority):
- `packages/core/src/migration/preflight.ts` — Shim re-exports `checkStorageMigration` from `../system/storage-preflight.js`. This cross-boundary forwarding creates a coupling from `migration/` to `system/`. If `system/storage-preflight.ts` moves or changes its API, the shim silently breaks. The shim was introduced in T5305 but there is no test verifying the re-export contract. Consider either removing the shim (callers should import from `system/` directly) or adding an export-contract test.

**P2 findings** (cleanup):
- `packages/core/src/migration/index.ts:87` — `MigrationFn = (data: unknown) => unknown` is correctly typed for a generic transform but the transforms themselves cast aggressively. If migration schema format ever gains a typed representation, these should be updated to use it.

---

### reconciliation — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/reconciliation/`
**Files**: `index.ts` (17 LOC), `link-store.ts` (234 LOC), `reconciliation-engine.ts` (363 LOC) — 614 total
**Test files**: 0 dedicated tests for this namespace. `nexus/__tests__/transfer.test.ts` imports `getLinksByTaskId` from `link-store.ts` which provides indirect coverage of link creation, but the `reconcile()` function in `reconciliation-engine.ts` has **zero test coverage**.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | RED | **`reconcile()` in `reconciliation-engine.ts` has no tests.** The `link-store.ts` functions (`createLink`, `getLinksByProvider`, `touchLink`) have indirect coverage via the nexus transfer test, but the reconciliation logic (create/update/close/skip/fail actions, provider mapping, CLEO-SSoT enforcement) is completely untested. |
| 7. Public surface | GREEN | `index.ts` exports a clean named API; `reconcile()` and `createLink` etc. have TSDoc with correct parameter types from `@cleocode/contracts` |
| 8. Cross-domain coupling | YELLOW | `reconciliation-engine.ts` imports `../tasks/add.js`, `../tasks/complete.js`, `../tasks/update.js` directly. These are domain-level imports (not infrastructure), meaning reconciliation is coupled to the tasks mutation surface. This is architecturally expected (reconciliation applies CLEO-SSoT mutations) but is worth flagging — changes to add/complete/update signatures will require reconciliation-engine updates. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations |
| 10. Documentation | RED | No README.md; no ADR reference. Reconciliation is a significant capability (provider-agnostic task sync with Linear/Jira/GitHub) with no architecture doc |

**P0 findings** (immediate action):
- `packages/core/src/reconciliation/reconciliation-engine.ts` — **Zero test coverage** for `reconcile()`. This function manages bidirectional task sync between CLEO and external providers with create/update/complete/skip/fail actions. A regression here would silently corrupt task state. Minimum viable test: happy path with a mock ExternalTaskProvider returning 1 new task + 1 updated task.

**P2 findings** (cleanup):
- `packages/core/src/reconciliation/reconciliation-engine.ts:24-26` — Direct imports from `../tasks/add.js`, `../tasks/complete.js`, `../tasks/update.js` couple the reconciliation engine to task mutation internals. Consider routing through `DataAccessor` methods or a dedicated `MutationFacade` to reduce coupling depth.

---

### routing — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/routing/`
**Files**: `index.ts` (23 LOC), `capability-matrix.ts` (1624 LOC) — 1647 total
**Test files**: No dedicated `__tests__/` in routing; `skills/__tests__/routing-table.test.ts` has 16 tests that pass and exercises `getCapabilityMatrix()` indirectly

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | YELLOW | `routing-table.test.ts` (16 tests, all pass) covers the routing table concept but tests live in `skills/` not `routing/`. No dedicated test file in `routing/__tests__/`. The capability matrix itself (the large static array) is not directly validated for completeness against registered operations. |
| 7. Public surface | GREEN | `index.ts` exports 6 clean named functions + 5 types with TSDoc. Module header references `@task T5706` |
| 8. Cross-domain coupling | GREEN | `capability-matrix.ts` is self-contained; no cross-domain imports beyond own types |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations |
| 10. Documentation | YELLOW | No README.md in routing/; module header docstring in `capability-matrix.ts` is comprehensive. Notes "Re-exported from: src/dispatch/lib/capability-matrix.ts (backward compat)" — this re-export is in dispatch layer, acceptable. |

**P2 findings** (cleanup):
- `packages/core/src/routing/capability-matrix.ts` — 1624 LOC is a large static data file. The capability matrix entries are not validated against any authoritative operation registry at test time. A test that cross-checks `CAPABILITY_MATRIX` entries against registered dispatch operations would catch entries added to dispatch without routing entries (or vice versa).

---

### snapshot — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/snapshot/`
**Files**: `index.ts` (266 LOC)
**Test files**: 1 test at `packages/core/src/__tests__/snapshot.test.ts` (3 tests: round-trip, default path, invalid format)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. Uses `as Snapshot` once in `readSnapshot` which is appropriate after format validation. |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | YELLOW | 1 test file, 3 tests pass. The `exportSnapshot` and `importSnapshot` functions (which require a live SQLite accessor) are not tested — only `writeSnapshot`, `readSnapshot`, and `getDefaultSnapshotPath` are covered. Last-write-wins merge logic in `importSnapshot` is untested. |
| 7. Public surface | GREEN | 8 exported items (functions + interfaces) all have TSDoc. 4 `SSoT-EXEMPT` annotations are present (lines 111, 150, 163, 193) with valid rationale per ADR-057 D1 (snapshot fns use file-path/cwd args, not projectRoot+params). |
| 8. Cross-domain coupling | GREEN | Only imports `../paths.js` and `../store/data-accessor.js` — both infrastructure |
| 9. Dead code | GREEN | 4 `SSoT-EXEMPT` annotations are all live and correctly rationale-cited against ADR-057 D1. No stale annotations. |
| 10. Documentation | YELLOW | No README.md; SSoT-EXEMPT comments serve as inline rationale |

**P2 findings** (cleanup):
- `packages/core/src/snapshot/index.ts` — `importSnapshot` last-write-wins merge logic (lines 194-265) is not covered by any test. A test with pre-seeded local tasks and a snapshot with mixed newer/older/equal timestamps would exercise the conflict resolution logic.

---

### security — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/security/`
**Files**: `index.ts` (69 LOC), `input-sanitization.ts` (443 LOC), `override-cap.ts` (307 LOC), `owner-override-auth.ts` (353 LOC), `shared-evidence-tracker.ts` (345 LOC) — 1517 total
**Test files**: Tests at `packages/core/src/lifecycle/verification/__tests__/override-cap.test.ts` (41 tests) and `__tests__/shared-evidence.test.ts` (both pass). `input-sanitization.ts` and `owner-override-auth.ts` covered via integration/dispatch layer.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as`. T1501/T1502 new files use proper typed structs throughout. `shared-evidence-tracker.ts` uses `entry as SharedEvidenceEntry` with a preceding type guard — correct pattern. |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | GREEN | 41 tests pass for `override-cap.ts` (T1501/T1504); separate test for `shared-evidence-tracker.ts` (T1502). ADR-059 is the source of truth. Tests are in `lifecycle/verification/__tests__/` which is appropriate given these are consumed by the verification layer. |
| 7. Public surface | GREEN | `index.ts` is a clean barrel with grouped exports. New T1501/T1502 exports are grouped with task reference comments. All exported symbols in `override-cap.ts`, `shared-evidence-tracker.ts`, `owner-override-auth.ts` have TSDoc with `@task` and `@adr` references. Excellent documentation quality. |
| 8. Cross-domain coupling | GREEN | `input-sanitization.ts` imports `../store/tasks-schema.js` (for `TASK_PRIORITIES`) and `../tasks/id-generator.js` (for `normalizeTaskId`) — both are infrastructure imports, not domain logic. `override-cap.ts` and `shared-evidence-tracker.ts` only import `@cleocode/contracts` and Node builtins. |
| 9. Dead code | GREEN | No SSoT-EXEMPT, no stale annotations. ADR-059 references in source code are all live. |
| 10. Documentation | GREEN | ADR-059 (`docs/adr/ADR-059-override-pumps.md`) is comprehensive (158 lines), accepted, and cross-references exactly the files in this namespace. ADR-055 referenced in `owner-override-auth.ts`. No README in directory but the ADR file covers the namespace design. |

**No findings — this namespace is the healthiest in scope.** T1501/T1502/T1504 were implemented cleanly with full ADR coverage, proper TSDoc, no type leakage, and passing unit tests.

---

### coreHooks (hooks/) — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/hooks/`
**Exported as**: `coreHooks` from `packages/core/src/index.ts:45`
**Files**: `index.ts` (31 LOC), `payload-schemas.ts` (269 LOC), `provider-hooks.ts` (83 LOC), `registry.ts` (254 LOC), `types.ts` (526 LOC)
**Handlers**: `handlers/` (2030 LOC across 14 files)
**Test files**: 11 test files — `__tests__/provider-hooks.test.ts`, `__tests__/registry.test.ts`, `handlers/__tests__/conduit-hooks.test.ts`, `handlers/__tests__/error-hooks.test.ts`, `handlers/__tests__/file-hooks.test.ts`, `handlers/__tests__/hook-automation-e2e.test.ts`, `handlers/__tests__/precompact.test.ts`, `handlers/__tests__/session-hooks.test.ts`, `handlers/__tests__/task-hooks.test.ts`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch |
| 2. Handler thinness | N/A | Core namespace, not dispatch |
| 3. Inline type leakage | GREEN | Zero `: any`, `as any`, `as unknown as` in source files. The comment "any error is silently swallowed" in `intelligence-hooks.ts:33` is natural-language prose inside a JSDoc, not a TypeScript type. |
| 4. Per-op imports | N/A | Core namespace, not dispatch |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK |
| 6. Test coverage | GREEN | 9 test files covering major handlers; all 144 tests pass in combined run |
| 7. Public surface | YELLOW | `index.ts` re-exports `export * from './handlers/index.js'` which is a wildcard re-export — leaks all handler internals. The module header in `index.ts` incorrectly states `@module @cleocode/cleo/hooks` (referencing the old package name `cleo` not `core`). Should be `@cleocode/core/hooks`. |
| 8. Cross-domain coupling | YELLOW | `handlers/conduit-hooks.ts` imports `../../conduit/local-transport.js` directly. This creates a tight coupling from `hooks/handlers/` to `conduit/`. If `LocalTransport` moves or is refactored, conduit-hooks breaks. `handlers/precompact.ts` imports from `../../memory/precompact-flush.js`. These are architecturally justified (hooks respond to lifecycle events from those subsystems) but are cross-domain. |
| 9. Dead code | YELLOW | `types.ts` has 8 `@deprecated` type aliases (`OnSessionStartPayload`, `OnSessionEndPayload`, `OnToolStartPayload`, `OnToolCompletePayload`, `OnCascadeStartPayload`, `OnNotificationPayload`, `OnToolFailurePayload`, `OnPromptSubmitPayload`, `OnResponseCompletePayload`) kept for backward compatibility. `payload-schemas.ts` has 8 matching `@deprecated` schema aliases. These are live deprecations (they point to the correct replacement types) but accumulating — no timeline set for removal. |
| 10. Documentation | YELLOW | No README.md; no ADR reference in module headers (ADR-053 on playbook runtime is mentioned in project docs but not wired into this module's TSDoc) |

**P1 findings** (high priority):
- `packages/core/src/hooks/index.ts:1-10` — Module `@module` annotation reads `@cleocode/cleo/hooks` (stale package name). Should be `@cleocode/core/hooks`. Minor but causes doc generators to file this module under the wrong package namespace.

**P2 findings** (cleanup):
- `packages/core/src/hooks/types.ts` + `payload-schemas.ts` — 16 `@deprecated` backward-compat aliases with no removal timeline. Consider adding a deprecation version tag (e.g., `@since 2026.4.xx @deprecated`) and a target removal milestone to prevent indefinite accumulation.
- `packages/core/src/hooks/handlers/conduit-hooks.ts:20` + `precompact.ts:33` — Direct cross-domain imports from `conduit/` and `memory/` respectively. Document or formalize these as expected hook-handler integration points (e.g., a comment like `// Intentional: hooks respond to conduit lifecycle events`) to prevent future auditors from flagging them without context.

---

## Overall recommendations

### P0 tasks to file immediately

1. **Missing tests: context module** — `packages/core/src/context/index.ts` has zero test coverage for `getContextStatus`, `checkContextThreshold` (exit-code map), and `listContextSessions`. File as `cleo add "Add unit tests for core/src/context module" --parent T1520` with acceptance criterion: vitest tests covering all 3 exported functions including stale-detection logic and exit-code map.

2. **Missing tests: reconciliation engine** — `packages/core/src/reconciliation/reconciliation-engine.ts:reconcile()` is completely untested. File as `cleo add "Add unit tests for reconciliation-engine.ts reconcile() function" --parent T1520` with acceptance criterion: tests covering create/update/skip/close actions with a mock ExternalTaskProvider.

### P1 tasks to file

3. **Stale module name in hooks index** — `packages/core/src/hooks/index.ts:1`: `@module @cleocode/cleo/hooks` should be `@cleocode/core/hooks`. File as documentation bug fix.

4. **Migration preflight shim coupling** — `packages/core/src/migration/preflight.ts` re-exports from `../system/storage-preflight.js` without a contract test. Add export-contract test or remove shim in favor of direct imports.

### P2 tasks to consider

5. **READMEs for all 10 namespaces** — None of the 10 audited namespaces have a `README.md`. Given AGENTS.md requires TSDoc on all exports, namespace-level READMEs would complete the documentation picture. This is a broad cleanup task.

6. **Context return types** — `Record<string, unknown>` return types in `context/index.ts` lose structural typing. Define `ContextStatus` and `ThresholdCheckResult` interfaces in `@cleocode/contracts`.

7. **Hooks deprecated accumulation** — 16 deprecated type aliases with no removal timeline. Set a deprecation milestone.

8. **Routing capability matrix validation** — Add a test that cross-checks `CAPABILITY_MATRIX` entries against registered operations to catch orphaned entries.

9. **Snapshot importSnapshot coverage** — Add tests for last-write-wins merge logic with mixed timestamp scenarios.

---

## Cross-references

- **ADR-013** §9: Runtime data safety — referenced in `hooks/handlers/session-hooks.ts` (backup on session end)
- **ADR-055**: Agents architecture — referenced in `security/owner-override-auth.ts`
- **ADR-057**: Contracts-Core SSoT — referenced in `snapshot/index.ts` SSoT-EXEMPT annotations
- **ADR-059**: Override governance pumps — fully documented in `security/override-cap.ts` and `shared-evidence-tracker.ts`
- **Linked CLEO tasks**: T1501, T1502, T1504 (security/), T4882 (snapshot), T4535 (context), T4539 (inject), T5240 (adapters), T5706 (security/routing), T5305 (migration/preflight)
- **Files reviewed**:
  - adapters/: 4 source files + 2 tests
  - context/: 1 source file + 0 tests
  - inject/: 1 source file + 0 tests
  - lib/: 4 source files + 2 tests
  - migration/: 7 source files + 6 tests (5 unit + 1 integration)
  - reconciliation/: 3 source files + 0 dedicated tests (1 indirect via nexus/transfer.test.ts)
  - routing/: 2 source files + 1 indirect test (skills/routing-table.test.ts)
  - snapshot/: 1 source file + 1 test
  - security/: 5 source files + 2 tests (41+N passing)
  - hooks/: 5 source files + 14 handler files + 9 tests

**Total files reviewed**: 47 source files + 23 test files
