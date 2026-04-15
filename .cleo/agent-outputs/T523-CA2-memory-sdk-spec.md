# T523-CA2: Cleo Memory SDK — Graph-Native Cognitive Memory System

**Version**: 1.0.0
**Date**: 2026-04-11
**Task**: T523 (EPIC: BRAIN Integrity + Cleo Memory SDK)
**Status**: Complete
**Author**: Memory SDK Architect (CA2 subagent)

---

## Executive Summary

This specification defines the graph-native Cleo Memory SDK: a traversable knowledge graph built on SQLite that transforms `brain.db` from a collection of flat, disconnected tables into a first-class cognitive reasoning substrate. The design is grounded in the LadybugDB lessons (typed nodes, typed edges, quality scoring, content-hash dedup), is fully backward-compatible with the existing CLI surface, and maintains a hard SQLite-only constraint with no external database dependencies.

The chosen approach is **Option C: Hybrid** — existing typed tables (decisions, patterns, learnings, observations) are preserved for typed queries and domain-specific tooling, while a graph layer (`brain_page_nodes` + `brain_page_edges`) is extended to index, mirror, and relate all memory entities into a traversable knowledge graph.

---

## 1. Graph Data Model

### 1.1 Design Choice: Option C (Hybrid)

**Decision**: Keep separate typed tables; expand the graph layer to mirror and cross-link them.

**Rationale**:

- The existing tables (`brain_decisions`, `brain_patterns`, `brain_learnings`, `brain_observations`) have typed schemas, domain-specific fields (confidence, successRate, outcome), and existing CLI commands wired to them. Migrating everything into `brain_page_nodes` (Option B) would destroy type information and require rewriting every command that touches memory.
- The graph layer (`brain_page_nodes` / `brain_page_edges`) is currently empty — a clean slate. Extending it costs zero migration debt.
- Option A (graph as pure index) is too weak: it cannot represent memory-to-memory relationships that span table boundaries (e.g., a learning derived from a decision derived from an observation).
- The hybrid pattern matches how production graph databases work alongside relational stores: the relational layer owns typed entity storage; the graph layer owns traversal and cross-entity reasoning.

**Mapping rule**: Every entity row in a typed table gets a corresponding node in `brain_page_nodes`. Every semantic relationship between entities becomes an edge in `brain_page_edges`. The typed table row is the source of truth; the graph node is the index entry.

### 1.2 Node Schema (brain_page_nodes — Extended)

Replace the current minimal schema with the full graph node schema. Drizzle ORM definition:

```typescript
// packages/core/src/store/brain-schema.ts

export const BRAIN_NODE_TYPES = [
  // Memory entity types (mirror typed tables)
  'decision',
  'pattern',
  'learning',
  'observation',
  'sticky',
  // Task provenance (soft FK into tasks.db)
  'task',
  'session',
  'epic',
  // Codebase integration (bridge to nexus.db code_index)
  'file',
  'symbol',
  // Abstract / synthesized
  'concept',
  'summary',
] as const;

export type BrainNodeType = (typeof BRAIN_NODE_TYPES)[number];

export const brainPageNodes = sqliteTable(
  'brain_page_nodes',
  {
    /**
     * Stable composite ID: '<type>:<source-id>'
     * Examples: 'decision:D-abc123', 'observation:O-mntphoj6-0',
     *           'task:T523', 'symbol:src/store/brain-schema.ts::brainPageNodes',
     *           'concept:graph-native-memory'
     */
    id: text('id').primaryKey(),

    /** Discriminated type from BRAIN_NODE_TYPES. */
    nodeType: text('node_type', { enum: BRAIN_NODE_TYPES }).notNull(),

    /** Human-readable label (title, name, or generated summary). */
    label: text('label').notNull(),

    /**
     * Quality score: 0.0 (noise) – 1.0 (canonical).
     * Derived from: source confidence, edge density, age decay, agent provenance.
     * Default 0.5 for unknown provenance; 0.0 triggers exclusion from traversal.
     */
    qualityScore: real('quality_score').notNull().default(0.5),

    /**
     * SHA-256 prefix (first 16 hex chars) of the canonical content.
     * Computed at insert time; duplicate hashes are rejected.
     * Null for external references (task, session, symbol nodes).
     */
    contentHash: text('content_hash'),

    /**
     * ISO 8601 timestamp of last activity on this node.
     * Updated when new edges are added, quality changes, or content is revised.
     */
    lastActivityAt: text('last_activity_at').notNull().default(sql`(datetime('now'))`),

    /**
     * Extensible JSON metadata blob — type-specific payload.
     * decision: { type, confidence, outcome }
     * observation: { sourceType, agent, sessionId }
     * symbol: { filePath, kind, startLine, endLine, language }
     * task: { status, priority, epicId }
     */
    metadataJson: text('metadata_json'),

    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
    updatedAt: text('updated_at'),
  },
  (table) => [
    index('idx_brain_nodes_type').on(table.nodeType),
    index('idx_brain_nodes_quality').on(table.qualityScore),
    index('idx_brain_nodes_content_hash').on(table.contentHash),
    index('idx_brain_nodes_last_activity').on(table.lastActivityAt),
  ],
);
```

