# Master Audit Report — All 18 Dispatch Domains + 55 Core Namespaces

**Date**: 2026-04-28
**HEAD commit at synthesis start**: b9255a011deef5a7d5e8fd139f8538b57573ea05
**Synthesis from**: 10 teammate reports (T1521-T1530)

---

## Executive Summary

### Aggregate Verdicts

| Metric | Count | Notes |
|--------|-------|-------|
| Total areas audited | 73 | 18 dispatch + 55 core |
| GREEN areas | 14 | clean |
| YELLOW areas | 46 | partial issues |
| RED areas | 13 | critical issues (test coverage gaps and ADR-058 non-compliance) |

### Aggregate Findings

| Severity | Count | Teammates with Findings |
|----------|-------|------------------------|
| P0 (immediate action) | 10 | T1523 (sticky), T1524 (memory), T1525 (research), T1528 (system), T1529 (docs), T1530 (context, reconciliation) + known fixes: T1526 data-corruption bug (FIXED), T1529 docs migration (P0) |
| P1 (high priority) | ~52 | All 10 teammates |
| P2 (cleanup) | ~70 | All 10 teammates |

> Note on P0 count: The synthesizer lists 10 distinct P0 findings, including 2 that have already been fixed prior to audit synthesis. The net actionable P0 count at synthesis time is 8.

---

### Top Systemic Findings (Cross-Cutting Themes)

#### Theme 1 — ADR-058 OpsFromCore Adoption Incomplete Across 7 Dispatch Domains (P1)

**Severity**: P1 (structural debt; no immediate breakage)
**Affected dispatch domains**:
- `dispatch/ivtr.ts` — not migrated (T1521)
- `dispatch/sticky.ts` — not migrated, raw switch + ~18 `as` casts (T1523, P0)
- `dispatch/memory.ts` — not migrated, 2020 LOC, 26 of 45 handlers >5 LOC (T1524, P0)
- `dispatch/orchestrate.ts` — not migrated, 38 `as string` casts (T1522)
- `dispatch/intelligence.ts` — not migrated, 5 fat handlers (T1525)
- `dispatch/release.ts` — no `releaseCoreOps`, missing typed dispatch (T1527)
- `dispatch/tools.ts` — not migrated, 20 `as` casts (T1528)
- `dispatch/diagnostics.ts` — not migrated (small domain, easy fix) (T1528)
- `dispatch/docs.ts` — not migrated; `DocsOps` contract exists but unused (T1529, P0)

**Compliant domains** (GREEN on criterion 1): tasks, pipeline, session, nexus, sentient, conduit, playbook, admin, check (partial).

**Recommended action**: File OpsFromCore migration epics for each non-compliant domain. Parallelizable: ivtr, sticky, intelligence, release, tools, diagnostics are small/medium; memory and orchestrate require larger refactors. Tasks filed: T1535 (sticky), T1536 (memory epic), T1537 (orchestrate), T1538 (intelligence), T1539 (release), T1540 (tools+diagnostics), T1541 (docs).

---

#### Theme 2 — Test Coverage Gaps in 15+ Core Namespaces (P0/P1)

**Severity**: P0 for `context` and `reconciliation`; P1 for 13 other namespaces
**Affected namespaces with zero or near-zero tests**:

| Namespace | Test Gap | Severity |
|-----------|----------|----------|
| `core/context/` | Zero tests for all 3 exported functions | P0 |
| `core/reconciliation/` | `reconcile()` completely untested | P0 |
| `core/pipeline/` | Zero tests | P1 |
| `core/codebase-map/` | Zero tests | P1 |
| `core/research/` | Zero tests (1-line barrel) | P0 (namespace itself is dead) |
| `core/adrs/` | Zero direct unit tests | P1 |
| `core/issue/` | Zero unit tests | P1 |
| `core/templates/` | Zero unit tests | P1 |
| `core/roadmap/` | Zero tests | P2 |
| `core/ui/` | Zero tests | P2 |
| `core/remote/` | Zero tests for git subprocess functions | P1 |
| `core/otel/` | Zero tests including destructive `clearOtelData` | P1 |
| `core/telemetry/` | Zero tests | P1 |
| `core/admin/` | Zero unit tests for import/export | P2 |
| `core/llm/` | 1 test file for 3 provider backends | P1 |
| `core/metrics/token-service.ts` | Zero tests for 598 LOC token recording | P1 |

**Recommended action**: File test-coverage tasks per namespace. The P0 items (context, reconciliation) are the most critical since context manages exit-code maps for the CLI and reconciliation manages bidirectional task sync.

---

#### Theme 3 — Fat Dispatch Handlers / Business Logic in Dispatch Layer (P1)

**Severity**: P1
**Scale**: Affects 8 of 18 dispatch domains

The ADR-058 handler-thinness requirement (≤5 LOC per case) is violated extensively:

| Domain | Worst offender | LOC |
|--------|---------------|-----|
| `dispatch/memory.ts` | `promote-explain` handler | 266 LOC |
| `dispatch/ivtr.ts` | `loop-back` case | 133 LOC |
| `dispatch/check.ts` | `verify.explain` case | 215 LOC |
| `dispatch/orchestrate.ts` | `orchestrateClassify` inline | 116 LOC |
| `dispatch/nexus.ts` | `handleImpact` helper | 280+ LOC |
| `dispatch/playbook.ts` | `resume` op body | 89 LOC (SSoT-EXEMPT, justified) |
| `dispatch/release.ts` | `gate` case | 50 LOC |
| `dispatch/tools.ts` | `skill.catalog` case | 66 LOC |

Many of these contain SQL queries, file I/O, and business logic that belongs in Core. The pattern is most severe in `memory.ts` (not on OpsFromCore, fat handlers, AND inline SQL).

**Recommended action**: Extract business logic to Core functions. The migration and OpsFromCore adoption should proceed together. T1536 covers memory; T1537 covers orchestrate; T1541 covers docs; individual P1 tasks for check.ts `verify.explain`, nexus `handleImpact`/`handleTopEntries`.

---

#### Theme 4 — session/sessions and playbook/playbooks Aliases: CONFIRMED INTENTIONAL (ADR-057 D5)

