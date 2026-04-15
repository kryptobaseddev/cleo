# LadybugDB Technical Analysis Report

> Research conducted 2026-04-13 | Confidence: HIGH (85%)
> Sources: GitHub repo, official docs, Leanpub book TOC, Volland/agentic-memory ontology, Hybrid Graph RAG article, LadybugDB.com, memory-graph MCP integration

---

## Executive Summary

LadybugDB is an **embedded columnar property graph database** forked from Kuzu (after Apple acquired Kuzu and halted open-source development). It is written in C++ with native bindings for Node.js (`@ladybug/core`), Python, Rust, Go, Java, Swift, and WebAssembly. It speaks Cypher, runs in-process (no server), and combines graph traversal with HNSW vector indexes and BM25 full-text search in a single query engine.

**LadybugDB itself is not a memory system.** It is a general-purpose graph database. The "AI agent memory" narrative comes from the book *"LadybugDB for Edge Agent AI Memory"* by Volodymyr Pavlyshyn and the companion `agentic-memory` ontology repository, which define a **reference architecture** for building memory systems on top of LadybugDB. This distinction is critical: LadybugDB provides the primitives (graph, vector, FTS, algorithms); the memory architecture is a layer you build.

**Key verdict**: LadybugDB's approach to AI memory is architecturally superior to our current brain.db in several specific dimensions (graph-native relationships, hybrid retrieval, temporal modeling). However, our system is ahead in practical agent integration (quality scoring, citation tracking, extraction gates, consolidation pipelines). The most valuable adoption path is not replacing brain.db with LadybugDB wholesale, but extracting specific patterns from the agentic-memory ontology into our existing SQLite + graph model.

---

## 1. Architecture: How LadybugDB Solves the AI Memory Problem

### 1.1 Core Database Engine

LadybugDB inherits Kuzu's research-grade architecture (published at VLDB 2023):

| Component | Detail |
|-----------|--------|
| **Storage model** | Columnar disk-based (not row-based like SQLite) |
| **Adjacency** | Compressed Sparse Row (CSR) format for join indices |
| **Query processing** | Vectorized + factorized (operates on 2048-element value vectors sized to fit CPU cache) |
| **Join algorithms** | Novel worst-case optimal joins for multi-way graph patterns |
| **Parallelism** | Multi-core query parallelism built in |
| **Transactions** | Serializable ACID with WAL |
| **Persistence** | On-disk (`.lbug` files) or in-memory (`:memory:`) |
| **Embedding** | In-process, no server, no network latency |

### 1.2 The Property Graph Model

Unlike triple stores (RDF) or document stores, LadybugDB uses a **labeled property graph** where:

- **Nodes** are typed tables with explicit schemas (like relational tables but with graph semantics)
- **Relationships** are also typed tables with FROM/TO declarations and properties
- Schema is **enforced at write time** -- the database rejects data that violates the ontology

This means the schema *is* the ontology. You don't document your data model separately; the `CREATE NODE TABLE` and `CREATE REL TABLE` statements ARE the enforceable contract.

### 1.3 How It Handles Tiered Memory

**LadybugDB itself does not implement tiered memory.** The tiered model comes from the agentic-memory ontology, which defines a layered hierarchy:

| Layer | Meaning | Tables |
|-------|---------|--------|
| **-1** | Raw conversational data (DuckDB-projected) | Conversation, Message |
| **0** | Edge/relation nodes (reified relationships) | Contains, Source, Similar, ... |
| **1** | Entities and time anchors | Entity, Time, AbstractTime |
| **2** | Facts (declarative knowledge) | Fact |
| **3** | Events (time-anchored occurrences) | Event |
| **4** | Memories (subjective, reflective) | Memory |

Knowledge flows **upward**: raw messages (layer -1) are processed to extract entities (1), facts (2), events (3), and memories (4). Each layer is progressively more abstract and durable.

Every node table carries universal temporal columns:
```
learned_at       TIMESTAMP   -- when the system first learned this
expire_at        TIMESTAMP   -- when this knowledge expires
layer            INT16       -- hierarchy level (0-4)
```

