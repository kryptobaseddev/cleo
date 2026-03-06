# BRAIN Phase 3-5 Research Report

**Date**: 2026-03-05
**Researcher**: brain-researcher agent
**Epic**: T5149 (BRAIN Database & Cognitive Infrastructure)
**Status**: Phases 1-2 DONE, Phases 3-5 PENDING

---

## 1. Current brain.db Schema (8 Tables + FTS5 + vec0)

### Core Tables (Phase 1-2, all DONE)
| Table | Purpose | Rows (approx) |
|-------|---------|---------------|
| `brain_decisions` | Architecture/technical/process decisions | D-prefixed IDs |
| `brain_patterns` | Workflow/blocker/success/failure patterns | P-prefixed IDs |
| `brain_learnings` | Insights with confidence scores | L-prefixed IDs |
| `brain_observations` | General observations (replaces claude-mem) | O-/CM-prefixed IDs |
| `brain_sticky_notes` | Ephemeral quick capture notes | Active/converted/archived |
| `brain_memory_links` | Cross-references between brain entries and tasks | Composite PK |
| `brain_schema_meta` | Schema version tracking | Key-value |

### Graph Tables (Phase 3 schema, DEFINED but no business logic)
| Table | Purpose | Status |
|-------|---------|--------|
| `brain_page_nodes` | Graph nodes: task, doc, file, concept | Schema in brain-schema.ts, tests pass, NO accessor/domain wiring |
| `brain_page_edges` | Directed edges: depends_on, relates_to, implements, documents | Schema in brain-schema.ts, tests pass, NO accessor/domain wiring |

### Virtual Tables
| Table | Type | Status |
|-------|------|--------|
| `brain_decisions_fts` | FTS5 | DONE - content-sync triggers wired |
| `brain_patterns_fts` | FTS5 | DONE - content-sync triggers wired |
| `brain_learnings_fts` | FTS5 | DONE - content-sync triggers wired |
| `brain_observations_fts` | FTS5 | DONE - content-sync triggers wired |
| `brain_embeddings` | vec0 (FLOAT[384]) | CREATED on init if sqlite-vec loads, NO population logic |

### Key Files
- `src/store/brain-schema.ts` — Drizzle schema (all 8 tables + PageIndex)
- `src/store/brain-sqlite.ts` — SQLite init, sqlite-vec loading, vec0 creation
- `src/store/brain-accessor.ts` — CRUD for decisions/patterns/learnings/observations/sticky/links (NO PageIndex accessors)
- `src/core/memory/brain-retrieval.ts` — 3-layer retrieval (search/timeline/fetch/observe)
- `src/core/memory/brain-search.ts` — FTS5 search with LIKE fallback
- `src/dispatch/domains/memory.ts` — MCP domain handler (17 ops: 12q + 5m)

---

## 2. Phase 3: Advanced Search (T5152)

### Task Hierarchy
- **T5152** — Phase 3: Advanced Search (SQLite-vec + PageIndex) [PENDING]
  - **T5157** — sqlite-vec extension integration
  - **T5158** — Embedding generation pipeline
  - **T5159** — Vector similarity search ops
  - **T5160** — PageIndex graph tables
  - **T5161** — Hybrid search (FTS5 + vec + graph merge)

### What Already Exists
1. **sqlite-vec dependency**: `"sqlite-vec": "^0.1.7-alpha.2"` in package.json
2. **Extension loading**: `brain-sqlite.ts:loadBrainVecExtension()` — loads via `require('sqlite-vec')`, tracked by `_vecLoaded` flag
3. **vec0 table creation**: `brain-sqlite.ts:initializeBrainVec()` — creates `brain_embeddings USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384])`
4. **Tests pass**: `brain-vec.test.ts` — 5 tests (extension load, table creation, version check, insert/query, cleanup)
5. **PageIndex schema**: `brain-schema.ts` — `brainPageNodes` and `brainPageEdges` tables defined with Drizzle
6. **PageIndex tests pass**: `brain-pageindex.test.ts` — 6 tests (table creation, indexes, CRUD, PK constraints)
7. **`isBrainVecLoaded()` utility**: Exported from brain-sqlite.ts for conditional code paths

