# Audit Report — Teammate 7: Playbook-Release-UI

**Auditor**: T1527 (CLEO task ID)
**Scope**: dispatch/playbook.ts, dispatch/release.ts, core/playbooks/, core/release/, core/roadmap/, core/ui/
**Date**: 2026-04-28
**HEAD commit at audit start**: bc8730617ff5f83b0389b484d3edfc3e2c6f4291
**Audit framework**: 10-criteria per area — see /tmp/AUDIT-FRAMEWORK.md

---

## Executive Summary

| Area | Type | Overall Verdict | Critical Findings |
|------|------|----------------|-------------------|
| dispatch/playbook.ts | dispatch | YELLOW | 1 P1 (handler bodies >5 LOC in typed handler) |
| dispatch/release.ts | dispatch | YELLOW | 1 P1 (no OpsFromCore, no releaseCoreOps), 1 P2 |
| core/playbooks/ | core | GREEN | 0 |
| core/release/ | core | YELLOW | 1 P2 (TSDoc gap in github-pr.ts), 1 P2 (no README) |
| core/roadmap/ | core | YELLOW | 1 P2 (weak return type), 1 P2 (no tests, no README) |
| core/ui/ | core | YELLOW | 1 P2 (no tests, no README) |

**Critical investigation — playbook/ vs playbooks/ RESOLVED**: No true duplication. There is only one physical directory (`packages/core/src/playbooks/`). The `core/src/index.ts` exports it under TWO names: `playbook` (singular) and `playbooks` (plural). The singular alias was introduced by ADR-057 D5 / T1470 so dispatch can do `import { playbook } from '@cleocode/core'` matching the domain name. The comment in `index.ts` explicitly says "DO NOT REMOVE — complements (does not replace) the playbooks export below." This is intentional and documented.

---

## Per-Area Findings

---

### dispatch/playbook.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/playbook.ts`
**Lines of code**: 802
**Test files**: 1 test — `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/__tests__/playbook.test.ts` (351 lines, 18 tests, all passing)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | GREEN | Uses `OpsFromCore<typeof corePlaybook.playbookCoreOps>` at line 141. `playbookCoreOps` is defined in `packages/core/src/playbooks/ops.ts`. Fully ADR-058 compliant. |
| 2. Handler thinness | YELLOW | The outer `PlaybookHandler.query` and `PlaybookHandler.mutate` gateways are 27 LOC each (lines 677-704, 710-736) — above the 5-LOC guideline. However, these are envelope-wrapping boilerplate (typedDispatch delegation + error shape), not business logic. The per-op typed handler bodies range: `status` 11 LOC, `list` 23 LOC, `validate` 68 LOC, `run` 70 LOC, `resume` 89 LOC. These are all significantly >5 LOC because they contain legitimate file-load, parse, db-acquire, and runtime-state-machine orchestration logic that cannot be pushed to Core (SSoT-EXEMPT annotations present). |
| 3. Inline type leakage | YELLOW | Two `as unknown` casts at lines 692 and 724 (`envelope.data as unknown` in gateway envelope construction). One `as unknown` at line 242 in `parseContextJson` (safe: `JSON.parse` returns `unknown` which is immediately validated). These are typed boundary casts at a single trust boundary — acceptable per ADR-058 D1. Count: 3 occurrences, all justified. |
| 4. Per-op imports | GREEN | No per-op `*Params`/`*Result` imports from `@cleocode/contracts/operations/playbook`. Imports from `@cleocode/contracts` are for wire types (`PlaybookApproval`, `PlaybookRun`, `PlaybookRunStatus`) only — compliant. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK found. Four `SSoT-EXEMPT` annotations at lines 369, 397, 474, 550 — all live (db-injection, file-load, runtime-state-machine exceptions per ADR-057 D1). None reference closed/archived task IDs. |
| 6. Test coverage | GREEN | 1 integration test file, 18 passing tests, hermetic in-memory SQLite, stub dispatcher. Passes as of HEAD. |
| 7. Public surface | N/A | Dispatch domain — not a core namespace. Exports: `PlaybookHandler`, `__playbookRuntimeOverrides` (test hook), `acquirePlaybookDb`, `lookupApprovalByTokenForDispatch`, `listPendingApprovalsForDispatch`. All exported symbols have TSDoc. |
| 8. Cross-domain coupling | GREEN | Imports: `@cleocode/contracts` (wire types), `@cleocode/core` (type import only), `@cleocode/playbooks` (runtime SSoT — correct), `../adapters/typed.js` (dispatch infra), `../lib/engine.js` (spawn helper). No unexpected cross-domain coupling. |
| 9. Dead code | GREEN | No stale T1488/T1451/T310/T1093 references. SSoT-EXEMPT annotations are all live. |
| 10. Documentation | YELLOW | ADR-053 referenced in CLEO-INJECTION.md (playbook runtime state machine). Module JSDoc at lines 1-39 is thorough (references ADR-039, WAL safety ADR-006, T935, T1442). No README file. Docs in `docs/architecture/orchestration-flow.md` covers playbook flow. |

