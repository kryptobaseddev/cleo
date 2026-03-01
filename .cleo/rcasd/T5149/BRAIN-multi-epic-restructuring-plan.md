# Comprehensive BRAIN System — Multi-Epic Restructuring Plan

**Status**: EXECUTED (all mutations applied 2026-03-01)
**Epics**: T5112 (Sessions), T5149 (BRAIN), T5057 (nexus.db)

## Context

The original SBMU plan (T5112, 27 tasks in 1 epic) tried to solve 5 problems in one monolith. After deep research into the vision, ADR-009, CLEO-BRAIN-SPECIFICATION, PORTABLE-BRAIN-SPEC, and all related epics (T5057, T4573, T4284), we found:

1. **T5057** already planned brain.db with the correct ADR-009 schema but was separate from SBMU
2. **T5112 Phase 3-6** overlap significantly with T5057 Phases 1, 3, 4
3. The vision requires **three search tiers**, **reasoning operations**, **memory consolidation**, and **temporal decay** — far exceeding the original 27-task scope
4. Cramming 35+ tasks into one epic with 7-sibling limits constrains decomposition
5. Session work, brain.db work, and cognitive search are naturally separate concerns

**Solution**: Break into **3 focused epics** with clear depends/relates, plus restructure T5057 as nexus.db-only.

---

## Epic Structure Overview

```
Epic A: T5112 ─── Session Safety, Lifecycle & Recovery
    3 phases (T5113, T5114, T5115), 14 subtasks
    No dependencies on other epics

Epic B: T5149 ─── BRAIN Database & Cognitive Infrastructure
    5 phases (T5150-T5154), 28 subtasks
    Absorbs T5057 brain.db scope (T5058, T5060)
    Phase 4 depends on Epic A Phase 2 (handoff fix for debrief integration)

Epic C: T5057 ─── nexus.db SQLite Architecture
    3 phases (T5059, T5061, T5062)
    Phase 1 depends on Epic B Phase 1 (follow brain.db patterns)
    T4284 (Nexus WebUI) depends on Epic C Phase 1

Epic D: T4573 (EXISTING, no change) ─── Vision & Spec Revision
    T5026, T5027 depend on Epic B (T5149) completion
```

---

## Epic A: Session Safety, Lifecycle & Recovery [T5112]

**Scope**: Everything session-related. No brain.db, no search infrastructure.

### Phase 1: Session Context Safety & Discovery [T5113]
| ID | Title | Depends |
|----|-------|---------|
| T5119 | Add session.find lightweight discovery | — |
| T5120 | Wire budget enforcement on session.list | — |
| T5121 | Add default limits to session.list (limit=10) | — |
| T5122 | Integration tests for session context safety | T5119, T5120, T5121 |

### Phase 2: Session Lifecycle Audit & Simplification [T5114]
| ID | Title | Depends |
|----|-------|---------|
| T5123 | Fix T5023 — session.handoff returns no data | — |
| T5125 | Review 17 operations for overlap and tier classification | — |
| T5124 | Create canonical session operation decision tree | T5125 |
| T5126 | Update CLEO-INJECTION.md with session agent guide | T5124 |

### Phase 3: Agent Recovery Protocol [T5115] — depends T5113, T5114
| ID | Title | Depends |
|----|-------|---------|
| T5136 | Implement session.recover (~200 token response) | — |
| T5138 | Design canonical recovery flow docs | T5136 |
| T5139 | Update CLEO-INJECTION.md with recovery protocol | T5138 |
| T5140 | E2E integration test for full recovery cycle | T5136 |
| T5148 | Session debrief handoff enhancement | T5123 |

### Cancelled from T5112:
- T5116 (Phase 4) → children moved to T5149 Phase 2 (T5151)
- T5117 (Phase 5) → children reparented to T5115/T5153
- T5118 (Phase 6) → children moved to T5149 Phase 5 (T5154)

---

## Epic B: BRAIN Database & Cognitive Infrastructure [T5149]

**Scope**: Everything brain.db per vision.md + ADR-009.
**Absorbs**: T5058, T5060 from T5057; SBMU Phases 3-6

### Phase 1: brain.db Foundation [T5150]
| ID | Title | Depends |
|----|-------|---------|
| T5127 | Design brain.db Drizzle schema (full ADR-009) | — |
| T5128 | Implement brain.db DataAccessor | T5127 |
| T5155 | Implement Decision Memory module (decisions.ts) | T5128 |
| T5129 | Migrate JSONL data to brain.db | T5128 |
| T5130 | FTS5 search implementation (all brain.db tables) | T5128 |
| T5156 | brain_memory_links cross-reference management | T5128 |

**Schema** (ADR-009 + SBMU merged):
- `observations` — claude-mem replacement
- `brain_decisions` — ADR-009 §3.2
- `brain_patterns` — ADR-009 §3.2
- `brain_learnings` — ADR-009 §3.2
- `brain_memory_links` — ADR-009 §3.2 cross-references
- `session_summaries` — SBMU addition
- FTS5 virtual tables on observations, decisions, patterns, learnings