### What Is MISSING for Phase 3

#### A. Embedding Generation Pipeline (T5158) — THE HARD PART
**Problem**: How do text entries get turned into 384-dimension float vectors?

**Options documented in specs**:
- Local model (no external API calls needed, works offline)
- API call to embedding service (requires network, costs money)

**Current state**: ZERO embedding generation code exists. The vec0 table is created but never populated.

**Decision needed**: Which embedding model to use?
- `all-MiniLM-L6-v2` (384 dims) — matches current vec0 dimension
- ONNX Runtime for local inference (no API dependency)
- Or: use an external embedding API (OpenAI, Voyage, etc.)

**Risk**: HIGH. This is the single biggest technical unknown. Options:
1. **ONNX Runtime + all-MiniLM-L6-v2**: Pure local, ~30MB model, ~50ms/embed. Requires `onnxruntime-node` npm package.
2. **Transformers.js**: Browser/Node.js ML runtime from HuggingFace. Requires `@xenova/transformers` or `@huggingface/transformers`.
3. **External API**: Claude/OpenAI embeddings. Network dependency, token cost, but simplest.
4. **Lazy/deferred**: Generate embeddings only on first similarity query (amortize cost).

**Recommendation**: Option 1 (ONNX) or Option 2 (Transformers.js) for offline-first. The spec says "no external dependencies" rationale for SQLite-vec choice, suggesting local inference is preferred.

#### B. Vector Similarity Search Ops (T5159)
**What's needed**:
- `memory.similar` or `reason.similar` MCP operation
- SQL: `SELECT id FROM brain_embeddings WHERE embedding MATCH ? ORDER BY distance LIMIT ?`
- sqlite-vec supports KNN queries via `MATCH` on vec0 tables
- Need to embed the query text, then search

**Files to create/modify**:
- `src/core/memory/brain-embedding.ts` — new file: embed text -> Float32Array
- `src/core/memory/brain-similarity.ts` — new file: similarity search using vec0
- `src/dispatch/domains/memory.ts` — wire new ops

#### C. PageIndex Graph Operations (T5160)
**Schema exists** but zero business logic. Needs:
- `BrainDataAccessor` methods for PageIndex CRUD (addNode, addEdge, getNeighbors, traverseGraph)
- Population strategy: When/how do nodes and edges get created?
  - On task creation? On observation save? On session end?
  - Manually via `memory.link`?
- Graph traversal queries: shortest path, connected components, neighborhood
- Integration with search results (graph boost for structurally related entries)

**Current node types**: `task`, `doc`, `file`, `concept`
**Current edge types**: `depends_on`, `relates_to`, `implements`, `documents`

#### D. Hybrid Search Merge (T5161)
**Concept**: Combine FTS5 keyword search + vec0 similarity + graph traversal into unified ranked results.

**Architecture** (from ADR-009 Section 4.2):
```
Query
  |-- Vectorless RAG (structural: FTS5 + hierarchy + labels)
  |-- Vector RAG (semantic: SQLite-vec cosine similarity)
  --> Merged Results (weighted by source confidence)
```

**Implementation needs**:
- Score normalization across search methods
- Configurable weights (FTS5 weight, vec weight, graph weight)
- Graceful fallback when sqlite-vec unavailable (FTS5 only)

---

## 3. Phase 4: Reasoning & Session Integration (T5153)

### Task Hierarchy
- **T5153** — Phase 4: Reasoning & Session Integration [PENDING, blocked by T5152]
  - **T5137** — memory.reason.why (causal trace)
  - **T5162** — memory.reason.similar (similarity via SQLite-vec)
  - **T5163** — Memory-session bridge (observations into session debrief)
  - **T5165** — Reasoning domain placement research
  - **T5171** — Wire reasoning + observe ops into MCP memory domain

