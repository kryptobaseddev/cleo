/**
 * BRAIN substrate adapter for the Living Brain API.
 *
 * Queries brain.db and returns BrainNodes/BrainEdges for all typed memory tables:
 * observations, decisions, patterns, learnings, plus the graph layer
 * (brain_page_nodes / brain_page_edges).
 *
 * Cross-substrate bridges are synthesized for:
 * - brain_page_edges whose to_id references a task (task:T-xxx → tasks:T-xxx)
 * - brain_page_edges whose to_id is a nexus-style path (foo.ts::Symbol → nexus:...)
 * - brain_memory_links rows (memory_type + memory_id → task_id link)
 * - brain_observations.files_modified_json (observation → nexus file path)
 *
 * Node IDs are prefixed with "brain:" to prevent collisions.
 */

import { allTyped, getBrainDb } from '../db-connections.js';
import { resolveDefaultProjectContext } from '../project-context.js';
import type { BrainEdge, BrainNode, BrainQueryOptions } from '../types.js';

/** Raw row from brain_observations. */
interface ObservationRow {
  id: string;
  title: string;
  quality_score: number | null;
  memory_tier: string | null;
  created_at: string;
  source_session_id: string | null;
  files_modified_json: string | null;
}

/** Raw row from brain_decisions. */
interface DecisionRow {
  id: string;
  decision: string;
  quality_score: number | null;
  context_task_id: string | null;
  created_at: string;
}

/** Raw row from brain_patterns. */
interface PatternRow {
  id: string;
  /** The main pattern text (brain_patterns.pattern column). */
  pattern: string;
  type: string;
  quality_score: number | null;
  /** brain_patterns uses extracted_at, not created_at. */
  extracted_at: string;
}

/** Raw row from brain_learnings. */
interface LearningRow {
  id: string;
  /** The main insight text (brain_learnings.insight column). */
  insight: string;
  quality_score: number | null;
  created_at: string;
}

/** Raw row from brain_page_edges. */
interface PageEdgeRow {
  from_id: string;
  to_id: string;
  edge_type: string;
  weight: number;
}

/** Raw row from brain_memory_links. */
interface MemoryLinkRow {
  memory_type: string;
  memory_id: string;
  task_id: string;
  link_type: string;
}

/**
 * Converts a brain_page_edges type-prefixed ID (e.g. "observation:O-abc")
 * into the BrainNode ID prefix (e.g. "brain:O-abc").
 *
 * Returns null when the prefix is not a recognised brain type.
 *
 * @param typeId - Type-prefixed ID from brain_page_edges.from_id or to_id.
 * @returns BrainNode-prefixed ID or null.
 */
function brainTypeIdToBrainNodeId(typeId: string): string | null {
  const sep = typeId.indexOf(':');
  if (sep === -1) return null;
  const prefix = typeId.slice(0, sep);
  const rawId = typeId.slice(sep + 1);
  if (
    prefix === 'observation' ||
    prefix === 'decision' ||
    prefix === 'pattern' ||
    prefix === 'learning'
  ) {
    return `brain:${rawId}`;
  }
  return null;
}

/**
 * Returns true when a brain_page_edges to_id looks like a nexus node path
 * (contains "::" separator used by nexus for file::Symbol paths, or is a
 * relative file path with a known extension).
 *
 * @param toId - to_id value from brain_page_edges.
 * @returns True when the ID appears to reference a nexus node.
 */
function isNexusStyleId(toId: string): boolean {
  // Nexus symbol IDs contain :: (file::SymbolName)
  if (toId.includes('::')) return true;
  // Nexus file IDs are relative paths (no type: prefix, contain a /)
  if (!toId.includes(':') && toId.includes('/')) return true;
  return false;
}

/**
 * Returns true when a brain_page_edges ID looks like a task reference
 * (e.g. "task:T532").
 *
 * @param id - ID from brain_page_edges.
 * @returns True when the ID references a task node.
 */
function isTaskId(id: string): boolean {
  return id.startsWith('task:');
}

/**
 * Converts a brain_page_edges task-reference to a tasks-substrate BrainNode ID.
 * e.g. "task:T532" → "tasks:T532"
 *
 * @param taskRef - Task reference from brain_page_edges.
 * @returns tasks-substrate BrainNode ID.
 */