### Phase 2: 3-Layer Retrieval & MCP Wiring [T5151] — depends T5150
| ID | Title | Depends |
|----|-------|---------|
| T5131 | memory.search — compact index | — |
| T5132 | memory.timeline — chronological context | T5131 |
| T5133 | memory.fetch — full details for filtered IDs | T5131 |
| T5134 | Token economics tracking | T5131 |
| T5135 | Wire into MCP: memory.search/timeline/fetch + observe | T5131, T5132, T5133 |

### Phase 3: Advanced Search [T5152] — depends T5151
| ID | Title | Depends |
|----|-------|---------|
| T5157 | Integrate SQLite-vec extension into brain.db | — |
| T5158 | Implement embedding generation pipeline | T5157 |
| T5159 | Implement vector similarity search (brain_vec) | T5158 |
| T5160 | Design and implement PageIndex graph tables | — |
| T5161 | Implement PageIndex traversal + graph query API | T5160 |

### Phase 4: Reasoning & Session Integration [T5153] — depends T5152, T5114
| ID | Title | Depends |
|----|-------|---------|
| T5162 | Implement memory.reason.why (causal trace) | — |
| T5163 | Implement memory.reason.similar (similarity search) | — |
| T5137 | Integrate memory observations into session debrief | T5123 |
| T5164 | Wire reasoning + observe ops into MCP memory domain | T5162, T5163, T5137 |
| T5165 | Integration tests for reasoning + debrief integration | T5164 |

### Phase 5: Memory Lifecycle, Validation & Retirement [T5154] — depends T5150-T5153
| ID | Title | Depends |
|----|-------|---------|
| T5166 | Implement memory consolidation | — |
| T5167 | Implement temporal decay | T5166 |
| T5141 | E2E test suite for full session-memory-recovery cycle | — |
| T5142 | Performance benchmarks (FTS5 vs JSONL vs vec vs pageindex) | T5141 |
| T5143 | Migration CLI (cleo migrate claude-mem) | — |
| T5144 | Update vision.md + specs — mark brain.db SHIPPED | — |
| T5145 | Remove claude-mem, update injection to native ops | T5141, T5143 |

---

## Epic C: nexus.db SQLite Architecture [T5057]

**Scope**: nexus.db only. brain.db scope removed (absorbed by T5149).

| ID | Title | Depends |
|----|-------|---------|
| T5059 | Create nexus.db + migrate JSON registry | T5150 (Epic B P1) |
| T5061 | Update nexus docs for three-database architecture | T5059 |
| T5062 | graph-rag tests + nexus integration tests | T5059 |

**Cancelled**: T5058 (absorbed by T5127+T5128+T5129), T5060 (absorbed by T5155+T5130)

---

## Cross-Epic Dependency Graph

```
Epic A (T5112): Session Safety
  T5113 (Context Safety) ──┐
  T5114 (Lifecycle Audit) ─┤── T5115 (Recovery)
                            │
                            ▼
Epic B (T5149): BRAIN Database
  T5150 (Foundation) ──► T5151 (3-Layer) ──► T5152 (Search)
                                                    │
                         T5114 ─────────────► T5153 (Reasoning)
                                                    │
                                             T5154 (Lifecycle/Retire)
                                                    │
Epic C (T5057): nexus.db ──────────────────────────┘
  T5150 ──► T5059 (nexus.db) ──► T5061 (docs) + T5062 (tests)

Epic D (T4573): Vision Revision
  T5026 ──► depends T5149
  T5027 ──► depends T5149
  T4284 ──► depends T5059
```

## Relates Links (Applied)

| From | To | Type | Reason |
|------|----|------|--------|
| T5127 | T5058 | absorbs | Epic B subsumes T5058 brain.db schema |
| T5155 | T5060 | absorbs | Epic B subsumes T5060 Decision Memory |
| T5149 | T5023 | relates | Handoff bug fix enables debrief integration |
| T5112 | T5149 | relates | Session + brain epics are companions |
| T5149 | T5057 | relates | brain.db + nexus.db are companion databases |
| T5144 | T5061 | relates | Both update three-database docs |
| T5123 | T5023 | fixes | T5123 fixes handoff empty data bug |

## Depends Links (Applied)

| Task | Depends On | Reason |
|------|-----------|--------|
| T5026 | T5149 | PORTABLE-BRAIN-SPEC waits for brain.db |
| T5027 | T5149 | CLEO-BRAIN-SPEC waits for brain.db |
| T5059 | T5150 | nexus.db follows brain.db Drizzle patterns |
| T5153 | T5114 | Reasoning needs handoff fix from Epic A |

## Totals
- **Epic A (T5112)**: 3 phases, 14 subtasks
- **Epic B (T5149)**: 5 phases, 28 subtasks
- **Epic C (T5057)**: 3 phases, 3 active subtasks (2 cancelled)
- **Grand total**: ~45 active subtasks across 11 phases in 3 epics