### Dependencies
- Depends on T5152 (Phase 3 — needs vec for similarity)
- Depends on T5114 (Session Lifecycle Flow Audit — DONE)

### What's Needed

#### A. Reasoning Operations (T5137, T5162)

**`reason.why` (Causal Trace)**:
- Trace dependency chains to find root cause of blocked/failed tasks
- Uses existing task dependency graph + brain_memory_links
- Query: "Why is T5152 blocked?" -> traces deps, finds unresolved items
- Implementation: graph traversal on tasks.db deps + brain_decisions context
- **Difficulty**: MEDIUM — mostly graph traversal over existing data

**`reason.similar` (Similarity Detection)**:
- Find tasks/observations similar to a given entry
- Uses SQLite-vec embeddings from Phase 3
- Fallback: FTS5 keyword overlap + label Jaccard similarity
- **Difficulty**: EASY if Phase 3 embeddings work, MEDIUM for fallback

**`reason.impact` (Impact Prediction)**:
- Reverse dependency analysis: "What breaks if I change X?"
- Uses task dependency graph (already exists) + pattern memory
- **Difficulty**: MEDIUM — reverse traversal + pattern lookup

**`reason.timeline` (Historical Analysis)**:
- Statistical analysis of historical task completion patterns
- "How long did similar research tasks take?" (historical context, not estimates)
- **Difficulty**: EASY — aggregation queries on tasks.db

#### B. Domain Placement (T5165) — DEFERRED per ADR-009 Section 2.5

**Current decision**: Reasoning domain placement is DEFERRED to a future RCSD cycle.

**Options** (from ADR-009):
1. Subdomain of `memory` (reasoning = querying stored knowledge)
2. Cross-cutting across `tasks`, `memory`, `orchestrate`
3. Subdomain of `check` (reasoning = analysis)
4. New `reason` domain

**Interim approach**: Reasoning ops documented but without committed domain. Existing reasoning-adjacent ops stay where they are (task deps in `tasks`, waves in `orchestrate`, similarity in `nexus`).

**Practical implication for implementation**: Can wire as `memory.reason.*` initially and move later if the R&C cycle decides differently. The dispatch layer makes this a registry-only change.

#### C. Memory-Session Bridge (T5163)
- Auto-save observations at session end (debrief → brain_observations)
- Include key decisions made during session
- Populate session handoff with relevant brain entries
- **Difficulty**: EASY — hook into session.end flow, call observeBrain()

#### D. MCP Wiring (T5171)
- Add new operations to memory domain registry
- Wire through dispatch/engines layer
- Add to gateway operation counts
- **Difficulty**: EASY — mechanical wiring following existing patterns

---

## 4. Phase 5: Memory Lifecycle, Validation & Retirement (T5154)

### Task Hierarchy
- **T5154** — Phase 5: Memory Lifecycle, Validation & Retirement [PENDING, blocked by T5152 + T5153]
  - **T5141** — Memory consolidation (compress old memories)
  - **T5142** — Temporal decay (age-based weakening)
  - **T5143** — claude-mem migration CLI
  - **T5144** — E2E test suite
  - **T5145** — Performance benchmarks
  - **T5166** — Update specs and vision docs
  - **T5167** — Remove claude-mem, update hooks to native ops

### What's Needed

#### A. Memory Consolidation (T5141)
- Compress old observations into summaries
- Merge similar patterns (deduplicate)
- Archive low-confidence learnings
- Create consolidated summary entries
- **Difficulty**: MEDIUM — needs consolidation algorithm + new `memory.consolidate` op

#### B. Temporal Decay (T5142)
- Age-based confidence weakening for learnings
- Reduce relevance scores for old observations
- Configurable decay rate
- **Difficulty**: EASY — SQL UPDATE with date-based formula