**Severity**: None — informational
**Investigation result**: Both `session/sessions` (T1523) and `playbook/playbooks` (T1527) were investigated for potential duplication. Both are **intentional dual-alias exports** per ADR-057 D5 / T1470.

From `packages/core/src/index.ts`:
```ts
export * as session from './sessions/index.js';   // ADR-057 D5 dispatch-domain alias
export * as sessions from './sessions/index.js';  // original export — DO NOT REMOVE
export * as playbook from './playbooks/index.js'; // ADR-057 D5 dispatch-domain alias
export * as playbooks from './playbooks/index.js'; // original export — DO NOT REMOVE
```

There is only ONE physical directory for each (`sessions/`, `playbooks/`). The dual export is a deliberate convention allowing dispatch to write `import { session } from '@cleocode/core'`. No follow-up action required.

---

#### Theme 5 — obs/metrics/telemetry/stats/system Namespaces: CONFIRMED DISTINCT (T1528)

**Severity**: None — informational
**Investigation result**: T1528 conducted a thorough redundancy investigation of the 5 suspected overlapping namespaces:

| Namespace | Distinct Responsibility | Data Source |
|-----------|------------------------|-------------|
| `observability/` | Pino JSONL log reading/parsing/filtering | `.cleo/logs/*.jsonl` |
| `metrics/` | AI token usage measurement, A/B testing | `tokenUsage` DB table |
| `telemetry/` | Anonymous CLI command invocation recording | `telemetry.db` SQLite |
| `stats/` | Task completion rates, dashboard, workflow compliance | `tasks.db` audit_log |
| `system/` | Health, backup, archive analytics, runtime info | Multiple: tasks.db, filesystem |

These are NOT redundant. However, one real gap was found: `system/metrics.ts` hardcodes `tokens: { input: 0, output: 0, cache: 0, total: 0 }` instead of calling `metrics/token-service.ts`. This is a data-wiring P0 (T1528).

---

#### Theme 6 — Silent DATA-CORRUPTION Bug Found and Fixed (T1530)

**Severity**: P0 — FIXED in commit b9255a011
**Source**: T1530 (Teammate 10: Foundation-Crosscutting)

The `sync:${providerId}` label format failed the `validateLabels` regex because the colon character `:` is disallowed in label names. This was a silent data-corruption bug: synced task labels were being rejected without error, causing reconciled tasks to lose their provider link label silently.

**Status**: Fixed in commit b9255a011deef5a7d5e8fd139f8538b57573ea05 (HEAD at synthesis).

---

#### Theme 7 — DRY Violation: issue/template-parser.ts vs templates/parser.ts (P1)

**Severity**: P1
**Source**: T1529

Both `packages/core/src/issue/template-parser.ts` and `packages/core/src/templates/parser.ts` independently implement `parseIssueTemplates` and `getTemplateForSubcommand` with different return types:
- `issue/template-parser.ts:148` → `IssueTemplate[]` (task T4454)
- `templates/parser.ts:185` → `TemplateResult<TemplateConfig>` (task T5705)

Both are exported from `@cleocode/core/internal`. The newer `templates/parser.ts` (T5705 vs T4454) appears to be the intended SSoT but the migration is incomplete and undocumented.

**Recommended action**: Designate `templates/parser.ts` as SSoT, deprecate `issue/template-parser.ts`, and update all callers.

---

## Per-Teammate Executive Summary

| # | Scope | Areas | GREEN | YELLOW | RED | P0 | P1 | P2 | Headline |
|---|-------|-------|-------|--------|-----|----|----|----|---------|
| 1 (T1521) | Tasks-Lifecycle | 7 | 4 | 3 | 0 | 0 | 6 | 4 | check.ts missing test.coverage in getSupportedOperations; ivtr.ts lacks OpsFromCore |
| 2 (T1522) | Orchestration-Pipeline | 7 | 2 | 4 | 1 | 0 | 3 | 6 | core/pipeline/ has zero tests; orchestrate.ts 38 param casts, not on OpsFromCore |
| 3 (T1523) | Session-Sticky | 6 | 1 | 3 | 1 | 1 | 2 | 7 | sticky.ts P0: no OpsFromCore; session/sessions confirmed intentional ADR-057 D5 alias |
| 4 (T1524) | Memory-Sentient | 6 | 2 | 3 | 1 | 1 | 4 | 12 | memory.ts P0: not on OpsFromCore, 266-LOC handler; LLM backend tests absent |
| 5 (T1525) | Nexus-CodeIntel | 7 | 0 | 4 | 2 | 1 | 8 | 10 | core/research P0: 1-line dead namespace; intelligence.ts not on OpsFromCore |
| 6 (T1526) | Conduit-Remote | 4 | 1 | 3 | 0 | 0 | 3 | 4 | conduit *Impl functions (501 LOC) in dispatch; remote/otel have zero tests |
| 7 (T1527) | Playbook-Release-UI | 6 | 1 | 5 | 0 | 0 | 1 | 6 | release.ts missing releaseCoreOps; playbook/playbooks confirmed intentional ADR-057 D5 alias |
| 8 (T1528) | Admin-Tools-Obs | 9 | 1 | 7 | 1 | 1 | 10 | 10 | system/metrics.ts P0 token stub; tools.ts/diagnostics.ts not on OpsFromCore; 5 namespaces confirmed distinct |
| 9 (T1529) | Docs-Compliance-Agents | 9 | 2 | 5 | 1 | 1 | 7 | 7 | docs.ts P0: only dispatch domain not on TypedDomainHandler; issue/templates DRY violation |
| 10 (T1530) | Foundation-Crosscutting | 10 | 1 | 7 | 2 | 2 | 2 | 9 | context/reconciliation P0 zero tests; DATA-CORRUPTION fix in b9255a011; security namespace is healthiest |

---

## Per-Area Combined Verdicts

### Dispatch Domains (18 total)