### 1.3 Edge Schema (brain_page_edges — Extended)

Replace the current minimal edge schema with a weighted, typed, provenance-aware edge schema:

```typescript
export const BRAIN_EDGE_TYPES = [
  // Provenance / derivation
  'derived_from',     // learning ← derived_from ← observation
  'produced_by',      // observation ← produced_by ← session
  'informed_by',      // decision ← informed_by ← pattern

  // Semantic relationship
  'supports',         // observation → supports → decision
  'contradicts',      // observation → contradicts → decision
  'supersedes',       // decision → supersedes → decision (older)
  'applies_to',       // decision/pattern → applies_to → task/file/symbol

  // Structural
  'documents',        // observation → documents → symbol/file
  'summarizes',       // summary → summarizes → observation (consolidation)
  'part_of',          // task → part_of → epic

  // Graph bridging (memory ↔ code)
  'references',       // observation → references → symbol
  'modified_by',      // file → modified_by → session
] as const;

export type BrainEdgeType = (typeof BRAIN_EDGE_TYPES)[number];

export const brainPageEdges = sqliteTable(
  'brain_page_edges',
  {
    fromId: text('from_id').notNull(),   // brain_page_nodes.id
    toId:   text('to_id').notNull(),     // brain_page_nodes.id or nexus node id
    edgeType: text('edge_type', { enum: BRAIN_EDGE_TYPES }).notNull(),

    /**
     * Edge weight / confidence: 0.0 – 1.0.
     * Semantic edges use extractor confidence (similarity score).
     * Structural edges use 1.0 (deterministic).
     * Contradiction edges store the overlap score that triggered detection.
     */
    weight: real('weight').notNull().default(1.0),

    /**
     * Human-readable note on why this edge was emitted.
     * 'auto:task-complete' | 'auto:session-end' | 'auto:contradiction-detected'
     * | 'auto:consolidation' | 'manual'
     */
    provenance: text('provenance'),

    createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.fromId, table.toId, table.edgeType] }),
    index('idx_brain_edges_from').on(table.fromId),
    index('idx_brain_edges_to').on(table.toId),
    index('idx_brain_edges_type').on(table.edgeType),
    index('idx_brain_edges_from_type').on(table.fromId, table.edgeType),
    index('idx_brain_edges_to_type').on(table.toId, table.edgeType),
  ],
);
```

### 1.4 Relationship Between Typed Tables and Graph

```
brain_decisions     → node type 'decision'  (id prefix D-)
brain_patterns      → node type 'pattern'   (id prefix P-)
brain_learnings     → node type 'learning'  (id prefix L-)
brain_observations  → node type 'observation' (id prefix O-)
brain_sticky_notes  → node type 'sticky'    (id prefix SN-)
tasks.id            → node type 'task'      (id prefix task:T)
sessions.id         → node type 'session'   (id prefix session:)
code_index.id       → node type 'symbol'    (id prefix symbol:)
file paths          → node type 'file'      (id prefix file:)
```

**Node ID convention**: `'<type>:<source-id>'` — e.g., `decision:D-mntpeeer`, `observation:O-mntphoj6-0`, `task:T523`, `symbol:src/store/brain-schema.ts::brainPageNodes`.

The `brain_memory_links` table is superseded by `brain_page_edges` for new entries. Existing `brain_memory_links` rows are migrated to edges during Phase 3. The table is retained read-only for one release cycle then dropped.

---

## 2. Auto-Population Strategy

### 2.1 When a Decision Is Stored

Trigger: `memory brain.observe` / `cleo memory decide` / any path writing to `brain_decisions`.

Graph updates:
1. Upsert node `decision:<id>` with label = decision text (truncated to 120 chars), qualityScore from confidence (`high=0.9`, `medium=0.7`, `low=0.5`).
2. If `contextTaskId` is set: upsert node `task:<contextTaskId>`, add edge `decision:<id> → applies_to → task:<contextTaskId>` (weight=1.0, provenance='auto:decision-store').
3. If `contextEpicId` is set: upsert node `epic:<contextEpicId>`, add edge `decision:<id> → applies_to → epic:<contextEpicId>`.
4. Trigger contradiction scan: find existing decision nodes where `qualityScore > 0.3`, compute keyword overlap with the new decision's rationale + alternatives. If overlap ≥ 0.6 and content diverges, emit edge `new → contradicts → old` (weight = overlap score).

### 2.2 When a Task Is Completed

Trigger: `cleo complete <id>` → `tasks.complete` operation.