**P1 findings**:
- `packages/cleo/src/dispatch/domains/playbook.ts:356-642` — Typed handler operation bodies substantially exceed 5 LOC (validate: 68, run: 70, resume: 89). While SSoT-EXEMPT annotations are present and technically justified, these bodies contain file I/O, parse logic, and state machine orchestration that per ADR-058 D2 should ideally live in Core or `@cleocode/playbooks`. The current design is an ADR-057 D1 documented exception (non-wire-serializable `DatabaseSync` handle + file-load required), but T1456 (the exception tracking task referenced in ops.ts) should be revisited when the playbook runtime gains an async DB interface.

**P2 findings**:
- `packages/cleo/src/dispatch/domains/playbook.ts:677-736` — The `PlaybookHandler.query`/`mutate` gateway methods are 27 LOC each (vs ≤5 guideline). The extra LOC is envelope construction / error shaping boilerplate. Consider extracting a shared `wrapTypedDispatch` helper used by all typed-handler-backed domains.

---

### dispatch/release.ts — type: dispatch

**File path**: `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/release.ts`
**Lines of code**: 214
**Test files**: 1 test — `/mnt/projects/cleocode/packages/cleo/src/dispatch/domains/__tests__/release.test.ts` (341 lines, 22 tests, all passing). Also 3 related engine tests at `dispatch/engines/__tests__/release-*.test.ts`.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | RED | `release.ts` does NOT use `OpsFromCore`. There is no `releaseCoreOps` declaration in `packages/core/src/release/`. The contracts file (`@cleocode/contracts/operations/release.ts`) DOES define `ReleaseGateCheckParams`, `ReleaseGateCheckResult`, and `IvtrAutoSuggestResult` for the `gate` and `ivtr-suggest` ops. The missing `releaseCoreOps` in core means ADR-058 D1 cannot be applied here. No `SSoT-EXEMPT` annotation documents this gap. |
| 2. Handler thinness | RED | `query` and `mutate` gateway methods are both 61 LOC each (lines 62-122, 141-201). The `gate` case body is 50 LOC — 10x the 5-LOC guideline. Contains inline param extraction (`params?.['epicId'] as string`), validation guard (`if (!epicId) return errorResult(...)`), and delegating call. The validation + param-extraction should move to a `releaseCoreOps` + `defineTypedHandler` pattern per ADR-058. |
| 3. Inline type leakage | YELLOW | 4 type assertions: `params?.['epicId'] as string | undefined` (×2), `params?.['taskId'] as string | undefined` (×2). These are manual untyped param extractions — an anti-pattern that `OpsFromCore` would eliminate. No `as any`. |
| 4. Per-op imports | GREEN | No per-op imports from `@cleocode/contracts/operations/release`. However, this is because the handler uses ZERO contract types — it performs only untyped `params?.['x'] as string` extraction. This is worse than per-op imports. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. Zero SSoT-EXEMPT annotations (none are needed since no Core inference is attempted). |
| 6. Test coverage | GREEN | 22 passing tests (query + mutate gateway coverage, gate + ivtr-suggest + unsupported-op paths). All pass. |
| 7. Public surface | N/A | Dispatch domain. |
| 8. Cross-domain coupling | GREEN | Imports: `@cleocode/core/internal` (getLogger, getProjectRoot — infrastructure), `../lib/engine.js` (releaseGateCheck, releaseIvtrAutoSuggest — engine layer), `../types.js`, `./_base.js`. No unexpected coupling. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | Module JSDoc at lines 1-25 references T820 RELEASE-03/RELEASE-07, T1416. ADR-053 not referenced (not applicable for release). No README. No `docs/architecture` entry for release domain. |

