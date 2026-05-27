# H1: Epic Registry + Child Rollup Integrity

**Audit date**: 2026-05-01  
**Scope**: All epics in the CLEO task database (read-only)  
**Auditor**: H1 subagent (CLEO Subagent Base Protocol v1.1.0)

---

## 1. Executive Summary

| Metric | Count |
|--------|-------|
| Total epics found | 71 |
| Status: done | 20 |
| Status: pending | 43 |
| Status: active | 4 |
| Status: cancelled | 4 |
| **Invalid ID format (cleo show rejected)** | **2** (E1, T932EP) |

### Defect Type Counts

| Type | Label | Count |
|------|-------|-------|
| A | Epic pending but all children done (ready to close) | 4 |
| B | Epic done but has pending children (prematurely closed) | 2 |
| C | Epic with zero children (empty — stale or scaffolding) | 35 |
| D | Epic with blocked children, no clear path | 0 |
| E | Epic active/pending with zero child progress (stale) | 9 |

**Top 10 Critical Issues**:
1. **T1563** — pending master audit epic but all 4 direct children are done (Type-A)
2. **T1467** — done epic with 2 pending children T1491/T1495 (Type-B)
3. **T1603** — done epic with 3 pending children T1619/T1620/T1621 (Type-B)
4. **T1622** — pending sub-epic of T1586, all 4 children done/cancelled (Type-A)
5. **T1232** — pipelineStage=`release` but 0/13 children done; 8+ days stale (Type-E + stage drift)
6. **E1, T932EP** — IDs rejected by `cleo show` (invalid format); appear in `cleo find` but not actionable
7. **T939/T940/T941** — explicit test-bug epics, never closed, 13 days stale (Type-C)
8. **T1346–T1382 cluster** — 10 test/import scaffolding epics all with 0 children and generic titles (Type-C)
9. **T603/T800** — active/pending epics with null updatedAt, unknown age, 0 children (Type-C)
10. **T1337/T1354/T1376** — "imported" auth epics with active status, 0 children, 7 days since update (Type-C)

---

## 2. Inventory Table

All 69 epics with valid IDs (E1 and T932EP excluded — invalid format).