This is fundamentally different from our `short/medium/long` tier model. The agentic-memory approach uses **semantic layers** (what kind of knowledge) rather than **temporal tiers** (how long to keep it). Expiration is per-node, not per-tier.

---

## 2. Memory Pipeline: Extraction -> Consolidation -> Retrieval

### 2.1 Extraction

The ontology defines a `Source` edge node that tracks provenance:

```cypher
CREATE NODE TABLE Source (
    id               STRING PRIMARY KEY,
    extraction_method STRING,  -- 'llm'|'regex'|'ner'|'manual'|'tool'
    confidence       DOUBLE DEFAULT 1.0,
    fragment         STRING,   -- the relevant substring from the message
    -- universal columns...
);
```

LadybugDB does **not** have built-in NLP/LLM extraction. It provides the `llm` extension for generating embeddings (supports OpenAI, Ollama, Amazon Bedrock, Google Vertex/Gemini, Voyage AI), but entity extraction and relationship identification must be done externally.

The expected pipeline is:
1. Conversation messages arrive (stored in DuckDB, projected into LadybugDB)
2. External LLM extracts entities, facts, events, relationships
3. Extracted knowledge is written as graph nodes with `Source` provenance edges back to originating messages
4. Embeddings are generated via the `llm` extension or externally, stored as `FLOAT[518]` arrays

### 2.2 Consolidation

The agentic-memory ontology supports consolidation through:

- **`Similar` edge nodes**: Track semantic similarity between entities (with method and context)
- **`Contains` edge nodes**: Compositional/membership relationships for grouping
- **Louvain community detection**: Built-in graph algorithm groups related knowledge into clusters
- **PageRank scoring**: Identifies structurally important entities

However, there is **no automatic consolidation pipeline**. The ontology provides the schema; you build the consolidation logic.

### 2.3 Retrieval (Hybrid Graph RAG)

This is where LadybugDB genuinely excels. The Hybrid Graph RAG pattern combines four retrieval modes in a single database:

**Step 1: Semantic Entry (HNSW Vector Search)**
```cypher
CALL QUERY_VECTOR_INDEX('Entity', 'entity_embedding_idx', $query_vector, 10)
RETURN node, distance;
```

**Step 2: Structural Expansion (Cypher Graph Traversal)**
```cypher
MATCH (seed:Entity)-[*1..2]-(neighbor)
WHERE seed.id IN $seed_ids
RETURN neighbor;
```

**Step 3: Importance Ranking (PageRank)**
```cypher
CALL pagerank('knowledge_graph') RETURN node, rank;
```

**Step 4: Topic Scoping (Louvain Community Detection)**
```cypher
CALL louvain('knowledge_graph') RETURN node, community_id;
```

**Step 5: Reciprocal Rank Fusion (RRF)**
```
score(item) = sum(1 / (rank + 60))
```

Published benchmarks on 500 technical documents:
- Context Precision: +21% (0.68 -> 0.82) vs vector-only
- Answer Completeness: +30% (0.61 -> 0.79)
- Multi-hop Questions: +109% (0.34 -> 0.71)
- Global Questions: +195% (0.22 -> 0.65)

---

## 3. Context Rot Prevention

LadybugDB itself has **no built-in context window management or automatic summarization**. However, the architecture enables several patterns:

### 3.1 Per-Node Expiration
Every node carries `learned_at` and `expire_at` timestamps. Expired knowledge can be filtered at query time:
```cypher
MATCH (f:Fact)
WHERE f.expire_at IS NULL OR f.expire_at > timestamp()
RETURN f;
```

### 3.2 Layer-Based Token Budgeting
The `layer` column enables queries at different abstraction levels. To reduce token usage:
- Query layer 4 (memories) first for high-level summaries
- Drop to layer 2-3 (facts/events) only when needed
- Layer -1 (raw messages) is a last resort

### 3.3 Community-Scoped Retrieval
Louvain clustering limits retrieval to the relevant knowledge cluster rather than searching the entire graph. This implicitly reduces token consumption.

### 3.4 What's Missing
- No automatic summarization (you must build a consolidation pipeline)
- No token budget enforcement (you must count tokens yourself)
- No progressive disclosure built into the database

