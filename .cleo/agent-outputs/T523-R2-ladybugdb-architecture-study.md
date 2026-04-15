# R2: LadybugDB Architecture Study

**Task**: T523 — BRAIN Integrity + Cleo Memory SDK  
**Date**: 2026-04-11  
**Researcher**: Subagent (research-explorer)  
**Status**: Complete  

---

## Executive Summary

LadybugDB (https://github.com/LadybugDB/ladybug) is **not a purpose-built AI memory system**. It is an embedded property graph database forked from KuzuDB, written in C++ with bindings for Python, Node.js, Rust, Java, Go, Swift, and WASM. The "Graph-Based Memory" framing on the LadybugDB website is marketing language — the actual repository is a general-purpose analytical graph database with Cypher query language, columnar disk storage, ACID transactions, vectorized query processing, and an optional vector extension.

This distinction is critical: LadybugDB does not solve CLEO's memory problems directly. However, it is an **exceptional storage substrate** that CLEO could use to power a graph-native memory layer. The architecture study reveals several specific patterns CLEO should adopt, adapted to its SQLite-native constraint.

**Bottom line**: CLEO should not embed LadybugDB (C++ native library with pnpm `@ladybug/core` bindings is feasible but heavyweight for an agent tool). Instead, CLEO should adopt LadybugDB's **data model and query patterns** implemented natively in SQLite using the existing brain.db infrastructure. The graph model and Cypher-inspired query patterns are the real value.

---

## Repository Structure

```
ladybug/
├── src/
│   ├── antlr4/          # Cypher grammar (925-line .g4 file)
│   ├── binder/          # Query binder + expression binder
│   ├── c_api/           # C API (database.cpp, connection.cpp, etc.)
│   ├── catalog/         # Schema catalog (node tables, rel tables, indexes)
│   │   └── catalog_entry/
│   │       ├── node_table_catalog_entry.h  # Node entity schema
│   │       ├── rel_group_catalog_entry.h   # Relationship schema
│   │       ├── index_catalog_entry.h       # Index definitions
│   │       └── catalog_entry_type.h        # Entry type enum
│   ├── common/
│   │   └── types/
│   │       ├── types.h           # LogicalTypeID enum (NODE, REL, ARRAY, FLOAT, etc.)
│   │       └── value/
│   │           ├── node.h        # NodeVal (id, label, properties)
│   │           └── rel.h         # RelVal (id, label, src, dst, properties)
│   ├── function/gds/    # Graph data science: BFS, shortest paths, variable-length joins
│   ├── storage/         # Columnar disk storage, WAL, buffer manager
│   └── include/main/    # Public API: Database, Connection, PreparedStatement, QueryResult
├── tools/
│   ├── nodejs_api/      # Node.js bindings (empty in clone — built separately)
│   ├── python_api/      # Python bindings
│   ├── rust_api/        # Rust bindings
│   └── shell/           # Interactive Cypher shell
├── docs/
│   ├── morsel_parallelism.md    # Multi-core query design
│   └── semi_mask_in_scan.md    # Semi-mask join optimization
└── test/test_files/     # Comprehensive .test files with Cypher examples
```

**Language**: C++ (core), with bindings in Python/Node.js/Rust/Java/Go/Swift/WASM  
**Storage**: Custom columnar disk format (not SQLite, not RocksDB)  
**Query**: openCypher dialect with extensions (`iC_CreateNodeTable`, `iC_CreateRelTable`, etc.)  
**Version**: Storage v40 (per `storage_version_info.h`). Based on KuzuDB 0.12-0.15.x lineage.

---

## Graph Data Model

### Core Primitives

LadybugDB implements the **Property Graph Model (PGM)**:

```
Property Graph Model
====================

Node (Vertex)
┌──────────────────────────────────────┐
│  nodeID: {tableID, offset}           │ ← internal address
│  label: STRING                       │ ← the node "type" (table name)
│  properties: {key: value, ...}       │ ← arbitrary typed fields
└──────────────────────────────────────┘

Relationship (Edge)
┌──────────────────────────────────────┐
│  relID: {tableID, offset}            │ ← internal address
│  label: STRING                       │ ← the rel "type" (table name)
│  src: nodeID                         │ ← source node
│  dst: nodeID                         │ ← destination node
│  properties: {key: value, ...}       │ ← arbitrary typed fields
└──────────────────────────────────────┘
```

### DDL Syntax (Cypher)

```cypher
-- Node table (entity type definition)
CREATE NODE TABLE Person(
  name STRING,
  age  INT64,
  embedding FLOAT[1536],    -- vector column for embeddings
  PRIMARY KEY(name)
);

-- Relationship table (typed, directional)
CREATE REL TABLE knows(
  FROM Person TO Person,
  since DATE,
  strength DOUBLE
);

-- Creating instances
CREATE (:Person {name: 'Alice', age: 25});
CREATE (:Person {name: 'Bob', age: 30});
MATCH (a:Person {name: 'Alice'}), (b:Person {name: 'Bob'})
CREATE (a)-[:knows {since: date('2020-01-01'), strength: 0.85}]->(b);
```

### Type System

From `LogicalTypeID` enum in `types.h`:

```
Primitive types:
  BOOL, INT8/16/32/64/128, UINT8/16/32/64/128, FLOAT, DOUBLE
  STRING, BLOB, UUID, DATE, TIMESTAMP (ns/ms/s/tz), INTERVAL

Complex types:
  NODE         - graph node value (id + label + properties)
  REL          - graph relationship value
  RECURSIVE_REL - path through multiple hops
  ARRAY[T,N]   - fixed-length typed array (used for embeddings: FLOAT[1536])
  LIST[T]      - variable-length list
  STRUCT       - named field composite
  MAP[K,V]     - key-value map
  UNION        - tagged union

Special:
  SERIAL       - auto-increment INT64 sequence
  ANY          - polymorphic (binding time)
```

The `FLOAT[N]` (fixed-length float array) is the embedding type used for vector search.

### Catalog Entry Types

```
CatalogEntryType enum:
  NODE_TABLE_ENTRY      = 0   - entity type definition
  REL_GROUP_ENTRY       = 2   - relationship type definition
  FOREIGN_TABLE_ENTRY   = 4   - external table (DuckDB, Postgres, etc.)
  SCALAR_MACRO_ENTRY    = 10  - user-defined macro
  AGGREGATE_FUNCTION    = 20  - aggregate UDF
  SCALAR_FUNCTION       = 21  - scalar UDF
  TABLE_FUNCTION        = 23  - table-valued function
  SEQUENCE_ENTRY        = 40  - auto-increment sequence
  TYPE_ENTRY            = 41  - user-defined type
  INDEX_ENTRY           = 42  - secondary or vector index
  GRAPH_ENTRY           = 50  - named subgraph view
```

### Relationship Multiplicity

Relationships are typed with cardinality:

```
RelMultiplicity: MANY | ONE

RelGroupCatalogEntry fields:
  srcMultiplicity  - cardinality from source side
  dstMultiplicity  - cardinality from destination side
  storageDirection - FWD | BWD | BOTH (storage optimization)

Examples:
  CREATE REL TABLE owns(FROM Person TO Account)    -- MANY-to-ONE implied
  CREATE REL TABLE knows(FROM Person TO Person)    -- MANY-to-MANY
```

---

## ASCII Data Model Diagram

```
LadybugDB Conceptual Graph Model
=================================

    ┌──────────────────────────────────────────────────────────────────────┐
    │                         SCHEMA LAYER (Catalog)                       │
    │                                                                      │
    │   NodeTableEntry           RelGroupEntry          IndexEntry         │
    │   ┌───────────────┐       ┌───────────────┐      ┌──────────────┐   │
    │   │ name: STRING  │       │ name: STRING  │      │ type: STRING │   │
    │   │ primaryKey    │       │ FROM: nodeType│      │ tableID      │   │
    │   │ properties[]  │──────▶│ TO:   nodeType│      │ columns[]    │   │
    │   │ storage       │       │ properties[]  │      │ auxInfo      │   │
    │   └───────────────┘       │ multiplicity  │      └──────────────┘   │
    │                           └───────────────┘                         │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │                         DATA LAYER (Storage)                         │
    │                                                                      │
    │      NodeGroup (128K rows)                                           │
    │      ┌─────────────────────────────────────────┐                    │
    │      │  ColumnChunk[prop1]  ColumnChunk[prop2]  │                    │
    │      │  ┌──────────────┐   ┌──────────────┐    │                    │
    │      │  │ compressed   │   │ FLOAT[1536]  │    │                    │
    │      │  │ columnar data│   │ embedding vec│    │                    │
    │      │  └──────────────┘   └──────────────┘    │                    │
    │      └─────────────────────────────────────────┘                    │
    │                                                                      │
    │      RelTableData (CSR adjacency list)                               │
    │      ┌─────────────────────────────────────────┐                    │
    │      │  FWD CSR: src_offset → [dst_offsets]    │                    │
    │      │  BWD CSR: dst_offset → [src_offsets]    │                    │
    │      │  Edge properties: columnar chunks        │                    │
    │      └─────────────────────────────────────────┘                    │
    └──────────────────────────────────────────────────────────────────────┘

    ┌──────────────────────────────────────────────────────────────────────┐
    │                       QUERY LAYER (Cypher)                           │
    │                                                                      │
    │  MATCH (a:Person)-[:knows*1..3]->(b:Person)                          │
    │  WHERE a.name = 'Alice'                                              │
    │  RETURN b.name, length(path)                                         │
    │                                                                      │
    │  Graph Algorithms:                                                   │
    │  - BFS traversal with semi-mask join optimization                    │
    │  - Variable-length path (1..N hops)                                  │
    │  - Weighted shortest path (Dijkstra)                                 │
    │  - All-pairs shortest path                                           │
    │                                                                      │
    │  Indexes:                                                            │
    │  - Hash index (primary key lookup)                                   │
    │  - Full-text search (FTS extension)                                  │
    │  - Vector index HNSW (vector extension)                              │
    └──────────────────────────────────────────────────────────────────────┘
```

---

## API Surface

### Core Operations

```cpp
// C++ API
Database db("path/to/db");           // open or create
Connection conn(&db);                 // thread-safe connection

// DDL
conn.query("CREATE NODE TABLE Entity(id INT64, name STRING, PRIMARY KEY(id))");
conn.query("CREATE REL TABLE relates(FROM Entity TO Entity, type STRING, weight DOUBLE)");

// DML
conn.query("CREATE (:Entity {id: 1, name: 'CLEO brain decision'})");

// Traversal
conn.query("MATCH (a:Entity)-[:relates*1..3]->(b:Entity) RETURN a, b");

// Vector similarity
conn.query("MATCH (a:Entity) "
           "WITH array_cosine_similarity(a.embedding, $query) AS score, a "
           "RETURN a.name, score ORDER BY score DESC LIMIT 10");

// Parameterized queries
auto stmt = conn.prepare("MATCH (n:Entity {id: $id}) RETURN n");
conn.execute(stmt.get(), std::make_pair("id", 42LL));
```

### Index Types

```cypher
-- Primary key hash index (automatic on node table creation)
CREATE NODE TABLE Entity(id INT64, PRIMARY KEY(id));

-- Full-text search (FTS extension)
CALL CREATE_FTS_INDEX('Entity', 'ftsIdx', ['name', 'description']);
CALL QUERY_FTS_INDEX('Entity', 'ftsIdx', 'search term') YIELD node, score;

-- Vector index (vector extension, HNSW-based)
CALL CREATE_VECTOR_INDEX('Entity', 'vecIdx', 'embedding');
CALL QUERY_VECTOR_INDEX('Entity', 'vecIdx', $queryVec, 10) YIELD node, distance;
```

### Graph Algorithm Functions (GDS)

Built into the query processor:

```cypher
-- Variable-length path traversal
MATCH (a)-[*1..5]->(b) RETURN a, b

-- Weighted shortest path (Dijkstra)
MATCH p = wshortest((a)-[e:ROAD weight := e.distance]->(b))
RETURN p, total_weight(p)

-- All-shortest-paths
MATCH p = all_shortest((a)-[:knows]->(b))
RETURN nodes(p), relationships(p)
```

---

## Memory Lifecycle

LadybugDB is a general database — it does not implement AI memory lifecycle concepts natively. However, its architecture informs what CLEO should build:

### What LadybugDB Does

| Mechanism | Implementation |
|-----------|---------------|
| **Durability** | WAL (write-ahead log), checkpoint at 16MB threshold |
| **Transactions** | Serializable ACID via MVCC (insertedVersions/deletedVersions per vector) |
| **Concurrency** | Multi-reader + optional multi-writer mode (`enableMultiWrites`) |
| **Compression** | Column-level compression (ALP for floats, etc.) |
| **Versioning** | MVCC timestamps on every row; time-travel queries possible |
| **Index consistency** | Hash index maintained via InsertState/DeleteState/UpdateState lifecycle |
| **Buffer pool** | Configurable buffer pool (default 8TB virtual address space) |

### What LadybugDB Does NOT Do

- No memory decay (TTL, confidence degradation)
- No deduplication of semantically equivalent content
- No automatic consolidation of related records
- No quality scoring or signal-to-noise separation
- No contradiction detection between knowledge entries
- No agent-aware access patterns

All of these must be built at the CLEO application layer.

---

## Key Innovations to Adopt

### Innovation 1: Property Graph as First-Class Model

LadybugDB's most important lesson: **schema-first entity typing via node tables and relationship tables**.

Instead of CLEO's flat tables with JSON blobs for relationships, define typed entities:

```cypher
CREATE NODE TABLE Entity(
  id      STRING PRIMARY KEY,
  type    STRING,   -- 'decision' | 'pattern' | 'learning' | 'observation'
  content STRING,
  quality DOUBLE,   -- signal-to-noise score
  created TIMESTAMP
);

CREATE REL TABLE relates(
  FROM Entity TO Entity,
  relType STRING,   -- 'contradicts' | 'supports' | 'derived_from' | 'applies_to'
  weight  DOUBLE
);
```

This replaces the flat `brain_memory_links` table with a traversable graph.

### Innovation 2: FLOAT[N] Array Type for Embeddings

LadybugDB's ARRAY type is designed for embedding vectors:

```cypher
CREATE NODE TABLE Entity(
  id        STRING PRIMARY KEY,
  content   STRING,
  embedding FLOAT[1536]  -- semantic embedding for similarity search
);

-- Nearest-neighbor query
MATCH (a:Entity)
WITH array_cosine_similarity(a.embedding, $queryVec) AS score, a
RETURN a ORDER BY score DESC LIMIT 10
```

CLEO should add an `embedding` column (stored as BLOB in SQLite, JSON array as fallback) to all memory entities once an embedding service is available.

### Innovation 3: CSR Adjacency List for Fast Graph Traversal

LadybugDB stores relationships in Compressed Sparse Row format — both forward (`src → dsts`) and backward (`dst → srcs`) directions. This enables O(1) neighbor lookup for any node.

For CLEO in SQLite: the `brain_page_edges` table should have composite indexes on `(from_id)` and `(to_id)` — already done — but also a **bidirectional traversal pattern** where queries always optionally check both directions:

```sql
-- Current: needs two queries for undirected traversal
SELECT * FROM brain_page_edges WHERE from_id = ?
UNION
SELECT * FROM brain_page_edges WHERE to_id = ?
```

### Innovation 4: Variable-Length Path Traversal

LadybugDB's Cypher supports `MATCH (a)-[*1..N]->(b)` — variable-length relationship traversal. This is critical for memory chains like:

```
decision → informed_by → observation → derived_from → learning
```

CLEO should implement a recursive CTE pattern in SQLite that mirrors this:

```sql
-- Find all memory entities connected to a given entity up to 3 hops
WITH RECURSIVE connected(id, depth) AS (
  SELECT to_id, 1 FROM brain_page_edges WHERE from_id = ?
  UNION ALL
  SELECT e.to_id, c.depth + 1
  FROM brain_page_edges e
  JOIN connected c ON e.from_id = c.id
  WHERE c.depth < 3
)
SELECT DISTINCT id FROM connected;
```

### Innovation 5: Typed Relationship Multiplicity

LadybugDB enforces cardinality at the schema level (`MANY-to-ONE`, `ONE-to-ONE`). For CLEO:

- `derived_from` should be MANY-to-ONE (many learnings from one observation)
- `contradicts` should be MANY-to-MANY (decisions can contradict each other mutually)
- `documents` should be MANY-to-ONE (many learnings can document one decision)

This prevents orphaned references and enables better query planning.

### Innovation 6: Graph Data Science (GDS) Built-In

LadybugDB includes BFS, Dijkstra weighted shortest path, all-shortest-paths, and variable-length joins as built-in functions. For CLEO's memory system:

- **BFS traversal** → "find all related memories up to N hops from this task"
- **Weighted shortest path** → "what chain of decisions led to this outcome?"
- **Semi-mask join optimization** → filter candidate nodes before traversal

CLEO should implement simplified versions of these at the CLI layer (`cleo memory trace`, `cleo memory related`).

### Innovation 7: Columnar Storage + Vectorized Execution

LadybugDB processes 2048 rows at a time (morsel-driven parallelism) and stores data in columnar format. For CLEO's SQLite brain.db:

- Batch insert operations rather than individual row inserts
- Use covering indexes to avoid full-table scans during memory search
- Pre-compute and store content hashes for deduplication at insert time

### Innovation 8: Extension Architecture

LadybugDB has a clean extension system with dedicated extensions for:
- `fts` — full-text search
- `vector` — HNSW vector index
- `llm` — LLM integration
- `postgres`, `sqlite`, `duckdb` — foreign data wrappers

For CLEO: design the memory SDK with a pluggable backend architecture where the SQLite implementation is the default, but a LadybugDB backend could be swapped in for larger deployments.

---

## Comparison Table: LadybugDB vs Current CLEO brain.db

| Dimension | LadybugDB | Current CLEO brain.db | Gap |
|-----------|-----------|----------------------|-----|
| **Storage engine** | Custom columnar binary format | SQLite (flat tables) | Different class entirely — not comparable for CLEO's scale |
| **Data model** | Property graph (nodes + typed relationships) | Flat tables + JSON blobs + `brain_page_edges` stub | Graph stub exists but empty; no traversal queries implemented |
| **Schema definition** | Cypher DDL (`CREATE NODE TABLE`) | Drizzle ORM TypeScript schema | No entity-relationship typing |
| **Relationship typing** | `CREATE REL TABLE` with cardinality, direction | `brain_memory_links` (flat join table) | No direction or cardinality enforcement |
| **Query language** | openCypher (pattern matching, variable-length paths) | SQL via Drizzle ORM | No graph traversal capability |
| **Vector support** | `FLOAT[N]` + HNSW vector index + `array_cosine_similarity` | Not implemented | No semantic similarity search |
| **Full-text search** | FTS extension via `CALL CREATE_FTS_INDEX` | Not implemented | No text-based memory search |
| **Graph algorithms** | BFS, Dijkstra, all-shortest-paths (built-in GDS) | Not implemented | No traversal reasoning |
| **Indexes** | Primary hash + secondary + FTS + vector | B-tree indexes on scalar columns | Missing FTS and vector indexes |
| **Transactions** | MVCC, serializable ACID | SQLite WAL (serializable by default) | SQLite ACID is sufficient |
| **Concurrency** | Multi-reader + optional multi-writer | SQLite WAL (multi-reader, single-writer) | WAL is sufficient for CLEO agent patterns |
| **Memory lifecycle** | None (general-purpose DB) | Partial (content_hash dedup, no decay) | Both lack decay and consolidation |
| **Deduplication** | None built-in | content_hash field exists but not enforced | Need semantic dedup engine |
| **Quality scoring** | None built-in | None implemented | Need quality/signal scoring model |
| **Contradiction detection** | None built-in | None implemented | Need contradiction detection |
| **Agent API** | Connection + query() | `cleo memory` CLI commands | CLI is sufficient, SDK layer missing |
| **Cross-language bindings** | C++, Python, Node.js, Rust, Java, Go, Swift, WASM | TypeScript only | Not a CLEO concern |
| **Embedding** | Library (linked into app process) | Separate process (SQLite via file) | Different deployment model |
| **Production readiness** | Yes (KuzuDB fork, mature) | Yes (SQLite is production-grade) | Both suitable |

---

## CLEO Adoption Recommendations

### Adopt (High Priority)

**1. Explicit entity-relationship schema with typed nodes and edges**

Replace flat `brain_memory_links` with a richer `brain_page_edges` schema that has explicit relationship types, directions, and weights. Activate and populate `brain_page_nodes` and `brain_page_edges` — these tables exist but are empty.

Recommended node types to implement:
```
'decision' | 'pattern' | 'learning' | 'observation' | 'task' | 'session' | 'concept' | 'file'
```

Recommended edge types to implement:
```
'derived_from'     - this memory was produced by another
'supports'         - this memory validates/confirms another
'contradicts'      - this memory conflicts with another
'applies_to'       - this memory is relevant to a task/session
'informed_by'      - this memory was shaped by another
'documents'        - this memory describes a code artifact
'supersedes'       - this memory replaces an older entry
```

**2. Recursive CTE traversal for memory chains**

Implement `cleo memory trace <id> --depth 3` as a recursive CTE query across `brain_page_edges`.

**3. Content-hash deduplication at insert time**

Always compute and check `content_hash` before inserting any memory entry. Reject or merge duplicates rather than accumulating noise.

**4. Quality scoring on all entities**

Add a `quality_score REAL` column to all brain tables. Score based on:
- Source reliability (agent vs manual vs session-debrief)
- Age (exponential decay with configurable half-life)
- Reference count (how often this memory is traversed or cited)
- Contradiction penalty (lower score if contradicted by other memories)

**5. Variable-length path CLI command**

Implement `cleo memory related <id> [--depth N] [--type <edge_type>]` that executes a recursive CTE and returns a ranked list of connected entities.

### Adopt (Medium Priority)

**6. Semantic similarity placeholder column**

Add `embedding_preview TEXT` column to `brain_observations` and `brain_decisions` to store a short semantic fingerprint (first 64 chars normalized). This enables cheap fuzzy dedup without requiring an embedding model.

**7. Contradiction detection rule engine**

When inserting a `decision`, query for existing decisions with high semantic overlap (same title keywords) and conflicting content. Surface contradictions in `cleo memory find` results with a `contradicted_by` annotation.

**8. Named graphs / subgraph views**

LadybugDB supports `CREATE GRAPH` and `USE GRAPH` to work with named subgraphs. CLEO should support tagging memory entries with a `graph_namespace` (e.g., `T523`, `cli-audit`, `session-xyz`) to enable scoped traversal.

### Adopt (Low Priority / Future)

**9. LadybugDB as optional backend for larger deployments**

If CLEO projects grow to tens of thousands of memory entries, offer `cleo memory --backend=ladybug` that connects to a LadybugDB instance via `@ladybug/core` npm package. The SDK layer should abstract the backend.

**10. Vector embeddings via FLOAT[N] pattern**

When an embedding model is available (local via llama.cpp, or remote via API), add `embedding BLOB` to memory entities and implement cosine similarity search. Mirrors LadybugDB's `FLOAT[1536]` pattern exactly.

### Skip or Avoid

**LadybugDB as a direct dependency for CLEO core**: The C++ native library adds ~50MB binary overhead and complex build requirements. SQLite is already embedded and sufficient for CLEO's agent memory scale (thousands, not millions, of entries).

**Cypher query language**: CLEO already has a working SQL layer via Drizzle ORM. Cypher would require either a Cypher parser or full LadybugDB integration. The patterns (graph traversal, pattern matching) can be expressed in SQL with recursive CTEs.

**Columnar storage**: Unnecessary at CLEO's scale. SQLite B-tree storage is sufficient.

**Multi-writer mode**: CLEO agents are single-writer by design (one active session writes at a time). SQLite WAL is sufficient.

---

## Summary: What LadybugDB Actually Is

LadybugDB is a **KuzuDB fork** — a high-performance embedded graph database written in C++ with Cypher query support, columnar disk storage, ACID transactions, and optional vector/FTS extensions. It is:

- NOT a purpose-built AI memory system
- NOT a cognitive memory framework
- NOT an agent-native tool

It IS:
- An excellent property graph database substrate
- A reference for how to model entity-relationship knowledge
- A source of query patterns (variable-length paths, semi-mask joins, vector similarity)
- A potential long-term backend for CLEO's memory layer if scale demands it

The website marketing ("entity-relationship graphs for knowledge storage", "contextual reasoning") describes what you can *build on top of* LadybugDB, not what LadybugDB provides out of the box.

**CLEO's path forward**: Implement graph-native memory model in SQLite now, using the patterns learned from LadybugDB (typed nodes, typed edges, traversal queries, quality scoring). Design the API so LadybugDB can be swapped in as a backend later without changing the SDK surface.

---

## Files Studied

- `/tmp/ladybug-study/README.md` — project overview, installation
- `/tmp/ladybug-study/AGENTS.md` — build/test commands for agents
- `/tmp/ladybug-study/src/antlr4/Cypher.g4` — 925-line Cypher grammar
- `/tmp/ladybug-study/src/include/main/database.h` — Database API
- `/tmp/ladybug-study/src/include/main/connection.h` — Connection API
- `/tmp/ladybug-study/src/include/common/types/types.h` — Type system
- `/tmp/ladybug-study/src/include/common/types/value/node.h` — NodeVal type
- `/tmp/ladybug-study/src/include/common/types/value/rel.h` — RelVal type
- `/tmp/ladybug-study/src/include/catalog/catalog_entry/` — all schema entry types
- `/tmp/ladybug-study/src/include/storage/table/node_table.h` — node storage
- `/tmp/ladybug-study/src/include/storage/index/hash_index.h` — index architecture
- `/tmp/ladybug-study/src/include/catalog/catalog_entry/index_catalog_entry.h` — index schema
- `/tmp/ladybug-study/src/function/gds/` — BFS, shortest paths, variable-length paths
- `/tmp/ladybug-study/docs/morsel_parallelism.md` — parallel query execution
- `/tmp/ladybug-study/docs/extensions.md` — extension list (vector, fts, llm, etc.)
- `/tmp/ladybug-study/test/test_files/function/array_embeddings.test` — vector embedding patterns
- `/tmp/ladybug-study/src/c_api/database.cpp` — C API implementation
- `/tmp/ladybug-study/examples/cpp/main.cpp` — C++ usage example
- `/tmp/ladybug-study/examples/c/main.c` — C usage example
- `/tmp/ladybug-study/storage/storage_version_info.h` — version history (KuzuDB lineage)
- `/mnt/projects/cleocode/packages/core/src/store/brain-schema.ts` — current CLEO schema