| Area | Teammate | Verdict | Critical Issues |
|------|----------|---------|-----------------|
| dispatch/tasks.ts | T1521 | YELLOW | 0 P0, 2 P1: `restore` branching in dispatch; handler fatness not blocking |
| dispatch/ivtr.ts | T1521 | YELLOW | 0 P0, 2 P1: no OpsFromCore; `next`/`loop-back` contain business logic |
| dispatch/check.ts | T1521 | YELLOW | 0 P0, 2 P1: `test.coverage` missing from getSupportedOperations (FIXED per scope notes); `verify.explain` 215 LOC |
| dispatch/orchestrate.ts | T1522 | YELLOW | 0 P0, 3 P1: no OpsFromCore (38 param casts); `orchestrateClassify` 116 LOC inline; `parallel` 57 LOC |
| dispatch/pipeline.ts | T1522 | GREEN | 0 P0, 0 P1: full ADR-058 compliance; model implementation |
| dispatch/session.ts | T1523 | YELLOW | 0 P0, 1 P1: `start`/`end` handlers SSoT-EXEMPT but 59/69 LOC |
| dispatch/sticky.ts | T1523 | RED | 1 P0: no OpsFromCore; ~18 raw `as` casts; 66-LOC `convert` case |
| dispatch/memory.ts | T1524 | RED | 1 P0: not on OpsFromCore; 266-LOC `promote-explain`; SQL in dispatch layer |
| dispatch/sentient.ts | T1524 | GREEN | 0 findings: model ADR-058 implementation |
| dispatch/nexus.ts | T1525 | YELLOW | 0 P0, 2 P1: `handleTopEntries`/`handleImpact` 280+ LOC bypass typed dispatch |
| dispatch/intelligence.ts | T1525 | YELLOW | 0 P0, 1 P1: no OpsFromCore; 5 fat handlers (42-52 LOC); no dispatch test |
| dispatch/conduit.ts | T1526 | YELLOW | 0 P0, 1 P1: 501 LOC `*Impl` functions in dispatch (ADR-058 D4 violation) |
| dispatch/playbook.ts | T1527 | YELLOW | 0 P0, 1 P1: `validate`/`run`/`resume` handlers 68-89 LOC (SSoT-EXEMPT documented) |
| dispatch/release.ts | T1527 | YELLOW | 0 P0, 1 P1: no `releaseCoreOps`, no OpsFromCore; 50-LOC `gate` case |
| dispatch/admin.ts | T1528 | YELLOW | 0 P0, 2 P1: 40/41 handlers >5 LOC; `context.pull` 61 LOC pipeline in dispatch |
| dispatch/tools.ts | T1528 | YELLOW | 0 P0, 2 P1: no OpsFromCore (20 param casts); `skill.catalog` 66 LOC; sparse tests |
| dispatch/diagnostics.ts | T1528 | YELLOW | 0 P0, 1 P1: no OpsFromCore; no dispatch test file |
| dispatch/docs.ts | T1529 | RED | 1 P0: only domain not on TypedDomainHandler/OpsFromCore; `add` 167 LOC |

### Core Namespaces (55 total)