#### C. claude-mem Migration CLI (T5143)
- **ALREADY EXISTS**: `src/core/memory/claude-mem-migration.ts`
- Migrates from `~/.claude-mem/claude-mem.db` to brain.db
- Imports observations (CM- prefix), decisions (CMD-), learnings (CML-)
- Idempotent, batch-based, FTS5 rebuild after
- **Status**: Code exists, needs CLI command wiring (`cleo migrate claude-mem`)
- **Difficulty**: EASY — just wire existing code to CLI

#### D. E2E Test Suite (T5144)
- End-to-end tests covering full brain.db lifecycle
- Observation → Search → Timeline → Fetch → Consolidate
- Embedding generation → Similarity search
- PageIndex graph operations
- **Difficulty**: MEDIUM — comprehensive but straightforward

#### E. Performance Benchmarks (T5145)
- FTS5 vs LIKE search speed
- vec0 similarity vs FTS5 keyword search
- PageIndex graph traversal performance
- Memory consolidation speed
- **Difficulty**: EASY — benchmark harness + timing

#### F. Spec Updates (T5166)
- Update CLEO-BRAIN-SPECIFICATION.md storage references
- Update cognitive-architecture.mdx (vectorless + vector augmentation)
- Update vision.md with Phase 3-5 status
- **Difficulty**: EASY — documentation

#### G. claude-mem Retirement (T5167) — THE CRITICAL ONE
**What claude-mem currently provides**:
- Plugin at `~/.claude/plugins/marketplaces/thedotmack/`
- SQLite database at `~/.claude-mem/claude-mem.db` (~30MB, 5,059+ observations)
- MCP tools: `search()`, `timeline()`, `get_observations()`, `save_observation()`
- 6 hook types: SessionStart x3, UserPromptSubmit, PostToolUse, Stop x2
- Chroma vector DB for semantic search

**What BRAIN replaces**:
- brain.db observations table replaces claude-mem.db observations
- `memory.find` replaces claude-mem `search()`
- `memory.timeline` replaces claude-mem `timeline()`
- `memory.fetch` replaces claude-mem `get_observations()`
- `memory.observe` replaces claude-mem `save_observation()`

**Retirement steps**:
1. Ensure all claude-mem data migrated (T5143 — migration code exists)
2. Update Claude hooks to use CLEO native ops instead of claude-mem MCP tools
3. Disable/remove claude-mem plugin
4. Verify no data loss
5. Update AGENTS.md / CLAUDE.md references

**Risk**: MEDIUM — hooks integration is the tricky part. Need to ensure the CLEO MCP server's `memory.observe` can be called from hooks with the same reliability as claude-mem's HTTP bridge.

---

## 5. Dependencies Between Phases

```
Phase 1 (DONE) ──> Phase 2 (DONE) ──> Phase 3 (T5152) ──> Phase 4 (T5153) ──> Phase 5 (T5154)
                                            |                    |
                                            |                    +-- Also depends on T5114 (DONE)
                                            |
                                            +-- Deps: T5151 (DONE)
```

**Critical path**: Phase 3 (embedding pipeline) blocks everything downstream.

**Phase 3 internal ordering**:
1. T5157 (sqlite-vec integration) — DONE (extension loads, vec0 created)
2. T5158 (embedding generation) — BLOCKS ALL OTHERS
3. T5160 (PageIndex graph) — independent of embeddings, can parallel
4. T5159 (vector similarity search) — needs T5158
5. T5161 (hybrid search merge) — needs T5158 + T5160

**Phase 4** can start partially before Phase 3 completes:
- `reason.why` (causal trace) only needs task deps + brain links — NO vec dependency
- `reason.timeline` (historical analysis) only needs tasks.db — NO vec dependency
- `reason.similar` needs vec from Phase 3
- Memory-session bridge (T5163) is independent of Phase 3