| ID | Status | Priority | Children (done/total/blocked) | Last Updated | Pipeline Stage | Notes |
|----|--------|----------|-------------------------------|--------------|----------------|-------|
| T603 | active | high | 0/0/0 | null | none | Generic title "Epic" |
| T800 | pending | medium | 0/0/0 | null | none | Generic title "Task T800" |
| T911 | pending | high | 1/4/0 | 2026-04-18 | none | Install Canonical Layout |
| T931 | archived | — | — | — | contribution | (archived, not audited) |
| T939 | pending | medium | 0/0/0 | 2026-04-18 | none | Test epic for T929 bug |
| T940 | pending | medium | 0/0/0 | 2026-04-18 | none | Test epic for T929 bug v2 |
| T941 | pending | medium | 0/0/0 | 2026-04-18 | none | Test epic T929 alias fix |
| T942 | pending | critical | 1/7/0 | 2026-04-18 | none | Sentient Arch Redesign |
| T990 | pending | critical | 0/0/0 | 2026-04-21 | contribution | Studio UI/UX Design System |
| T1007 | pending | high | 0/0/0 | 2026-04-19 | none | Sentient Loop Completion |
| T1042 | pending | critical | 0/0/0 | 2026-04-20 | none | Cleo Nexus vs GitNexus Far-Exceed |
| T1054 | pending | critical | 3/8/0 | 2026-04-20 | none | Nexus P0: Core Query Power |
| T1055 | pending | high | 0/5/0 | 2026-04-20 | none | Nexus P1: Competitive Closure |
| T1056 | pending | critical | 4/12/0 | 2026-04-20 | none | Nexus P2: Living Brain |
| T1093 | done | critical | 0/0/0 | 2026-04-25 | contribution | MANIFEST/RCASD Unification |
| T1106 | cancelled | critical | 0/1/0 | 2026-04-28 | none | CLOSE-ALL sandbox proof (1 cancelled child) |
| T1118 | done | critical | 0/0/0 | 2026-04-25 | contribution | T-BRANCH-LOCK |
| T1135 | pending | critical | 0/0/0 | 2026-04-21 | research | CLEO-OBSERVABILITY |
| T1136 | pending | critical | 0/0/0 | 2026-04-21 | research | CLEO-PROVENANCE |
| T1137 | pending | high | 0/0/0 | 2026-04-21 | research | CLEO-AGENT-LIFECYCLE |
| T1147 | done | high | 1/1/0 | 2026-04-28 | contribution | Wave 7: Reconciler Extension |
| T1187 | done | medium | 0/0/0 | 2026-04-25 | contribution | Tree/Dep Visualization Overhaul |
| T1212 | pending | medium | 0/3/0 | 2026-04-22 | research | T-MIG-LINT-CLEAN |
| T1232 | pending | critical | 0/13/0 | 2026-04-23 | **release** | PRE-WAVE Agents Arch Remediation |
| T1250 | pending | high | 0/0/0 | 2026-04-23 | research | META: compress 312-op surface |
| T1262 | cancelled | high | 0/0/0 | 2026-04-24 | — | cleo memory doctor (cancelled) |
| T1323 | done | critical | 2/2/0 | 2026-04-25 | contribution | Orchestration Coherence v1 |
| T1337 | active | medium | 0/0/0 | 2026-04-24 | none | Epic: Auth (imported) |
| T1346 | pending | medium | 0/0/0 | 2026-04-24 | research | "My epic" (test scaffolding) |
| T1347 | pending | medium | 0/0/0 | 2026-04-24 | research | "Epic" (test scaffolding) |
| T1348 | pending | medium | 0/0/0 | 2026-04-24 | research | "Epic" (test scaffolding) |
| T1351 | pending | medium | 0/0/0 | 2026-04-24 | research | "Epic" (test scaffolding) |
| T1352 | pending | medium | 0/0/0 | 2026-04-24 | research | "Epic" (test scaffolding) |
| T1353 | pending | medium | 0/0/0 | 2026-04-24 | implementation | "Epic" (test scaffolding) |
| T1354 | active | medium | 0/0/0 | 2026-04-24 | none | Epic: Auth (imported-3) |
| T1358 | pending | medium | 0/0/0 | 2026-04-24 | research | "Test Epic" (test scaffolding) |
| T1376 | active | medium | 0/0/0 | 2026-04-24 | none | Epic: Auth (imported-5) |
| T1379 | pending | medium | 0/0/0 | 2026-04-24 | research | "My epic" (test scaffolding) |
| T1380 | pending | medium | 0/0/0 | 2026-04-24 | implementation | "Epic" (test scaffolding) |
| T1382 | pending | medium | 0/0/0 | 2026-04-24 | research | "Test Epic" (test scaffolding) |
| T1386 | done | critical | 15/15/0 | 2026-04-25 | contribution | PSYCHE LLM Layer Port |
| T1403 | done | high | 0/0/0 | 2026-04-28 | contribution | Pump #1: post-deploy gap |
| T1404 | done | high | 0/0/0 | 2026-04-28 | contribution | Pump #2: parent-closure-without-atom |
| T1407 | pending | high | 0/6/0 | 2026-04-25 | decomposition | Self-enforcing release invariant |
| T1415 | done | critical | 6/6/0 | 2026-04-25 | contribution | T1216 Remediation Queue |
| T1417 | done | high | 7/7/0 | 2026-04-25 | contribution | Dispatch Typed Narrowing |
| T1428 | pending | medium | 0/0/0 | 2026-04-25 | research | T988 cleanup — final cast reduction |
| T1429 | done | medium | 1/1/0 | 2026-04-28 | contribution | Brain-stdp deflake |
| T1434 | pending | high | 0/0/0 | 2026-04-25 | research | 104 TS errors blocking release |
| T1435 | done | high | 13/13/0 | 2026-04-27 | contribution | T-DISPATCH-INFER |
| T1449 | done | high | 11/11/0 | 2026-04-27 | contribution | T-CORE-CONTRACTS-SSOT |
| T1461 | pending | high | 2/3/0 | 2026-04-26 | testing | Disk-space hygiene |
| T1465 | pending | high | 0/0/0 | 2026-04-26 | research | Dynamic provider/model arch |
| T1466 | pending | high | 0/0/0 | 2026-04-26 | research | T-CLEANUP-WORKTREE |
| T1467 | **done** | critical | 13/23/0 | 2026-04-27 | contribution | T-THIN-WRAPPER migration |
| T1468 | cancelled | high | 0/0/0 | 2026-04-27 | — | T-SDK-PUBLIC (cancelled) |
| T1498 | done | critical | 5/5/0 | 2026-04-28 | contribution | Override governance pumps |
| T1499 | done | high | 1/1/0 | 2026-04-28 | contribution | DB integrity — re-parent orphans |
| T1505 | done | high | 5/5/0 | 2026-04-28 | contribution | Test suite cleanup |
| T1508 | done | medium | 7/7/0 | 2026-04-28 | contribution | Code hygiene |
| T1520 | done | high | 10/10/0 | 2026-04-28 | contribution | Full domain audit |
| T1555 | pending | medium | 9/17/0 | 2026-04-28 | implementation | Audit-2026-04-28 follow-up |
| T1556 | done | critical | 6/6/0 | 2026-04-28 | contribution | Release-readiness validation |
| T1563 | **pending** | critical | 4/4/0 | 2026-04-29 | implementation | Audit-driven execution master epic |
| T1566 | done | critical | 17/17/0 | 2026-05-01 | contribution | T-ENGINE-MIGRATION |
| T1586 | pending | critical | 17/19/0 | 2026-04-29 | implementation | T-FOUNDATION-LOCKDOWN |
| T1603 | **done** | critical | 7/10/0 | 2026-04-30 | contribution | T-FOUNDATION-LOCKDOWN-V2 |
| T1611 | done | critical | 7/7/0 | 2026-04-30 | contribution | T-KNOWLEDGE-FIRST-CITIZEN |
| T631 | pending | low | 0/0/0 | 2026-04-16 | none | Cleo Prime Orchestrator Persona |
| T889 | pending | high | 0/0/0 | 2026-04-17 | none | Orchestration Coherence v3 |