**Our brain.db is actually ahead here**: We have `brain_retrieval_log` tracking tokens per retrieval, the 3-layer search/timeline/fetch pattern that controls progressive disclosure, and quality score gates that exclude noise.

---

## 4. Ground Truth and Verification

### 4.1 LadybugDB's Approach

The agentic-memory ontology handles verification through:

- **`certainty` field** on Fact, Event, and Memory nodes (0.0-1.0 DOUBLE)
- **`source` field** tracking where knowledge came from
- **`Source` edge node** with `extraction_method` and `confidence`
- **Schema enforcement** -- the database rejects invalid relationships at write time

There is no built-in distinction between "verified" and "unverified" memories. The `certainty` score is a continuous value, not a binary flag.

### 4.2 Comparison to Our System

Our brain.db has a more sophisticated verification model:

| Dimension | Our brain.db | LadybugDB Ontology |
|-----------|-------------|-------------------|
| **Verified flag** | Binary `verified` boolean per entry | No binary flag; continuous `certainty` |
| **Source confidence** | 4-level enum: `owner/task-outcome/agent/speculative` with quality multipliers | Free-text `source` field + `confidence` DOUBLE |
| **Quality scoring** | Computed at insert (confidence + content richness + context), 0.3 gate | `certainty` on content nodes only |
| **Citation tracking** | `citation_count` per entry, drives tier promotion | Not present in base ontology |
| **Contradiction detection** | `contradicts` edge type + consolidator analysis | No built-in contradiction system |
| **Bitemporal** | `valid_at` + `invalid_at` per entry | `learned_at` + `expire_at` per node |

**Verdict**: Our verification model is more operationally mature. The LadybugDB ontology has cleaner temporal modeling but lacks the practical machinery (quality gates, citation tracking, automated contradiction detection).

---

## 5. Memory Types: Semantic / Episodic / Procedural

### 5.1 LadybugDB's Approach

The agentic-memory ontology does NOT use the standard cognitive taxonomy (semantic/episodic/procedural). Instead, it uses a **hierarchical entity model**:

| Type | Maps to Cognitive Type | Description |
|------|----------------------|-------------|
| **Entity** (layer 1) | Semantic | Named things, concepts, actors |
| **Fact** (layer 2) | Semantic | Declarative propositions with certainty |
| **Event** (layer 3) | Episodic | Time-anchored occurrences with status |
| **Memory** (layer 4) | Episodic + Reflective | Subjective experiences with significance, emotions, reflection |

Procedural memory is not a first-class type in the ontology. It would be modeled as Facts with specific predicates or as pattern sequences of Events.

### 5.2 Memory Node Schema (Layer 4)
```cypher
CREATE NODE TABLE Memory (
    id               STRING PRIMARY KEY,
    predicate        STRING,
    certainty        DOUBLE DEFAULT 1.0,
    source           STRING,
    status           STRING DEFAULT 'occurred',
    is_ongoing       BOOLEAN DEFAULT FALSE,
    significance     STRING,
    emotions         STRING[],
    reflection       STRING,
    label_embedding  FLOAT[518],
    learned_at       TIMESTAMP,
    expire_at        TIMESTAMP,
    layer            INT16 DEFAULT 4,
    context          STRING
);
```

### 5.3 Comparison

Our brain.db has explicit `memory_type` (`semantic/episodic/procedural`) on every entry, mapped to specific tables:
- `brain_decisions` -> always `semantic`
- `brain_observations` -> always `episodic`
- `brain_patterns` -> always `procedural`
- `brain_learnings` -> `semantic` (default) or `episodic` (transcript-derived)

**Verdict**: Our explicit cognitive type taxonomy is more immediately useful for agents that need to query by memory type. The LadybugDB approach is more ontologically rich but requires more complex queries to achieve the same filtering.

---

## 6. Decay and Forgetting

### 6.1 LadybugDB's Approach

The agentic-memory ontology supports temporal decay through:

- **`expire_at` on every node**: Explicit expiration timestamp
- **`learned_at`**: Enables age-based calculations
- **Temporal edge nodes**: `Before`, `After`, `During`, `ValidFrom`, `ValidTo` model temporal relationships as first-class graph entities