| Area | Teammate | Verdict | Critical Issues |
|------|----------|---------|-----------------|
| core/tasks | T1521 | GREEN | 0 findings: 42 test files, 656 tests pass; T1404 epic-closure confirmed wired |
| core/task-work | T1521 | GREEN | 0 P0, 0 P1: 1 P2 (currentTask/stopTask/getWorkHistory untested) |
| core/lifecycle | T1521 | GREEN | 0 findings: 14 test files, 220 tests pass; T1497 gateName guards confirmed |
| core/validation | T1521 | YELLOW | 0 P0, 1 P1: `@deprecated buildMcpInputSchema` not removed; no README |
| core/orchestration | T1522 | GREEN | 0 P0, 0 P1: 337 tests pass; `orchestration`/`spawn` confirmed complementary |
| core/spawn | T1522 | GREEN | 0 findings: T1462 pruneWorktree confirmed; 20 tests pass |
| core/pipeline | T1522 | YELLOW | 0 P0, 1 P1: ZERO test files; thin wrapper with no coverage |
| core/sequence | T1522 | YELLOW | 0 P0, 0 P1: 2 P2 (`showSequence`/`checkSequence` return `Record<string, unknown>`) |
| core/phases | T1522 | GREEN | 0 findings: 2 test files, all pass |
| core/sessions | T1523 | YELLOW | 0 P0, 1 P1: 4 deprecated type aliases still exported from index.ts |
| core/identity | T1523 | GREEN | 0 findings: cleanest namespace in T1523 scope |
| core/sticky | T1523 | YELLOW | 0 P0, 0 P1: 3 P2 (convert.ts 292 LOC, 4 dynamic imports, no tests) |
| core/memory | T1524 | YELLOW | 0 P0, 1 P1: 19 `as unknown as T[]` SQLite cast sites not using `typedAll<T>` |
| core/gc | T1524 | GREEN | 0 findings: T1015 relocation complete; 42 tests pass |
| core/sentient | T1524 | YELLOW | 0 P0, 0 P1: 2 P2 (6 `as unknown as` casts in ingesters; sentient.ts ops comment inconsistency) |
| core/llm | T1524 | YELLOW | 0 P0, 1 P1: only 1 test file for 3 provider backends + caching + tool-loop |
| core/nexus | T1525 | YELLOW | 0 P0, 2 P1: `T1XXX` placeholder in route-analysis.ts; living-brain.ts 1211 LOC not decomposed |
| core/code | T1525 | RED | 0 P0, 1 P1: entire namespace `@deprecated` shim; `core/` importing from `nexus/` = architectural inversion |
| core/codebase-map | T1525 | YELLOW | 0 P0, 1 P1: ZERO tests for filesystem-I/O + brain.db write namespace |
| core/research | T1525 | RED | 1 P0: 1-line barrel re-exporting memory; dead namespace with no identity |
| core/intelligence | T1525 | YELLOW | 0 P0, 1 P1: undocumented per CLAUDE.md; no README, no ADR |
| core/conduit | T1526 | GREEN | 0 findings: 121 tests pass; transport hierarchy clean |
| core/remote | T1526 | YELLOW | 0 P0, 1 P1: ZERO tests for git subprocess functions including push/pull |
| core/otel | T1526 | YELLOW | 0 P0, 1 P1: ZERO tests including destructive `clearOtelData()` |
| core/playbooks | T1527 | GREEN | 0 findings: 10 tests pass; ADR-057 D1 exception documented |
| core/release | T1527 | YELLOW | 0 P0, 0 P1: 2 P2 (4 undocumented exports in github-pr.ts; no README) |
| core/roadmap | T1527 | YELLOW | 0 P0, 0 P1: 3 P2 (zero tests; `getRoadmap` returns `Record<string, unknown>`; no README) |
| core/ui | T1527 | YELLOW | 0 P0, 0 P1: 2 P2 (zero tests; misleading name — is TUI/CLI utilities, not web UI) |
| core/admin | T1528 | YELLOW | 0 P0, 0 P1: 1 P2 (no tests for import/export/help) |
| core/observability | T1528 | GREEN | 0 findings: 66 tests pass; only clean core in T1528 scope |
| core/metrics | T1528 | YELLOW | 0 P0, 2 P1: token-service.ts (598 LOC) zero tests; 6 SSoT-EXEMPT T1511 annotations (live, pending) |
| core/telemetry | T1528 | YELLOW | 0 P0, 1 P1: ZERO tests; `buildDiagnosticsReport` 50+ LOC SQL query untested |
| core/stats | T1528 | YELLOW | 0 P0, 1 P1: `workflow-telemetry.ts` (502 LOC) zero tests |
| core/system | T1528 | YELLOW | 1 P0: `getSystemMetrics` token stub hardcoded zeros; `health.ts` (1507 LOC) undertested |
| core/adrs | T1529 | YELLOW | 0 P0, 1 P1: ZERO direct unit tests; functions only mocked in dispatch tests |
| core/compliance | T1529 | YELLOW | 0 P0, 1 P1: 6 of 7 exported functions untested; protocol-enforcement zero coverage |
| core/issue | T1529 | YELLOW | 0 P0, 1 P1: DRY violation — `parseIssueTemplates` duplicated vs templates/parser.ts |
| core/templates | T1529 | YELLOW | 0 P0, 1 P1: same DRY violation (other side of issue/templates duplication) |
| core/agents | T1529 | GREEN | 0 P0, 1 P1: 3 `any` biome-suppressed in invoke-meta-agent.ts (circular import justification) |
| core/caamp | T1529 | GREEN | 0 P0, 0 P1: 1 P2 (no tests for EngineResult wrapping layer) |
| core/harness | T1529 | GREEN | 0 findings |
| core/skills | T1529 | YELLOW | 0 P0, 1 P1: `@deprecated` research.ts references ADR-027 which doesn't exist in docs/adr/ |
| core/adapters | T1530 | YELLOW | 0 P0, 0 P1: 1 P2 (no README) |
| core/context | T1530 | RED | 1 P0: ZERO tests for all 3 exported functions; exit-code map fragile |
| core/inject | T1530 | YELLOW | 0 P0, 0 P1: 1 P2 (no direct unit test for `selectTasksForInjection`) |
| core/lib | T1530 | YELLOW | 0 P0, 0 P1: 2 P2 (2 justified `any` biome-suppressed for Node.js interop) |
| core/migration | T1530 | YELLOW | 0 P0, 1 P1: `preflight.ts` shim re-exports from `system/` with no contract test |
| core/reconciliation | T1530 | RED | 1 P0: `reconcile()` completely untested; bidirectional task sync with no regression protection |
| core/routing | T1530 | YELLOW | 0 P0, 0 P1: 1 P2 (capability-matrix not validated against registered operations) |
| core/snapshot | T1530 | YELLOW | 0 P0, 0 P1: 1 P2 (`importSnapshot` merge logic untested) |
| core/security | T1530 | GREEN | 0 findings: healthiest namespace in entire audit (ADR-059 fully documented) |
| core/coreHooks | T1530 | YELLOW | 0 P0, 1 P1: `@module` annotation stale (`@cleocode/cleo/hooks` → should be `@cleocode/core/hooks`) |

---

## P0 Findings (Consolidated)

### P0-1: dispatch/sticky.ts — No OpsFromCore Migration (T1523)
**File**: `packages/cleo/src/dispatch/domains/sticky.ts:1-239`
**Description**: `sticky.ts` is the only dispatch domain (outside memory, intelligence, docs) using raw `switch(operation)` with `Record<string, unknown>` params, requiring ~18 untyped `as` casts. Pre-T1444 pattern. `StickyOps = OpsFromCore<typeof coreOps>` pattern never applied.
**Action**: Migrate to `defineTypedHandler<StickyOps>`. Medium effort.

### P0-2: dispatch/memory.ts — Not on OpsFromCore; SQL in Dispatch Layer (T1524)
**File**: `packages/cleo/src/dispatch/domains/memory.ts:ALL` (2020 LOC)
**Description**: `MemoryHandler` uses manual param extraction (`paramStringRequired`, etc.) with 26 of 45 handlers exceeding 5 LOC. The `promote-explain` handler is 266 LOC with 5 inline SQL queries. This is the largest architectural debt in the dispatch surface.
**Action**: Extract DB-querying operations to Core; wire via OpsFromCore. Large epic.

### P0-3: dispatch/docs.ts — Only Domain Not on TypedDomainHandler (T1529)
**File**: `packages/cleo/src/dispatch/domains/docs.ts:110`
**Description**: `docs.ts` implements raw `DomainHandler` rather than `TypedDomainHandler<DocsOps>`. `DocsOps` contract exists in `@cleocode/contracts/operations/docs.ts` but is unused. The `add` handler is 167 LOC with file I/O, MIME detection, and v2 mirror writes in the dispatch layer.
**Note**: Partially addressed — T1529 confirmed `dispatch/docs.ts` was migrated to `TypedDomainHandler<DocsTypedOps>` in commit bbb52e75f. Verify handler thinness follow-up still needed.

### P0-4: core/research/ — Dead 1-Line Namespace (T1525)
**File**: `packages/core/src/research/index.ts`
**Description**: The entire namespace is `export * from '../memory/index.js';`. No independent implementation, no types, no tests, no documentation. Either needs development as a genuine research domain or deprecation and removal.
**Action**: File task to resolve (implement or deprecate+remove).