**P1 findings**:
- `packages/cleo/src/dispatch/domains/release.ts` — **Missing `releaseCoreOps` + `OpsFromCore` migration.** The contracts file already defines `ReleaseGateCheckParams`, `ReleaseGateCheckResult`, and `IvtrAutoSuggestResult`. This domain needs a `packages/core/src/release/ops.ts` (mirroring the `playbooks/ops.ts` pattern) declaring `releaseCoreOps`, followed by migrating `release.ts` to `defineTypedHandler<ReleaseOps>`. Without this, ADR-058 D1 compliance is broken and param extraction is untyped. Follow-up task recommended: add to parent T1520.

**P2 findings**:
- `packages/cleo/src/dispatch/domains/release.ts:68,147` — `params?.['epicId'] as string | undefined` inline assertions. These are the direct symptom of the missing OpsFromCore migration. Will be resolved by P1 fix.

---

### core/playbooks/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/playbooks/`
**Files**: `agent-dispatcher.ts` (431 LOC), `ops.ts` (64 LOC), `index.ts` (25 LOC)
**Test files**: 1 — `/mnt/projects/cleocode/packages/core/src/playbooks/__tests__/agent-dispatcher.test.ts` (10 passing tests)

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace, not dispatch. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`, `as any`, `as unknown as`. |
| 4. Per-op imports | N/A | Core. `ops.ts` correctly imports from `@cleocode/contracts/operations/playbook` — this is the SSoT declaration file, not dispatch, so imports are appropriate. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | GREEN | 10 passing tests covering `CoreAgentDispatcher`, `createAgentDispatcher`, `resolveMetaAgent`, and dispatch routing logic. |
| 7. Public surface | GREEN | Clean barrel in `index.ts`. Named exports: `AGENT_TIER_META`, `AgentDispatcher`, `CoreAgentDispatcher`, `CoreAgentDispatcherOptions`, `createAgentDispatcher`, `DispatchContext`, `DispatchResult`, `resolveMetaAgent`, `playbookCoreOps`. Module JSDoc present. `ops.ts` has thorough TSDoc including architecture note and cross-references to ADR-057 D1 exception. |
| 8. Cross-domain coupling | GREEN | `agent-dispatcher.ts` imports only from `@cleocode/contracts` and `node:*`. `ops.ts` imports only from `@cleocode/contracts/operations/playbook` (correct — it IS the ops declaration file). |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | YELLOW | No `README.md` in `packages/core/src/playbooks/`. TSDoc is thorough. ADR-057 D1 exception documented in `ops.ts`. ADR-053 not referenced in this directory (it lives in `@cleocode/playbooks` package). The absence of README is the only gap. |

**P0 findings**: None.
**P1 findings**: None.
**P2 findings**:
- No `README.md` in `packages/core/src/playbooks/`. Given the architectural nuance (Core owns dispatch type declarations but NOT the runtime, which lives in `@cleocode/playbooks`), a README explaining this split would prevent future confusion.

---

### core/release/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/release/`
**Files**: 10 source files + `invariants/` subdirectory, total ~3,814 LOC
**Test files**: 6 test files in `__tests__/`, 1 in `invariants/__tests__/` — 62 passing tests

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | YELLOW | One instance at `packages/core/src/release/version-bump.ts:324`: `.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], obj)`. This is a deep-access utility for traversing nested JSON structures. The cast chain `<unknown>(...acc as Record...)` is a reasonable pattern for arbitrary JSON traversal. Count: 1 occurrence, justified. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK across all release files. |
| 6. Test coverage | GREEN | 62 passing tests across 6 test files (artifacts, cancel-release, changelog-writer, project-agnostic-release, push-policy, release, archive-reason-invariant). |
| 7. Public surface | YELLOW | Clean barrel in `index.ts`. TSDoc coverage is good overall (artifacts: 23 TSDoc vs 10 exports; release-config: 20 vs 16; release-manifest: 18 vs 17) but `github-pr.ts` has 10 exported symbols and only 6 TSDoc blocks — 4 exported functions lack TSDoc (`extractRepoOwnerAndName`, `detectBranchProtection`, `buildPRBody`, `formatManualPRInstructions`). `index.ts` itself has only 1 TSDoc block (module comment). |
| 8. Cross-domain coupling | GREEN | `release-manifest.ts` imports `drizzle-orm` and internal store modules (`../store/sqlite.js`, `../store/tasks-schema.js`, `../paths.js`, `../pagination.js`). `invariants/archive-reason-invariant.ts` imports internal task-query APIs. All are appropriate intra-core imports — no unexpected cross-namespace coupling. |
| 9. Dead code | GREEN | No stale `@deprecated`, `SSoT-EXEMPT`, or stale T-ID annotations. `index.ts` has a live comment noting the `getDefaultChannelConfig` naming collision between `channel.ts` and `release-config.ts` — this is documentation, not dead code. |
| 10. Documentation | YELLOW | No `README.md` in `packages/core/src/release/`. ADR-056 (post-release invariants) referenced in `index.ts`. No reference to ADR-057/058/059. No dedicated architecture doc in `docs/architecture/` for the release core namespace. |

