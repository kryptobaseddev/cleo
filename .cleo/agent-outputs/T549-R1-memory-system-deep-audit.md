# CLEO Memory Architecture Deep Audit

**Task**: T549-R1  
**Date**: 2026-04-13  
**Author**: Research subagent  
**Status**: Complete

---

## 1. Complete Data Flow Diagram (ASCII)

```
╔══════════════════════════════════════════════════════════════════════╗
║                        WRITE PATHS                                   ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  CLI Commands                                                        ║
║  ├─ cleo memory observe <text>  ──────────────────────────────────╮  ║
║  ├─ cleo memory store --type pattern/learning                     │  ║
║  ├─ cleo memory decision-store                                    │  ║
║  └─ cleo memory graph-add                                         │  ║
║                                                                   │  ║
║  Lifecycle Hooks (CAAMP)                                          │  ║
║  ├─ TaskStart    → task-hooks.ts:handleTaskStart                  │  ║
║  ├─ TaskComplete → task-hooks.ts:handleTaskComplete               │  ║
║  ├─ AgentSpawn   → agent-hooks.ts:handleSubagentStart             │  ║
║  ├─ AgentStop    → agent-hooks.ts:handleSubagentStop              │  ║
║  ├─ FileWrite    → file-hooks.ts (captureFiles gate)              │  ║
║  ├─ Notification → notification-hooks.ts                          │  ║
║  ├─ Error        → error-hooks.ts                                 │  ║
║  ├─ ContextSave  → context-hooks.ts                               │  ║
║  ├─ WorkAdd      → work-capture-hooks.ts (captureWork gate)       │  ║
║  └─ WorkUpdate   → work-capture-hooks.ts (captureWork gate)       │  ║
║                                                                   │  ║
║  Session Lifecycle                                                │  ║
║  ├─ session.end → session-hooks.ts → session-memory.ts           │  ║
║  │             → persistSessionMemory → decisions+summary+note   │  ║
║  ├─ session.end → auto-extract.ts:extractFromTranscript           │  ║
║  │             → storeLearning (up to 5 action lines, conf=0.6)  │  ║
║  └─ session.grade → session-grade.ts → storeLearning             │  ║
║                                                                   │  ║
║  Codebase Map                                                     │  ║
║  └─ codebase-map/store.ts → storePattern + storeLearning          │  ║
║                           + observeBrain                          │  ║
║                                                                   │  ║
║  Sticky Note Convert                                              │  ║
║  └─ sticky/convert.ts → observeBrain                             │  ║
║                                                                   ↓  ║
║  ┌───────────────────────────────────────────────────────────────┐   ║
║  │            brain-retrieval.ts:observeBrain()                  │   ║
║  │  1. auto-classify type from text keywords                     │   ║
║  │  2. SHA-256 content-hash dedup (30s window)                   │   ║
║  │  3. cross-db session FK validation                            │   ║
║  │  4. computeObservationQuality() → 0.6 base + bonuses         │   ║
║  │  5. accessor.addObservation() → brain_observations            │   ║
║  │  6. setImmediate: embedText() → brain_embeddings (if vec on)  │   ║
║  │  7. if type=decision → refreshMemoryBridge (fire-forget)      │   ║
║  │  8. if session → autoLinkObservationToTask → brain_links      │   ║
║  │  9. upsertGraphNode + addGraphEdge (autoCapture gate)         │   ║
║  └───────────────────────────────────────────────────────────────┘   ║
║                                                                      ║
║  memory/decisions.ts:storeDecision()                                 ║
║  ├─ dedup: case-insensitive decision text match                      ║
║  ├─ cross-db task/epic FK validation                                 ║
║  ├─ computeDecisionQuality() → conf-mapped base + bonuses            ║
║  ├─ accessor.addDecision() → brain_decisions                         ║
║  └─ upsertGraphNode + addGraphEdge (applies_to task/epic)            ║
║                                                                      ║
║  memory/patterns.ts:storePattern()                                   ║
║  ├─ dedup: normalized text match within same type                    ║
║  ├─ computePatternQuality() → 0.4 base + bonuses                     ║
║  ├─ accessor.addPattern() → brain_patterns                           ║
║  └─ upsertGraphNode (autoCapture gate, fire-forget)                  ║
║                                                                      ║
║  memory/learnings.ts:storeLearning()                                 ║
║  ├─ dedup: case-insensitive insight text match                        ║
║  ├─ computeLearningQuality() → confidence base + bonuses             ║
║  ├─ accessor.addLearning() → brain_learnings                         ║
║  └─ upsertGraphNode (autoCapture gate, fire-forget)                  ║
║                                                                      ║
╠══════════════════════════════════════════════════════════════════════╣
║                        READ PATHS                                    ║
╠══════════════════════════════════════════════════════════════════════╣
║                                                                      ║
║  brain-retrieval.ts:searchBrainCompact()                             ║
║  └─ → searchBrain() → FTS5 (BM25) or LIKE fallback                  ║
║       → quality_score >= 0.3 filter                                  ║
║       → project to compact hits (~50 tokens/hit)                     ║
║       → optional agent post-filter                                   ║
║       → memoryFindHitNext() for progressive disclosure               ║
║                                                                      ║
║  brain-search.ts:hybridSearch()                                      ║
║  ├─ 1. searchBrain() FTS5 (weight 0.5)                               ║
║  ├─ 2. searchSimilar() vec KNN (weight 0.4, fallback → 0.0)          ║
║  └─ 3. graph neighbor expansion (weight 0.1)                         ║
║       → min-max normalize → weighted combine → top-N                 ║
║                                                                      ║
║  brain-retrieval.ts:timelineBrain()                                  ║
║  └─ UNION ALL across all 4 tables via anchor date                    ║
║     → depthBefore + depthAfter entries chronologically               ║
║                                                                      ║
║  brain-retrieval.ts:fetchBrainEntries()                              ║
║  └─ ID-prefix routing to getDecision/getPattern/getLearning/         ║
║     getObservation via BrainDataAccessor                             ║
║                                                                      ║
║  graph-queries.ts:traceBrainGraph()                                  ║
║  └─ Recursive CTE BFS from seed node (bidirectional, max depth=3)    ║
║                                                                      ║
║  graph-queries.ts:relatedBrainNodes()                                ║
║  └─ 1-hop UNION (out edges + in edges), filtered by edgeType         ║
║                                                                      ║
║  graph-queries.ts:contextBrainNode()                                 ║
║  └─ node + inEdges + outEdges + all neighbors (deduplicated)         ║
║                                                                      ║
║  graph-queries.ts:graphStats()                                       ║
║  └─ GROUP BY node_type + edge_type                                   ║
║                                                                      ║
║  brain-reasoning.ts:reason-why / reason-similar                      ║
║  └─ reason.why  → causal task dep chain traversal                    ║
║  └─ reason.similar → fetchBrainEntries + searchSimilar               ║
║                                                                      ║
║  memory-bridge.ts:generateMemoryBridgeContent()                      ║
║  ├─ queryRecentDecisions (ORDER BY created_at DESC LIMIT 5)          ║
║  ├─ queryHighConfidenceLearnings (conf >= 0.3, decay applied)        ║
║  ├─ queryPatterns (type='success' LIMIT 8)                           ║
║  ├─ queryPatterns (type='failure' LIMIT 8)                           ║
║  └─ queryRecentObservations (excl change/hook/file-change types)     ║
║     → writes to .cleo/memory-bridge.md                               ║
║                                                                      ║
║  session-memory.ts:getSessionMemoryContext()                         ║
║  └─ parallel searchBrainCompact (decisions + patterns +              ║
║     observations + learnings) scoped to task/epic                    ║
╚══════════════════════════════════════════════════════════════════════╝
```