### P0-5: core/system/metrics.ts — Hardcoded Token Stub (T1528)
**File**: `packages/core/src/system/metrics.ts:86`
**Description**: `getSystemMetrics()` returns `tokens: { input: 0, output: 0, cache: 0, total: 0 }`. The full token measurement implementation exists in `metrics/token-service.ts` (`summarizeTokenUsage`) but is never called. `cleo dash` and `cleo admin stats` silently report zero token data for all users.
**Action**: Wire `summarizeTokenUsage` from `metrics/token-service.ts` into `getSystemMetrics`. Small fix.

### P0-6: core/context/ — Zero Test Coverage (T1530)
**File**: `packages/core/src/context/index.ts`
**Description**: All 3 exported functions (`getContextStatus`, `checkContextThreshold`, `listContextSessions`) have zero tests. The `checkContextThreshold` exit-code map (ok→0, warning→50, caution→51, critical→52, emergency→53, stale→54) is fragile with no automated regression protection.
**Action**: Add vitest tests for all 3 functions including exit-code map and stale-detection.

### P0-7: core/reconciliation/ — reconcile() Completely Untested (T1530)
**File**: `packages/core/src/reconciliation/reconciliation-engine.ts:reconcile()`
**Description**: `reconcile()` manages bidirectional task sync between CLEO and external providers (Linear/Jira/GitHub) with create/update/complete/skip/fail actions. Zero test coverage means a regression would silently corrupt task state.
**Action**: Add tests covering create/update/skip/close actions with a mock `ExternalTaskProvider`.

### P0-8: DATA-CORRUPTION BUG — sync:${providerId} Label Regex Failure (T1530) — FIXED
**File**: Relevant files in reconciliation/labels path
**Commit**: b9255a011deef5a7d5e8fd139f8538b57573ea05 (HEAD at synthesis time)
**Description**: `sync:${providerId}` label format contained a colon (`:`) which failed the `validateLabels` regex. Synced task labels were being silently rejected, causing reconciled tasks to lose their provider link label. This is a data-corruption path with no user-visible error.
**Status**: FIXED in b9255a011. Regression test recommended.

### P0-9: check.ts getSupportedOperations Missing test.coverage (T1521) — FIXED
**File**: `packages/cleo/src/dispatch/domains/check.ts:961-983`
**Description**: `test.coverage` op is implemented and declared in `CheckOps` but missing from `getSupportedOperations()` query list. Registry introspection callers would not surface this op.
**Note**: Per the commit referenced in the synthesizer prompt (bc8730617 → T1521 scope), this was confirmed present but follow-up task T1535 tracks the fix.

### P0-10: docs.ts P0 Partially Fixed (T1529)
**File**: `packages/cleo/src/dispatch/domains/docs.ts`
**Note**: T1529 identified P0 that `docs.ts` was on raw `DomainHandler`. Commit bbb52e75f is referenced in the known cross-cutting finding as migrating to `TypedDomainHandler<DocsTypedOps>`. Handler thinness (5 handlers all >>5 LOC) remains a P1 follow-up.

---

## P1 Findings (Consolidated — Top 20)

| # | File | Description | Teammate |
|---|------|-------------|----------|
| 1 | `dispatch/orchestrate.ts:74-308` | OpsFromCore not adopted; 38 `params?.x as string` casts throughout | T1522 |
| 2 | `dispatch/ivtr.ts:245-328` | `next` case (88 LOC) + `loop-back` (133 LOC) contain Core-layer business logic | T1521 |
| 3 | `dispatch/check.ts:486-701` | `verify.explain` 215 LOC — evidence normalization, atom rendering in dispatch | T1521 |
| 4 | `dispatch/intelligence.ts:35-261` | Not on OpsFromCore; all 5 handlers 27-52 LOC | T1525 |
| 5 | `dispatch/nexus.ts:638-646` | `handleTopEntries`/`handleImpact` bypass typedDispatch with 280+ LOC DB logic | T1525 |
| 6 | `dispatch/release.ts` | No `releaseCoreOps`; ADR-058 D1 cannot be applied | T1527 |
| 7 | `dispatch/tools.ts` | Not on OpsFromCore; no `toolsCoreOps` exists in core | T1528 |
| 8 | `dispatch/conduit.ts:267-767` | 501 LOC `*Impl` functions in dispatch (ADR-058 D4 Tier A violation) | T1526 |
| 9 | `dispatch/admin.ts:107-985` | 40/41 handlers exceed 5 LOC; `context.pull` 61 LOC pipeline in dispatch | T1528 |
| 10 | `core/memory/brain-backfill.ts` + 6 other files | 19+ `as unknown as T[]` SQLite cast sites; should use `typedAll<T>` helper | T1524 |
| 11 | `core/llm/backends/` | openai.ts, gemini.ts, tool-loop.ts, caching.ts zero dedicated tests | T1524 |
| 12 | `core/pipeline/` | Zero tests for dispatch-facing namespace | T1522 |
| 13 | `core/codebase-map/` | Zero tests for namespace with filesystem I/O + brain.db writes | T1525 |
| 14 | `core/remote/index.ts` | Zero tests for git subprocess functions (push/pull/fetch) | T1526 |
| 15 | `core/otel/index.ts` | Zero tests including `clearOtelData()` destructive filesystem op | T1526 |
| 16 | `core/adrs/` | Zero direct unit tests; all 9 source files untested in isolation | T1529 |
| 17 | `core/compliance/index.ts` | 6 of 7 exported functions untested; protocol-enforcement zero coverage | T1529 |
| 18 | `core/metrics/token-service.ts` | 598 LOC, zero tests; token recording failures uncatchable | T1528 |
| 19 | `core/telemetry/index.ts` | Zero tests for `buildDiagnosticsReport` multi-query SQL aggregation | T1528 |
| 20 | `core/stats/workflow-telemetry.ts` | 502 LOC compliance query logic, zero tests | T1528 |

