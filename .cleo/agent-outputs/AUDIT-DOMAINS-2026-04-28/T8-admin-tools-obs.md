# Audit Report — Teammate 8: Admin / Tools / Diagnostics / Observability / Metrics / Telemetry / Stats / System

**Auditor**: T1528 (CLEO task ID)
**Scope**: dispatch/admin.ts, dispatch/tools.ts, dispatch/diagnostics.ts + core/admin, core/observability, core/metrics, core/telemetry, core/stats, core/system
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | Overall Verdict | Critical Findings |
|------|------|----------------|-------------------|
| dispatch/admin.ts | dispatch | YELLOW | 0 P0, 2 P1, 3 P2 |
| dispatch/tools.ts | dispatch | YELLOW | 0 P0, 2 P1, 1 P2 |
| dispatch/diagnostics.ts | dispatch | YELLOW | 0 P0, 1 P1, 1 P2 |
| core/admin | core | YELLOW | 0 P0, 0 P1, 1 P2 |
| core/observability | core | GREEN | 0 P0, 0 P1, 0 P2 |
| core/metrics | core | YELLOW | 0 P0, 2 P1, 1 P2 |
| core/telemetry | core | YELLOW | 0 P0, 1 P1, 1 P2 |
| core/stats | core | YELLOW | 0 P0, 1 P1, 1 P2 |
| core/system | core | YELLOW | 1 P0, 1 P1, 1 P2 |

**P0 count**: 1 (system/metrics.ts hardcoded token stub)
**P1 count**: 10
**P2 count**: 10

**Namespace Redundancy Finding (Scope Investigation Outcome)**: The 5 namespaces `observability`, `metrics`, `telemetry`, `stats`, and `system` have DISTINCT non-overlapping responsibilities. No P0 redundancy. One P0 was found inside `system/metrics.ts` — its `tokens` field is a hardcoded stub `{ input: 0, output: 0, cache: 0, total: 0 }` while `metrics/token-service.ts` has a full OTel/tokenizer/heuristic implementation. This is NOT namespace redundancy but a data-wiring gap: `getSystemMetrics` never calls `summarizeTokenUsage`. Filed as P0 below.

---

## Per-Area Findings

---

