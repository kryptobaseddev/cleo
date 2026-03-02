# Wave 3 Dependency Graph Audit

**Auditor**: dep-graph-auditor
**Date**: 2026-03-01
**Scope**: 14 tasks across Epic A (T5112 Session Safety) and Epic B (T5149 BRAIN Database)

---

## 1. Full Downstream Dependency Map

### Direct Dependents (tasks that list one of our 14 as a dependency)

| Downstream Task | Depends On | Status | Notes |
|-----------------|-----------|--------|-------|
| **T5115** (Phase 3: Agent Recovery Protocol) | T5113, T5114 | pending | Next session phase, unblocked once phases 1+2 marked done |
| **T5153** (Phase 4: Reasoning & Session Integration) | T5114, T5152 | pending | Still blocked by T5152 (Advanced Search) even after T5114 done |
| **T5117** (Phase 5: Agent Handoff & Recovery) | T5113, T5114 | **cancelled** | Absorbed by T5149 BRAIN epic |
| **T5118** (Phase 6: Validation & claude-mem Retirement) | T5113, T5114 | **cancelled** | Absorbed by T5149 BRAIN epic |
| **T5122** (Integration tests for session context safety) | T5119, T5120, T5121 | pending | **Already implemented** in commit 689508e2 — needs status update |
| **T5137** (Integrate memory observations into session debrief) | T5123 | pending | Phase 4 task, parent T5153 |
| **T5148** (Session debrief handoff enhancement) | T5123 | pending | Phase 3 task, parent T5115 |
| **T5126** (Update CLEO-INJECTION.md with session agent guide) | T5124 | pending | **Already implemented** in commit b8f19f20 — needs status update |
| **T5124** (Create canonical session op decision tree) | T5125 | pending | **Already implemented** in commit b8f19f20 — needs status update |
| **T5128** (Implement brain.db DataAccessor) | T5127 | pending | **Already implemented** in commit 8da39624 — needs status update |
| **T5129** (Migrate JSONL to brain.db) | T5128 | pending | **Already implemented** in commit f59eb77a — needs status update |
| **T5130** (FTS5 search implementation) | T5128 | pending | **Already implemented** in commit f59eb77a — needs status update |
| **T5155** (Implement Decision Memory module) | T5128 | pending | **Already implemented** in commit f59eb77a — needs status update |
| **T5156** (brain_memory_links cross-reference mgmt) | T5128 | pending | **Already implemented** in commit f59eb77a — needs status update |
| **T5026** (Align PORTABLE-BRAIN-SPEC.md) | T5149 | pending | Documentation task, parent T4573 |
| **T5027** (Align CLEO-BRAIN-SPECIFICATION.md) | T5149 | pending | Documentation task, parent T4573 |
| **T5059** (nexus.db Phase 2: migrate JSON registry) | T5150 | pending | Nexus epic cross-dependency |
| **T5151** (BRAIN Phase 2: 3-Layer Retrieval & MCP) | T5150 | pending | Next brain phase |
| **T5154** (BRAIN Phase 5: Memory Lifecycle) | T5150 | pending | Far downstream |

### Transitive Closure (all tasks reachable through dependency chains from our 14)

**12 tasks total** in transitive downstream:
- T5122, T5124, T5126 (session, already implemented)
- T5128, T5129, T5130, T5155, T5156 (brain, already implemented)
- T5137, T5148 (next wave — not yet implemented)
- T5165, T5171 (Phase 4 reasoning — far downstream)

### KEY FINDING: ALL 14 tasks show status `pending` in the database despite having committed code

The git log confirms implementation:
- `44ee652a` — T5119, T5120, T5121 (session.find, budget enforcement, default limits)
- `b8f19f20` — T5123, T5125, T5124, T5126 (handoff fix, ops audit, decision tree, injection guide)
- `689508e2` — T5122 (integration tests)
- `8da39624` — T5127, T5128 (brain schema + accessor)
- `f59eb77a` — T5155, T5129, T5130, T5156 (decision memory, migration, FTS5, links)

**All 14 tasks need status updated from `pending` to `done`.**

---

## 2. Nexus-BRAIN Analysis

### T5057 (nexus.db SQLite Architecture) Subtree