---

## 2. brain.db Schema — Full Definition

**File**: `packages/core/src/store/brain-schema.ts`

### Tables

#### `brain_decisions`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Sequential: D001, D002, … |
| `type` | TEXT ENUM | architecture / technical / process / strategic / tactical |
| `decision` | TEXT | Not null |
| `rationale` | TEXT | Not null |
| `confidence` | TEXT ENUM | low / medium / high |
| `outcome` | TEXT ENUM | success / failure / mixed / pending (nullable) |
| `alternatives_json` | TEXT | JSON array (nullable) |
| `context_epic_id` | TEXT | Soft FK to tasks.db (nullable) |
| `context_task_id` | TEXT | Soft FK to tasks.db (nullable) |
| `context_phase` | TEXT | Nullable |
| `quality_score` | REAL | 0.0–1.0; null for legacy; <0.3 excluded from search |
| `created_at` | TEXT | datetime('now') default |
| `updated_at` | TEXT | Nullable |

**Indexes**: type, confidence, outcome, context_epic_id, context_task_id, quality_score

---

#### `brain_patterns`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | P-{4hex} |
| `type` | TEXT ENUM | workflow / blocker / success / failure / optimization |
| `pattern` | TEXT | Not null |
| `context` | TEXT | Not null |
| `frequency` | INTEGER | Default 1, incremented on dedup merge |
| `success_rate` | REAL | Nullable |
| `impact` | TEXT ENUM | low / medium / high (nullable) |
| `anti_pattern` | TEXT | Nullable |
| `mitigation` | TEXT | Nullable |
| `examples_json` | TEXT | JSON array, default '[]' |
| `extracted_at` | TEXT | datetime('now') default |
| `updated_at` | TEXT | Nullable |
| `quality_score` | REAL | 0.0–1.0; null for legacy |

