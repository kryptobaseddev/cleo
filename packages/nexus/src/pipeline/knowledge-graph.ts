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
import type {
  GraphNode,
  GraphPublicationRows,
  GraphRelation,
  NexusNodeInsertRow,
  NexusRelationInsertRow,
} from '@cleocode/contracts';
import type { Column } from 'drizzle-orm';

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
 * Structural typing for an injected Drizzle table — the runtime object is
 * a Drizzle SQLiteTable whose columns appear as enumerable properties whose
 * values are {@link Column} instances. We accept any string-keyed columns
 * here so we can `nexusNodes['projectId']` for `eq()` without going through
 * `as unknown as Column` per call site (T9767).
 *
 * Operations that need the raw table identity (e.g. `db.select().from(...)`)
 * pass the value through to drizzle which treats it as opaque — the index
 * signature does not interfere because drizzle's runtime ignores it.
 */
export type DrizzleTableRef = { [columnName: string]: Column };

/**
 * Drizzle table references passed to the flush function.
 * Allows the pipeline to remain decoupled from `@cleocode/core` internals.
 */
export interface NexusTables {
  /** The `nexus_nodes` Drizzle table object. */
  nexusNodes: DrizzleTableRef;
  /** The `nexus_relations` Drizzle table object. */
  nexusRelations: DrizzleTableRef;
}

// ---------------------------------------------------------------------------
// Row types (matches nexus-schema.ts NewNexusNodeRow / NewNexusRelationRow)
// ---------------------------------------------------------------------------

// ADR-090 · T11648: the graph tables are PROJECT-scoped (one project per
// `cleo.db`), so `project_id` was dropped from `nexus_nodes` / `nexus_relations`.
// The insert rows below therefore no longer carry `projectId`.

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
  /** Serialize and validate the staged generation before opening a write transaction. */
  preparePublication(): GraphPublicationRows;
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

  function canonicalEndpoint(id: string): string {
    if (nodes.has(id) || !id.endsWith('::__file__')) return id;
    const filePath = id.slice(0, -'::__file__'.length);
    const file = nodes.get(filePath);
    return file?.kind === 'file' && file.filePath === filePath ? filePath : id;
  }

  function addRelation(rel: GraphRelation): void {
    rel = { ...rel, source: canonicalEndpoint(rel.source), target: canonicalEndpoint(rel.target) };
    const key = `${rel.source}::${rel.target}::${rel.type}`;
    if (!relationKeys.has(key)) {
      relationKeys.add(key);
      relations.push(rel);
    }
  }

  function preparePublication(): GraphPublicationRows {
    const now = new Date().toISOString();

    // Build node insert rows (ADR-090 · T11648 — no `projectId`).
    const nodeRows: NexusNodeInsertRow[] = [];
    for (const node of nodes.values()) {
      nodeRows.push({
        id: node.id,
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
        metaJson:
          node.meta || node.isExternal !== undefined
            ? JSON.stringify({
                ...node.meta,
                ...(node.isExternal !== undefined ? { isExternal: node.isExternal } : {}),
              })
            : null,
        indexedAt: now,
      });
    }

    // Build relation insert rows (ADR-090 · T11648 — no `projectId`).
    const relationRows: NexusRelationInsertRow[] = [];
    for (const rel of relations) {
      relationRows.push({
        id: randomUUID(),
        sourceId: rel.source,
        targetId: rel.target,
        type: rel.type,
        confidence: rel.confidence,
        reason: rel.reason ?? null,
        step: null,
        indexedAt: now,
      });
    }

    for (const relation of relations) {
      if (!nodes.has(relation.source) || !nodes.has(relation.target)) {
        throw new Error(`Invalid graph relationship: ${relation.source} -> ${relation.target}`);
      }
      if (
        !Number.isFinite(relation.confidence) ||
        relation.confidence < 0 ||
        relation.confidence > 1
      ) {
        throw new Error(`Invalid graph confidence: ${relation.source} -> ${relation.target}`);
      }
    }
    return { nodes: nodeRows, relations: relationRows };
  }

  async function flush(_projectId: string, db: NexusDbInsert, tables: NexusTables): Promise<void> {
    const { nodes: nodeRows, relations: relationRows } = preparePublication();

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
    preparePublication,
  };
}
