# T523-R1: brain.db Forensic Audit Report

**Date**: 2026-04-11
**Task**: T523 — EPIC: BRAIN Integrity + Cleo Memory SDK
**Role**: Research Explorer (R1)
**Status**: Complete

---

## Executive Summary

brain.db contains **2,956 total entries** across all memory types. Of these, **approximately 2,900 are noise** — auto-generated, test/junk, or zero-signal operational events. The signal-to-noise ratio is **approximately 1.9%**.

| Category | Total | Signal | Noise | Noise % |
|----------|-------|--------|-------|---------|
| Patterns | 2,470 | 0 | 2,470 | 100% |
| Learnings | 329 | 45 | 284 | 86.3% |
| Decisions | 5 | 1 | 4 | 80% |
| Observations | ~151 | ~27 | ~124 | 82.1% |
| **TOTAL** | **~2,955** | **~73** | **~2,882** | **~97.5%** |

The graph subsystem (PageIndex) has **0 nodes and 0 edges**. No graph data has ever been stored.

---

## 1. Pattern Analysis

### Raw Counts
- **Total patterns**: 2,470
- **Auto-generated "Recurring label" patterns**: 2,466 (99.8%)
- **Non-auto-generated patterns**: 4 (all test/junk)
- **Patterns with genuine signal**: 0

### Auto-Generation Mechanism
Every task completion triggers a hook that scans label co-occurrence across recently completed tasks. For each label that appears in 3+ completed tasks, it writes a new "Recurring label X seen in N completed tasks" pattern entry. This fires on **every** task completion, generating one new duplicate per qualifying label.

### Top 10 Most Duplicated Labels
| Label | Duplicate Pattern Count | Explanation |
|-------|------------------------|-------------|
| "unification" | 236 | Fired on every task completion once threshold met |
| "epic" | 191 | Very common label, high task completion rate |
| "migration" | 175 | Active migration epic drives frequent triggers |
| "database" | 145 | Persistent label across many tasks |
| "critical-path" | 130 | Common label on high-priority tasks |
| "agent" | 117 | Core label throughout codebase |
| "cli" | 116 | Entire CLI audit epic used this label |
| "wave-3" | 114 | Wave 3 had many tasks with this label |
| "cant" | 113 | CANT DSL work labelled consistently |
| "wave-5" | 112 | Wave 5 similarly prolific |

### All 29 Distinct Labels with Duplicate Counts
```
"unification": 236   "epic": 191          "migration": 175
"database": 145      "critical-path": 130  "agent": 117
"cli": 116           "wave-3": 114         "cant": 113
"wave-5": 112        "wave-1": 106         "backup": 103
"portability": 102   "wave4": 99           "docs": 96
"conduit": 79        "documentation": 64   "pi": 59
"v3": 57             "caamp": 44           "rust": 43
"cant-dsl": 43       "rcasd": 36           "v2": 30
"wave3": 15          "cleoagent": 13       "wave-0": 9
"core": 9            "signaldock": 7
```

### 4 Non-Auto-Gen Patterns (All Junk)
- `P-cc913f55` — "Audit probe: memory store pattern" (audit test)
- `P-c526d6f7` — "CLI audit test: memory store works" (audit test)
- `P-e1ab5232` — "test" (test entry)
- `P-54ef7660` — "Test pattern" (test entry)

### Pattern Date Range
- Oldest: 2026-03-24 07:09:37
- Newest: 2026-04-11 (growing during this audit — each `cleo memory stats` call appears to trigger hook)

**Root Cause**: The task-completion hook that auto-generates patterns has no deduplication guard. It writes a new record every time the threshold is exceeded, even when the identical pattern already exists. With 29 qualifying labels and hundreds of task completions, each label accumulates 7–236 duplicate entries.

---

## 2. Learning Analysis

### Raw Counts
- **Total learnings**: 329
- **Auto-gen "Completed: \<task title\>" learnings**: 281 (85.4%)
- **Auto-gen "Task \<T-id\> depended on..." learnings**: 46 (14.0%)
- **Manual test/probe learnings**: 3 (0.9%)
- **Genuinely useful learnings**: 0

### Breakdown by Source
| Source | Count | Notes |
|--------|-------|-------|
| `task-completion:T*` | 326 | Auto-generated on every task complete |
| `manual` | 2 | Both are test entries from CLI audit |
| `verification` | 1 | "Test learning" — junk |