**Indexes**: type, impact, frequency, quality_score

---

#### `brain_learnings`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | L-{4hex} |
| `insight` | TEXT | Not null |
| `source` | TEXT | Not null (e.g. 'manual', 'transcript:ses_xxx') |
| `confidence` | REAL | 0.0–1.0, not null |
| `actionable` | INTEGER (boolean) | Default false |
| `application` | TEXT | Nullable |
| `applicable_types_json` | TEXT | JSON array (nullable) |
| `created_at` | TEXT | datetime('now') default |
| `updated_at` | TEXT | Nullable |
| `quality_score` | REAL | 0.0–1.0; null for legacy |

**Indexes**: confidence, actionable, quality_score

---

#### `brain_observations`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | O-{base36timestamp}-{seq} |
| `type` | TEXT ENUM | discovery / change / feature / bugfix / decision / refactor |
| `title` | TEXT | Not null, max 120 chars |
| `subtitle` | TEXT | Nullable |
| `narrative` | TEXT | Full observation text (nullable) |
| `facts_json` | TEXT | JSON array of strings (nullable) |
| `concepts_json` | TEXT | JSON array (nullable) |
| `project` | TEXT | Nullable |
| `files_read_json` | TEXT | JSON array of file paths (nullable) |
| `files_modified_json` | TEXT | JSON array of file paths (nullable) |
| `source_session_id` | TEXT | Soft FK to sessions (nullable) |
| `source_type` | TEXT ENUM | agent / session-debrief / claude-mem / manual |
| `agent` | TEXT | Nullable — spawned agent provenance (T383/T417) |
| `content_hash` | TEXT | SHA-256 prefix 16 chars for dedup |
| `discovery_tokens` | INTEGER | Cost to produce this observation (nullable) |
| `quality_score` | REAL | 0.0–1.0; null for legacy |
| `created_at` | TEXT | datetime('now') default |
| `updated_at` | TEXT | Nullable |

**Indexes**: type, project, created_at, source_type, source_session_id, content_hash+created_at (composite), type+project (composite), agent, quality_score

**FTS5 table**: `brain_observations_fts` (id, title, narrative) with INSERT/DELETE/UPDATE triggers

---

#### `brain_sticky_notes`
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | |
| `content` | TEXT | Not null |
| `created_at` | TEXT | |
| `updated_at` | TEXT | Nullable |
| `tags_json` | TEXT | JSON array (nullable) |
| `status` | TEXT ENUM | active / converted / archived |
| `converted_to_json` | TEXT | Nullable |
| `color` | TEXT ENUM | yellow / blue / green / red / purple (nullable) |
| `priority` | TEXT ENUM | low / medium / high (nullable) |
| `source_type` | TEXT | Default 'sticky-note' |

**Indexes**: status, created_at, tags_json

---

#### `brain_memory_links`
| Column | Type | Notes |
|--------|------|-------|
| `memory_type` | TEXT ENUM | decision / pattern / learning / observation (composite PK) |
| `memory_id` | TEXT | (composite PK) |
| `task_id` | TEXT | Soft FK to tasks.db (composite PK) |
| `link_type` | TEXT ENUM | produced_by / applies_to / informed_by / contradicts (composite PK) |
| `created_at` | TEXT | |

**Indexes**: task_id, (memory_type, memory_id)

---

#### `brain_page_nodes` (Graph)
| Column | Type | Notes |
|--------|------|-------|
| `id` | TEXT PK | Format: `<type>:<source-id>` |
| `node_type` | TEXT ENUM | decision/pattern/learning/observation/sticky/task/session/epic/file/symbol/concept/summary |
| `label` | TEXT | Max 200 chars |
| `quality_score` | REAL | Default 0.5 |
| `content_hash` | TEXT | SHA-256 16-char prefix (nullable) |
| `last_activity_at` | TEXT | Updated on edge add or quality change |
| `metadata_json` | TEXT | Type-specific JSON blob (nullable) |
| `created_at` | TEXT | |
| `updated_at` | TEXT | Nullable |