function taskRefToBrainNodeId(taskRef: string): string {
  return `tasks:${taskRef.slice('task:'.length)}`;
}

/**
 * Returns all BrainNodes and BrainEdges sourced from brain.db.
 *
 * Pulls from all four typed memory tables plus brain_page_edges.
 * Emits intra-brain edges between loaded nodes, cross-substrate
 * brain→tasks bridges, cross-substrate brain→nexus bridges, and
 * brain_memory_links as cross-substrate edges.
 *
 * Applies `minWeight` filter where quality_score is available.
 * Node count is bounded by `limit / 5` to share budget with other substrates.
 *
 * @param options - Query options (limit, minWeight).
 * @returns Nodes and edges from the BRAIN substrate.
 */
export function getBrainSubstrate(options: BrainQueryOptions = {}): {
  nodes: BrainNode[];
  edges: BrainEdge[];
} {
  const ctx = options.projectCtx ?? resolveDefaultProjectContext();
  const db = getBrainDb(ctx);
  if (!db) return { nodes: [], edges: [] };

  const minWeight = options.minWeight ?? 0;
  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: BrainNode[] = [];
  const edges: BrainEdge[] = [];

  try {
    // Observations — normalise created_at to ISO-8601 with 'T' separator via strftime
    const obsRows = allTyped<ObservationRow>(
      db.prepare(
        `SELECT id, title, quality_score, memory_tier,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at,
                source_session_id, files_modified_json
         FROM brain_observations
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      ),
      minWeight,
      Math.ceil(perSubstrateLimit * 0.4),
    );

    for (const row of obsRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'observation',
        substrate: 'brain',
        label: row.title,
        weight: row.quality_score ?? undefined,
        createdAt: row.created_at,
        meta: {
          memory_tier: row.memory_tier,
          created_at: row.created_at,
          source_session_id: row.source_session_id,
        },
      });
    }

    // Decisions — normalise created_at to ISO-8601 with 'T' separator via strftime
    const decRows = allTyped<DecisionRow>(
      db.prepare(
        `SELECT id, decision, quality_score, context_task_id,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at
         FROM brain_decisions
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      ),
      minWeight,
      Math.ceil(perSubstrateLimit * 0.25),
    );

    for (const row of decRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'decision',
        substrate: 'brain',
        label: row.decision.slice(0, 100),
        weight: row.quality_score ?? undefined,
        createdAt: row.created_at,
        meta: {
          context_task_id: row.context_task_id,
          created_at: row.created_at,
        },
      });
    }

    // Patterns — uses 'pattern' text column (not 'title') and 'extracted_at' (not 'created_at').
    // SQLite strftime is used to normalise the timestamp to ISO-8601 with 'T' separator.
    const patRows = allTyped<PatternRow>(
      db.prepare(
        `SELECT id, pattern, type, quality_score,
                strftime('%Y-%m-%dT%H:%M:%S', extracted_at) AS extracted_at
         FROM brain_patterns
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, extracted_at DESC
         LIMIT ?`,
      ),
      minWeight,
      Math.ceil(perSubstrateLimit * 0.2),
    );

    for (const row of patRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'pattern',
        substrate: 'brain',
        label: row.pattern.slice(0, 100),
        weight: row.quality_score ?? undefined,
        createdAt: row.extracted_at,
        meta: { pattern_type: row.type, created_at: row.extracted_at },
      });
    }

    // Learnings — uses 'insight' text column (not 'title').
    // Normalise created_at to ISO-8601 with 'T' separator via strftime.
    const learnRows = allTyped<LearningRow>(
      db.prepare(
        `SELECT id, insight, quality_score,
                strftime('%Y-%m-%dT%H:%M:%S', created_at) AS created_at
         FROM brain_learnings
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      ),
      minWeight,
      Math.ceil(perSubstrateLimit * 0.15),
    );

    for (const row of learnRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'learning',
        substrate: 'brain',
        label: row.insight.slice(0, 100),
        weight: row.quality_score ?? undefined,
        createdAt: row.created_at,
        meta: { created_at: row.created_at },
      });
    }

    // Build lookup: type-prefixed ID (e.g. "observation:O-abc") → BrainNode ID
    // (e.g. "brain:O-abc"). This is needed because brain_page_edges stores
    // IDs in type-prefixed format while BrainNode IDs use the "brain:" prefix.
    const typeIdToBrainNodeId = new Map<string, string>();
    for (const n of nodes) {
      const rawId = n.id.slice('brain:'.length);
      // Determine which type prefix this node would have in brain_page_edges
      let typePrefix: string;
      if (n.kind === 'observation') typePrefix = 'observation';
      else if (n.kind === 'decision') typePrefix = 'decision';
      else if (n.kind === 'pattern') typePrefix = 'pattern';
      else typePrefix = 'learning';
      typeIdToBrainNodeId.set(`${typePrefix}:${rawId}`, n.id);
    }

    // brain_page_edges: query all and classify each edge
    const pageEdgeRows = allTyped<PageEdgeRow>(
      db.prepare(`SELECT from_id, to_id, edge_type, weight FROM brain_page_edges`),
    );

    for (const row of pageEdgeRows) {
      const sourceBrainNodeId =
        typeIdToBrainNodeId.get(row.from_id) ?? brainTypeIdToBrainNodeId(row.from_id);
      if (!sourceBrainNodeId) continue; // source not a recognised brain node

      if (isTaskId(row.to_id)) {
        // Cross-substrate: brain → tasks
        edges.push({
          source: sourceBrainNodeId,
          target: taskRefToBrainNodeId(row.to_id),
          type: row.edge_type,
          weight: row.weight ?? 0.5,
          substrate: 'cross',
        });
      } else if (isNexusStyleId(row.to_id)) {
        // Cross-substrate: brain → nexus (code_reference, etc.)
        edges.push({
          source: sourceBrainNodeId,
          target: `nexus:${row.to_id}`,
          type: row.edge_type,
          weight: row.weight ?? 0.5,
          substrate: 'cross',
        });
      } else {
        // Intra-brain: both IDs should be brain nodes
        const targetBrainNodeId =
          typeIdToBrainNodeId.get(row.to_id) ?? brainTypeIdToBrainNodeId(row.to_id);
        if (targetBrainNodeId) {
          edges.push({
            source: sourceBrainNodeId,
            target: targetBrainNodeId,
            type: row.edge_type,
            weight: row.weight ?? 0.5,
            substrate: 'brain',
          });
        }
      }
    }

    // brain_memory_links: cross-substrate edges from typed memory nodes to tasks
    const memLinkRows = allTyped<MemoryLinkRow>(
      db.prepare(
        `SELECT memory_type, memory_id, task_id, link_type
         FROM brain_memory_links`,
      ),
    );

    for (const row of memLinkRows) {
      const sourceTypeId = `${row.memory_type}:${row.memory_id}`;
      const sourceBrainNodeId =
        typeIdToBrainNodeId.get(sourceTypeId) ?? brainTypeIdToBrainNodeId(sourceTypeId);
      if (!sourceBrainNodeId) continue; // source node not in loaded set
      edges.push({
        source: sourceBrainNodeId,
        target: `tasks:${row.task_id}`,
        type: row.link_type,
        weight: 0.7,
        substrate: 'cross',
      });
    }

    // brain_observations.files_modified_json: cross-substrate observation → nexus file
    for (const row of obsRows) {
      if (!row.files_modified_json) continue;
      let filePaths: unknown;
      try {
        filePaths = JSON.parse(row.files_modified_json);
      } catch {
        continue;
      }
      if (!Array.isArray(filePaths)) continue;
      const sourceBrainNodeId = `brain:${row.id}`;
      for (const rawPath of filePaths) {
        if (typeof rawPath !== 'string' || rawPath.length === 0) continue;
        edges.push({
          source: sourceBrainNodeId,
          target: `nexus:${rawPath}`,
          type: 'modified_by',
          weight: 0.6,
          substrate: 'cross',
        });
      }
    }

    // Soft FK: brain_decisions.context_task_id → tasks (direct, not via page_edges)
    // This handles decisions whose context_task_id may not yet appear in brain_page_edges.
    for (const dec of decRows) {
      if (dec.context_task_id) {
        edges.push({
          source: `brain:${dec.id}`,
          target: `tasks:${dec.context_task_id}`,
          type: 'applies_to',
          weight: 0.8,
          substrate: 'cross',
        });
      }
    }
  } catch {
    // Return partial results on error
  }

  return { nodes, edges };
}