**Phase 5** truly needs everything:
- Consolidation and decay need all memory types populated
- Benchmarks need all search methods working
- claude-mem retirement needs native ops fully functional

---

## 6. Risk Assessment

### HIGH RISK
| Item | Risk | Mitigation |
|------|------|------------|
| **Embedding generation (T5158)** | Biggest unknown — which model, how to run locally, binary size, inference speed | Prototype with Transformers.js first; fallback to API-based if local inference too heavy |
| **ONNX/Transformers.js binary size** | Could add 50-200MB to package | Make optional dependency; lazy-load; or download model on first use |
| **Node.js 24+ compatibility** | sqlite-vec is alpha (0.1.7-alpha.2); node:sqlite is experimental | Already tested and working; vec tests pass |

### MEDIUM RISK
| Item | Risk | Mitigation |
|------|------|------------|
| **Hybrid search score normalization** | Different search methods produce incomparable scores | Use percentile ranking instead of raw scores |
| **claude-mem retirement hooks** | Hook integration may differ from claude-mem's HTTP bridge | Test hooks thoroughly before cutting over |
| **Reasoning domain placement** | ADR-009 defers this; may need redesign later | Wire as `memory.reason.*` now, plan registry move |
| **PageIndex population strategy** | When/how to create graph nodes automatically | Start manual, add auto-population incrementally |

### LOW RISK (Straightforward)
| Item | Why Low Risk |
|------|-------------|
| PageIndex schema | Already defined and tested |
| claude-mem migration | Code already exists and works |
| FTS5 search | Already working with triggers |
| Memory consolidation | Standard SQL aggregation |
| Temporal decay | Simple date-based UPDATE |
| Performance benchmarks | Standard timing harness |
| Spec updates | Documentation only |
| MCP wiring | Mechanical, follows existing patterns |

---

## 7. Atomic Task Decomposition

### Phase 3 Tasks (ordered by dependency)

#### Wave 3A: Independent foundations (can parallel)
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5158a: Embedding model selection & prototype** | `src/core/memory/brain-embedding.ts` (new) | Choose model, create embedText() function, add npm dep | HARD |
| **T5160a: PageIndex accessor CRUD** | `src/store/brain-accessor.ts` (extend) | Add addNode, addEdge, getNeighbors, removeNode, removeEdge | EASY |
| **T5160b: PageIndex domain wiring** | `src/dispatch/domains/memory.ts`, `src/core/memory/engine-compat.ts` | Wire graph ops to MCP | EASY |

#### Wave 3B: Depends on 3A
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5158b: Embedding population pipeline** | `src/core/memory/brain-embedding.ts`, `src/store/brain-accessor.ts` | On observe/store, auto-embed and insert into brain_embeddings | MEDIUM |
| **T5159: Vector similarity search** | `src/core/memory/brain-similarity.ts` (new) | KNN query via vec0, return ranked results | MEDIUM |

#### Wave 3C: Depends on 3B
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5161: Hybrid search merge** | `src/core/memory/brain-search.ts` (extend) | Combine FTS5 + vec + graph scores, normalize, return merged | MEDIUM |

### Phase 4 Tasks (ordered by dependency)

#### Wave 4A: Independent (can start before Phase 3 completes)
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5137: reason.why causal trace** | `src/core/memory/brain-reasoning.ts` (new) | Dependency chain traversal + brain_decisions lookup | MEDIUM |
| **T5163: Memory-session bridge** | `src/core/sessions/session-debrief.ts` (extend) | Auto-observe at session.end, populate handoff | EASY |

#### Wave 4B: Depends on Phase 3 embeddings
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5162: reason.similar** | `src/core/memory/brain-reasoning.ts` (extend) | Vec similarity + FTS5 fallback | EASY (if T5158 done) |
| **T5165: Reasoning domain research** | `.cleo/rcasd/T5165/` (research artifact) | R&C on domain placement | RESEARCH |