**Indexes**: node_type, quality_score, content_hash, last_activity_at

---

#### `brain_page_edges` (Graph)
| Column | Type | Notes |
|--------|------|-------|
| `from_id` | TEXT | (composite PK) |
| `to_id` | TEXT | (composite PK) |
| `edge_type` | TEXT ENUM | (composite PK) — derived_from/produced_by/informed_by/supports/contradicts/supersedes/applies_to/documents/summarizes/part_of/references/modified_by |
| `weight` | REAL | Default 1.0 (0.0–1.0) |
| `provenance` | TEXT | Human-readable note (nullable) |
| `created_at` | TEXT | |

**Indexes**: from_id, to_id, edge_type

---

#### `brain_schema_meta`
| Column | Type | Notes |
|--------|------|-------|
| `key` | TEXT PK | |
| `value` | TEXT | Not null |

Seeded with `schemaVersion = '1.0.0'`

---

#### Virtual Table: `brain_embeddings` (sqlite-vec vec0)
```sql
CREATE VIRTUAL TABLE IF NOT EXISTS brain_embeddings
USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])
```
Only created when sqlite-vec extension loads successfully. Populated by `embedText()` after `observeBrain()` calls.

#### Virtual Tables: FTS5 (brain-search.ts)
- `brain_decisions_fts` (id, decision, rationale)
- `brain_patterns_fts` (id, pattern, context)
- `brain_learnings_fts` (id, insight, source)
- `brain_observations_fts` (id, title, narrative)

All use `content=<main_table>` and AUTO INSERT/DELETE/UPDATE triggers. Created lazily on first search call via `ensureFts5Tables()`.

---

## 3. Memory Write Paths — Every Caller with File:Line

### `observeBrain()` — `packages/core/src/memory/brain-retrieval.ts:542`

**What it does**: Unified save to `brain_observations`. Auto-classifies type, deduplicates by SHA-256 (30s window), validates session FK, computes quality score, writes embedding async, links to active task, auto-populates graph node.

**All callers**:
| Trigger | File | Context |
|---------|------|---------|
| `cleo memory observe <text>` | `packages/cleo/src/cli/commands/memory-brain.ts:186` → dispatch → `cleo.ts:318` | Manual agent capture |
| TaskStart hook | `packages/core/src/hooks/handlers/task-hooks.ts:22-32` | Gated: `autoCapture` |
| TaskComplete hook | `packages/core/src/hooks/handlers/task-hooks.ts:45-56` | Gated: `autoCapture` |
| Agent spawn | `packages/core/src/hooks/handlers/agent-hooks.ts:46-60` | Gated: `autoCapture` |
| Agent stop | `packages/core/src/hooks/handlers/agent-hooks.ts:84-98` | Gated: `autoCapture` |
| File write | `packages/core/src/hooks/handlers/file-hooks.ts:94-105` | Gated: `captureFiles` |
| Notification | `packages/core/src/hooks/handlers/notification-hooks.ts:44-53` | Gated: `autoCapture` |
| Error (tool failure) | `packages/core/src/hooks/handlers/error-hooks.ts:36-49` | Gated: `autoCapture` |
| Context save | `packages/core/src/hooks/handlers/context-hooks.ts:50-65`, `90-105` | Gated: `autoCapture` |
| Work add | `packages/core/src/hooks/handlers/work-capture-hooks.ts:109-119` | Gated: `captureWork` |
| Work update | `packages/core/src/hooks/handlers/work-capture-hooks.ts:142-151` | Gated: `captureWork` |
| Session debrief decisions | `packages/core/src/memory/session-memory.ts:188-194` | Session end only |
| Session debrief summary | `packages/core/src/memory/session-memory.ts:188-194` | Session end only |
| Session note | `packages/core/src/memory/session-memory.ts:188-194` | Session end only |
| Structured summary ingest | `packages/core/src/memory/session-memory.ts:312,323,337` | On summarization.enabled |
| Codebase map — general obs | `packages/core/src/codebase-map/store.ts:49-58`, `116-127` | Map command |
| Sticky note convert | `packages/core/src/sticky/convert.ts:115-124` | cleo sticky convert |
| observeBrain (decision type) triggers bridge refresh internally | `packages/core/src/memory/brain-retrieval.ts:648-653` | Fire-forget |

---

### `storePattern()` — `packages/core/src/memory/patterns.ts:57`