**Invalid IDs** (appear in `cleo find` results but rejected by `cleo show`):

| ID | Reason |
|----|--------|
| E1 | `E_VALIDATION_FAILED: Invalid task ID format: E1` |
| T932EP | `E_VALIDATION_FAILED: Invalid task ID format: T932EP` |

---

## 3. Type-A List — Epic Ready to Close (pending but all children done)

These epics have `status=pending` and `childRollup.done >= childRollup.total` with `total > 0`.

- **T1563** `Audit-driven execution master epic — red main + layering + engine migration + dogfooding`
  - Rollup: 4/4 done (T1564 done, T1565 done, T1566 done, T1567 done)
  - Last updated: 2026-04-29 (2 days ago)
  - pipelineStage: `implementation`
  - Recommendation: Mark done. All direct children completed. Note that T1566 (child epic, also done) has its own complete subtree.

- **T1622** `T-FOUND-1C: Doctrine cleanup — cherry-pick references purge`
  - Rollup: 4 children: T1623 done, T1624 done, T1625 done, T1626 cancelled
  - Status: pending, parentId: T1586
  - Recommendation: Mark done (all live children done; cancelled child is resolved). This will also improve T1586's rollup count.

- **T1461** `Disk-space hygiene: worktree leak, getProjectRoot trap, pnpm node-linker`
  - Rollup: 2/3 done (T1462 done, T1463 done, T1464 pending)
  - pipelineStage: `testing`
  - Note: T1464 is an investigation subtask (`perf(spawn): per-worktree node_modules bloat`) still pending — NOT fully closeable yet. Flagged here as near-Type-A; closing requires T1464 resolution first.
  - Recommendation: Resolve T1464 or descope it before closing T1461.

