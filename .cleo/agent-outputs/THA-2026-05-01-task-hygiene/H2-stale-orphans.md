# H2: Stale + Orphan Task Audit

**Audit date**: 2026-05-01
**Auditor**: cleo-task-hygiene-subagent (read-only)
**Scope**: All tasks in `.cleo/tasks.db`

---

## 1. Executive Summary

| Category | Count | Notes |
|----------|-------|-------|
| Total pending tasks | 186 | All statuses checked |
| Stale pending (>60 days) | 0 | Oldest pending task is 14 days old |
| Stale pending (>30 days) | 0 | DB was re-initialized recently |
| Orphan-broken (missing parent) | 0 | All parent_id references resolve |
| Orphan-cancelled (parent cancelled) | 0 | No pending tasks under cancelled parents |
| Orphan-archived (parent archived, tasks pending) | 3 | T1531, T1532, T1533 under archived T1082 |
| Orphan-done (parent done, tasks still pending) | 7 | Loose ends under closed epics |
| High-priority abandoned (>30 days, critical/high) | 0 | No tasks meet the 30-day threshold |
| Top-level orphan tasks (no epic parent) | 22 | Tasks/subtasks floating without parent epic |
| Test/placeholder tasks (pending, no real work) | 52 | T036-T080 + test scaffolding |
| Active tasks with no work signs (>7 days) | 2 | T932E, T932EP — test fixtures |

**Key finding**: The project database is young (max 14 days old for any pending task). No classical "stale >60 days" exists. The primary hygiene issues are:
1. 52 placeholder/test tasks (T036-T080 and related) that are noise in orchestration
2. 10 pending tasks under completed or archived parents (orphan-done / orphan-archived)
3. 22 top-level floating tasks without a parent epic
4. 2 test-fixture epics permanently stuck active (T932E, T932EP)

---

## 2. Stale Pending Table (>60 days)

**None.** The oldest pending task is 14 days old (T800, T632, T889 cluster from 2026-04-17).

The system database appears to have been re-initialized or bulk-imported in mid-to-late April 2026. The 60-day staleness threshold does not apply to the current dataset.

---

## 3. Orphan-Cancelled

**None found.** No pending or active tasks have a parent in `cancelled` status.

---

## 4. Orphan-Broken (parent ID points to non-existent task)

**None found.** All `parent_id` values resolve to existing task records. The SQLite FK constraint (`ON DELETE SET NULL`) prevents dangling foreign keys.

---

## 5. Orphan-Archived / Orphan-Done (pending tasks under closed parents)

These tasks are functionally orphaned: their parent epic is `done` or `archived`, meaning the epic's work is considered complete, but these children remain open.

### 5a. Orphan-Archived (parent status = `archived`)

| ID | Title | Priority | Parent Epic | Parent Status | Days Since Update | Recommended Action |
|----|-------|----------|-------------|---------------|-------------------|--------------------|
| T1531 | Implement embedding cosine similarity for session pivot detection in session-narrative.ts | medium | T1082 (Wave 3: Continuous Dialectic Evaluator & Observer Upgrade) | archived | 2 | Re-parent to active epic or cancel |
| T1532 | Iterate on dialectic evaluator: add few-shot examples + tune confidence thresholds in buildDialecticSystemPrompt | medium | T1082 | archived | 2 | Re-parent to active epic or cancel |
| T1533 | Add telemetry logging to evaluateDialectic: log when no LLM backend available + surface structured errors from generateObject failures | medium | T1082 | archived | 2 | Re-parent to active epic or cancel |

**Root cause**: T1082 (Wave 3 Dialectic Evaluator epic) was archived on 2026-04-24, but three follow-up tasks created on 2026-04-28 were still parented to it. These are genuine open work items stranded under a closed epic.

### 5b. Orphan-Done (parent status = `done`)