### dispatch/admin.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/admin.ts`
**Lines of code**: 1290
**Test files**: 1 — `packages/cleo/src/dispatch/domains/__tests__/admin.test.ts` (36 tests, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | `type AdminOps = OpsFromCore<typeof coreAdmin.adminCoreOps>` at line 92. All handlers use narrowed params from `AdminOps`. |
| 2. Handler thinness | RED | 40/41 handlers exceed 5 LOC. Most are 10–61 LOC. Largest: `context.pull` (61 LOC), `token` (61 LOC), `token.mutate` (48 LOC), `backup.mutate` (55 LOC), `job` (47 LOC), `import` (39 LOC). See P1 findings. |
| 3. Inline type leakage | GREEN | Zero `as any` / `as unknown as`. One `catch (err: unknown)` at line 256 inside `context.pull` which is a valid pattern (dynamic import chain). |
| 4. Per-op imports | GREEN | No imports from `@cleocode/contracts/operations/<file>`. Only `import type { admin as coreAdmin } from '@cleocode/core'`. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | GREEN | 36 tests pass in `admin.test.ts`. |
| 7. Public surface | N-A | Dispatch layer — not a public API. |
| 8. Cross-domain coupling | GREEN | Imports only from `@cleocode/core`, `@cleocode/core/internal`, dispatch adapters, lib/engine, registry. Dynamic imports of `@cleocode/core/internal` inside `context.pull` and `install.global` are acceptable patterns. |
| 9. Dead code | GREEN | No SSoT-EXEMPT or stale task annotations. No T1451 references. |
| 10. Documentation | YELLOW | File has TSDoc header. No README. No ADR references in file header. |

**P1 findings**:
- `admin.ts:107-985` — Handler thinness: 40/41 op handlers exceed 5 LOC. The typed handler pattern wraps all logic in `_adminTypedHandler`, which is correct architecturally, but every handler body contains boilerplate `if (!result.success)` blocks that could be factored into a shared adapter. The largest offenders (`context.pull` at 61 LOC, `token` at 61 LOC) contain meaningful business logic (query fan-out, action dispatch) that belongs in Core or engine layer. This is the primary P1 for this domain. See ADR-058.
- `admin.ts:203-263` (`context.pull`) — This handler performs a 5-step pipeline: accessor load, title/description extraction, parallel BRAIN retrieval, slice, and response mapping. This is Core SDK logic embedded in the dispatch layer. Should move to `core/admin` or a dedicated engine function.

**P2 findings**:
- `admin.ts:1083-1106` — `queryKey`/`mutateKey` helper functions and the QUERY_OPS/MUTATE_OPS sets are necessary workarounds for same-name ops on both gateways (`health`, `backup`, `map`, `token`). P2: document this design decision with a comment referencing the ADR or file a follow-up to unify under distinct op names.
- `admin.ts:1005-1020` — `envelopeToEngineResult` is a private adapter that bridges `LafsEnvelope` to `EngineResult`. P2: consider promoting to the shared `_base.ts` adapter since other domains may need this pattern.
- `admin.ts:1` — No ADR references in file header (ADR-058 mentioned as T1426/T1437 task refs but not as `ADR-058` directly).

---

### dispatch/tools.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/tools.ts`
**Lines of code**: 684
**Test files**: 1 — `packages/cleo/src/dispatch/domains/__tests__/tools.test.ts` (5 tests, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | No `OpsFromCore` pattern. No `defineTypedHandler`/`typedDispatch`. No `coreOps` reference. All params accessed via `params?.name as string | undefined` inline casts. No core ops.ts for the tools domain exists. |
| 2. Handler thinness | RED | `querySkill.catalog` case block is 66 LOC (lines 319–384). `querySkill` overall method is ~180 LOC. `queryProvider`, `mutateAdapter` methods contain ~30-50 LOC case bodies each. |
| 3. Inline type leakage | YELLOW | 20 occurrences of `params?.X as Type` casts (lines 242, 257, 262, 277, 292, 389, 395, 396, 419, 430, 431, 436, 447, 494, 495, 500, 501, 517, 548, 549, 551). These are not `any` casts per se but unsafe narrowing from `Record<string, unknown>`. Permitted in dispatch layer per current convention but should move to OpsFromCore inference. |
| 4. Per-op imports | GREEN | No per-op contract imports. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | Only 5 tests in `tools.test.ts` — very thin coverage for a 684-LOC domain with 4 sub-domains (issue, skill, provider, adapter) and 5 code analysis ops. No tests for `code.*` sub-domain, `skill.catalog`, `skill.precedence`, or adapter mutations. |
| 7. Public surface | N-A | Dispatch layer. |
| 8. Cross-domain coupling | GREEN | Imports only from tools-engine, code-engine, `@cleocode/core`, dispatch internals. Clean. |
| 9. Dead code | GREEN | No stale annotations. `mutateIssue` returns `unsupportedOp` for all sub-operations — this is intentional (plugin-extracted). |
| 10. Documentation | YELLOW | File has TSDoc header. No README. No ADR refs. |

**P1 findings**:
- `tools.ts:1` — `tools.ts` has NOT been migrated to `OpsFromCore` inference (criterion 1 RED). All other dispatch domains in the T1426/T1437 thinning wave were migrated. This domain was skipped. It should use `defineTypedHandler<ToolsOps>` once a `toolsCoreOps` is defined in `packages/core/src/tools/ops.ts`. No `ops.ts` exists in the tools namespace.
- `tools.ts:319-384` — `skill.catalog` case is 66 LOC. The pattern dispatches sub-types (protocols/profiles/resources/info) via `routeByParam` with 4 inline closures each building a full `DispatchResponse`. This logic belongs in the engine layer. The inline closures access `result.data!.protocols` etc. with non-null assertions rather than safe narrowing.

**P2 findings**:
- `tools.ts:181-211` — `queryIssue` and `mutateIssue` exist solely to return `unsupportedOp`. These are dead dispatch stubs. The comment says "plugin-extracted" but there is no runtime check — the stubs simply forward to `unsupportedOp`. P2: remove the stubs or add a comment documenting the intentional empty extension point.

---

### dispatch/diagnostics.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/diagnostics.ts`
**Lines of code**: 95
**Test files**: 0 — no `diagnostics.test.ts` found in `__tests__/`

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | No `OpsFromCore` pattern. No `defineTypedHandler`. No core ops.ts for the diagnostics domain. Params accessed via raw `typeof params?.days === 'number'` and `params?.noBrain !== true` inline checks. |
| 2. Handler thinness | GREEN | All case handlers are ≤4 LOC (lines 36-58, 65-84). Very thin. Delegates cleanly to engine functions. |
| 3. Inline type leakage | GREEN | No `as any` / `as unknown as`. `catch (err: unknown)` at lines 56 and 83 — each immediately uses `handleErrorResult` which expects `unknown`, valid. |
| 4. Per-op imports | GREEN | No per-op contract imports. Imports are from `diagnostics-engine.js` and dispatch internals only. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | No test file exists for diagnostics dispatch. The engine-level behavior (`buildDiagnosticsReport`, `enableTelemetry`) is only tested at unit level via `telemetry/index.ts`. No dispatch-level integration test. |
| 7. Public surface | N-A | Dispatch layer. |
| 8. Cross-domain coupling | GREEN | Imports only from `diagnostics-engine.js` and `_base.js`. Clean. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | TSDoc header present. No README. No ADR refs. |

**P1 findings**:
- `diagnostics.ts:1` — Missing dispatch test file. Given that `diagnostics` manages opt-in telemetry state (enable/disable toggle affects all subsequent CLEO CLI runs), this needs at least smoke tests for `enable`, `disable`, and `status` operations.

**P2 findings**:
- `diagnostics.ts:1` — Not migrated to `OpsFromCore` inference. No `diagnosticsCoreOps` in core. Since the domain is small (5 ops), a core ops.ts stub would be trivial to add. This completes the ADR-058 migration for the entire dispatch surface.

---

### core/admin — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/admin/`
**Lines of code**: 965 total (index.ts: 26, ops.ts: 73, export.ts: 129, export-tasks.ts: 197, import.ts: 156, import-tasks.ts: 232, help.ts: 152)
**Test files**: 0 (no `__tests__/` directory)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace — defines the ops contract, not a consumer of it. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | No `as any` / `as unknown as` in the admin core files. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK in admin core. |
| 6. Test coverage | RED | No test files for admin core (import/export/help functions). Import and export operations are complex (snapshot format, tasks package, conflict resolution). |
| 7. Public surface | YELLOW | `index.ts` has a clean barrel export. `ops.ts` has TSDoc. `help.ts` functions have TSDoc. `export.ts` / `import.ts` / `export-tasks.ts` / `import-tasks.ts` have minimal or no TSDoc on exported functions. |
| 8. Cross-domain coupling | GREEN | Imports from `@cleocode/contracts`, `../store/*`, `../paths.js`. No unexpected cross-domain coupling. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README. No ADR refs in source files. |

**P2 findings**:
- `core/admin/` — No unit tests for import/export/help functionality. Given that export/import handle snapshot formats and task package migrations, test coverage is a meaningful risk surface.

---

### core/observability — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/observability/`
**Lines of code**: 596 total (index.ts: 146, log-filter.ts: 69, log-parser.ts: 104, log-reader.ts: 154, types.ts: 123)
**Test files**: 4 files in `__tests__/` — `log-filter.test.ts`, `log-parser.test.ts`, `log-reader.test.ts`, `index.test.ts` (66 tests total, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | No `as any` / `as unknown as`. Types are properly defined in `types.ts`. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK. |
| 6. Test coverage | GREEN | 4 test files, 66 tests, all pass. Full coverage of log-filter, log-parser, log-reader, and the index convenience functions. |
| 7. Public surface | GREEN | Clean barrel export in `index.ts`. All exported functions and types documented. `queryLogs`, `streamLogs`, `getLogSummary` have TSDoc. |
| 8. Cross-domain coupling | GREEN | No cross-namespace imports. Only imports from `./` (internal files). |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README in namespace. Epic T5186 referenced in header. No ADR refs. |

No P0/P1/P2 findings for this namespace.

---

### core/metrics — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/metrics/`
**Lines of code**: 2559 total (token-service.ts: 598, aggregation.ts: 460, token-estimation.ts: 407, otel-integration.ts: 327, ab-test.ts: 358, common.ts: 83, enums.ts: 81, index.ts: 82, model-provider-registry.ts: 114, provider-detection.ts: 147)
**Test files**: 2 — `model-provider-registry.test.ts`, `provider-detection.test.ts` (6 tests total, all pass)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | No `as any` / `as unknown as` in the public API. Internal helper `tokenizerCount` casts `mod` twice (lines 276-282) but these are typed casts on dynamic imports, not public API exposure. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | Only 6 tests covering `model-provider-registry` and `provider-detection`. No tests for: `token-service.ts` (598 LOC, 9 exported functions), `aggregation.ts` (460 LOC, 7 exported functions), `token-estimation.ts` (407 LOC, 12 exported functions), `otel-integration.ts` (327 LOC), or `ab-test.ts` (358 LOC). |
| 7. Public surface | YELLOW | `index.ts` has a full barrel export. No TSDoc on most exported functions in `aggregation.ts`, `otel-integration.ts`, `ab-test.ts`. `token-service.ts` lacks TSDoc on exported functions. |
| 8. Cross-domain coupling | GREEN | Imports from `../store/*`, `../paths.js`. No unexpected cross-domain coupling. |
| 9. Dead code | YELLOW | 6 `SSoT-EXEMPT: T1511` annotations in `token-service.ts` (lines 401, 442, 454, 482, 538, 550). T1511 is OPEN (status: pending). These annotations are LIVE (not stale) — they correctly reference an open task. Verify: the prior T1451 wrong task ID has been cleaned up — no T1451 references found. CONFIRMED clean. |
| 10. Documentation | YELLOW | No README in namespace. Task T4454 and epic T4454 referenced. No ADR refs. |

**P1 findings**:
- `core/metrics/token-service.ts:401-563` — 6 `SSoT-EXEMPT: T1511` annotations on 6 exported functions. These are correctly targeting an open task (T1511 status=pending, filed 2026-04-28). The annotations are live and accurate — no cleanup needed until T1511 ships. However, the `Omit<>` pattern on line 403 (`Omit<TokenExchangeInput, 'cwd'>`) is a real API inconsistency: callers must know to omit `cwd` even though all other filters accept it. This should be addressed in T1511.
- `core/metrics/` — Severely undertested. 2558 LOC with 6 tests. `token-service.ts` (the token persistence SSoT) has zero tests. If token recording breaks, no test will catch it before production.

**P2 findings**:
- `core/metrics/index.ts` — The index re-exports from 8 source files but does not export `token-service.ts` functions directly (they appear to be available via `@cleocode/core/internal` only). Verify that the intended public surface is clear — if `recordTokenExchange` is internal-only, document this explicitly.

---

### core/telemetry — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/telemetry/`
**Lines of code**: 547 total (index.ts: 341, schema.ts: 68, sqlite.ts: 138)
**Test files**: 0 — no `__tests__/` directory found

**Distinction from metrics**: `telemetry/` records anonymized CLI command invocations (domain/operation/duration/exitCode) for self-improvement diagnostics. `metrics/` tracks AI token usage, compliance scores, session metrics, and A/B test data. These are distinct concerns.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | GREEN | No `as any` / `as unknown as`. Types are explicitly defined: `TelemetryEvent`, `CommandStats`, `DiagnosticsReport`, `TelemetryConfig`. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | Zero test files. `buildDiagnosticsReport` is a complex SQL-aggregate query (5 DB queries) with no unit or integration tests. `recordTelemetryEvent` has no test. Given the complexity of the drizzle ORM queries, this is a meaningful gap. |
| 7. Public surface | GREEN | `index.ts` is the single entry point. Exports types and all public functions with TSDoc comments. `recordTelemetryEvent`, `buildDiagnosticsReport`, `enableTelemetry`, `disableTelemetry` all have TSDoc. Re-exports schema and sqlite. |
| 8. Cross-domain coupling | GREEN | Imports only from `../paths.js`, `./schema.js`, `./sqlite.js`. Clean. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README. Task T624 referenced. No ADR refs. |

**P1 findings**:
- `core/telemetry/index.ts` — Zero test coverage for a module managing opt-in telemetry state and SQLite DB writes. `buildDiagnosticsReport` alone has 50+ lines of aggregation SQL. At minimum, a mock-DB test for the analysis pipeline is needed.

**P2 findings**:
- `core/telemetry/index.ts:155-180` (`recordTelemetryEvent`) — The function swallows all errors silently (`catch {}`). This is correct for a fire-and-forget telemetry flow but means there is no observability into telemetry write failures. P2: add a debug-level log in the catch block to assist troubleshooting without affecting the non-fatal contract.

---

### core/stats — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/stats/`
**Lines of code**: 935 total (index.ts: 433, workflow-telemetry.ts: 502)
**Test files**: 1 — `__tests__/stats.test.ts` (22 tests, all pass)

**Distinction from telemetry/metrics**: `stats/` computes task-completion rates, dashboard summaries, blocked task rankings from the TASKS database (audit_log + tasks table). It is NOT about CLI command telemetry (that is `telemetry/`) and NOT about AI token usage (that is `metrics/`). Includes workflow compliance metrics via `workflow-telemetry.ts`.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | YELLOW | `stats/__tests__/stats.test.ts:41` — `} as unknown as DataAccessor` in a test mock. Not in production code but it is in the test file within the scope. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK in production files. `@task T0000` in test file at line 4 — placeholder ID, but this is in a test. |
| 6. Test coverage | YELLOW | 22 tests pass for `rankBlockedTask` and `getDashboard`. No tests for `getProjectStats`, `getCompletionHistory`, or the `workflow-telemetry.ts` module (502 LOC, complex workflow compliance queries). |
| 7. Public surface | YELLOW | `index.ts` is the entry point with a clean barrel-style structure. TSDoc on `getDashboard`, `getProjectStats`, `rankBlockedTask`. `workflow-telemetry.ts` exports are typed with TSDoc. `getCompletionHistory` lacks TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports from `../errors.js`, `../project-info.js`, `../store/*`, `../logger.js`. Cross-namespace imports are limited to store (expected) and errors (expected). |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README. Tasks T4535/T4454 referenced. No ADR refs. |

**P1 findings**:
- `core/stats/workflow-telemetry.ts` (502 LOC) — Zero test coverage. This module computes workflow compliance rates (WF-001 through WF-005) via SQL queries. It is the data source for agent workflow scoring but has no tests verifying its correctness.

**P2 findings**:
- `core/stats/__tests__/stats.test.ts:41` — `as unknown as DataAccessor` type cast in test. Should use a proper typed partial mock (e.g., `Partial<DataAccessor>` with explicit cast to `DataAccessor`). Minor quality concern.

---

### core/system — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/system/`
**Lines of code**: 4527 total (health.ts: 1507, project-health.ts: 898, archive-analytics.ts: 464, dependencies.ts: 534, backup.ts: 348, audit.ts: 180, cleanup.ts: 152, runtime.ts: 220, inject-generate.ts: 147, storage-preflight.ts: 154, archive-stats.ts: 90, safestop.ts: 128, bridge-mode.ts: 37, labels.ts: 49, metrics.ts: 90, migrate.ts: 55, platform-paths.ts: 96, index.ts: 81)
**Test files**: 4 — `backup.test.ts`, `cleanup.test.ts`, `health.test.ts`, `project-health.test.ts` (26 tests total, all pass)

**Note**: Despite being named `system`, this namespace contains diverse system operations (health checks, backup/restore, cleanup, analytics, audit, migration). It is NOT primarily metrics-related. `system/metrics.ts` is a sub-file that aggregates compliance and session data — and contains a P0 bug.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N-A | Core namespace. |
| 2. Handler thinness | N-A | Core namespace. |
| 3. Inline type leakage | YELLOW | `system/metrics.ts:51` — `(e.compliance ?? {}) as Record<string, unknown>` — this is a widening cast on an untyped JSONL field. Acceptable given that compliance entries come from external files with no guaranteed schema, but the compliance path types in `compliance/store.js` should be consulted to see if stronger typing is possible. |
| 4. Per-op imports | N-A | Core namespace. |
| 5. Behavior markers | GREEN | No TODO/FIXME/XXX/HACK. |
| 6. Test coverage | YELLOW | 4 test files, 26 tests. No tests for: `archive-analytics.ts` (464 LOC), `dependencies.ts` (534 LOC), `runtime.ts` (220 LOC), `audit.ts` (180 LOC), `inject-generate.ts` (147 LOC), `safestop.ts` (128 LOC), `metrics.ts` (90 LOC). The most complex files are untested. |
| 7. Public surface | YELLOW | `index.ts` exports everything by type + function. TSDoc on most exported functions. `archive-analytics.ts` exports many functions with TSDoc. Some functions in `audit.ts` lack TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports from `../store/*`, `../paths.js`, `../compliance/store.js`, `../errors.js`, etc. Expected dependencies. No unexpected cross-namespace coupling. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No README. Tasks T4783 and T4631 referenced. No ADR refs in source files. |

**P0 findings**:
- `core/system/metrics.ts:86` — **STUB IMPLEMENTATION**: `getSystemMetrics()` hardcodes `tokens: { input: 0, output: 0, cache: 0, total: 0 }`. The `metrics/token-service.ts` module has a full provider-aware token measurement and persistence implementation (`summarizeTokenUsage`, `listTokenUsage`). `getSystemMetrics` never calls it. Any consumer of `getSystemMetrics` (including `cleo admin stats` via `systemStats` in the engine layer, and `cleo dash`) receives zero token data. This is a silent data-wiring gap that produces incorrect dashboards and stats reports.

**P1 findings**:
- `core/system/health.ts` (1507 LOC) — Largest file in scope by far. While it has 1 test file (`health.test.ts`), it has no tests for the doctor report path (`coreDoctorReport`) or `getSystemDiagnostics`. Given the size and criticality of the health system, the test gap is meaningful.

**P2 findings**:
- `core/system/` — No README. The namespace is a heterogeneous grab-bag (archive analytics, backup, cleanup, health, audit, labels, metrics, platform paths, runtime, migration). Consider documenting the namespace purpose in a README so future contributors know which system operations belong here vs in `admin/`.

---

## Namespace Redundancy Investigation

The 5 suspected-redundant namespaces have the following DISTINCT responsibilities:

| Namespace | Responsibility | Data Source | Overlap Risk |
|-----------|---------------|-------------|--------------|
| `observability/` | Pino JSONL log file reading, parsing, filtering | `.cleo/logs/*.jsonl` files | NONE |
| `metrics/` | Token usage measurement (OTel/tokenizer/heuristic), compliance aggregation, A/B testing, OTel integration | `tokenUsage` DB table, compliance JSONL files | LOW — shares compliance JSONL with system/metrics.ts |
| `telemetry/` | Anonymous CLI command invocation recording + diagnostics analysis | `telemetry.db` SQLite (separate DB) | NONE |
| `stats/` | Task completion statistics, dashboard, workflow compliance rates | `tasks.db` (audit_log + tasks tables) | NONE |
| `system/` | System operations: health, backup, cleanup, archive analytics, runtime info, inject-generate | Multiple: `tasks.db`, filesystem, `.cleo/config.json` | LOW — `system/metrics.ts` should call `metrics/token-service.ts` |

**Verdict**: The 5 namespaces are NOT redundant. The naming is somewhat misleading but the data boundaries are clean. The one real gap is `system/metrics.ts` stub (P0 above).

---

## Admin Domain Kitchen-Sink Assessment

`dispatch/admin.ts` handles: version, health, config, stats, context, runtime, paths, jobs, dashboard, log, sequence, help, ADR management, token tracking, backup, export, import, map, roadmap, smoke tests, hooks matrix, init, scaffold-hub, migration, cleanup, job cancellation, safestop, inject generation, context injection, install.global, detection.

This is a large surface but NOT a kitchen-sink anti-pattern in the negative sense. The domain consolidates genuine system administration operations that share the same authorization model (owner-level CLI operations). The pattern is similar to a Unix `admin` command namespace. The concern is handler fatness (most handlers are 10-60 LOC rather than 1-5 LOC), which is a P1 thinness issue rather than a design problem.

`core/admin/` is appropriately scoped: import, export, help computation, and ops.ts contract. It does NOT own health/backup/migration — those live in `core/system/`. The boundary is clean.

---

## Overall Recommendations

1. **P0 (file immediately)**: Wire `system/metrics.ts` to `summarizeTokenUsage` from `metrics/token-service.ts`. The token data is being silently dropped — `cleo dash` and `cleo admin stats` report `{ input: 0, output: 0, cache: 0, total: 0 }` for all users regardless of recorded token usage.

2. **P1 — admin.ts handler thinness**: The typed handler pattern (`_adminTypedHandler`) is architecturally correct per ADR-058 but 40/41 handlers exceed 5 LOC. The boilerplate `if (!result.success) return lafsError(...)` blocks should be abstracted. Consider a shared `wrapEngineCall(result, op)` adapter inside the typed handler block to reduce each handler to 3-5 lines.

3. **P1 — tools.ts OpsFromCore migration**: `tools.ts` is the last major dispatch domain without `OpsFromCore` inference. Requires: (a) `packages/core/src/tools/ops.ts` stub, (b) contracts `ToolsOps` type, (c) `defineTypedHandler<ToolsOps>` in the domain.

4. **P1 — diagnostics.ts OpsFromCore + test gap**: Small domain (5 ops), easy to migrate. Add `diagnosticsCoreOps` in core and add at least smoke tests for `enable`/`disable`/`status` dispatch.

5. **P1 — metrics/token-service.ts test gap**: 598 LOC with zero tests. At minimum: test `recordTokenExchange` inserts a valid row, `listTokenUsage` filters correctly, `summarizeTokenUsage` returns correct aggregates.

6. **P1 — telemetry zero test coverage**: `buildDiagnosticsReport` is a multi-query SQL analysis. Mock the drizzle DB and test the aggregation logic.

7. **P1 — stats/workflow-telemetry.ts zero test coverage**: 502 LOC of workflow compliance SQL queries. File new follow-up.

8. **P2 — system namespace README**: Document what belongs in `core/system/` vs `core/admin/`. The boundary is currently implicit.

9. **P2 — admin core no tests**: `import.ts`, `export.ts`, `import-tasks.ts`, `export-tasks.ts` handle snapshot formats and are complex enough to warrant tests.

---

## New Follow-Up Tasks to File

```
# P0 — wire system/metrics.ts token stub
cleo add "Fix getSystemMetrics token stub: wire summarizeTokenUsage from metrics/token-service.ts" \
  --parent T1520 \
  --acceptance "getSystemMetrics().tokens reflects actual tokenUsage DB data|admin stats and dash show real token totals"

# P1 — admin.ts handler thinness adapter
cleo add "Extract wrapEngineCall adapter for admin typed handler boilerplate (ADR-058)" \
  --parent T1520 \
  --acceptance "40+ admin handlers reduced to ≤5 LOC via shared adapter"

# P1 — tools.ts OpsFromCore migration
cleo add "Migrate dispatch/tools.ts to OpsFromCore typed dispatch — add toolsCoreOps and ToolsOps contract" \
  --parent T1520 \
  --acceptance "tools.ts uses defineTypedHandler<ToolsOps>|no inline 'as string' param casts remain"

# P1 — diagnostics dispatch test + OpsFromCore
cleo add "Add diagnostics dispatch test + OpsFromCore migration (diagnosticsCoreOps)" \
  --parent T1520 \
  --acceptance "diagnostics.test.ts covers enable/disable/status/analyze/export|diagnosticsCoreOps ops.ts exists"

# P1 — metrics/token-service.ts tests
cleo add "Add tests for metrics/token-service.ts — recordTokenExchange, listTokenUsage, summarizeTokenUsage" \
  --parent T1520 \
  --acceptance "At least 3 tests covering CRUD operations on tokenUsage table"

# P1 — telemetry tests
cleo add "Add tests for core/telemetry/index.ts — buildDiagnosticsReport aggregation logic" \
  --parent T1520 \
  --acceptance "buildDiagnosticsReport tested against mock drizzle DB|recordTelemetryEvent insert verified"

# P1 — stats/workflow-telemetry.ts tests
cleo add "Add tests for core/stats/workflow-telemetry.ts workflow compliance queries" \
  --parent T1520 \
  --acceptance "getWorkflowComplianceReport tested with mock task/session data"
```

---

## Cross-References

- **ADR-058**: OpsFromCore dispatch inference — `tools.ts` and `diagnostics.ts` are not yet migrated
- **ADR-057**: Contract SSoT — `metrics/token-service.ts` has 6 open SSoT-EXEMPT annotations tracked in T1511 (open, pending)
- **T1511**: ADR-057 D1 normalization for `metrics/token-service.ts` — OPEN, correctly targeted
- **T1528**: This audit task
- **T1520**: Parent audit epic

## Files Reviewed (counts)

| Package | Files | LOC |
|---------|-------|-----|
| dispatch/admin.ts | 1 | 1290 |
| dispatch/tools.ts | 1 | 684 |
| dispatch/diagnostics.ts | 1 | 95 |
| core/admin/ | 7 | 965 |
| core/observability/ | 5 | 596 |
| core/metrics/ | 10 | 2559 |
| core/telemetry/ | 3 | 547 |
| core/stats/ | 2 | 935 |
| core/system/ | 18 | 4527 |
| **Total** | **48** | **12,198** |