**All callers**:
| Trigger | File | Notes |
|---------|------|-------|
| `cleo memory store --type pattern` | `packages/cleo/src/cli/commands/memory-brain.ts:43-53` | Manual |
| Codebase map | `packages/core/src/codebase-map/store.ts:26-45` | On map run |

---

### `storeLearning()` — `packages/core/src/memory/learnings.ts:48`

**All callers**:
| Trigger | File | Notes |
|---------|------|-------|
| `cleo memory store --type learning` | `packages/cleo/src/cli/commands/memory-brain.ts:56-73` | Manual |
| Transcript extraction | `packages/core/src/memory/auto-extract.ts:104-110` | Session end, up to 5 lines, conf=0.6 |
| Session grade — good grades | `packages/core/src/sessions/session-grade.ts:281-286` | On session.grade |
| Session grade — bad grades | `packages/core/src/sessions/session-grade.ts:292-297` | On session.grade |
| Codebase map — insights | `packages/core/src/codebase-map/store.ts:67-82` | On map run |

---

### `storeDecision()` — `packages/core/src/memory/decisions.ts:80`

**All callers**:
| Trigger | File | Notes |
|---------|------|-------|
| `cleo memory decision-store` | `packages/cleo/src/cli/commands/memory-brain.ts:272-284` | Manual |
| (No automatic lifecycle callers — decisions are intentionally manual-only) | | |

---

### `upsertGraphNode()` — `packages/core/src/memory/graph-auto-populate.ts:75`

**Called from**: `storeDecision()`, `storePattern()`, `storeLearning()`, `observeBrain()` — all fire-and-forget, gated on `brain.autoCapture`.

Also callable directly via `cleo memory graph-add --node-id ... --node-type ... --label ...` which routes through `packages/cleo/src/cli/commands/memory-brain.ts:416-432` → dispatch domain.

---

### `addGraphEdge()` — `packages/core/src/memory/graph-auto-populate.ts:145`

**Called from**:
- `storeDecision()`: decision → task (`applies_to`), decision → epic (`applies_to`)
- `observeBrain()`: observation → session (`produced_by`)
- Directly via `cleo memory graph-add --from ... --to ... --edge-type ...`

---

### Memory Bridge Refresh (`refreshMemoryBridge` / `writeMemoryBridge`)

**All triggers**:
| Trigger | File | Notes |
|---------|------|-------|
| `cleo refresh-memory` | `packages/cleo/src/cli/commands/refresh-memory.ts:17-18` | Manual |
| session.start hook | `packages/core/src/hooks/handlers/session-hooks.ts:35` | via `maybeRefreshMemoryBridge` |
| session.end hook | `packages/core/src/hooks/handlers/session-hooks.ts:80` | via `maybeRefreshMemoryBridge` |
| task.complete hook | `packages/core/src/hooks/handlers/task-hooks.ts:59` | via `maybeRefreshMemoryBridge` |
| `cleo init` | `packages/core/src/init.ts:738` | On project init |
| `cleo upgrade` | `packages/core/src/upgrade.ts:861` | On upgrade |
| observeBrain (type=decision) | `packages/core/src/memory/brain-retrieval.ts:648-653` | Fire-forget |
| sessions index.ts | `packages/core/src/sessions/index.ts:283-284` | After session start |
| dispatch session domain | `packages/cleo/src/dispatch/domains/session.ts:274-275` | On session end |

---

## 4. Memory Read Paths — Every Caller with File:Line

### `searchBrainCompact()` — Layer 1 (FTS5 index, ~50 tokens/hit)
- `packages/core/src/memory/brain-retrieval.ts:154`
- Called by: `session-memory.ts:getSessionMemoryContext()`, `memory-bridge.ts:generateContextAwareContent()`
- Dispatch: `cleo memory find <query>` (no `--type`) → `memory/find` operation

### `searchBrain()` — FTS5 + LIKE search across all 4 tables
- `packages/core/src/memory/brain-search.ts:280`
- Called by: `searchBrainCompact()`, `hybridSearch()`
- Filters: quality_score >= 0.3; BM25 ranking when FTS5 available

### `hybridSearch()` — FTS5 + Vector + Graph
- `packages/core/src/memory/brain-search.ts:606`
- Called by: `memory-bridge.ts:generateContextAwareContent()`, `brain-reasoning.ts`
- Dispatch: `cleo memory search-hybrid <query>` → `memory/search.hybrid`
- Weights: FTS5=0.5, Vec=0.4 (falls back to 0.0+redistribution), Graph=0.1