| ID | Title | Priority | Parent | Parent Status | Days Since Update | Recommended Action |
|----|-------|----------|--------|---------------|-------------------|--------------------|
| T1619 | T-FOUND-V3-1: commit-msg 50-char cap rejects orchestrator merge messages | high | T1603 (T-FOUNDATION-LOCKDOWN-V2) | done | 0 | Re-parent to T1586 (active foundation epic) |
| T1620 | T-FOUND-V3-2: hotfix release ship auto-adds CHANGELOG section | medium | T1603 | done | 0 | Re-parent to T1586 |
| T1621 | T-FOUND-V3-3: validateCallsiteCoverage falls back when ripgrep unavailable | medium | T1603 | done | 0 | Re-parent to T1586 |
| T1491 | T-FU10 thin remaining fat CLI commands agent memory docs | medium | T1467 (T-THIN-WRAPPER epic) | done | 3 | Re-parent to T1563 or T1555 |
| T1493 | T-FU12 document SDK consumer dep boundary brain agents cant | medium | T948 (SDK + REST Surface) | done | 3 | Re-parent to T1563 or promote to standalone |
| T1494 | T-FU13 harden core public API surface remove internal wildcards | medium | T948 | done | 3 | Re-parent to T1563 or T1555 |
| T1495 | T-FU14 pipeline domain contract types decision | low | T1467 | done | 3 | Re-parent to T1563 or cancel |

**Note on T1619-T1621**: These tasks were created 2026-04-30 under T1603, which was already `done`. They appear to be V3 follow-ons intended for the still-active T1586 (T-FOUNDATION-LOCKDOWN). The naming convention (`T-FOUND-V3-*`) confirms they belong under T1586.

---

## 6. High-Priority Abandoned (critical/high, >30 days no movement)

**None.** The 30-day threshold is not crossed by any task in the current dataset. The most urgent concern is tasks that are *high-priority* but have been pending for 7-14 days with no active assignment:

### Notable High-Priority Unassigned (7-14 days pending, no owner)

These are not "abandoned" by the audit definition (30-day threshold), but they warrant attention as they represent significant planned work sitting idle.

| ID | Title | Priority | Type | Days Pending | Status |
|----|-------|----------|------|--------------|--------|
| T889 | EPIC: Orchestration Coherence v3 | high | epic | 13 | No active child tasks |
| T911 | EPIC: Install Canonical Layout + Sandbox Harness Coverage | high | epic | 12 | Has children but no active |
| T927 | G3: Fix double-JSON envelope in cleo CLI output | high | task | 12 | Top-level, unassigned |
| T942 | Sentient CLEO Architecture Redesign | critical | epic | 12 | Has children, none active |
| T945 | Universal Semantic Graph — promote brain_page_nodes | high | task | 12 | Top-level, no parent |
| T946 | Autonomous Self-Improving Loop — Tier1/2/3 | high | task | 12 | Top-level, no parent |
| T1042 | Cleo Nexus vs GitNexus: Far-Exceed Capability Analysis | critical | epic | 10 | Has children, none active |
| T1048 | REVISED synthesis: core-native, no-MCP, living-brain decomposition | critical | task | 10 | Top-level, no parent |
| T1054 | Nexus P0: Core Query Power | critical | epic | 10 | Has children, none active |
| T1056 | Nexus P2: Living Brain Completion | critical | epic | 10 | Has children, none active |
| T1232 | PRE-WAVE: CLEO Agents Architecture Remediation | critical | epic | 7 | Large epic, no active children |

---

## 7. Top-Level Orphan Tasks (no parent epic, type=task or subtask)

Tasks that should either be assigned to an epic, promoted to epics themselves, or cancelled.