| Task | Title | Status |
|------|-------|--------|
| T5057 | EPIC: nexus.db SQLite Architecture | pending |
| T5058 | Phase 1: brain.db Drizzle schema + migrate JSONL | **cancelled** (absorbed by T5149) |
| T5059 | Phase 2: Create nexus.db + migrate JSON registry | pending |
| T5060 | Phase 3: Decision Memory + FTS5 on brain.db | **cancelled** (absorbed by T5149) |
| T5061 | Update nexus docs for three-database architecture | pending |
| T5062 | Phase 5: graph-rag.ts test coverage + Nexus integration tests | pending |

### Nexus-Brain Dependencies

**Direct dependency**: T5059 (nexus.db Phase 2) depends on T5150 (brain.db Phase 1)
- This means nexus.db development is now unblocked once T5150 is marked done
- T5058 and T5060 were correctly cancelled as their scope was absorbed by T5149

### Architectural Overlap

Both nexus and brain use **separate SQLite databases** (three-database architecture):
- `tasks.db` — task management (existing)
- `brain.db` — cognitive infrastructure (new, Wave 3)
- `nexus.db` — multi-project registry (planned, T5059)

There are NO formal task_relations between nexus and brain tasks in the DB. The only connection is the dependency T5059 -> T5150. However, the description of T5059 mentions migrating `~/.cleo/projects-registry.json` to SQLite, which is architecturally independent from brain.db.

### Recommendation

The nexus.db work (T5059) is now unblocked. It should follow the same Drizzle ORM + separate SQLite file pattern established by brain.db.

---

## 3. T5148 Analysis

**T5148**: "Session debrief handoff enhancement"
- **Parent**: T5115 (Phase 3: Agent Recovery Protocol)
- **Depends on**: T5123 (our handoff fix)
- **Related to**: T5149 (BRAIN epic)
- **Status**: pending
- **No children**

**Description**: Enhance `session.end` to compute and persist debrief + handoff data reliably. Fix empty catch blocks that silently eat errors from `sessionComputeDebrief`/`sessionComputeHandoff`. Connects Epic A (sessions) to Epic B (brain.db) — debrief data will eventually persist to brain.db `session_summaries` table.

**Analysis**: T5148 is the bridge task between the two epics. It:
1. Depends on T5123 (our handoff fix) which fixed error propagation
2. Is related to T5149 (BRAIN epic) because debrief data feeds into brain.db
3. Lives under T5115 (Phase 3) which is now unblocked by our Phase 1+2 completion

T5148 is a **natural next task** to work on — it continues the session safety work and prepares the data pipeline for brain.db session_summaries.

---

## 4. Missing Tasks Analysis

### session_summaries table

The ADR-009 spec and T5127's description both call for a `session_summaries` table:
> (6) session_summaries -- id, session_id, summary, key_decisions, tasks_completed, created_at

**However, this table was NOT implemented in brain-schema.ts.** The schema contains:
- brain_decisions
- brain_patterns
- brain_learnings
- brain_memory_links
- brain_schema_meta

This is a **deliberate deferral**, not a missed task. The session_summaries integration is tracked by:
- **T5137**: "Integrate memory observations into session debrief" (Phase 4, T5153)
- **T5148**: "Session debrief handoff enhancement" (Phase 3, T5115)

The deferral makes architectural sense — session_summaries depends on the session debrief system (T5148) being enhanced first, which in turn depends on the handoff fix (T5123) we just completed.

### No Skipped Subtasks

All planned subtasks under T5150 (Phase 1) were implemented:
- T5127: Schema design
- T5128: DataAccessor implementation
- T5129: JSONL migration
- T5130: FTS5 search
- T5155: Decision Memory module
- T5156: brain_memory_links management

No subtasks were skipped or missed.

---

## 5. Phase Completion Status

### T5113 (Phase 1: Session Context Safety & Discovery) — ALL DONE in code

| Task | Title | DB Status | Git Commit | Actual |
|------|-------|-----------|------------|--------|
| T5119 | session.find lightweight discovery | pending | 44ee652a | DONE |
| T5120 | Automatic budget enforcement on session.list | pending | 44ee652a | DONE |
| T5121 | Default limits to session.list engine | pending | 44ee652a | DONE |
| T5122 | Integration tests for session context safety | pending | 689508e2 | DONE |