The **Time Tree** provides temporal anchoring:
```cypher
CREATE NODE TABLE Time (
    id               STRING PRIMARY KEY,
    granularity      STRING,  -- 'year'|'month'|'day'|'hour'|'minute'
    starts_at        TIMESTAMP,
    ends_at          TIMESTAMP,
    -- universal columns...
);

CREATE NODE TABLE AbstractTime (
    id               STRING PRIMARY KEY,
    semantics        STRING,  -- 'morning'|'weekend'|'quarterly'
    -- universal columns...
);
```

However, there is **no automatic decay mechanism**. Eviction, aging, and forgetting must be implemented as application-level logic.

### 6.2 Comparison

Our brain.db has a more operational decay model:

| Feature | Our brain.db | LadybugDB Ontology |
|---------|-------------|-------------------|
| **Tier-based TTL** | short=48h auto-evict, medium=weeks, long=permanent | Per-node `expire_at` (manual) |
| **Citation-based promotion** | `citation_count` drives medium->long | Not present |
| **Quality decay** | quality_score gates search results (< 0.3 excluded) | No quality gate |
| **Consolidator** | Automated `brain-consolidator.ts` runs on session end | No built-in consolidation |
| **Temporal model** | `valid_at` + `invalid_at` bitemporal | `learned_at` + `expire_at` + Time Tree |

**Verdict**: Our decay/eviction system is more automated and practical. The LadybugDB Time Tree is more expressive for temporal reasoning but requires you to build all the automation yourself. The `AbstractTime` concept (semantic time like "morning", "quarterly") is genuinely novel and something we lack.

---

## 7. Retrieval Strategies

### 7.1 LadybugDB's Four Retrieval Modes

| Mode | Technology | Configuration |
|------|-----------|---------------|
| **Vector Search** | HNSW index, disk-based | mu=30, ml=60, pu=0.05, efc=200, cosine/l2/dotproduct |
| **Graph Traversal** | Cypher MATCH with variable-length paths | Recursive CTEs, Kleene star `*1..N` syntax |
| **Full-Text Search** | BM25 via `fts` extension | Extension-based, loaded per session |
| **Graph Algorithms** | PageRank, Louvain, K-Core, SCC, WCC | Via `algo` extension on projected graphs |

The killer feature is **combining these in a single query pipeline**:
```cypher
-- 1. Vector search for seeds
CALL QUERY_VECTOR_INDEX('Entity', 'emb_idx', $query_vec, 10)
RETURN node AS seed, distance;

-- 2. Expand via graph
MATCH (seed)-[*1..2]-(neighbor)
WHERE neighbor.expire_at IS NULL OR neighbor.expire_at > timestamp()
RETURN seed, neighbor;

-- 3. Rank by PageRank (pre-computed)
-- 4. Filter by community (pre-computed Louvain)
-- 5. Fuse with RRF
```

### 7.2 Comparison to Our Retrieval

| Feature | Our brain.db | LadybugDB |
|---------|-------------|-----------|
| **Text search** | FTS5 (built into SQLite) | BM25 (extension) |
| **Vector search** | sqlite-vec (external, limited) | Native HNSW (disk-based, configurable) |
| **Graph traversal** | Recursive CTEs in SQLite (manual) | Native Cypher with Kleene star |
| **Graph algorithms** | None built-in | PageRank, Louvain, K-Core, SCC, WCC |
| **Hybrid fusion** | Not implemented | RRF pattern documented and demonstrated |
| **Filtered search** | WHERE clauses on FTS5 | Projected graphs with property predicates |

**Verdict**: LadybugDB is significantly ahead in retrieval. Our FTS5 is comparable to BM25, but we lack native HNSW vector search, graph algorithms, and hybrid fusion. The multi-hop retrieval pattern (+109% on multi-hop questions) addresses a real weakness in our system.

---

## 8. Integration: Node.js / TypeScript

### 8.1 Installation
```bash
npm install @ladybug/core
```

### 8.2 API Surface