| ID | Title | Priority | Days Old | Recommendation |
|----|-------|----------|----------|----------------|
| T1048 | REVISED synthesis: core-native, no-MCP, living-brain decomposition | critical | 10 | Re-parent to T1042 or T1563 |
| T927 | G3: Fix double-JSON envelope in cleo CLI output | high | 12 | Re-parent to T1434 or T1563 |
| T945 | Universal Semantic Graph — promote brain_page_nodes | high | 12 | Re-parent to T1056 or promote to epic |
| T946 | Autonomous Self-Improving Loop — Tier1/2/3 | high | 12 | Re-parent to T942 |
| T1043 | GitNexus CLI deep-dive: feature matrix, data model, storage | high | 10 | Re-parent to T1042 |
| T1044 | Cleo Nexus CLI deep-dive: feature matrix, data model, storage | high | 10 | Re-parent to T1042 |
| T1045 | Execute gitnexus full pipeline on /mnt/projects/openclaw | high | 10 | Re-parent to T1042 |
| T1046 | Execute cleo nexus full pipeline on /mnt/projects/openclaw | high | 10 | Re-parent to T1042 |
| T1074 | Complete Tier 3 sentient state-pause subsystem | high | 10 | Re-parent to T942 or T1007 |
| T1110 | RD: Wire git-log task-symbol sweeper to nexus analyze post-hook | high | 9 | Re-parent to T1042 or T1056 |
| T896 | Docs + architecture diagram — docs/architecture/orchestration-flow.md | medium | 13 | Re-parent to T889 |
| T913 | E2a: scenario — corrupted-db-recovery | medium | 12 | Re-parent to T911 or cancel |
| T915 | E3: strictly delete cleo-os/src/xdg.ts + inline at call sites | medium | 12 | Re-parent to T911 or T1563 |
| T916 | E4: W1.4 migrate adapter install refs to getCleoTemplatesTildePath | medium | 12 | Re-parent to T911 or T1563 |
| T918 | E6: schema-version probes in project-health | medium | 12 | Re-parent to T911 |
| T919 | G1: Fix GH issue #94 — task auto-complete inconsistency | medium | 12 | Re-parent to T1563 or T505 |
| T928 | test-success | medium | 12 | Cancel (test artifact) |
| T1119 | Followup: migrate remaining MANIFEST.jsonl entries + rename to .migrated | medium | 9 | Re-parent to T1555 |
| T917 | E5: caamp platform-paths consolidation | low | 12 | Re-parent to T911 or cancel |
| T1049 | Kind scope smoke test | low | 10 | Cancel (test artifact) |
| T1050 | T944 local smoke test | low | 10 | Cancel (test artifact) |
| T1051 | T944 explicit bug test | low | 10 | Cancel (test artifact) |

---

## 8. Active Tasks With No Work Signs (>7 days)

Tasks in `active` status that haven't been updated in more than 7 days — likely leaked status (set active, never completed or reset).

| ID | Title | Priority | Days Since Update | Recommendation |
|----|-------|----------|-------------------|----------------|
| T932E | T932 integration epic | high | 14 | Test fixture — reset to pending or cancel |
| T932EP | T932 standalone epic with no files | high | 14 | Test fixture — reset to pending or cancel |

Both T932E and T932EP are described as test fixtures ("Parent epic for composer integration test", "Epic for T1014 role auto-promotion test"). Their children T932W and T932WX are also pending for 14 days. These appear to be test scaffolding that was never cleaned up after the tests ran.

Additionally, the following active tasks have been in `active` status for 6 days with test/placeholder descriptions:

| ID | Title | Priority | Days | Notes |
|----|-------|----------|------|-------|
| T302 | Documented | medium | 6 | Test fixture |
| T501 | Partial gates | high | 6 | Test fixture |
| T502 | Ready | high | 6 | Test fixture |
| T504 | Blocked task | high | 2 | Test fixture |
| T506 | Task with done dep | high | 2 | Test fixture |
| T603 | Epic | high | 6 | Test fixture |
| E1 | Test Epic | medium | 6 | Test scaffolding with wave-task children |
| W2T1 | Wave-2 Task A | critical | 6 | Test scaffolding under E1 |
| T1332 | Auth API (imported) | high | 6 | Import test artifact |
| T1337 | Epic: Auth (imported) | medium | 6 | Import test artifact |
| T-cap-001 | Capacity test task | medium | 6 | Capacity test artifact |
| T1354 | Epic: Auth (imported-3) | medium | 6 | Import test artifact |
| T1361 | Auth API (imported-2) | medium | 6 | Import test artifact |
| T1376 | Epic: Auth (imported-5) | medium | 6 | Import test artifact |

---