#### Wave 4C: Wiring
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5171: MCP wiring for reasoning ops** | `src/dispatch/domains/memory.ts`, registry | Wire reason.* ops to MCP gateway | EASY |

### Phase 5 Tasks (ordered by dependency)

#### Wave 5A: Independent
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5142: Temporal decay** | `src/core/memory/brain-lifecycle.ts` (new) | SQL UPDATE with age-based confidence decay | EASY |
| **T5143: claude-mem migration CLI** | `src/cli/commands/migrate.ts` (extend) | Wire existing migrateClaudeMem() to CLI | EASY |
| **T5166: Spec updates** | `docs/specs/*.md`, `docs/concepts/*.mdx` | Documentation updates | EASY |

#### Wave 5B: Depends on 5A
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5141: Memory consolidation** | `src/core/memory/brain-lifecycle.ts` (extend) | Compress old observations, merge patterns | MEDIUM |
| **T5145: Performance benchmarks** | `dev/benchmark-brain.ts` (new) | Timing harness for all search methods | EASY |

#### Wave 5C: Integration
| Task | Files | Description | Difficulty |
|------|-------|-------------|------------|
| **T5144: E2E test suite** | `tests/e2e/brain-lifecycle.test.ts` (new) | Full lifecycle testing | MEDIUM |
| **T5167: claude-mem retirement** | `.claude/hooks/`, AGENTS.md, CLAUDE.md | Switch hooks, remove plugin | MEDIUM |

---

## 8. Package Dependencies Needed

### Currently installed
- `sqlite-vec: ^0.1.7-alpha.2` (production dep) — vec0 virtual tables

### Needed for Phase 3 (embedding generation)
One of:
- `@huggingface/transformers` or `@xenova/transformers` — local inference with all-MiniLM-L6-v2
- `onnxruntime-node` — ONNX Runtime for Node.js (alternative to Transformers.js)
- OR: external API client (if choosing API-based embeddings)

### No other new dependencies expected for Phases 4-5

---

## 9. Summary: What Is Done vs What Remains

| Component | Phase | Status | Effort |
|-----------|-------|--------|--------|
| brain.db schema (8 tables) | 1-2 | DONE | - |
| 3-layer retrieval (find/timeline/fetch/observe) | 2 | DONE | - |
| FTS5 search + triggers | 2 | DONE | - |
| sqlite-vec extension loading | 3 | DONE | - |
| vec0 table creation | 3 | DONE | - |
| PageIndex schema + tests | 3 | DONE | - |
| **Embedding generation pipeline** | 3 | **NOT STARTED** | **LARGE** |
| **Vector similarity search** | 3 | **NOT STARTED** | MEDIUM |
| **PageIndex business logic** | 3 | **NOT STARTED** | SMALL |
| **Hybrid search merge** | 3 | **NOT STARTED** | MEDIUM |
| **Reasoning ops (why/similar/impact/timeline)** | 4 | **NOT STARTED** | MEDIUM |
| **Memory-session bridge** | 4 | **NOT STARTED** | SMALL |
| **Memory consolidation** | 5 | **NOT STARTED** | MEDIUM |
| **Temporal decay** | 5 | **NOT STARTED** | SMALL |
| **claude-mem migration CLI wiring** | 5 | **PARTIALLY DONE** (code exists, no CLI) | SMALL |
| **E2E tests + benchmarks** | 5 | **NOT STARTED** | MEDIUM |
| **claude-mem retirement** | 5 | **NOT STARTED** | MEDIUM |
| **Spec/docs updates** | 5 | **NOT STARTED** | SMALL |

**Bottom line**: The foundation is solid (schema, FTS5, sqlite-vec loading, PageIndex tables). The critical blocker is the **embedding generation pipeline** — everything in Phase 3-4 that involves semantic similarity depends on it. Phase 4's causal reasoning and session bridge can proceed independently of embeddings.