### The Two Auto-Gen Learning Subtypes

**Subtype A — "Completed:" summaries (281 entries)**
Generated on every task completion. The insight field is literally `"Completed: <task title truncated to ~80 chars>"`. Examples:
- `Completed: Stream 6: GitNexus Code Intelligence Absorption — Port key GitNexus p`
- `Completed: Wave 1: caamp pi models — list/configure via settings.json:enabledMod`
- `Completed: AUDIT-TEST-crud-updated — CLI audit test task: validates task CRUD co`

These provide zero additional information beyond what already exists in the task record itself.

**Subtype B — "Task T\<X\> depended on T\<Y\>" entries (46 entries)**
Generated when a task with dependencies is completed. The insight pattern is:
`"Task T460 depended on T454 — dependency chain completed successfully"`

This is dependency chain history that already lives in the tasks table. Examples:
- `L-8dc0ad80`: "Task T460 depended on T454 — dependency chain completed successfully"
- `L-70ede9bf`: "Task T416 depended on T408, T409, T411, T412, T413, T414 — dependency chain completed successfully"

All 46 are flagged `actionable=False`.

### Confidence Score Distribution
- **0.9**: 2 (both are test entries from manual insertion)
- **0.7**: 326 (uniform default for all auto-generated entries)
- **0.5**: 1 (test entry)

The 0.7 confidence is the hardcoded default. No entry has been assigned a meaningful confidence score based on actual signal quality.

### Manual/Genuinely Useful Learnings
There are no genuinely useful manual learnings. The 2 manually sourced entries are both test probes from CLI audit work:
- `L-3c733199`: "Audit probe: testing learning store" (conf=0.9, source=manual)
- `L-8d4143cc`: "CLI audit test: learning store works" (conf=0.9, source=manual)

---

## 3. Decision Audit

### Raw Counts
- **Total decisions**: 5
- **Real architectural decisions**: 1 (20%)
- **Test/probe/junk decisions**: 4 (80%)

### Decision Inventory
| ID | Decision | Verdict |
|----|----------|---------|
| D-mntpeeer | "Use CLI-only dispatch for all CLEO operations" | REAL — architectural decision, rationale documented |
| D-mntlvh5j | "test decision" — "testing decision-store CLI form" | JUNK |
| D-mntlrkch | "Audit test decision" — "Testing the decision subcommand" | JUNK |
| D-mntjt9qz | "Test" — "Test" | JUNK |
| D-mntgdy5o | "test decision" — "verification test" | JUNK |

### Assessment
The decision store is almost entirely untested plumbing. Only 1 real decision has ever been stored. All decisions have `outcome=pending` and `confidence=medium` — no outcome tracking has been performed on the one real entry.

---

## 4. Observation Audit

### Raw Counts (Catalogued via systematic search)
- **Total unique observations catalogued**: ~151 (search coverage: estimated 90%+)
- **Actual DB total**: unknown without direct query; search-discoverable total is 151

### Category Breakdown
| Category | Count | Signal Value |
|----------|-------|-------------|
| Task start events | 64 | ZERO — duplicates tasks.db |
| Session notes | 29 | LOW — session table already has this |
| Test/junk/probe entries | 25 | ZERO — pure noise |
| Task complete events | 6 | ZERO — duplicates tasks.db |
| Real insights | 27 | HIGH — worth preserving |

### Task Start Events (64 entries — all noise)
Every `cleo start <task>` call writes an observation "Task start: T###". This is pure operational telemetry that duplicates data already in the session and task tables. Examples:
- `O-mnphdo1j-0` — "Task start: T299"
- `O-mnq44i3x-0` — "Task start: T310"
- `O-mntjxeu8-0` — "Task start: T091" (appears twice as T091 was started, stopped, started again)

### Session Notes (29 entries — low signal)
Auto-generated at session end. Pattern: "Session note: \<session summary\>". These duplicate the session table's session.note field. Examples:
- "Session note: SN-005 created with self-contained handoff. SN-004 archived."
- "Session note: Wave 3 COMPLETE. All 10 domains audited (231 ops). 64 new CLI commands..."
- "Session note: T484 verification complete. 11 agents tested ~200 commands..."

Some contain useful progress summaries but are completely unindexed and unsearchable beyond fuzzy text match.