## 9. Test/Placeholder Task Cluster (Bulk Noise)

A large block of 45 tasks with titles "Task 36" through "Task 80" (T036-T080) are all pending, have no description beyond "Description for T0xx", no parent, and were created 2026-04-24. These are bulk test artifacts polluting the pending queue.

Similarly: T800 ("Task T800"), T932W, T932WX, and 10+ test epics (T939, T940, T941, T1346-T1353, T1358, T1379-T1382) are test scaffolding.

**Total test/placeholder tasks (pending): 52**

- T036-T080: 45 tasks (bulk insert test artifacts)
- T800, T932W, T932WX: 3 test tasks
- T928 (test-success): 1
- T939, T940, T941: 3 test lifecycle epics
- T1346-T1348, T1351-T1353, T1358, T1379-T1380, T1382: 10 test epics

These 52 tasks appear in `cleo find` and `cleo next` results, creating substantial noise for orchestrators.

---

## 10. Recommended Bulk Actions

### Priority 1 — Cancel test scaffolding (52 tasks)

**Cancel the following groups** — they are test artifacts with no real work content:

- `T036` through `T080` (45 tasks) — bulk placeholder insert
- `T800`, `T928` — individual test tasks
- `T939`, `T940`, `T941` — lifecycle bug test epics
- `T1346`, `T1347`, `T1348`, `T1351`, `T1352`, `T1353`, `T1358`, `T1379`, `T1380`, `T1382` — unnamed/generic test epics
- Also cancel their children: `W2T2`, `W3T1`, `W3T2`, `W3T3`, `EXT1` (under test E1 epic)
- `T932W`, `T932WX` — test worker tasks under T932E

### Priority 2 — Reset or cancel stuck test-active tasks (14 tasks)

Reset the 14 active test fixtures to `pending` (if needed for future tests) or cancel:
- T302, T501, T502, T504, T506, T603, E1, W2T1, T1332, T1337, T-cap-001, T1354, T1361, T1376

### Priority 3 — Re-parent orphan-done/archived tasks (10 tasks)

| Task | Current Parent | Target Parent |
|------|---------------|---------------|
| T1619, T1620, T1621 | T1603 (done) | T1586 (active foundation epic) |
| T1491, T1495 | T1467 (done) | T1563 (audit execution master epic) |
| T1493, T1494 | T948 (done) | T1563 or T1555 |
| T1531, T1532, T1533 | T1082 (archived) | T1082 archived — re-parent to a live dialectic epic or cancel |

### Priority 4 — Re-parent high-value floating tasks (11 tasks)

| Task | Recommended Target |
|------|-------------------|
| T1043, T1044, T1045, T1046 | T1042 (Nexus capability analysis epic) |
| T1048 | T1042 or T1563 |
| T945, T1074 | T942 (Sentient Architecture epic) |
| T946 | T942 |
| T1110 | T1056 (Nexus P2 epic) |
| T896 | T889 (Orchestration Coherence epic) |
| T927 | T1434 or T1563 |

### Priority 5 — Cancel low-value floating tasks (7 tasks)

- T913, T915, T916, T917, T918, T919 (E2a-E6 tasks without clear home — likely superseded by T1563)
- T1049, T1050, T1051 (smoke test artifacts from T944 experiment)

---

## Appendix: Parent Status Reference

| Parent ID | Title | Status | Affected Pending Children |
|-----------|-------|--------|--------------------------|
| T948 | SDK + REST Surface | done | T1493, T1494 |
| T1082 | Wave 3: Dialectic Evaluator & Observer Upgrade | archived | T1531, T1532, T1533 |
| T1467 | T-THIN-WRAPPER CLI migration | done | T1491, T1495 |
| T1603 | T-FOUNDATION-LOCKDOWN-V2 | done | T1619, T1620, T1621 |
| E1 | Test Epic | active (test) | W2T2, W3T1, W3T2, W3T3, EXT1 |
| T932E | T932 integration epic | active (test) | T932W, T932WX |

---

*Report generated: 2026-05-01 | Audit H2 of THA-2026-05-01-task-hygiene*