- **T1555** `Audit-2026-04-28 follow-up remediation tasks`
  - Rollup: 9/17 done (8 children still pending)
  - This is NOT Type-A (only 9/17 done). Included here for reference — listed in inventory but does not qualify.

**Confirmed Type-A (genuine)**: T1563, T1622

---

## 4. Type-B List — Epic Prematurely Closed (done but has pending children)

- **T1467** `T-THIN-WRAPPER complete CLI thin-wrapper migration` (status: done)
  - Rollup: 13/23 done, 8 cancelled, **2 pending** (T1491, T1495)
  - Pending children:
    - `T1491` — T-FU10: thin remaining fat CLI commands (agent/memory/docs)
    - `T1495` — T-FU14: pipeline domain contract types decision
  - Note: The rollup's "done" count of 13 + cancelled 8 = 21, not 23. The 2 pending are genuine open work.
  - Recommendation: Either complete/cancel T1491 and T1495, or re-open T1467 to pending until they are resolved.

- **T1603** `T-FOUNDATION-LOCKDOWN-V2: residual-risk guards` (status: done)
  - Rollup: 7/10 done, **3 pending** (T1619, T1620, T1621)
  - Pending children:
    - `T1619` — T-FOUND-V3-1: commit-msg 50-char cap rejects orchestrator merge messages
    - `T1620` — T-FOUND-V3-2: hotfix release ship auto-adds CHANGELOG section
    - `T1621` — T-FOUND-V3-3: validateCallsiteCoverage falls back when ripgrep unavailable
  - Note: These appear to be V3 wave tasks added after T1603 was closed. They are pending with no progress.
  - Recommendation: Either re-parent T1619–T1621 to a new V3 epic, or re-open T1603. These represent real incomplete work that was filed under a closed parent.

---

## 5. Type-C List — Empty Epics (zero children)

35 epics have `childRollup.total = 0`. Grouped by category:

### Category C1: Test/Bug Fixture Epics (clear candidates for cancellation)

These were created to reproduce specific bugs (T929 lifecycle) and were never cleaned up:

| ID | Title | Status | Age | Recommendation |
|----|-------|--------|-----|----------------|
| T939 | Test epic for T929 lifecycle bug | pending | 13d | Cancel — test fixture, bug resolved |
| T940 | Test epic for T929 bug v2 | pending | 13d | Cancel — test fixture, bug resolved |
| T941 | Test epic T929 alias fix | pending | 13d | Cancel — test fixture, bug resolved |

### Category C2: Import/Scaffolding Test Epics (CI/integration test artifacts)

10 epics created during import testing — generic titles, no real work:

| ID | Title | Status | Age | Recommendation |
|----|-------|--------|-----|----------------|
| T1337 | Epic: Auth (imported) | active | 7d | Cancel — import test artifact |
| T1354 | Epic: Auth (imported-3) | active | 7d | Cancel — import test artifact |
| T1376 | Epic: Auth (imported-5) | active | 7d | Cancel — import test artifact |
| T1346 | My epic | pending | 7d | Cancel — scaffolding artifact |
| T1347 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1348 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1351 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1352 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1353 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1358 | Test Epic | pending | 7d | Cancel — scaffolding artifact |
| T1379 | My epic | pending | 7d | Cancel — scaffolding artifact |
| T1380 | Epic | pending | 7d | Cancel — scaffolding artifact |
| T1382 | Test Epic | pending | 7d | Cancel — scaffolding artifact |

### Category C3: Unknown-Age Epics (null updatedAt)

| ID | Title | Status | Age | Recommendation |
|----|-------|--------|-----|----------------|
| T603 | Epic | active | null | Investigate — generic title, unknown origin, never updated |
| T800 | Task T800 | pending | null | Investigate — created 2026-04-17, never updated, generic title |