```typescript
const lb = require("@ladybug/core");

// Database (on-disk)
const db = new lb.Database("memory.lbug");
// Database (in-memory)
const db = new lb.Database(":memory:");

// Connection
const conn = new lb.Connection(db);

// Async query
const result = await conn.query("MATCH (n:Entity) RETURN n LIMIT 10");
const rows = await result.getAll();

// Sync query
const result = conn.querySync("MATCH (n:Entity) RETURN n LIMIT 10");
const rows = result.getAllSync();

// Multiple statements (returns array)
const results = await conn.query(`
  CREATE NODE TABLE IF NOT EXISTS Entity (...);
  CREATE REL TABLE IF NOT EXISTS Contains (...);
`);

// Load extensions
await conn.query("INSTALL vector; LOAD vector;");
await conn.query("INSTALL algo; LOAD algo;");
await conn.query("INSTALL llm; LOAD llm;");
```

### 8.3 Integration Considerations for CLEO

**Advantages:**
- Embedded (no server process to manage)
- Native Node.js bindings (not a WASM shim)
- ACID transactions (safe for concurrent agent access)
- File-based persistence (compatible with our backup/restore model)

**Challenges:**
- C++ native addon -- requires `node-gyp` build toolchain at install time
- Binary compatibility issues across Node.js versions
- No Drizzle ORM support (Cypher only, no SQL)
- Would require a completely new data access layer
- Extension loading is session-scoped (must reload per connection)
- No TypeScript type generation from schema (unlike Drizzle)

### 8.4 Migration Cost Assessment

Replacing brain.db with LadybugDB would require:
1. Rewriting `brain-schema.ts` as Cypher DDL (medium effort)
2. Rewriting `brain-accessor.ts`, `brain-search.ts`, `brain-retrieval.ts`, `brain-similarity.ts`, `graph-queries.ts`, `graph-auto-populate.ts` to use Cypher (high effort)
3. Rewriting all memory dispatch/engine code (high effort)
4. Losing Drizzle ORM type safety (significant DX regression)
5. New backup/restore mechanism (`.lbug` files instead of SQLite VACUUM INTO)
6. New migration strategy (no Drizzle migrations; schema changes via Cypher DDL)

**Estimated effort**: Large (4-6 weeks for a single developer). Not recommended as a near-term initiative.

---

## 9. Comparison: LadybugDB vs. Our brain.db

### 9.1 Where We Are Behind

| Dimension | Gap Severity | Detail |
|-----------|-------------|--------|
| **Graph query language** | HIGH | Cypher is purpose-built for graphs. Our recursive CTEs in SQLite are verbose and limited. |
| **Vector search** | HIGH | Native HNSW with configurable parameters vs. sqlite-vec which is limited and external. |
| **Hybrid retrieval** | HIGH | Combined vector + graph + FTS + algorithms in one pipeline. We have no fusion strategy. |
| **Graph algorithms** | HIGH | PageRank, Louvain community detection, K-Core built in. We have none. |
| **Temporal modeling** | MEDIUM | Time Tree with concrete and abstract time nodes. We have bitemporal columns but no temporal graph. |
| **Causal relationships** | MEDIUM | 13 typed edge node tables (Contains, Causes, Prevents, LeadsTo, BecauseOf...). We have 13 edge types but they're flat, not reified. |
| **Schema-as-ontology** | MEDIUM | Table definitions enforce the ontology at write time. Our schema is structural, not ontological. |
| **Columnar storage** | LOW | Better for analytical queries on large datasets. Not a bottleneck for us at current scale. |
| **Embedding generation** | LOW | Built-in `llm` extension for 6 providers. We use external embedding-local.ts. Similar capability. |

### 9.2 Where We Are Ahead