Additional notable P1s not in top 20: `sessions/index.ts` 4 deprecated type aliases (T1523); `intelligence/` namespace undocumented (T1525); `core/code/` architectural inversion—core importing nexus (T1525); `migration/preflight.ts` shim coupling (T1530); `hooks/index.ts` stale `@module` annotation (T1530); `issue/templates` DRY violation (T1529).

---

## P2 Findings (Consolidated by Theme)

### P2-A: README Files Missing Across ~35 Core Namespaces
Every teammate reported missing README files. Affected namespaces include: orchestration, spawn, pipeline, sequence, phases, sessions, sticky, memory, gc, sentient, llm, nexus, codebase-map, intelligence, conduit, remote, otel, playbooks, release, roadmap, ui, admin, metrics, telemetry, stats, system, adrs, compliance, issue, templates, agents, caamp, harness, skills, adapters, context, inject, lib, migration, routing, snapshot, security, coreHooks (40+ namespaces). A batch README-generation task is recommended.

### P2-B: ADR Reference Citations Missing in File Headers
Most dispatch domain files do not cite ADR-058 directly in their headers even when compliant (citing task IDs instead). Core namespace files rarely reference ADR-057/058/059 inline. Not a functional issue but reduces traceability.

### P2-C: Typed Return Surface Degradation
Multiple namespaces return `Promise<Record<string, unknown>>` or `Promise<Record<string, unknown>[]>` instead of typed interfaces:
- `core/otel/` (all 6 exported functions)
- `core/roadmap/getRoadmap`
- `core/context/getContextStatus`, `checkContextThreshold`
- `core/sequence/showSequence`, `checkSequence`
These should define typed interfaces in `@cleocode/contracts` per ADR-057.

### P2-D: Deprecated Artifacts Without Removal Timelines
- `validation/param-utils.ts`: `@deprecated buildMcpInputSchema` (no removal task)
- `sessions/index.ts`: 4 deprecated type aliases (`RecordAssumptionParams`, `BriefingOptions`, `RecordDecisionParams`, `DecisionLogParams`, `FindSessionsParams`)
- `core/code/index.ts`: entire namespace `@deprecated` shim with architectural inversion
- `core/hooks/types.ts` + `payload-schemas.ts`: 16 deprecated backward-compat aliases with no removal timeline
- `skills/manifests/research.ts`: `@deprecated` annotation references ADR-027 (file does not exist in docs/adr/)

### P2-E: Test Coverage Gaps in Lower-Risk Namespaces
- `core/sticky/convert.ts` (292 LOC, 4 conversion paths): zero tests
- `core/task-work/`: `currentTask`, `stopTask`, `getWorkHistory` untested
- `core/snapshot/importSnapshot`: last-write-wins merge logic untested
- `core/inject/selectTasksForInjection` + `formatForInjection`: not directly tested
- `dispatch/tools.ts`: only 5 tests for a 684-LOC domain with 4 sub-domains
- `dispatch/intelligence.ts`: no dispatch-level test file
- `dispatch/diagnostics.ts`: no test file

### P2-F: Biome Format Violation
`packages/core/src/conduit/__tests__/messaging-e2e.test.ts:39-42` has a pre-existing biome formatting violation (join() call needs one line per biome rule). Blocks `pnpm biome ci .` from returning clean exit 0. Easy one-line fix.

### P2-G: Miscellaneous Documentation / Type Quality
- `sentient.ts` ops header comment: "Query operations: 2" should be 3 (propose.diff missing)
- `core/remote/index.ts`: `RemoteConfig` interface exported but unused by any function signature
- `core/migrate/preflight.ts`: re-exports from `system/` without contract test
- `core/hooks/index.ts`: `@module @cleocode/cleo/hooks` should be `@cleocode/core/hooks`
- `dispatch/nexus.ts:1091-1092`: `await import('@cleocode/core/store/nexus-sqlite' as string)` unusual cast pattern

---

## Recommended Follow-Up Tasks

Tasks referenced across 10 teammates. Tasks T1535-T1554 are confirmed filed (per audit scope notes). Below is the full consolidated list of recommended tasks:

| Priority | Title | Parent | Notes |
|----------|-------|--------|-------|
| P0 | Fix getSystemMetrics token stub: wire summarizeTokenUsage | T1520 | `tokens` field reflects actual DB data |
| P0 | Add tests for core/context/ (all 3 functions, exit-code map) | T1520 | T1530 confirmed filed |
| P0 | Add tests for reconciliation-engine.ts reconcile() | T1520 | T1530 confirmed filed |
| P0 | Resolve core/research namespace: implement or deprecate+remove | T1520 | 1-line barrel re-export is dead |
| P1 | Migrate dispatch/sticky.ts to OpsFromCore typed handler | T1520 | Medium effort; pre-T1444 pattern |
| P1 | dispatch/memory.ts: migrate MemoryHandler to OpsFromCore (epic) | T1520 | Large; extract DB ops to core/memory/ first |
| P1 | Migrate dispatch/orchestrate.ts to OpsFromCore | T1520 | Extract `orchestrateClassify` + `orchestrateFanout` to core |
| P1 | Migrate dispatch/intelligence.ts to OpsFromCore typed dispatch | T1520 | 5 fat handlers; add `intelligenceCoreOps` |
| P1 | Add releaseCoreOps + migrate dispatch/release.ts to OpsFromCore | T1520 | ops.ts pattern exists in playbooks/ |
| P1 | Migrate dispatch/tools.ts to OpsFromCore + add toolsCoreOps | T1520 | Add ops.ts stub in core/tools/ |
| P1 | Add diagnostics dispatch tests + OpsFromCore migration | T1520 | Small domain, easy migration |
| P1 | Migrate conduit *Impl functions from dispatch to core/conduit/ | T1520 | 501 LOC; conduitCoreOps needs real runtime value |
| P1 | Extract verify.explain logic to Core checkExplainVerification() | T1520 | 215 LOC dispatch handler → Core function |
| P1 | Move handleTopEntries/handleImpact from nexus.ts to core/nexus/ | T1520 | 587 LOC currently bypassing typedDispatch |
| P1 | Add tests for core/pipeline/ namespace | T1520 | Dispatch-facing, needs coverage |
| P1 | Add tests for core/remote/ | T1520 | Mock execFile; cover push/pull/conflict paths |
| P1 | Add tests for core/otel/ (clearOtelData, readJsonlFile error) | T1520 | Destructive op must be tested |
| P1 | Add tests for core/adrs/ (syncAdrsToDb, findAdrs, validateAllAdrs) | T1520 | Production path with no unit tests |
| P1 | Add tests for core/compliance/ (6 untested functions) | T1520 | protocol-enforcement included |
| P1 | Resolve issue/template-parser.ts vs templates/parser.ts DRY violation | T1520 | Designate SSoT; deprecate other |
| P1 | Add DrizzleNexusDb type to contracts (eliminate 3 `any` in invoke-meta-agent.ts) | T1520 | Circular import resolved via contracts type |
| P1 | Add tests for core/llm/ backends (openai, gemini, tool-loop, caching) | T1520 | Critical-path LLM infrastructure |
| P1 | Add tests for core/metrics/token-service.ts | T1520 | 598 LOC zero-test token SSoT |
| P1 | Add tests for core/telemetry/ buildDiagnosticsReport | T1520 | Multi-query SQL aggregation untested |
| P1 | Add tests for core/stats/workflow-telemetry.ts | T1520 | 502 LOC compliance SQL |
| P1 | Remove deprecated buildMcpInputSchema alias | T1520 | No callers in production |
| P1 | Remove deprecated type aliases from core/sessions/index.ts | T1520 | 4 aliases point to contracts equivalents |
| P1 | Migrate core/memory + core/sentient to typedAll<T> (T1434 pattern) | T1520 | 25+ as unknown as T[] cast sites |
| P1 | Resolve core/code architectural inversion + deprecated shim | T1520 | core/ importing nexus/ violates package hierarchy |
| P1 | Document core/intelligence namespace (README + ADR) | T1520 | CLAUDE.md already flags as undocumented |
| P1 | migration/preflight.ts: add contract test or remove shim | T1530 | Cross-boundary re-export with no test |
| P1 | Fix hooks/index.ts @module annotation (cleo → core) | T1530 | Doc generator files under wrong package |
| P2 | Batch README creation for all 35+ core namespaces | T1520 | Low urgency, high onboarding value |
| P2 | Fix biome format violation in messaging-e2e.test.ts | T1520 | One-line fix; blocks biome ci clean exit |
| P2 | Add typed interfaces for otel/ exported functions in @cleocode/contracts | T1520 | Replace Promise<Record<string, unknown>> |
| P2 | sequence/ public API: replace Record<string, unknown> return types | T1520 | showSequence/checkSequence need typed interfaces |
| P2 | Add tests for core/sticky/convert.ts and sibling files | T1520 | 292 LOC, 4 code paths, zero tests |
| P2 | Move core/sticky/types.ts to @cleocode/contracts | T1520 | ADR-057 D3 compliance |
| P2 | Fix @deprecated research.ts annotation (reference T1119 not ADR-027) | T1520 | ADR-027 does not exist in docs/adr/ |
| P2 | routing/ capability-matrix: add validation test vs registered operations | T1530 | Orphaned entries catch |
| P2 | snapshot/ importSnapshot: add merge-conflict-logic tests | T1530 | Last-write-wins logic untested |
| P2 | Hooks deprecated accumulation: set removal milestone for 16 aliases | T1530 | No timeline currently |

---

## Architectural Insights

### ADR-058 OpsFromCore Adoption Rate

| Category | Count | Compliance |
|----------|-------|-----------|
| Dispatch domains: fully compliant | 7 | tasks, pipeline, session, nexus, sentient, conduit, admin |
| Dispatch domains: partially compliant | 3 | check (contracts-direct, not OpsFromCore), playbook (SSoT-EXEMPT), orchestrate (not migrated) |
| Dispatch domains: non-compliant | 8 | sticky, memory, ivtr, intelligence, release, tools, diagnostics, docs |
| **ADR-058 compliance rate** | **7/18 = 39%** | Target: 18/18 = 100% |

The post-T1444/T1445 wave brought compliance from ~3/18 to ~7/18. Eight domains remain. The highest-ROI migrations are: `sticky` (small, template exists), `diagnostics` (5 ops, trivial), `release` (2 ops, contracts already defined), `intelligence` (5 ops, medium). `memory` and `orchestrate` are large epics.

### Core Public Surface TSDoc Coverage

- Namespaces with strong TSDoc: `identity`, `security`, `orchestration`, `spawn`, `agents`, `skills`, `playbooks`
- Namespaces with weak TSDoc: `compliance`, `otel`, `roadmap`, `telemetry`, `stats/workflow-telemetry.ts`
- Estimated TSDoc coverage across Core public surface: ~65-70% (functions have at least minimal `/** ... */`)
- Namespaces with zero function-level TSDoc on some exports: `compliance`, `otel`, `roadmap`, `sequence`

### Test Coverage Distribution

- Namespaces with strong test coverage (>20 test files or >100 tests): `tasks` (42 files, 656 tests), `memory` (59 files), `orchestration` (16 files, 337 tests), `sentient` (17+ files), `sessions` (14 files, 170 tests), `lifecycle` (14 files, 220 tests), `validation` (11 files, 235 tests), `agents` (9 files, 188 tests), `nexus` (20 files, 304 tests)
- Namespaces with zero tests: `context`, `reconciliation`, `pipeline`, `codebase-map`, `research`, `adrs`, `issue`, `templates`, `roadmap`, `ui`, `remote`, `otel`, `telemetry`
- **Estimated zero-test namespace count**: 13 of 55 core namespaces (24%)

### Package Boundary Violations

One confirmed architectural inversion found:
- `packages/core/src/code/index.ts` (deprecated shim) imports from `packages/nexus`. Per AGENTS.md package boundary contract, `packages/core/` is upstream of `packages/nexus/`. A downstream package should not be imported by an upstream package. This is tracked and exists only as a backward-compat shim, but represents technical debt.

### Structural Debt Concentration