### Category C4: Legitimate Epics with No Children Yet (planned but not decomposed)

These represent real project initiatives that have no children yet:

| ID | Title | Status | Age | Priority | Recommendation |
|----|-------|--------|-----|----------|----------------|
| T631 | EPIC: Cleo Prime Orchestrator Persona | pending | 15d | low | Add children or deprioritize |
| T889 | EPIC: Orchestration Coherence v3 | pending | 14d | high | Decompose or mark as research |
| T990 | Studio UI/UX Design System | pending | 10d | critical | Decompose urgently (critical, 10d stale) |
| T1007 | Sentient Loop Completion — Tier 2+3 | pending | 12d | high | Decompose or link to T942 |
| T1042 | Cleo Nexus vs GitNexus Far-Exceed | pending | 11d | critical | Decompose or cancel (analysis task?) |
| T1135 | CLEO-OBSERVABILITY | pending | 10d | critical | Decompose (critical, 10d, no children) |
| T1136 | CLEO-PROVENANCE | pending | 10d | critical | Decompose (critical, 10d, no children) |
| T1137 | CLEO-AGENT-LIFECYCLE | pending | 10d | high | Decompose or hold |
| T1250 | META: compress 312-op surface | pending | 8d | high | Decompose or cancel |
| T1428 | T988 cleanup — final cast reduction | pending | 6d | medium | Add children (T1417 done, what remains?) |
| T1434 | 104 TS errors blocking release | pending | 6d | high | Decompose urgently — release blocker |
| T1465 | Dynamic provider/model architecture | pending | 5d | high | Decompose |
| T1466 | T-CLEANUP-WORKTREE | pending | 5d | high | Decompose (overlaps T1461?) |

### Category C5: Done Epics with No Children (closed without children — retrospective or direct work)

These are closed and therefore lower urgency, but worth noting as no child evidence exists:

| ID | Title | Status | Notes |
|----|-------|--------|-------|
| T1093 | MANIFEST/RCASD Architecture Unification | done | Epic-level work, no children in DB |
| T1118 | T-BRANCH-LOCK | done | Epic-level work, no children in DB |
| T1187 | Tree/Dep Visualization Overhaul | done | Epic-level work, no children in DB |
| T1403 | Pump #1: post-deploy gap | done | Direct implementation |
| T1404 | Pump #2: parent-closure-without-atom | done | Direct implementation |

These are low concern — work was done directly at the epic level.

---

## 6. Type-D List — Blocked with No Path to Unblock

**None found.** No epics have `childRollup.blocked > 0`. There are no blocked dependencies detected at the epic level. (Individual task blocks within children may exist but are not surfaced at rollup level as `blocked`.)

---

## 7. Type-E List — Stale Active/Pending with Zero Child Progress

Epics with `status=active` or `status=pending`, `childRollup.done = 0`, and more than 7 days since last update:

| ID | Title | Status | Children | Last Updated | Days Stale | Recommendation |
|----|-------|--------|----------|--------------|------------|----------------|
| T889 | Orchestration Coherence v3 | pending | 0/0 | 2026-04-17 | 14d | Decompose or deprioritize |
| T631 | Cleo Prime Orchestrator Persona | pending | 0/0 | 2026-04-16 | 15d | Decompose or deprioritize |
| T911 | Install Canonical Layout + Sandbox | pending | 1/4 | 2026-04-18 | 13d | 3 children stuck — investigate |
| T942 | Sentient CLEO Architecture Redesign | pending | 1/7 | 2026-04-18 | 13d | 6 children not started — stale |
| T1232 | PRE-WAVE: CLEO Agents Arch Remediation | pending | 0/13 | 2026-04-23 | 8d | Stage=`release` but 0/13 done — critical mismatch |
| T1055 | Nexus P1: Competitive Closure | pending | 0/5 | 2026-04-20 | 11d | 5 children waiting, none started |
| T1007 | Sentient Loop Completion | pending | 0/0 | 2026-04-19 | 12d | No children, no movement |
| T1042 | Nexus vs GitNexus Far-Exceed | pending | 0/0 | 2026-04-20 | 11d | No children, no movement |
| T1212 | T-MIG-LINT-CLEAN | pending | 0/3 | 2026-04-22 | 9d | 3 children waiting, none started |