Graph updates:
1. Upsert node `task:<id>` with label = task title, metadata = `{status:'done', priority, epicId}`.
2. If the task has a `contextEpicId`: upsert node `epic:<epicId>`, add edge `task:<id> → part_of → epic:<epicId>`.
3. For every `brain_observations.sourceSessionId` matching the active session: add edge `observation:<obsId> → applies_to → task:<id>` (provenance='auto:task-complete').
4. For every `brain_decisions` where `contextTaskId = id`: add edge `decision:<dId> → applies_to → task:<id>` if not already present.
5. Update `lastActivityAt` on all affected nodes.

### 2.3 When a Session Ends

Trigger: `cleo session end`.

Graph updates:
1. Upsert node `session:<sessionId>` with label = session scope + date, metadata = `{scope, taskCount, duration}`.
2. For every observation produced in the session (`sourceSessionId = sessionId`): add edge `observation:<obsId> → produced_by → session:<sessionId>`.
3. For every decision with `contextTaskId` pointing to tasks worked in this session: add edge `decision:<dId> → informed_by → session:<sessionId>`.
4. Run lightweight quality score refresh: for each observation node touched this session, recalculate `qualityScore = base_confidence * edge_density_bonus` where `edge_density_bonus = min(1.0, 0.5 + 0.1 * outgoing_edge_count)`.
5. Update `memory-bridge.md` with graph summary (total nodes, edges added this session).

### 2.4 When Code Changes

Trigger: post-commit hook / `cleo code index` / `gitnexus analyze`.

Graph updates:
1. For each modified file path: upsert node `file:<relativePath>` with label = path, quality=1.0.
2. For each observation whose `filesModifiedJson` includes the path: add edge `observation:<obsId> → documents → file:<path>` (provenance='auto:code-change').
3. For each decision whose rationale mentions the file path (substring match): add edge `decision:<dId> → applies_to → file:<path>`.
4. Cross-link to nexus: for each `code_index` symbol in the modified file: upsert node `symbol:<code_index.id>` if not present, add edge `file:<path> → contains → symbol:<code_index.id>`.

### 2.5 How the Graph Connects to nexus_nodes / nexus_relations (T513)

The two graphs live in separate databases (`brain.db` vs `nexus.db`) but share a consistent ID namespace via the `symbol:<code_index.id>` convention. The bridge mechanism is:

- `brain_page_nodes` with `nodeType = 'symbol'` or `nodeType = 'file'` acts as a **shadow node** — a stub that references the authoritative nexus record by its `code_index.id`.
- When a traversal reaches a `symbol` or `file` node in brain.db, the SDK can optionally hydrate it by querying `nexus.db`'s `code_index` table using the source ID from the composite node ID.
- No foreign keys cross databases. The shadow node stores `metadataJson = { nexusId: code_index.id, filePath, kind }` for self-contained traversal without cross-DB join.
- The `documents` and `references` edge types are the designated bridge edges.

```
brain.db:                              nexus.db:
observation:O-abc → documents → file:src/foo.ts → (shadow)
                                                     ↕ hydrate on demand
                                              code_index (src/foo.ts symbols)
```

---

## 3. SDK Interface Design

### 3.1 Package Placement

**Decision**: Extend `packages/core` — do NOT create a new package.

**Rationale**: The memory operations already live in `packages/core/src/memory/`. Spinning up a new `@cleocode/memory-sdk` package would require new `package.json`, build config, circular-dependency audits across the monorepo, and publishing coordination. The current memory module is already well-separated within core. The SDK is a façade module at `packages/core/src/memory/graph-sdk.ts` that re-exports a clean public API.

### 3.2 TypeScript API Surface