**P0 findings**: None.
**P1 findings**: None.
**P2 findings**:
- `packages/core/src/release/github-pr.ts` — 4 exported functions missing TSDoc: `extractRepoOwnerAndName` (line 60), `detectBranchProtection` (line 84), `buildPRBody` (line 173), `formatManualPRInstructions` (line 193). These are public API surface without documentation.
- No `README.md` in `packages/core/src/release/`. This is the largest namespace in scope (3,814 LOC across 10 files + invariants subdirectory). A README would help agents and developers understand the module structure.

---

### core/roadmap/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/roadmap/`
**Files**: `index.ts` (74 LOC)
**Test files**: NONE found.

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`, `as any`, `as unknown as`. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | No test files found in `packages/core/src/roadmap/` or at sibling level. The `getRoadmap` function queries the task store, reads filesystem (VERSION file, CHANGELOG.md), and aggregates epics — logic that is testable but untested. |
| 7. Public surface | YELLOW | Single exported function `getRoadmap` with a one-line TSDoc (`/** Get roadmap from pending epics and CHANGELOG history. */`) — minimal. The function's return type is `Promise<Record<string, unknown>>` (weak typing). Parameters `includeHistory`, `upcomingOnly`, and `cwd` are not individually documented. No typed return shape (the actual return object has `currentVersion`, `upcoming`, `releaseHistory`, `completedEpics`, `summary` keys — none of which are type-safe). |
| 8. Cross-domain coupling | GREEN | Imports only `../store/data-accessor.js` (intra-core store) and `node:fs`/`node:path`. |
| 9. Dead code | GREEN | No stale annotations. |
| 10. Documentation | RED | No `README.md`. No ADR references. Not documented in `docs/architecture/`. The roadmap is dispatched from `admin.ts` (lines 543-556) and not from a dedicated domain handler, which adds to the confusion about where this feature lives. |

**P0 findings**: None.
**P1 findings**: None.
**P2 findings**:
- `packages/core/src/roadmap/index.ts:13` — `getRoadmap` return type is `Promise<Record<string, unknown>>`. A typed return interface (e.g. `RoadmapResult`) would prevent consumers from accessing undefined keys silently.
- No tests for `getRoadmap`. The function has meaningful logic (epic detection, CHANGELOG parsing, status grouping) that should be covered.
- No `README.md` and no `docs/architecture/` entry. Purpose and routing (via `admin.ts`) is undiscoverable.

---

### core/ui/ — type: core

**File path**: `/mnt/projects/cleocode/packages/core/src/ui/`
**Files**: `aliases.ts` (185 LOC), `changelog.ts` (249 LOC), `command-registry.ts` (201 LOC), `flags.ts` (111 LOC), `index.ts` (61 LOC)
**Test files**: NONE found.

**Purpose note**: Despite the name `ui/`, this is NOT a web or graphical UI namespace. It is a terminal CLI utilities namespace containing: shell alias injection (`aliases.ts`), task-to-CHANGELOG generation (`changelog.ts`), CLI command discovery + introspection (`command-registry.ts`), and CLI flag parsing (`flags.ts`). The naming is potentially confusing but the module header (`@task T4454`) and content make the TUI/CLI purpose clear. The comment block at the bottom of `index.ts` documents the removal of `injection.ts` and `injection-registry.ts` (migrated to CAAMP in T4674/T4675/T4677).

| Criterion | Verdict | Notes |
|-----------|---------|-------|
| 1. OpsFromCore inference | N/A | Core namespace. |
| 2. Handler thinness | N/A | Core namespace. |
| 3. Inline type leakage | GREEN | Zero `any`, `as any`, `as unknown as` in scope files. |
| 4. Per-op imports | N/A | Core namespace. |
| 5. Behavior markers | GREEN | Zero TODO/FIXME/XXX/HACK. |
| 6. Test coverage | RED | No test files found in `packages/core/src/ui/`. `aliases.ts` (shell injection/detection), `changelog.ts` (task-to-markdown generation), `command-registry.ts` (command scanning + categorization), and `flags.ts` (CLI flag parsing) all have branching logic. None are tested. |
| 7. Public surface | YELLOW | Clean barrel in `index.ts`. TSDoc coverage per file: `aliases.ts` (15 TSDoc / 12 exports), `changelog.ts` (12 TSDoc / 8 exports), `command-registry.ts` (9 TSDoc / 7 exports), `flags.ts` (6 TSDoc / 5 exports). All exported functions have at least a one-line TSDoc. Coverage ratio acceptable but descriptions are minimal (e.g. `/** Detect the current shell. */` with no param/return docs). `changelog.ts` imports from `@cleocode/contracts` (Task type) — appropriate. |
| 8. Cross-domain coupling | GREEN | `changelog.ts` imports `Task` from `@cleocode/contracts` and `DataAccessor` from `../store/data-accessor.js`. `command-registry.ts` imports only `node:fs` and `node:path`. `aliases.ts` imports only `node:fs`, `node:os`, `node:path`. `flags.ts` has no external imports. All appropriate. |
| 9. Dead code | GREEN | No stale annotations. The injection module deletion is cleanly documented in `index.ts` with task references (T4674/T4675/T4677). |
| 10. Documentation | YELLOW | No `README.md`. No ADR references. The comment documenting injection removal (lines 53-62 in `index.ts`) is valuable context but not formal documentation. The "ui" naming warrants a README clarifying this is a TUI/CLI utilities module to prevent future misclassification. |

**P0 findings**: None.
**P1 findings**: None.
**P2 findings**:
- No tests for any `ui/` module. The alias injection logic (`injectAliases`, `removeAliases`) manipulates shell RC files and warrants regression tests.
- No `README.md`. The name `ui/` is misleading for a CLI utilities module. A brief README stating "TUI/CLI utilities: shell aliases, changelog generation, command registry, flag parsing" would prevent agents from misidentifying this as frontend/web UI code.

---

## Investigation: playbook/ vs playbooks/ Duplication

**RESOLVED — NOT a bug.**

There is exactly one physical directory: `packages/core/src/playbooks/`. The `packages/core/src/index.ts` exports it under two names:

```typescript
// Line 64-69 of packages/core/src/index.ts
/**
 * Canonical dispatch-domain alias for the `playbooks` module (ADR-057 D5 · T1470).
 * Consumers can do: `import { playbook } from '@cleocode/core'`.
 * DO NOT REMOVE — complements (does not replace) the `playbooks` export below.
 */