### `timelineBrain()` — Chronological context
- `packages/core/src/memory/brain-retrieval.ts:278`
- Dispatch: `cleo memory timeline <anchor>` → `memory/timeline`

### `fetchBrainEntries()` — Batch fetch by IDs
- `packages/core/src/memory/brain-retrieval.ts:409`
- Dispatch: `cleo memory fetch <ids>` → `memory/fetch`

### `traceBrainGraph()` — BFS traversal (recursive CTE)
- `packages/core/src/memory/graph-queries.ts:138`
- Dispatch: `cleo memory trace <nodeId>` → `memory/graph.trace`

### `relatedBrainNodes()` — 1-hop neighbors
- `packages/core/src/memory/graph-queries.ts:212`
- Dispatch: `cleo memory related <nodeId>` → `memory/graph.related`

### `contextBrainNode()` — 360-degree node view
- `packages/core/src/memory/graph-queries.ts:287`
- Dispatch: `cleo memory context <nodeId>` → `memory/graph.context`

### `graphStats()` — Aggregate counts
- `packages/core/src/memory/graph-queries.ts:393`
- Dispatch: `cleo memory graph-stats` → `memory/graph.stats`

### `searchDecisions()` — Decision search (LIKE based)
- `packages/core/src/memory/decisions.ts:237`
- Dispatch: `cleo memory decision-find [query]` → `memory/decision.find`

### `searchPatterns()` — Pattern search
- `packages/core/src/memory/patterns.ts:163`
- Dispatch: `cleo memory find --type pattern` → `memory/pattern.find`

### `searchLearnings()` — Learning search
- `packages/core/src/memory/learnings.ts:142`
- Dispatch: `cleo memory find --type learning` → `memory/learning.find`

### Memory Bridge Content Queries (`memory-bridge.ts`)
All raw SQL via `getBrainNativeDb()`:
- `queryRecentDecisions()` — `SELECT id, decision, created_at FROM brain_decisions ORDER BY created_at DESC LIMIT 5`
- `queryHighConfidenceLearnings()` — `WHERE confidence >= 0.3 ORDER BY confidence DESC`, then client-side decay filter (effective conf >= 0.6)
- `queryPatterns()` — `WHERE type='success'/'failure' ORDER BY extracted_at DESC`
- `queryRecentObservations()` — `WHERE type != 'change' AND title NOT LIKE 'File changed:%'...` (excludes noise types)

### `getSessionMemoryContext()` — Session enrichment
- `packages/core/src/memory/session-memory.ts:362`
- Runs 4 parallel `searchBrainCompact()` calls (decisions/patterns/observations/learnings)
- Used by briefing/handoff to enrich context

---

## 5. Memory Lifecycle

### Temporal Decay
- **Function**: `applyTemporalDecay()` — `packages/core/src/memory/brain-lifecycle.ts:38`
- **Formula**: `new_confidence = confidence * decayRate ^ daysSinceUpdate`
- **Defaults**: `decayRate=0.995`, `olderThanDays=30`
- **Scope**: `brain_learnings` table ONLY (not decisions, patterns, or observations)
- **Trigger**: Manual via `cleo brain maintenance`, or as step 1 of `runBrainMaintenance()`
- **NOT automatic**: No cron or lifecycle hook triggers decay. It only runs when explicitly called.

**Memory Bridge decay (separate, in `memory-bridge.ts:queryHighConfidenceLearnings()`)**:
- `effectiveConfidence = confidence * 0.5 ^ (ageDays / 90)`
- Threshold: effectiveConfidence >= 0.6 to appear in bridge
- Uses `updated_at` if present (referenced memories decay slower)
- This is READ-time decay for display purposes only, does not write to DB

### Memory Consolidation
- **Function**: `consolidateMemories()` — `packages/core/src/memory/brain-lifecycle.ts:232`
- **Scope**: `brain_observations` older than 90 days (default)
- **Algorithm**: Greedy Jaccard clustering by keyword overlap (threshold=0.3), min cluster size=3
- **Output**: Creates summary observation + marks originals with `[ARCHIVED]` prefix in narrative
- **Trigger**: Manual via `cleo brain maintenance`, step 2 of `runBrainMaintenance()`

### Eviction / Forgetting
- **No hard eviction**. There is no DELETE path that removes entries permanently from the main typed tables.
- Consolidation "archives" observations by text prefix — rows remain in DB.
- Quality score filter (>= 0.3) acts as soft exclusion from search results.
- `cross-db-cleanup.ts:reconcileOrphanedRefs()` nullifies stale soft FKs (cross-db integrity only).