```typescript
// packages/core/src/memory/graph-sdk.ts

/**
 * Cleo Memory SDK — graph-native cognitive memory façade.
 *
 * Entry point for all agent and CLI memory operations against
 * the brain.db knowledge graph.
 *
 * @module memory/graph-sdk
 * @epic T523
 */

import type { BrainEdgeType, BrainNodeType } from '../store/brain-schema.js';

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/** A graph node returned from SDK queries. */
export interface MemoryNode {
  /** Composite ID: '<type>:<source-id>' */
  id: string;
  nodeType: BrainNodeType;
  label: string;
  qualityScore: number;
  contentHash: string | null;
  lastActivityAt: string;
  metadataJson: string | null;
  createdAt: string;
}

/** A directed graph edge. */
export interface MemoryEdge {
  fromId: string;
  toId: string;
  edgeType: BrainEdgeType;
  weight: number;
  provenance: string | null;
  createdAt: string;
}

/** A node with its immediately connected edges (one hop). */
export interface MemoryNeighborhood {
  node: MemoryNode;
  outgoing: Array<{ edge: MemoryEdge; neighbor: MemoryNode }>;
  incoming: Array<{ edge: MemoryEdge; neighbor: MemoryNode }>;
}

/** A path between two nodes (from traverse / chain operations). */
export interface MemoryPath {
  nodes: MemoryNode[];
  edges: MemoryEdge[];
  totalWeight: number;
}

/** Options shared across store operations. */
export interface StoreOptions {
  projectRoot: string;
  /** Skip contradiction scan (useful for bulk migration). */
  skipContradictionScan?: boolean;
  /** Caller provenance tag for edge audit trail. */
  provenance?: string;
}

// ---------------------------------------------------------------------------
// store() — write a memory entity and auto-wire its graph node + edges
// ---------------------------------------------------------------------------

/**
 * Store a typed memory entity and auto-populate its graph node.
 *
 * Accepts the same payload as the existing domain-specific stores
 * (observeBrain, linkDecision, etc.) but additionally writes graph
 * nodes and edges.
 *
 * @returns The stable graph node ID for the stored entity.
 */
export async function store(
  entityType: BrainNodeType,
  payload: Record<string, unknown>,
  options: StoreOptions,
): Promise<string>;

// ---------------------------------------------------------------------------
// query() — find nodes by type, label, or quality threshold
// ---------------------------------------------------------------------------

export interface QueryOptions {
  projectRoot: string;
  nodeTypes?: BrainNodeType[];
  minQuality?: number;
  /** Full-text search against label + metadata. */
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Query the graph for matching nodes.
 * Returns a compact result set suitable for progressive disclosure.
 */
export async function query(options: QueryOptions): Promise<MemoryNode[]>;

// ---------------------------------------------------------------------------
// traverse() — recursive BFS/DFS from a starting node
// ---------------------------------------------------------------------------

export interface TraverseOptions {
  projectRoot: string;
  startId: string;
  /** Maximum hops from start node. Default: 3. */
  maxDepth?: number;
  /** Only follow edges of these types. Empty = all types. */
  edgeTypes?: BrainEdgeType[];
  /** Direction: 'outgoing' | 'incoming' | 'both'. Default: 'outgoing'. */
  direction?: 'outgoing' | 'incoming' | 'both';
  /** Exclude nodes below this quality score. Default: 0.0 (include all). */
  minQuality?: number;
}

/**
 * Recursive graph traversal using SQLite recursive CTEs.
 *
 * Returns all reachable nodes within maxDepth hops from startId,
 * along with the path that reached each node.
 */
export async function traverse(
  options: TraverseOptions,
): Promise<Array<{ node: MemoryNode; depth: number; path: string[] }>>;

// ---------------------------------------------------------------------------
// relate() — explicitly create an edge between two nodes
// ---------------------------------------------------------------------------

export interface RelateOptions {
  projectRoot: string;
  fromId: string;
  toId: string;
  edgeType: BrainEdgeType;
  weight?: number;
  provenance?: string;
}

/**
 * Create a directed edge between two existing graph nodes.
 * Upserts — safe to call multiple times with same (from, to, type).
 */
export async function relate(options: RelateOptions): Promise<MemoryEdge>;

// ---------------------------------------------------------------------------
// decay() — apply quality score decay to stale nodes
// ---------------------------------------------------------------------------

export interface DecayOptions {
  projectRoot: string;
  /** Target node types. Default: all memory types. */
  nodeTypes?: BrainNodeType[];
  /** Age threshold in days before decay applies. Default: 30. */
  olderThanDays?: number;
  /** Decay rate per day (0.0–1.0). Default: 0.995. */
  decayRate?: number;
  /** Minimum quality floor below which nodes are flagged for pruning. Default: 0.1. */
  minQualityFloor?: number;
}

/**
 * Apply time-based quality decay to graph nodes.
 *
 * Extends the existing applyTemporalDecay() in brain-lifecycle.ts
 * to operate on qualityScore in brain_page_nodes in addition to
 * confidence in brain_learnings.
 *
 * Returns count of nodes updated and nodes flagged below minQualityFloor.
 */
export async function decay(
  options: DecayOptions,
): Promise<{ updated: number; flaggedForPruning: number }>;

// ---------------------------------------------------------------------------
// consolidate() — merge high-density node clusters into summaries
// ---------------------------------------------------------------------------

export interface ConsolidateOptions {
  projectRoot: string;
  /** Minimum edge density (edges per node) to qualify as a cluster. Default: 3. */
  minEdgeDensity?: number;
  /** Minimum cluster size (nodes). Default: 4. */
  minClusterSize?: number;
  /** Skip writing merged summary nodes (dry-run mode). Default: false. */
  dryRun?: boolean;
}

/**
 * Graph-based memory consolidation.
 *
 * Identifies node clusters with high edge density (tightly connected
 * memory subgraphs) and merges them into a single 'summary' node.
 * Original nodes are downgraded (qualityScore *= 0.3) and connected
 * to the summary via 'summarizes' edges.
 *
 * Supersedes the keyword-overlap approach in brain-lifecycle.ts.
 */
export async function consolidate(
  options: ConsolidateOptions,
): Promise<{ clustersFound: number; merged: number; summaryNodesCreated: number }>;

// ---------------------------------------------------------------------------
// context() — 360-degree view of a node
// ---------------------------------------------------------------------------

/**
 * Return a node's full neighborhood: the node itself, all directly
 * connected nodes (one hop outgoing + incoming), and edge metadata.
 *
 * Used by `cleo memory context <id>`.
 */
export async function context(
  projectRoot: string,
  nodeId: string,
): Promise<MemoryNeighborhood>;

// ---------------------------------------------------------------------------
// contradictions() — list all contradicting node pairs
// ---------------------------------------------------------------------------

/**
 * Return all pairs of nodes connected by a 'contradicts' edge.
 * Sorted by edge weight descending (strongest contradiction first).
 */
export async function contradictions(
  projectRoot: string,
  options?: { minWeight?: number; nodeTypes?: BrainNodeType[] },
): Promise<Array<{ a: MemoryNode; b: MemoryNode; weight: number }>>;
```