export * as playbook from './playbooks/index.js';
export * as playbooks from './playbooks/index.js';
```

The `playbook` (singular) alias was introduced per ADR-057 D5 / T1470 to allow dispatch handlers to write `import type { playbook as corePlaybook } from '@cleocode/core'` — matching the dispatch domain name convention (`playbook.ts` handles `playbook.*` operations). The `playbooks` (plural) alias is the original export kept for backward compatibility. Both resolve to the same module. This is intentional, documented in-line, and enforced by the `// DO NOT REMOVE` guard.

**No P0 filing required.** The two-export pattern is a deliberate design decision per ADR-057 D5.

---

## Overall Recommendations

1. **File a follow-up task: Add `releaseCoreOps` + migrate `release.ts` to OpsFromCore (P1).** The `playbooks/ops.ts` file shows the exact pattern to follow. `@cleocode/contracts/operations/release.ts` already has `ReleaseGateCheckParams`, `ReleaseGateCheckResult`, and `IvtrAutoSuggestResult`. This is a straightforward migration that will eliminate 4 untyped param extractions and bring `release.ts` into ADR-058 compliance.

2. **Add tests for `core/roadmap/` and `core/ui/` (P2).** These namespaces have meaningful logic (CHANGELOG parsing, epic detection, shell alias injection, command scanning) that is completely untested. The risk surface is non-trivial.

3. **Add TSDoc to 4 missing exports in `core/release/github-pr.ts` (P2).** Small effort, high value for agent discoverability.

4. **Add README files to all core namespaces in scope (P2).** None of the five core namespaces (playbooks, release, roadmap, ui — noting `playbooks/` has no README despite architectural complexity, and `ui/` has a misleading name) have README files.

