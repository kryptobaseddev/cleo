/**
 * In-memory KnowledgeGraph — assembled during ingestion, flushed to Drizzle.
 *
 * The KnowledgeGraph is the central data structure for a single ingestion run.
 * All pipeline phases (filesystem walker, structure processor, future symbol
 * extractors) write nodes and relations into this graph. When all phases
 * complete, `flush()` batch-inserts the collected data into the
 * `nexus_nodes` and `nexus_relations` tables via an injected Drizzle database.
 *
 * Design choices:
 * - No import from `@cleocode/core` — nexus cannot circularly depend on core.
 *   The caller is responsible for providing a Drizzle DB instance.
 * - Nodes are deduplicated by ID (Map semantics: addNode is idempotent).
 * - Relations are deduplicated by `source + target + type` composite key.
 * - Flush uses chunk-based batch inserts (CHUNK_SIZE nodes per statement) to
 *   keep individual SQLite transactions within the parameter limit.
 *
 * @task T532
 * @module pipeline/knowledge-graph
 */

import { randomUUID } from 'node:crypto';
import type { GraphNode, GraphRelation } from '@cleocode/contracts';

// ---------------------------------------------------------------------------
// Database interface (injected — avoids circular import from core)
// ---------------------------------------------------------------------------

/**
 * Minimal Drizzle-like insert interface required by `KnowledgeGraph.flush()`.
 *
 * This intentionally omits the full Drizzle typing to avoid importing
 * `@cleocode/core`. Callers should pass the result of `getNexusDb()` from
 * `@cleocode/core/store/nexus-sqlite` — it satisfies this interface.
 */
export interface NexusDbInsert {
  /** Drizzle insert function for the nexus_nodes table. */
  insert: (table: unknown) => {
    values: (rows: unknown[]) => {
      onConflictDoNothing: () => Promise<unknown>;
    };
  };
}

/**
 * Drizzle table references passed to the flush function.
 * Allows the pipeline to remain decoupled from `@cleocode/core` internals.
 */
export interface NexusTables {
  /** The `nexus_nodes` Drizzle table object. */
  nexusNodes: unknown;
  /** The `nexus_relations` Drizzle table object. */
  nexusRelations: unknown;
}

// ---------------------------------------------------------------------------
// Row types (matches nexus-schema.ts NewNexusNodeRow / NewNexusRelationRow)
// ---------------------------------------------------------------------------

/** Insert row shape for nexus_nodes. */
interface NexusNodeInsertRow {
  id: string;
  projectId: string;
  kind: string;
  label: string;
  name: string | null;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
  isExported: boolean;
  parentId: string | null;
  parametersJson: string | null;
  returnType: string | null;
  docSummary: string | null;
  communityId: string | null;
  metaJson: string | null;
  indexedAt: string;
}

/** Insert row shape for nexus_relations. */
interface NexusRelationInsertRow {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  type: string;
  confidence: number;
  reason: string | null;
  step: number | null;
  indexedAt: string;
}

// ---------------------------------------------------------------------------
// KnowledgeGraph implementation
// ---------------------------------------------------------------------------

/** Batch size for Drizzle insert chunks (stays within SQLite param limits). */
const CHUNK_SIZE = 500;

/**
 * The in-memory KnowledgeGraph assembled during a single ingestion run.
 *
 * Implements the {@link KnowledgeGraph} contract from `@cleocode/contracts`
 * and adds the `flush()` method for persisting to Drizzle.
 */
export interface KnowledgeGraph {
  /** Primary node store: nodeId → GraphNode. */
  nodes: Map<string, GraphNode>;
  /** All directed edges (appended during ingestion). */
  relations: GraphRelation[];
  /** Add a node (idempotent — duplicate IDs are silently skipped). */
  addNode(node: GraphNode): void;
  /** Add a directed relation (deduplicated by source + target + type). */
  addRelation(rel: GraphRelation): void;
  /**
   * Flush all nodes and relations to `nexus_nodes` + `nexus_relations`.
   *
   * Uses `onConflictDoNothing` so re-indexing a project is safe: existing
   * rows are left intact and new rows are inserted.
   *
   * @param projectId - Project registry ID to scope the rows
   * @param db - Drizzle database instance (from getNexusDb())
   * @param tables - Table references ({ nexusNodes, nexusRelations })
   */
  flush(projectId: string, db: NexusDbInsert, tables: NexusTables): Promise<void>;
}

/**
 * Create a new empty KnowledgeGraph.
 *
 * @returns A fresh in-memory graph ready for ingestion.
 */
export function createKnowledgeGraph(): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const relations: GraphRelation[] = [];
  /** Dedup set for relations: `${source}::${target}::${type}` */
  const relationKeys = new Set<string>();

  function addNode(node: GraphNode): void {
    if (!nodes.has(node.id)) {
      nodes.set(node.id, node);
    }
  }

  function addRelation(rel: GraphRelation): void {
    const key = `${rel.source}::${rel.target}::${rel.type}`;
    if (!relationKeys.has(key)) {
      relationKeys.add(key);
      relations.push(rel);
    }
  }

  async function flush(projectId: string, db: NexusDbInsert, tables: NexusTables): Promise<void> {
    const now = new Date().toISOString();

    // Build node insert rows
    const nodeRows: NexusNodeInsertRow[] = [];
    for (const node of nodes.values()) {
      nodeRows.push({
        id: node.id,
        projectId,
        kind: node.kind,
        label: node.name || node.id,
        name: node.name || null,
        filePath: node.filePath || null,
        startLine: node.startLine ?? null,
        endLine: node.endLine ?? null,
        language: node.language || null,
        isExported: node.exported ?? false,
        parentId: node.parent ?? null,
        parametersJson: node.parameters ? JSON.stringify(node.parameters) : null,
        returnType: node.returnType ?? null,
        docSummary: node.docSummary ?? null,
        communityId: node.communityId ?? null,
        metaJson: node.meta ? JSON.stringify(node.meta) : null,
        indexedAt: now,
      });
    }

    // Build relation insert rows
    const relationRows: NexusRelationInsertRow[] = [];
    for (const rel of relations) {
      relationRows.push({
        id: randomUUID(),
        projectId,
        sourceId: rel.source,
        targetId: rel.target,
        type: rel.type,
        confidence: rel.confidence,
        reason: rel.reason ?? null,
        step: null,
        indexedAt: now,
      });
    }

    // Chunk-insert nodes
    for (let i = 0; i < nodeRows.length; i += CHUNK_SIZE) {
      const chunk = nodeRows.slice(i, i + CHUNK_SIZE);
      if (chunk.length > 0) {
        await db.insert(tables.nexusNodes).values(chunk).onConflictDoNothing();
      }
    }

    // Chunk-insert relations
    for (let i = 0; i < relationRows.length; i += CHUNK_SIZE) {
      const chunk = relationRows.slice(i, i + CHUNK_SIZE);
      if (chunk.length > 0) {
        await db.insert(tables.nexusRelations).values(chunk).onConflictDoNothing();
      }
    }
  }

  return {
    nodes,
    relations,
    addNode,
    addRelation,
    flush,
  };
}