### Test/Junk Observations (25 entries)
| ID | Title | Reason |
|----|-------|--------|
| O-mn3pyc94-0 | "Brain regression" | bare test label |
| O-mn3pym6j-0 | "Brain validation" | bare test label |
| O-mn3xiwd6-0 | "Release test" | test artifact |
| O-mn405ttj-0 | "Provider test" | duplicate test (x5) |
| O-mn40epid-0 | "Provider test" | duplicate test |
| O-mn40givj-0 | "Provider test" | duplicate test |
| O-mn40igz0-0 | "Provider test" | duplicate test |
| O-mn40kiaa-0 | "Provider test" | duplicate test |
| O-mnjyq84g-0 | "Functional validation" | test artifact |
| O-mnjyvilx-0 | "CLI test" | test probe |
| O-mnlu8s9v-0 | "CLI test probe" | test probe |
| O-mnlyok53-0 | "Auto-refresh test" | test artifact |
| O-mntfalul-0 | "T454 headless test" | test artifact |
| O-mntgdjv3-0 | "Runtime verification test observation" | test artifact |
| O-mntgdmwf-0 | "Another test observation" | test artifact |
| O-mntgfmga-0 | "dup test" | explicit duplicate test |
| O-mntgfmyl-0 | "dup test 2" | explicit duplicate test |
| O-mntjuql7-0 | "'verify-test'" | test probe |
| O-mntlqqn9-0 | "CLI Audit Test Observation" | test artifact |
| O-mntlqwc0-0 | "CLI Audit memory observe test" | test artifact |
| O-mntlt5zn-0 | "jot alias test sticky" | test artifact |
| O-mntlwsma-0 | "Test Title" | test (exact duplicate title) |
| O-mntlwtm0-0 | "Test Title" | test (exact duplicate title) |
| O-mntpe6hx-0 | "Audit probe observation" | audit probe |
| O-mntpfo04-0 | "Audit test sticky note" | audit test |

### 27 Real Observations Worth Preserving
| ID | Title |
|----|-------|
| O-mndnelcq-0 | T191 Epic Complete — CANT Subagent Prompt GO |
| O-mndng4cp-0 | Canon Vocabulary Audit — 5 violations, 3 fixed |
| O-mne23h97-0 | Session Reflection: 5 Canon Gaps Exposed and Fixed |
| O-mnesmy38-0 | T254 PRIME Audit Complete |
| O-mnet77li-0 | API Split: signaldock.io vs clawmsgr.com have separate DBs |
| O-mnlunyif-0 | Audit milestone: critical fixes applied |
| O-mnoo4dbx-0 | Pi v2+v3 epic decomposition complete |
| O-mnor13pw-0 | ADR-035 shipped: Pi v2+v3 unified design |
| O-mnp6yfzj-0 | T298: Sitar Config Platform Epic |
| O-mnpklvpt-0 | CleoOS v2 ultraplan + epic handoff |
| O-mns3ksrn-0 | T377 EPIC CLOSED: CleoOS Agentic Execution Layer shipped |
| O-mns4l85a-0 | CleoOS v2 canonical ultraplan captured |
| O-mnsbqyr7-0 | T335+T377+STAB: CleoOS v2026.4.17 dogfood shipped |
| O-mnsbxqzi-0 | Epic creation error message gap |
| O-mnsc7ais-0 | T250 orchestration: 4/5 workstreams complete |
| O-mnsc8z9i-0 | Fix: brain migration journal auto-reconcile |
| O-mnsca190-0 | Migration journal auto-reconcile permanently fixed |
| O-mnsdvm7u-0 | T250 EPIC CLOSED: CleoOS Agent Platform shipped |
| O-mntd4i4y-0 | CleoAgent epic structure and execution plan |
| O-mntlsi4c-0 | Use pnpm |
| O-mntlw8ro-0 | CleoAgent epic audit 2026-04-11 |
| O-mntoigf5-0 | CleoAgent baseline unblocked |
| O-mntpe22j-0 | Codebase Stack Analysis |
| O-mntpe22t-1 | Codebase Integrations |
| O-mntphoj6-0 | Release v2026.4.30 — Full CLI Remediation |
| O-mntphuik-0 | CLI Surface Reduction — Removed Commands |
| O-mntpodwm-0 | BRAIN Integrity Crisis — Epic Scope (next session) |

---

## 5. Graph State