5. **Consider extracting `wrapTypedDispatch` from `PlaybookHandler.query`/`mutate` boilerplate (P2).** The 27-LOC gateway bodies are structurally identical envelope-wrapping. If other typed-handler-backed domains have the same pattern, a shared helper would reduce drift.

---

## New Follow-Up Tasks

Recommended to file against parent T1520:

| Title | Priority | Acceptance |
|-------|----------|------------|
| `Add releaseCoreOps + migrate dispatch/release.ts to OpsFromCore (ADR-058)` | P1 | `releaseCoreOps` declared in `packages/core/src/release/ops.ts`; `release.ts` uses `defineTypedHandler<ReleaseOps>`; no untyped `params?.['x'] as string` in release.ts; ADR-058 D1 checklist passes |
| `Add unit tests for core/roadmap/getRoadmap` | P2 | ≥3 test cases covering epic detection, CHANGELOG parsing, and history flag; test-run passes |
| `Add unit tests for core/ui/ aliases + changelog + command-registry` | P2 | ≥5 test cases per file covering main code paths; test-run passes |
| `Add TSDoc to 4 undocumented exports in core/release/github-pr.ts` | P2 | All exported symbols in github-pr.ts have TSDoc; forge-ts passes |
| `Add README files to packages/core/src/playbooks/ release/ roadmap/ ui/` | P2 | README.md present in each dir; explains purpose and key contracts |

---

## Cross-References

- ADR-057 (`docs/adr/ADR-057-contracts-core-ssot.md`) — Contracts/Core SSoT layering; D5 defines playbook/playbooks dual export.
- ADR-058 (`docs/adr/ADR-058-dispatch-type-inference.md`) — OpsFromCore pattern; `release.ts` is non-compliant.
- ADR-053 (`docs/adr/ADR-053-playbook-runtime.md`) — Playbook state-machine architecture; `dispatch/playbook.ts` implements its CLI surface.
- T1442 — OpsFromCore migration for playbook dispatch (COMPLETE — playbook.ts is compliant).
- T1470 — ADR-057 D5: playbook/playbooks dual alias (COMPLETE — documented in index.ts).
- T1416, T820 — Release IVTR gate (RELEASE-03/RELEASE-07) — implemented in release.ts but not yet ADR-058 compliant.

## Files Reviewed

| File | LOC |
|------|-----|
| `packages/cleo/src/dispatch/domains/playbook.ts` | 802 |
| `packages/cleo/src/dispatch/domains/release.ts` | 214 |
| `packages/core/src/playbooks/agent-dispatcher.ts` | 431 |
| `packages/core/src/playbooks/ops.ts` | 64 |
| `packages/core/src/playbooks/index.ts` | 25 |
| `packages/core/src/release/artifacts.ts` | 542 |
| `packages/core/src/release/changelog-writer.ts` | 185 |
| `packages/core/src/release/channel.ts` | 176 |
| `packages/core/src/release/ci.ts` | 195 |
| `packages/core/src/release/github-pr.ts` | 285 |
| `packages/core/src/release/guards.ts` | 159 |
| `packages/core/src/release/index.ts` | 140 |
| `packages/core/src/release/release-config.ts` | 434 |
| `packages/core/src/release/release-manifest.ts` | 1,363 |
| `packages/core/src/release/version-bump.ts` | 335 |
| `packages/core/src/roadmap/index.ts` | 74 |
| `packages/core/src/ui/aliases.ts` | 185 |
| `packages/core/src/ui/changelog.ts` | 249 |
| `packages/core/src/ui/command-registry.ts` | 201 |
| `packages/core/src/ui/flags.ts` | 111 |
| `packages/core/src/ui/index.ts` | 61 |
| **Total** | **6,231** |

Test files reviewed (not modified):
- `dispatch/domains/__tests__/playbook.test.ts` (351 lines, 18 tests — PASS)
- `dispatch/domains/__tests__/release.test.ts` (341 lines, 22 tests — PASS)
- `dispatch/engines/__tests__/release-engine.test.ts`, `release-push-guard.test.ts`, `release-ship.test.ts` (pass)
- `core/src/playbooks/__tests__/agent-dispatcher.test.ts` (10 tests — PASS)
- `core/src/release/__tests__/` (6 files, 62 tests — PASS)
- `dispatch/domains/__tests__/no-inline-types.test.ts` (4 tests — PASS; release.ts and playbook.ts pass the inline-types regression)