### 3.3 Agent vs. Human Consumption

| Consumer | Interface | Notes |
|----------|-----------|-------|
| Agent (programmatic) | `import { store, query, traverse, relate, decay, consolidate, context, contradictions } from '@cleocode/core/memory/graph-sdk.js'` | Full typed API, returns rich objects |
| Human (CLI) | `cleo memory trace <id> --depth N` etc. (see §4) | Formats graph output for terminal display |
| Orchestrator | CLI via `cleo` subprocess | Same as human path, parses LAFS envelope JSON |

---

## 4. Traversal Queries

### 4.1 `cleo memory trace <id> --depth N`

Recursive CTE design (SQLite):

```sql
-- Outgoing BFS from a starting node, bounded by depth N.
WITH RECURSIVE graph(id, node_type, label, quality_score, depth, path) AS (
  -- Base case: the start node
  SELECT
    n.id, n.node_type, n.label, n.quality_score,
    0 AS depth,
    n.id AS path
  FROM brain_page_nodes n
  WHERE n.id = :startId

  UNION ALL

  -- Recursive case: follow outgoing edges
  SELECT
    target.id, target.node_type, target.label, target.quality_score,
    g.depth + 1,
    g.path || ' -> ' || target.id
  FROM graph g
  JOIN brain_page_edges e ON e.from_id = g.id
  JOIN brain_page_nodes target ON target.id = e.to_id
  WHERE g.depth < :maxDepth
    AND target.quality_score >= :minQuality
    -- Prevent cycles: the target must not already appear in the path
    AND g.path NOT LIKE ('%' || target.id || '%')
)
SELECT id, node_type, label, quality_score, depth, path
FROM graph
ORDER BY depth, quality_score DESC;
```

Drizzle ORM equivalent uses `sql` template tag for the recursive CTE since Drizzle does not have native recursive CTE support in the SQLite dialect.

### 4.2 `cleo memory related <id> --type <edge_type>`

Typed neighbor query — one hop, filtered by edge type:

```sql
SELECT
  n.id, n.node_type, n.label, n.quality_score,
  e.edge_type, e.weight, e.provenance
FROM brain_page_edges e
JOIN brain_page_nodes n ON n.id = e.to_id
WHERE e.from_id = :nodeId
  AND (:edgeType IS NULL OR e.edge_type = :edgeType)
ORDER BY e.weight DESC, n.quality_score DESC
LIMIT :limit;
```

For incoming edges (reverse direction), swap `e.from_id` / `e.to_id`.

### 4.3 `cleo memory chain <from> <to>`

Shortest path via bidirectional BFS (implemented in application layer on top of SQLite, not as a single CTE, because SQLite recursive CTEs cannot efficiently compute shortest paths across large graphs):

```typescript
// Application-layer BFS
async function shortestPath(
  projectRoot: string,
  fromId: string,
  toId: string,
): Promise<MemoryPath | null> {
  // Phase 1: expand frontiers from both ends simultaneously
  // Phase 2: detect intersection
  // Phase 3: reconstruct path from intersection node back to both ends
  // Max hops: 6 (3 from each end)
  // Returns null if no path found within 6 hops
}
```

The frontier expansion uses a single SQL query per BFS level:

```sql
SELECT e.from_id, e.to_id, e.edge_type, e.weight
FROM brain_page_edges e
WHERE e.from_id IN (:currentFrontierIds)
   OR e.to_id IN (:currentFrontierIds);
```

### 4.4 `cleo memory context <id>`

360-degree view (1-hop neighborhood):

```sql
-- Outgoing edges
SELECT
  'outgoing' AS direction,
  e.edge_type, e.weight, e.provenance,
  n.id, n.node_type, n.label, n.quality_score
FROM brain_page_edges e
JOIN brain_page_nodes n ON n.id = e.to_id
WHERE e.from_id = :nodeId

UNION ALL

-- Incoming edges
SELECT
  'incoming' AS direction,
  e.edge_type, e.weight, e.provenance,
  n.id, n.node_type, n.label, n.quality_score
FROM brain_page_edges e
JOIN brain_page_nodes n ON n.id = e.from_id
WHERE e.to_id = :nodeId

ORDER BY direction, edge_type, weight DESC;
```