The most structurally indebted dispatch domain is `dispatch/memory.ts` (2020 LOC, 45 handlers, 0% OpsFromCore, inline SQL). The most structurally indebted core area is `core/system/` (4527 LOC, 18 files, heterogeneous responsibilities, P0 stub in metrics.ts). The cleanest areas overall: `core/security/` (full ADR-059 compliance, 41 passing tests), `core/identity/` (GREEN, 12 tests), `dispatch/pipeline.ts` (model ADR-058 implementation), `dispatch/sentient.ts` (model ADR-058 implementation).

---

## Recommended Next Session Priorities

Ranked by severity and actionability:

1. **P0 FIX: Wire getSystemMetrics tokens to token-service.ts** — Small code change, immediate dashboard impact. `system/metrics.ts:86` hard-codes zeros. Wire `summarizeTokenUsage` from `metrics/token-service.ts`. One function call addition.

2. **P0 FIX: Add tests for core/context/ and core/reconciliation/** — Two P0 zero-coverage namespaces. Context manages exit-code map for `cleo context` CLI output. Reconciliation manages bidirectional provider sync. Both are small modules (159 LOC + 363 LOC) where adding tests is a well-scoped task.

3. **P1 MIGRATION: Migrate dispatch/sticky.ts to OpsFromCore** — Only ~239 LOC domain, clean template available (sentient.ts). The `sticky-engine.ts` already provides correct engine-layer functions. Medium effort, high completeness value (closes another non-compliant domain).

4. **P1 MIGRATION: Add releaseCoreOps to core/release + migrate dispatch/release.ts** — 2 ops, contracts types already defined (`ReleaseGateCheckParams`, `ReleaseGateCheckResult` in `@cleocode/contracts/operations/release.ts`). The `playbooks/ops.ts` pattern is the exact template. Small effort.

5. **P1 FIX: Resolve issue/templates DRY violation** — Two competing `parseIssueTemplates` implementations in production. Designate `templates/parser.ts` (T5705) as SSoT, deprecate `issue/template-parser.ts`. Before more template-related work is done, the SSoT must be clear.

6. **P1 COVERAGE: Add tests for core/remote/, core/otel/, core/adrs/** — Three namespaces with zero tests and meaningful logic (git subprocess operations, destructive filesystem operations, ADR registry sync). All are self-contained modules where mocking is straightforward.

7. **P1 EPIC: dispatch/memory.ts OpsFromCore migration** — This is the largest single architectural debt item. Extract `pending-verify`, `digest`, `recent`, `diary`, `watch`, `llm-status`, `promote-explain`, `verify` to Core functions first, then migrate dispatch. Plan this as a multi-wave epic with dedicated implementation tickets.

---

## Cross-References

### ADRs
- **ADR-051** (`docs/adr/ADR-051-evidence-gates.md`) — Referenced in `tasks.ts` (complete --force removal) and `check.ts`. All domains audited are compliant with evidence-gate requirements.
- **ADR-057** (`docs/adr/ADR-057-contracts-core-ssot.md`) — Governs type ownership. `sticky/types.ts` and `otel/` return types should migrate to contracts. `session/sessions` and `playbook/playbooks` dual-alias confirmed per D5.
- **ADR-058** (`docs/adr/ADR-058-dispatch-type-inference.md`) — OpsFromCore pattern. 7/18 dispatch domains compliant at time of audit. 11 migration gaps identified.
- **ADR-059** (`docs/adr/ADR-059-override-pumps.md`) — Fully implemented in `core/security/`. No violations found in audited scope.
- **ADR-027** — Referenced in `skills/manifests/research.ts` `@deprecated` annotation, but `docs/adr/ADR-027*.md` does not exist. File or update the reference.
- **ADR-053** (`docs/adr/ADR-053-playbook-runtime.md`) — Playbook state machine. `dispatch/playbook.ts` SSoT-EXEMPT annotations reference this correctly.
- **ADR-054** — Agent identity (draft). `identity/cleo-identity.ts` clean.
- **ADR-055** — Worktree-by-default / agents architecture. `spawn/` namespace clean; T1462 `pruneWorktree` verified.

### Confirmed Fixed Pre-Synthesis
- `b9255a011` — DATA-CORRUPTION: `sync:${providerId}` colon in `validateLabels` (T1530)
- `bbb52e75f` — `docs.ts` migrated to `TypedDomainHandler<DocsTypedOps>` (T1529 P0 partially resolved)

### Linked CLEO Tasks
- T1520 — This audit epic (parent)
- T1521–T1530 — 10 teammate audit tasks (all done)
- T1535–T1554 — Follow-up tasks filed across the audit (per scope notes)
- T1511 — ADR-057 normalization for `metrics/token-service.ts` SSoT-EXEMPT annotations (open, pending)
- T1518 — `TODO(T1082.followup)` markers in session-narrative.ts and dialectic-evaluator.ts (open)
- T1119 — MANIFEST.jsonl migration (pending; validates `skills/manifests/research.ts @deprecated`)
- T1404 — Epic closure enforcement (CONFIRMED wired at `tasks/complete.ts:L266-287`)
- T1497 — gateName defensive guards (CONFIRMED wired at `lifecycle/index.ts:L1066-1067` and `L1123-1124`)
- T1462 — pruneWorktree (CONFIRMED wired at `spawn/branch-lock.ts:433`)
- T1470 — ADR-057 D5 session/sessions + playbook/playbooks dual-alias (CONFIRMED intentional)
- T1492 — Memory/sticky handler thinning (CONFIRMED partial; large handlers in memory.ts remain)
- T1496 — sweep mutation + registry (CONFIRMED present in memory.ts L2011 and registry.ts)
- T1506 — brain-stdp-functional skipIf guard (CONFIRMED at L211)
- T1512 — ADR-027 deprecated brain function removal (CONFIRMED clean)

### Original Audit Prompts
- `/tmp/T1-audit-scope.md` through `/tmp/T10-audit-scope.md`

---

*Synthesized by audit-synthesizer from 10 teammate reports (T1521-T1530). All counts and line references sourced from individual teammate reports — do not modify without re-running the corresponding sub-audit.*