### Quality Score Gating
- All search paths apply `quality_score >= 0.3` (constant `QUALITY_SCORE_THRESHOLD`)
- Scores are computed AT INSERT TIME only, not recalculated
- Scores below 0.3 remain in DB but are invisible to search

---

## 6. Session/Task Integration with Memory

### Task Focus and Memory Surfacing
- When `observeBrain()` creates an observation and a session is active, `autoLinkObservationToTask()` fires immediately (fire-and-forget)
- It calls `sessionStatus()` to find the current task via `session.taskWork.taskId`
- Creates a `brain_memory_links` row with `linkType='produced_by'`
- No filtering at read time based on current task focus (only the write-time link is created)

### Session Scope Filtering
- `getSessionMemoryContext()` uses `scope.rootTaskId` or `scope.epicId` as the search query
- This is FTS5 text search, not a structured filter — searches all tables for the task/epic ID string
- Context-aware memory bridge (`brain.memoryBridge.contextAware=true`) builds query from `scope + currentTaskId` and uses `hybridSearch()`
- Standard mode does NOT filter by current session/task

### Memory Bridge Selection
- Decisions: no filter, just recency (ORDER BY created_at DESC)
- Learnings: confidence >= 0.3 raw, then decay applied client-side; effective threshold = 0.6
- Patterns: type='success' (follow) and type='failure' (avoid); recency ordered
- Observations: excludes type='change' and noise titles (File changed:, Task start:, Task complete:, [hook])
- No session/task scoping in standard mode

---

## 7. Current Type System Assessment

### Semantic vs Episodic vs Procedural Mapping

| CLEO Type | Cognitive Category | Notes |
|-----------|-------------------|-------|
| `brain_observations` | Episodic memory | "What happened during session X" — autobiographical |
| `brain_learnings` | Semantic memory | "Facts and insights that persist and generalize" |
| `brain_decisions` | Semantic memory | "Architectural choices with rationale" |
| `brain_patterns` | Procedural memory | "How to do things / what to avoid" |
| `brain_sticky_notes` | Working memory | Ephemeral capture before classification |
| `brain_page_nodes/edges` | Graph/associative | Relational index across all types |

### Missing Distinctions

**Short-term vs Long-term**: No explicit field. The closest proxy is:
- Sticky notes → working memory (explicit ephemeral status)
- Temporal decay only on `brain_learnings` — everything else is permanent until manually purged
- No TTL, no retention policy per type

**Verified vs Unverified**: No explicit field on any table. `quality_score` is the only signal:
- High quality_score (~0.9+) = high-confidence decisions
- No boolean `verified` flag
- No distinction between agent-written and human-verified entries

**Primary Key Organization**: No structural tier separation — all four typed tables are peers, none is marked as "authoritative" vs "draft."

**Source type discrimination** (partial):
- `source_type` on `brain_observations`: agent / session-debrief / claude-mem / manual
- `agent` on `brain_observations`: spawned agent provenance name
- No source tracking on decisions, patterns, or learnings

---

## 8. Full BrainConfig Shape (packages/contracts/src/config.ts)

```typescript
interface BrainConfig {
  autoCapture: boolean;       // Gate all lifecycle hook writes. Default: true
  captureFiles: boolean;      // Gate file-change observations. Default: false
  captureWork: boolean;       // Gate task.add/update capture. Default: false
  
  embedding: {
    enabled: boolean;         // Enable vector embeddings. Default: false
    provider: 'local' | 'openai'; // Default: 'local'
  };
  
  memoryBridge: {
    autoRefresh: boolean;     // Auto-regenerate memory-bridge.md. Default: true
    contextAware: boolean;    // Scope-aware hybrid search for bridge. Default: false
    maxTokens: number;        // Token budget for bridge content. Default: 2000
  };
  
  summarization: {
    enabled: boolean;         // LLM session summarization. Default: false
  };
}
```

`BrainConfig` is optional on `CleoConfig` (`brain?: BrainConfig`). When absent, all features use defaults.

---

## 9. CAAMP Adapter Memory Differences

### Finding: No Adapter-Specific Memory Logic

All CAAMP adapters (claude-code, cursor, gemini-cli, codex, opencode, kimi) have been audited. Memory operations are handled entirely in `packages/core/` through the hook system. **No adapter differentiates memory behavior**.

The adapters share:
- The same CANT hook registration pipeline
- The same `isAutoCaptureEnabled()` gate in handler-helpers.ts
- The same `observeBrain()` calls in handler files