Plus a direct lookup for the node itself:

```sql
SELECT * FROM brain_page_nodes WHERE id = :nodeId;
```

---

## 5. Contradiction Detection

### 5.1 Identification Algorithm

Contradictions are detected between memory entities (primarily decisions and observations) using a two-stage filter:

**Stage 1 — Candidate selection (fast, SQL)**

Find pairs of nodes with overlapping keyword signatures. Each node's keywords are stored in `metadataJson.keywords` as a JSON array (populated at insert time using the existing STOP_WORDS-filtered keyword extractor in `brain-lifecycle.ts`).

```sql
-- Find node pairs sharing at least K keywords
-- Uses SQLite JSON functions to extract keyword arrays
SELECT a.id AS id_a, b.id AS id_b,
  COUNT(*) AS shared_keywords
FROM brain_page_nodes a
JOIN brain_page_nodes b ON b.id > a.id  -- prevent duplicate pairs
JOIN json_each(json_extract(a.metadata_json, '$.keywords')) ka
JOIN json_each(json_extract(b.metadata_json, '$.keywords')) kb
  ON ka.value = kb.value
WHERE a.node_type IN ('decision', 'observation')
  AND b.node_type IN ('decision', 'observation')
  AND a.quality_score >= 0.3
  AND b.quality_score >= 0.3
GROUP BY a.id, b.id
HAVING shared_keywords >= :minSharedKeywords  -- default: 3
```

**Stage 2 — Content divergence check (application layer)**

For each candidate pair from Stage 1, load the full entity from the typed table and compare:
- Jaccard similarity of keyword sets (for overlap score)
- If the entities are both decisions: check if `outcome` values are opposite (success vs. failure) or if `rationale` fields are semantically opposed (negation heuristic: one contains "do not", "avoid", "never" and the other asserts the same subject affirmatively)
- If the entities are both observations: check if `factsJson` arrays contain conflicting fact strings (same subject noun, different predicate)

A pair is a contradiction when: `overlapScore >= 0.6 AND contentDiverges == true`.

### 5.2 What Happens When a Contradiction Is Found

1. Emit edge `node_a → contradicts → node_b` (weight = overlapScore, provenance = 'auto:contradiction-detected').
2. Apply a quality penalty to the lower-quality node: `qualityScore *= 0.8`.
3. Log the contradiction to the LAFS-compliant CLI output with both node IDs.
4. Do NOT automatically resolve or delete either node — contradictions are kept as structured signals for human or orchestrator review.

### 5.3 `cleo memory contradictions`

```sql
SELECT
  a.id AS id_a, a.label AS label_a, a.quality_score AS quality_a,
  b.id AS id_b, b.label AS label_b, b.quality_score AS quality_b,
  e.weight
FROM brain_page_edges e
JOIN brain_page_nodes a ON a.id = e.from_id
JOIN brain_page_nodes b ON b.id = e.to_id
WHERE e.edge_type = 'contradicts'
ORDER BY e.weight DESC;
```

Output format follows the LAFS envelope standard: `{success: true, data: { contradictions: [...] }, meta: {...}}`.

---

## 6. Memory Consolidation Evolution

### 6.1 Current Approach (to be preserved, not removed)

The existing keyword-overlap clustering in `brain-lifecycle.ts::consolidateMemories()` operates on `brain_observations` rows older than 30 days with overlapping stop-word-filtered keywords. It merges clusters into a single summary observation.

This is retained as the **observation-level consolidation** pass and runs as Step 2 in `cleo brain maintenance`.

### 6.2 Proposed: Graph-Based Consolidation

Graph consolidation operates at the node level, identifying densely connected subgraphs as consolidation candidates. It runs as a new Step 4 in `cleo brain maintenance`.

**Algorithm**:

1. Compute edge density per node: `density(n) = (outgoing_edges + incoming_edges) / 2`.
2. Identify a seed node: any node with `density >= minEdgeDensity` (default: 3).
3. Expand the cluster: BFS from seed, include neighbors where `density >= minEdgeDensity - 1`. Stop when no new members are found or `clusterSize > 20`.
4. If `clusterSize >= minClusterSize` (default: 4):
   a. Create a new `summary` node with `label = synthesize(member labels)` (concatenation of top-N labels by quality score, truncated to 250 chars).
   b. Connect all cluster members to the summary: `member → summarizes → summary` (weight = member.qualityScore).
   c. Downgrade member quality: `member.qualityScore *= 0.3` (they remain in the graph but de-prioritized).
   d. Connect the summary to all external nodes the cluster was connected to: `summary → <edgeType> → external_node` for every edge that crossed the cluster boundary.