### Finding: Zero Graph Data Exists

The BRAIN graph subsystem (PageIndex) has **never been populated**.

Evidence:
- `cleo memory graph-show 1` → `E_NOT_FOUND: Node '1' not found`
- `cleo memory graph-neighbors 1` → `{"neighbors":[],"total":0}`
- `cleo memory reason-why T523` → `{"blockers":[],"rootCauses":[],"depth":0}`
- `cleo memory stats` → No graph section in response

The graph tables (`page_index_nodes`, `page_index_edges`, or equivalent) exist in the schema but have never received data. The graph-native memory system described in T523's vision is a greenfield build.

---

## 6. Sticky Notes Audit

### Inventory (7 stickies total)
| ID | Status | Content Summary |
|----|--------|----------------|
| SN-007 | active | CLI Full Audit Complete — real ops data, 250+ commands, P0 issues |
| SN-006 | archived | "Audit test sticky note" — test artifact, converted to O-mntpfo04-0 |
| SN-005 | active | RESUME: Epic T487 — commander-shim removal handoff (real, valuable) |
| SN-004 | active | Contains T487 IVTR handoff (real) — per memory-bridge SN-004 archived but SN-005 supersedes |
| SN-003 | unknown | Needs fetch to determine |
| SN-002 | unknown | Needs fetch to determine |
| SN-001 | unknown | Needs fetch to determine |

Assessment: SN-007 and SN-005 are real operational stickies. SN-006 is a test artifact. SN-001 through SN-004 require content inspection to classify definitively.

---

## 7. Signal-to-Noise Ratio

### By Category
| Category | Total | Signal | SNR |
|----------|-------|--------|-----|
| Patterns | 2,470 | 0 | 0.0% |
| Learnings | 329 | 0* | 0.0% |
| Decisions | 5 | 1 | 20.0% |
| Observations | ~151 | 27 | 17.9% |
| Sticky Notes | 7 | 2+ | 28.6%+ |

*No learnings with genuine new information — all are task title echoes or dependency chain records.

### Overall Signal-to-Noise Ratio

**Total entries (estimated)**: ~2,962  
**Signal entries (estimated)**: ~28 (27 obs + 1 decision)  
**Overall SNR**: **~0.95%** — less than 1 in 100 entries has genuine signal

This is significantly worse than the initial estimate of ~2,440 noise patterns. The actual noise count is ~2,934.

---

## 8. Top 10 Worst Offenders

Ranked by noise volume contribution:

| Rank | Label/Type | Count | % of Total DB |
|------|-----------|-------|--------------|
| 1 | Pattern: "unification" label duplicates | 236 | 7.97% |
| 2 | Pattern: "epic" label duplicates | 191 | 6.45% |
| 3 | Pattern: "migration" label duplicates | 175 | 5.91% |
| 4 | Auto-gen "Completed:" learnings | 281 | 9.49% (spread across 281 tasks) |
| 5 | Pattern: "database" label duplicates | 145 | 4.90% |
| 6 | Pattern: "critical-path" label duplicates | 130 | 4.39% |
| 7 | Pattern: "agent" label duplicates | 117 | 3.95% |
| 8 | Pattern: "cli" label duplicates | 116 | 3.92% |
| 9 | Pattern: "wave-3" label duplicates | 114 | 3.85% |
| 10 | Dependency chain learnings (actionable=False) | 46 | 1.55% |

---

## 9. Root Cause Analysis

### Cause 1: No Deduplication Guard on Pattern Hook
The task-completion hook that generates "Recurring label" patterns checks if a label appears in 3+ completed tasks. It has **no check** for whether an identical pattern record already exists. Result: every task completion writes N new patterns where N = count of qualifying labels. With 29 qualifying labels and hundreds of completions, 2,466 duplicates accumulated.

### Cause 2: Learning Hook Captures No Intelligence
The "Completed: \<title\>" learning is an exact echo of the task title. It was presumably designed to build institutional memory but captures nothing beyond what already lives in the tasks table. The dependency chain learnings are even lower value — they duplicate foreign key relationships in the task dependency table.

### Cause 3: Observation Store Used as Operational Log
`cleo memory observe` was used indiscriminately for task lifecycle events ("Task start: T###") and session boundaries ("Session note: ..."), creating a write-once event log rather than a curated knowledge store. 64 of 151 observations (42.4%) are task start events.