**Claude Code adapter** (`packages/adapters/src/providers/claude-code/`): Installs hook handlers via `hooks.ts`, manages CLAUDE.md injection via `install.ts`. No memory-specific logic beyond the shared hook pipeline. The adapter comment references "brain observation plugin registration" but this refers to the CAAMP hook wiring, not a distinct memory path.

**Cursor adapter** (`packages/adapters/src/providers/cursor/`): No memory-specific logic found.

**All other adapters**: Same pattern.

---

## 10. What's Missing for Tiered/Typed Memory

Based on the audit, the following gaps exist for a redesigned tiered memory architecture:

### Gap 1: No Short-Term / Long-Term Distinction
- All typed tables persist indefinitely unless maintenance is run
- No TTL, no automatic promotion from working → short-term → long-term
- Sticky notes are the only "working memory" tier but don't auto-promote

### Gap 2: No Verified/Unverified Flag
- No `verified` boolean or `source_reliability` field
- Quality score approximates this but conflates content richness with reliability
- No way to distinguish agent-generated (possibly hallucinated) vs human-confirmed facts

### Gap 3: Decay Only Affects Learnings
- `applyTemporalDecay()` targets `brain_learnings` only
- Decisions and patterns never decay — they persist forever with full quality score
- Old decisions that have been superseded remain indexed unless manually archived

### Gap 4: Graph is Sparsely Populated
- Graph auto-population requires `brain.autoCapture = true`
- Only `storeDecision()`, `storePattern()`, `storeLearning()`, and `observeBrain()` populate graph nodes
- Edges are minimal: decision→task (`applies_to`), observation→session (`produced_by`)
- No cross-type edges (e.g., learning→decision `informed_by`, observation→pattern `supports`)

### Gap 5: No Memory Tier Routing
- All writes go to the same flat typed tables regardless of source quality
- Auto-extracted transcript learnings (confidence=0.6) are indistinguishable from manually written learnings at storage level

### Gap 6: FTS5 Search Does Not Cover All Fields
- `brain_decisions_fts` indexes: id, decision, rationale (NOT alternatives_json, context_phase)
- `brain_patterns_fts` indexes: id, pattern, context (NOT anti_pattern, mitigation)
- `brain_learnings_fts` indexes: id, insight, source (NOT application)
- `brain_observations_fts` indexes: id, title, narrative (NOT facts_json, concepts_json)

### Gap 7: Decay Is Not Automatic
- `applyTemporalDecay()` must be explicitly called via `cleo brain maintenance`
- No session-end trigger, no scheduled hook
- The memory-bridge applies read-time decay for display but does not write it back

### Gap 8: No Cross-Table Contradiction Detection
- `contradicts` edge type exists in schema but no code automatically detects contradictions
- Two conflicting decisions/learnings will both appear in search results with equal weight

---

## 11. Key File Locations Summary

| Area | File |
|------|------|
| Schema (all tables) | `packages/core/src/store/brain-schema.ts` |
| DB singleton + vec extension | `packages/core/src/store/brain-sqlite.ts` |
| CRUD accessor | `packages/core/src/store/brain-accessor.ts` |
| Observations write | `packages/core/src/memory/brain-retrieval.ts:542` |
| Patterns write | `packages/core/src/memory/patterns.ts:57` |
| Learnings write | `packages/core/src/memory/learnings.ts:48` |
| Decisions write | `packages/core/src/memory/decisions.ts:80` |
| Graph population | `packages/core/src/memory/graph-auto-populate.ts` |
| FTS5 search | `packages/core/src/memory/brain-search.ts` |
| Hybrid search | `packages/core/src/memory/brain-search.ts:606` |
| 3-layer retrieval | `packages/core/src/memory/brain-retrieval.ts` |
| Graph traversal | `packages/core/src/memory/graph-queries.ts` |
| Quality scoring | `packages/core/src/memory/quality-scoring.ts` |
| Temporal decay | `packages/core/src/memory/brain-lifecycle.ts` |
| Memory bridge | `packages/core/src/memory/memory-bridge.ts` |
| Auto-extract (disabled) | `packages/core/src/memory/auto-extract.ts` |
| Session memory | `packages/core/src/memory/session-memory.ts` |
| Maintenance runner | `packages/core/src/memory/brain-maintenance.ts` |
| BrainConfig contract | `packages/contracts/src/config.ts:197` |
| CLI commands | `packages/cleo/src/cli/commands/memory-brain.ts` |
| Hook handlers | `packages/core/src/hooks/handlers/{task,agent,session,file,error,context,work-capture,notification}-hooks.ts` |