5. Repeat until no new seed nodes qualify.

**When consolidation runs**:

- Automatically: `cleo session end` triggers a lightweight consolidation pass (minClusterSize=8 to avoid aggressive merging).
- On-demand: `cleo brain maintenance` with full settings.
- Manually: `cleo memory consolidate --dry-run` (preview) then without flag to execute.

**What gets merged vs. kept separate**:

| Scenario | Decision |
|----------|----------|
| 4+ observations about the same task, all from the same session | Merge into summary |
| 2 observations with similar content | Only create `contradicts` or `supports` edge, no merge |
| Decision + the observations that informed it | Keep separate; edge `observation → informed_by → decision` captures the link |
| Sticky notes older than 7 days with `status='active'` | Flag for conversion, not merged |
| Nodes with `qualityScore < 0.1` | Candidates for pruning, NOT for consolidation |

---

## 7. Integration Architecture

### 7.1 Topology Diagram

```
brain.db                              nexus.db
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  ━━━━━━━━━━━━━━━━━━━━━━━━━
brain_page_nodes   ←→   brain_page_edges      code_index (symbols)
    │                         │                     │
    │ shadow nodes             │ bridge edges         │
    │ type='file'              │ 'documents'          │
    │ type='symbol'            │ 'references'         │
    └──────────────────────────┴─────────── (hydrate on demand)
                                                      │
                                            nexus_relations
                                            (T513: calls, imports,
                                             extends, implements)
```

### 7.2 Connection Strategy

**Shared ID namespace** (no cross-DB foreign keys):
- `brain_page_nodes.id = 'symbol:' + code_index.id`
- `brain_page_nodes.id = 'file:' + filePath`

**Bridge edges** (in brain.db only):
- `observation:<obsId> → documents → file:<path>` — an observation documents a file
- `observation:<obsId> → references → symbol:<symbolId>` — an observation references a symbol
- `decision:<dId> → applies_to → file:<path>` — a decision applies to a file
- `decision:<dId> → applies_to → symbol:<symbolId>` — a decision applies to a symbol

**Hydration on demand**: When the SDK traverses to a `file` or `symbol` shadow node, it can optionally enrich the result by opening `nexus.db` (via `NexusSqlite`) and joining `code_index` on the source ID. This is opt-in via `TraverseOptions.hydrateNexus?: boolean` to avoid unnecessary cross-DB opens.

**No write from brain → nexus**: The brain graph never writes into nexus.db. Data flows one direction: code analysis writes `code_index`; brain observations create shadow nodes that reference those rows.

### 7.3 Unified Query Surface

Agents query the combined picture through `cleo memory context <id>` which, when given a `symbol:` or `file:` node ID, automatically hydrates from `nexus.db`:

```
cleo memory context symbol:src/store/brain-schema.ts::brainPageNodes
→ Shows: all observations that document this symbol,
         all decisions that apply to it,
         all sessions that modified its file,
         + nexus.db: callers, callees, containing module
```

---

## 8. Migration Plan

### 8.1 Phase 1 — Schema Migration (prerequisite: T523 purge complete)

Run after the noise-purge pass that reduces brain.db to its 57 real entries.

**Migration M-001** (Drizzle): Extend `brain_page_nodes`:
- Add columns: `qualityScore REAL NOT NULL DEFAULT 0.5`, `contentHash TEXT`, `lastActivityAt TEXT NOT NULL DEFAULT datetime('now')`, `updatedAt TEXT`.
- Change `nodeType` enum to the full 12-type list.
- Add indexes: `idx_brain_nodes_quality`, `idx_brain_nodes_content_hash`, `idx_brain_nodes_last_activity`.

**Migration M-002** (Drizzle): Extend `brain_page_edges`:
- Add columns: `weight REAL NOT NULL DEFAULT 1.0`, `provenance TEXT`.
- Change `edgeType` enum to the full 13-type list.
- Add indexes: `idx_brain_edges_type`, `idx_brain_edges_from_type`, `idx_brain_edges_to_type`.

Both migrations are additive (no column drops, no renames) — fully backward-compatible with existing read paths.

### 8.2 Phase 2 — Back-Fill Existing 57 Entries

A one-shot migration script (`packages/core/src/memory/brain-migration.ts::populateGraphFromTypedTables()`) walks each typed table and calls `graphSDK.store()` for each row.

```typescript
async function populateGraphFromTypedTables(projectRoot: string): Promise<void> {
  // 1. brain_decisions (5 rows) → decision:D-* nodes
  // 2. brain_observations (27 real rows) → observation:O-* nodes
  // 3. brain_sticky_notes (7 rows) → sticky:SN-* nodes
  // 4. brain_memory_links (5 rows) → convert to edges
  // 5. Skip patterns/learnings (all noise, being purged in Phase 1)
}
```

Triggered by `cleo upgrade` or `cleo brain maintenance --backfill-graph`.