### T5114 (Phase 2: Session Lifecycle Flow Audit & Simplification) — ALL DONE in code

| Task | Title | DB Status | Git Commit | Actual |
|------|-------|-----------|------------|--------|
| T5123 | Fix session.handoff returns no data | pending | b8f19f20 | DONE |
| T5124 | Session operation decision tree & tier map | pending | b8f19f20 | DONE |
| T5125 | Review 17 ops for overlap & tier classification | pending | b8f19f20 | DONE |
| T5126 | Update CLEO-INJECTION.md with session agent guide | pending | b8f19f20 | DONE |

### T5150 (Phase 1: brain.db Foundation) — ALL DONE in code

| Task | Title | DB Status | Git Commit | Actual |
|------|-------|-----------|------------|--------|
| T5127 | Design brain.db Drizzle schema | pending | 8da39624 | DONE |
| T5128 | Implement brain.db DataAccessor | pending | 8da39624 | DONE |
| T5129 | Migrate JSONL data to brain.db | pending | f59eb77a | DONE |
| T5130 | FTS5 search implementation | pending | f59eb77a | DONE |
| T5155 | Decision Memory module | pending | f59eb77a | DONE |
| T5156 | brain_memory_links cross-references | pending | f59eb77a | DONE |

**No additional children** exist under any phase that were not accounted for.

---

## 6. Cross-Epic Dependencies

### Formal Dependencies (task_dependencies table)

**No direct cross-epic dependencies** exist between Epic A session tasks and Epic B brain tasks.

### Formal Relations (task_relations table)

**T5148** has a `related` relation to T5149, but this is the ONLY cross-epic relation.

### Implicit Dependencies (description references)

- T5150 and T5127 descriptions mention `session_summaries` — connecting brain.db to session data
- T5137 explicitly bridges the epics: "Save session_summary to brain.db on session.end"
- T5148 connects them: "debrief data will eventually persist to brain.db session_summaries table"

### Dependency Flow

```
Epic A: Session Safety              Epic B: BRAIN Database
========================            ========================
Phase 1 (T5113) ─┐                Phase 1 (T5150) ── all 6 tasks DONE
Phase 2 (T5114) ─┤                        │
                  ├─► Phase 3 (T5115)      ├─► Phase 2 (T5151) 3-Layer Retrieval
                  │     └─► T5148 ─related─┤
                  │                        ├─► nexus.db T5059 (cross-epic)
                  └─► Phase 4 (T5153)      │
                        └─► T5137 ─────────┘ (writes to brain.db)
```

---

## 7. Recommendations

### Immediate Actions Required

1. **Update all 14 task statuses to `done`** — critical, as downstream tasks remain blocked in the system
2. **Update phase statuses**: T5113, T5114, T5150 should be marked `done` (all children complete)
3. **Check if T5112 and T5149 epics should auto-progress** once their respective phases update

### Now Unblocked (after status updates)

| Priority | Task | Why |
|----------|------|-----|
| HIGH | **T5115** (Phase 3: Agent Recovery Protocol) | Unblocked by T5113+T5114 done. Contains T5148 bridge task. |
| HIGH | **T5059** (nexus.db Phase 2) | Unblocked by T5150 done. Migrate JSON registry to SQLite. |
| HIGH | **T5151** (BRAIN Phase 2: 3-Layer Retrieval) | Unblocked by T5150 done. MCP wiring for brain.db. |
| MEDIUM | **T5026, T5027** (Spec alignment docs) | Unblocked by T5149 progress. Documentation updates. |
| LOW | **T5153** (Phase 4: Reasoning) | Still blocked by T5152 (Advanced Search, not yet started). |

### Next Logical Wave (Wave 4 candidates)

1. **T5115 subtasks** — particularly T5148 (session debrief enhancement) as the bridge task
2. **T5059** — nexus.db migration (architecturally independent, can parallelize)
3. **T5151** — BRAIN Phase 2 MCP wiring (builds directly on our Phase 1 foundation)

### session_summaries Gap

The `session_summaries` table was specified in ADR-009 and T5127 description but deliberately not implemented in Phase 1. It is tracked by T5137 (Phase 4) and T5148 (Phase 3). This should be added to brain-schema.ts when T5148 is implemented — recommend adding it to T5148's acceptance criteria.