| Dimension | Lead Severity | Detail |
|-----------|-------------|--------|
| **Quality scoring system** | HIGH | Computed quality_score with 0.3 gate, source confidence multipliers. LadybugDB ontology has only `certainty`. |
| **Citation tracking** | HIGH | citation_count drives tier promotion. Not present in LadybugDB. |
| **Automated consolidation** | HIGH | brain-consolidator.ts runs on session end. LadybugDB has no consolidation pipeline. |
| **Tier-based auto-eviction** | HIGH | short=48h, medium=weeks, long=permanent with automated promotion/demotion. |
| **Extraction gate** | MEDIUM | extraction-gate.ts prevents noise from entering the system. LadybugDB relies on external quality control. |
| **Progressive disclosure** | MEDIUM | 3-layer search/timeline/fetch pattern. LadybugDB has no built-in progressive disclosure. |
| **Retrieval logging** | MEDIUM | brain_retrieval_log tracks queries, entries returned, tokens used. |
| **Agent provenance** | MEDIUM | `agent` field on observations tracks which spawned agent produced the memory. |
| **Contradiction detection** | MEDIUM | `contradicts` edge + consolidator analysis. Not in LadybugDB base ontology. |
| **ORM type safety** | MEDIUM | Drizzle ORM provides full TypeScript type inference from schema. LadybugDB has no ORM. |
| **Cognitive type taxonomy** | LOW | Explicit semantic/episodic/procedural enum per entry. LadybugDB uses structural layers instead. |

---

## 10. Key Innovations to Adopt

These are specific patterns from LadybugDB / agentic-memory that we should adopt **even without using LadybugDB directly**.

### 10.1 MUST ADOPT: Reified Edge Nodes (Priority: HIGH)

The agentic-memory ontology's most powerful innovation is **edge nodes** -- relationships modeled as full graph nodes with their own properties, temporal columns, and confidence scores.

Currently our `brain_page_edges` are simple `(from_id, to_id, edge_type, weight)` tuples. The LadybugDB pattern makes each relationship a first-class entity that can:
- Have its own `learned_at` / `expire_at` timestamps
- Participate in other relationships (relationships about relationships -- metagraphs)
- Carry extraction provenance (`extraction_method`, `confidence`, `fragment`)
- Be queried independently

**Adoption path**: Add a `brain_edge_nodes` table to brain.db where important edges get promoted to full nodes. This is purely additive to our existing schema.

### 10.2 MUST ADOPT: Hybrid Retrieval with Reciprocal Rank Fusion (Priority: HIGH)

Our current retrieval is either FTS5 text search OR vector similarity (sqlite-vec). The RRF pattern for combining results from multiple retrieval modes is well-documented and can be implemented in application code:

```typescript
function reciprocalRankFusion(rankings: Map<string, number>[], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [id, rank] of ranking) {
      scores.set(id, (scores.get(id) || 0) + 1 / (rank + k));
    }
  }
  return scores;
}
```

**Adoption path**: Implement RRF in `brain-retrieval.ts` to fuse FTS5 results with vector similarity results. No database change needed.

### 10.3 SHOULD ADOPT: Temporal Relationship Modeling (Priority: MEDIUM)

The Before/After/During/ValidFrom/ValidTo edge node types create a temporal graph that enables queries like "what did the agent know at time T?" and "what caused what in sequence?"

**Adoption path**: Add `temporal_order` edge types to `BRAIN_EDGE_TYPES`: `before`, `after`, `during`, `valid_from`, `valid_to`. Create edges between chronologically related observations/events.

### 10.4 SHOULD ADOPT: Causal Edge Types (Priority: MEDIUM)

The `LeadsTo`, `Causes`, `Prevents`, `BecauseOf` edge types enable causal reasoning across the graph. Our current edge types (`derived_from`, `informed_by`, `supports`, `contradicts`) capture provenance but not causality.

**Adoption path**: Add causal edge types to `BRAIN_EDGE_TYPES`: `leads_to`, `causes`, `prevents`, `because_of`. Wire the consolidator to detect and create causal edges when patterns emerge.

### 10.5 SHOULD ADOPT: Abstract Time Nodes (Priority: MEDIUM)

The `AbstractTime` concept (semantic time references like "morning", "quarterly", "sprint-3") enables temporal queries that go beyond exact timestamps.

**Adoption path**: Add an `abstract_time` node type to `BRAIN_NODE_TYPES`. Create nodes for recurring time patterns (session boundaries, release cycles, sprint cadences) and wire `during` edges from events to these nodes.

### 10.6 CONSIDER: Layer-Based Knowledge Hierarchy (Priority: LOW)