### 8.3 Phase 3 — Wire Auto-Population Into Hooks

Hook attachment points (existing CANT hook infrastructure):

| Hook | CANT Event | Graph action |
|------|-----------|--------------|
| `tasks.complete` | `task:completed` | See §2.2 |
| `session.end` | `session:ended` | See §2.3 |
| `memory.observe` | `brain:observed` | See §2.1 |
| `memory.decide` | `brain:decided` | See §2.1 |
| `code.index` | `code:indexed` | See §2.4 |

All hooks call into `graphSDK` directly via the existing CANT hook-dispatch infrastructure. No new hook categories needed.

### 8.4 Phase 4 — New CLI Commands

New commands added to the `memory` domain in `packages/cleo/src/dispatch/domains/memory.ts`:

| Command | SDK function | Description |
|---------|-------------|-------------|
| `cleo memory trace <id> [--depth N] [--direction in/out/both]` | `traverse()` | Recursive graph walk |
| `cleo memory related <id> [--type <edgeType>]` | `query()` + 1-hop filter | Typed neighbors |
| `cleo memory chain <from> <to>` | `shortestPath()` | Shortest path between nodes |
| `cleo memory context <id>` | `context()` | 360-degree view |
| `cleo memory contradictions [--min-weight N]` | `contradictions()` | List conflict pairs |
| `cleo memory consolidate [--dry-run]` | `consolidate()` | Graph-based merge |
| `cleo memory graph-stats` | SQL count queries | Node/edge counts by type |

### 8.5 Backward Compatibility

All existing `cleo memory` commands (`find`, `fetch`, `timeline`, `observe`) continue to work unchanged. The graph layer is additive — it does not modify the read paths of existing typed table queries.

The `brain_memory_links` table is kept read-only through this release. A follow-on task can drop it after one full release cycle confirms no regressions.

### 8.6 Rollout Phases

| Phase | Scope | Gate |
|-------|-------|------|
| 1 | Schema migration (M-001, M-002) | `pnpm run build` passes |
| 2 | Back-fill script for 57 existing entries | `cleo memory graph-stats` shows expected counts |
| 3 | Hook wiring for auto-population | Integration tests: observe → verify node created |
| 4 | New CLI commands | BATS tests for each command |
| 5 | Contradiction detection enabled | `cleo memory contradictions` returns 0 false positives on real data |
| 6 | Graph consolidation in maintenance | `cleo brain maintenance` completes without errors |

---

## Appendix A: Quality Score Calculation

```
qualityScore = clamp(0.0, 1.0,
  base_confidence
  * age_factor
  * edge_density_bonus
  * provenance_multiplier
)

base_confidence:
  decision: high=0.9, medium=0.7, low=0.5
  observation: discoveryTokens present → 0.8, absent → 0.6
  learning: confidence field value (0.0-1.0)
  pattern: successRate field value (0.0-1.0), absent → 0.5
  task/session/file/symbol: 1.0 (structural, not decayed)

age_factor:
  decayRate ^ max(0, daysSinceLastActivity - 30)
  decayRate = 0.995 (default)

edge_density_bonus:
  min(1.2, 1.0 + 0.05 * outgoing_edge_count)
  (reward well-connected nodes, cap at 1.2x)

provenance_multiplier:
  agent-produced: 1.0
  session-debrief: 0.95
  claude-mem: 0.9
  manual: 0.85
```

---

## Appendix B: Drizzle Schema Changes Summary

The following additions/changes are needed to `packages/core/src/store/brain-schema.ts`:

1. Replace `BRAIN_NODE_TYPES` (4 items) with the 12-type enum defined in §1.2.
2. Replace `BRAIN_EDGE_TYPES` (4 items) with the 13-type enum defined in §1.3.
3. Add columns to `brainPageNodes`: `qualityScore`, `contentHash`, `lastActivityAt`, `updatedAt`.
4. Add columns to `brainPageEdges`: `weight` (already partially present), `provenance`.
5. Add 4 new indexes to `brainPageNodes`, 3 new indexes to `brainPageEdges`.
6. Export new type constants: `BrainNodeType`, `BrainEdgeType`.
7. Update `BrainPageNodeRow` and `BrainPageEdgeRow` inferred types automatically.

---

## Appendix C: Excluded Approaches

| Approach | Reason Excluded |
|----------|----------------|
| KuzuDB / LadybugDB as dependency | 50 MB C++ binary, complicates distribution |
| Cypher query language | Incompatible with SQLite; recursive CTEs achieve the same result |
| Full migration to nodes+edges only (Option B) | Destroys typed schema, breaks all existing commands |
| New `@cleocode/memory-sdk` package | Unnecessary complexity, circular dep risk, existing core module is the right home |
| Vector similarity as primary traversal | sqlite-vec not installed; embeddings are opt-in enrichment only |
| Cross-DB foreign keys (brain ↔ nexus) | SQLite does not support cross-DB FK constraints |