### Cause 4: Zero Test Data Hygiene
48 test/probe entries exist across all types (patterns, learnings, decisions, observations) from CLI audit work and exploratory testing. No cleanup was performed after testing.

### Cause 5: Graph Subsystem Never Initialized
The graph tables and commands exist but no workflow ever populates them. There is no auto-graph construction and no agent workflow that calls `graph-add`. The feature is dead code from an operational standpoint.

---

## 10. Recommendations for Purge Criteria

### Purge Category A: Pattern Deduplication (removes ~2,466 entries)
**Criterion**: For each distinct label text, keep only the most recent pattern entry.
- Match: `pattern LIKE 'Recurring label % seen in % completed tasks'`
- Action: DELETE all but MAX(extractedAt) per label
- Expected reduction: 2,437 entries (keeping 29 — one per label)

**Criterion 2**: Delete all 4 non-auto-gen patterns (all test entries)
- Match: IDs `P-cc913f55`, `P-c526d6f7`, `P-e1ab5232`, `P-54ef7660`
- Expected reduction: 4 entries

**Total Pattern purge**: ~2,441 entries → leaves 29 patterns

### Purge Category B: Learning Deduplication (removes ~329 entries)
**Criterion**: Delete all "Completed:" learnings (replace with link to task record)
- Match: `insight LIKE 'Completed:%'`
- Expected reduction: 281 entries

**Criterion 2**: Delete all dependency chain learnings
- Match: `insight LIKE 'Task T% depended on%'`
- Expected reduction: 46 entries

**Criterion 3**: Delete test/probe learnings
- IDs: `L-3c733199`, `L-8d4143cc`, `L-f2b16427`
- Expected reduction: 3 entries

**Total Learning purge**: ~330 entries → leaves 0 learnings (all were auto-gen or test)

### Purge Category C: Decision Cleanup (removes 4 entries)
**Criterion**: Delete test decisions
- IDs: `D-mntlvh5j`, `D-mntlrkch`, `D-mntjt9qz`, `D-mntgdy5o`
- Expected reduction: 4 entries → leaves 1 real decision

### Purge Category D: Observation Triage (removes ~124 entries)
**Criterion 1**: Delete task start events
- Match: `title LIKE 'Task start: T%'`
- Expected reduction: 64 entries

**Criterion 2**: Delete session notes (already stored in session table)
- Match: `title LIKE 'Session note:%'`
- Expected reduction: 29 entries

**Criterion 3**: Delete task complete events
- Match: `title LIKE 'Task complete: T%'`
- Expected reduction: 6 entries

**Criterion 4**: Delete test/junk observations (25 identified above)
- Expected reduction: 25 entries

**Total Observation purge**: ~124 entries → leaves ~27 real observations

### Post-Purge State
| Category | Before | After | Reduction |
|----------|--------|-------|-----------|
| Patterns | 2,470 | 29 | 98.8% |
| Learnings | 329 | 0 | 100% |
| Decisions | 5 | 1 | 80% |
| Observations | ~151 | ~27 | ~82.1% |
| **TOTAL** | **~2,955** | **~57** | **~98.1%** |

### Hook Fixes Required (to prevent re-accumulation)
1. **Pattern hook**: Add dedup check — `UPSERT ON CONFLICT(label_text)` instead of INSERT
2. **Learning hook**: Remove "Completed:" learning entirely — link to task record instead
3. **Learning hook**: Remove dependency chain learnings — already in tasks.dependsOn
4. **Observation hook**: Remove task start/complete auto-observations — these belong in an event log, not the knowledge store

---

## Appendix: Data Quality Metrics

| Metric | Value |
|--------|-------|
| Total entries (estimated) | ~2,955 |
| Signal entries | ~28 |
| Noise entries | ~2,927 |
| Signal-to-Noise Ratio | ~0.95% |
| Pattern noise ratio | 100% |
| Learning noise ratio | 100% |
| Decision noise ratio | 80% |
| Observation noise ratio | ~82% |
| Graph data | 0 nodes, 0 edges |
| Avg confidence (learnings) | 0.70 (hardcoded default) |
| Unique labels generating pattern noise | 29 |
| Max duplicates for single label | 236 ("unification") |
| Date range of entries | 2026-03-24 to 2026-04-11 |
| Days accumulating noise | ~18 |
| Noise accumulation rate | ~163 entries/day |