The 5-layer model (message -> entity -> fact -> event -> memory) provides a cleaner abstraction gradient than our flat table structure. However, our existing tables already encode this implicitly:
- Layer -1: Session transcripts (not stored in brain.db)
- Layer 1: Brain graph nodes (concept, symbol, file)
- Layer 2: Brain learnings + decisions (facts)
- Layer 3: Brain observations (events)
- Layer 4: No equivalent (subjective memories with emotions/reflection)

**Adoption path**: Add a `layer` integer column to `brain_page_nodes`. Map existing node types to layers. This enables layer-based retrieval without restructuring.

### 10.7 CONSIDER: Provenance Fragment Tracking (Priority: LOW)

The `Source` edge node's `fragment` field stores the exact substring from a message that a piece of knowledge was extracted from. This creates an audit trail from any fact back to the exact text that produced it.

**Adoption path**: Add a `source_fragment` text column to relevant brain tables or edge nodes.

---

## Appendix A: LadybugDB Repository Metadata

| Field | Value |
|-------|-------|
| GitHub | https://github.com/LadybugDB/ladybug |
| Stars | 938 |
| Forks | 68 |
| Language | C++ |
| License | MIT |
| Created | 2025-10-07 |
| Last pushed | 2026-04-12 |
| Latest release | v0.15.3 |
| Predecessor | Kuzu (acquired by Apple) |
| Node.js package | `@ladybug/core` |
| Docs | https://docs.ladybugdb.com |
| Book | https://leanpub.com/ladybugdb |
| Memory ontology | https://github.com/Volland/agentic-memory |

## Appendix B: Extension Ecosystem

| Extension | Purpose | Relevance |
|-----------|---------|-----------|
| `vector` | HNSW vector indexes (cosine/l2/dotproduct) | Critical for semantic search |
| `fts` | BM25 full-text search | Equivalent to our FTS5 |
| `algo` | PageRank, Louvain, K-Core, SCC, WCC | No equivalent in our system |
| `llm` | Embedding generation (OpenAI, Ollama, etc.) | Similar to our embedding-local.ts |
| `json` | JSON parsing and scanning | Built into SQLite |
| `neo4j` | Migration from Neo4j | Not relevant |
| `sqlite` | Import from SQLite databases | Potentially useful for migration |
| `duckdb` | Attach DuckDB databases | Used in ontology for conversations |

## Appendix C: Agentic Memory Ontology Summary

**5 Entity Node Tables**: Entity, Time, AbstractTime, Fact, Event, Memory
**2 Conversational Tables**: Conversation, Message (DuckDB-projected)
**13 Edge Node Tables**: Contains, Source, LeadsTo, Prevents, Causes, BecauseOf, Similar, HasProperty, Before, After, During, ValidFrom, ValidTo
**28 REL Tables**: 2 per edge node type (FROM_* and TO_*) using polymorphic syntax

Total schema: 20 node tables + 28 relationship tables = 48 table definitions

---

## Sources

- [LadybugDB GitHub Repository](https://github.com/LadybugDB/ladybug)
- [LadybugDB Official Documentation](https://docs.ladybugdb.com)
- [LadybugDB Website](https://ladybugdb.com)
- [LadybugDB for Edge Agent AI Memory (Book)](https://leanpub.com/ladybugdb)
- [Agentic Memory Ontology v3](https://github.com/Volland/agentic-memory/blob/main/memory-ontology-ladybug-v3.md)
- [Hybrid Graph RAG with LadybugDB](https://volodymyrpavlyshyn.medium.com/hybrid-graph-rag-with-ladybugdb-when-vectors-meet-graphs-aa7ddec45632)
- [Volland/ladybug-rag Repository](https://github.com/Volland/ladybug-rag)
- [LadybugDB Vector Extension Docs](https://docs.ladybugdb.com/extensions/vector/)
- [LadybugDB LLM Extension Docs](https://docs.ladybugdb.com/extensions/llm/)
- [LadybugDB Algorithm Extension Docs](https://docs.ladybugdb.com/extensions/algo/)
- [Ladybug Memory Platform](https://ladybugmem.ai/)
- [memory-graph MCP Server](https://github.com/memory-graph/memory-graph)