**Most critical stale case**: `T1232` has pipelineStage=`release` but zero of its 13 children have been touched. This is a stage-drift violation: the epic is at release stage but no implementation work has happened.

---

## 8. Cross-Epic Dependency Issues

All epics in this audit report `depends: null` or `depends: []`. **No cross-epic dependency chains were found.** There are no cases where epic A depends on epic B with a status mismatch.

However, the following **implicit coupling** exists based on parentId structure:

| Parent Epic | Child Epic | Parent Status | Child Status | Issue |
|-------------|------------|---------------|--------------|-------|
| T1586 | T1603 | pending | done | Child done, parent still pending (expected — T1586 has 2 more pending children) |
| T1586 | T1611 | pending | done | Same pattern — expected |
| T1563 | T1566 | pending | done | Parent T1563 is Type-A ready to close |
| T1415 | T1417 | done | done | Clean — both done |

---

## 9. Pipeline Stage Drift

Epics where `pipelineStage` is inconsistent with actual child progress:

| ID | Title | Epic Status | Pipeline Stage | Children Status | Drift |
|----|-------|-------------|----------------|-----------------|-------|
| T1232 | PRE-WAVE: CLEO Agents Arch Remediation | pending | **release** | 0/13 done | CRITICAL — stage says release, zero children done |
| T990 | Studio UI/UX Design System | pending | **contribution** | 0/0 (no children) | Stage says contribution but work hasn't started |
| T1353 | Epic (test scaffolding) | pending | **implementation** | 0/0 (no children) | Empty test epic at implementation stage |
| T1380 | Epic (test scaffolding) | pending | **implementation** | 0/0 (no children) | Empty test epic at implementation stage |
| T1603 | T-FOUNDATION-LOCKDOWN-V2 | **done** | contribution | 7/10 done (3 pending) | Type-B — closed early; 3 children never completed |

**Most severe**: `T1232` is at `release` pipelineStage with no child progress. Either the stage was set incorrectly (should be `research` or `decomposition`) or the epic was prematurely advanced without execution.

---

## 10. Special Notes

### Invalid Epic IDs in Task DB

Two IDs appear in `cleo find --type epic` results but are rejected by `cleo show`:

- **E1** — Format rejected (`Invalid task ID format: E1`). Appears in find results with title "Test Epic" and children W1T1, W1T2, W2T1, W2T2, W3T1, W3T2 (seen in find results). Cannot be audited via show.
- **T932EP** — Format rejected (`Invalid task ID format: T932EP`). Appears in find results as "T932 standalone epic with no files". Cannot be audited via show.

These represent DB rows with non-standard ID formats that pass the find index but fail show validation. They should be investigated for ID format compliance.

### T1106 (Cancelled Epic with Cancelled Child)

`T1106` is cancelled and has one child `T1139` (also cancelled). The rollup shows `1/0 done` (1 total, 0 done). This is internally consistent — cancelled work. No action needed.

### T1566 as Sub-Epic of T1563

`T1566` (done, 17/17 children done) is a child epic under `T1563`. When T1563 closes, T1566 and its subtree remain intact. This is correct behavior.

### T1586 Nearing Completion

`T1586` (pending, 17/19) has exactly 2 pending leaves: `T1600` (T-FOUND-7B briefing expansion) and `T1622` (doctrine cleanup sub-epic). `T1622` is itself Type-A (all children done). Once T1622 closes and T1600 is resolved, T1586 can close.

---

*Report generated: 2026-05-01. All data sourced from `cleo find`, `cleo show`, `cleo list --parent`. No mutations performed.*
