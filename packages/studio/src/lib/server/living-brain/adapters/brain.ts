/**
 * BRAIN substrate adapter for the Living Brain API.
 *
 * Queries brain.db and returns LBNodes/LBEdges for all typed memory tables:
 * observations, decisions, patterns, learnings, plus the graph layer
 * (brain_page_nodes / brain_page_edges).
 *
 * Node IDs are prefixed with "brain:" to prevent collisions.
 */

import { getBrainDb } from '../../db/connections.js';
import type { LBEdge, LBNode, LBQueryOptions } from '../types.js';

/** Raw row from brain_observations. */
interface ObservationRow {
  id: string;
  title: string;
  quality_score: number | null;
  memory_tier: string | null;
  created_at: string;
  source_session_id: string | null;
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
  title: string;
  quality_score: number | null;
  created_at: string;
}

/** Raw row from brain_learnings. */
interface LearningRow {
  id: string;
  title: string;
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

/**
 * Returns all LBNodes and LBEdges sourced from brain.db.
 *
 * Pulls from all four typed memory tables plus brain_page_edges.
 * Applies `minWeight` filter where quality_score is available.
 * Node count is bounded by `limit / 5` to share budget with other substrates.
 *
 * @param options - Query options (limit, minWeight).
 * @returns Nodes and edges from the BRAIN substrate.
 */
export function getBrainSubstrate(options: LBQueryOptions = {}): {
  nodes: LBNode[];
  edges: LBEdge[];
} {
  const db = getBrainDb();
  if (!db) return { nodes: [], edges: [] };

  const minWeight = options.minWeight ?? 0;
  const perSubstrateLimit = Math.ceil((options.limit ?? 500) / 5);

  const nodes: LBNode[] = [];
  const edges: LBEdge[] = [];

  try {
    // Observations
    const obsRows = db
      .prepare(
        `SELECT id, title, quality_score, memory_tier, created_at, source_session_id
         FROM brain_observations
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(minWeight, Math.ceil(perSubstrateLimit * 0.4)) as ObservationRow[];

    for (const row of obsRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'observation',
        substrate: 'brain',
        label: row.title,
        weight: row.quality_score ?? undefined,
        meta: {
          memory_tier: row.memory_tier,
          created_at: row.created_at,
          source_session_id: row.source_session_id,
        },
      });
    }

    // Decisions
    const decRows = db
      .prepare(
        `SELECT id, decision, quality_score, context_task_id, created_at
         FROM brain_decisions
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(minWeight, Math.ceil(perSubstrateLimit * 0.25)) as DecisionRow[];

    for (const row of decRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'decision',
        substrate: 'brain',
        label: row.decision.slice(0, 100),
        weight: row.quality_score ?? undefined,
        meta: {
          context_task_id: row.context_task_id,
          created_at: row.created_at,
        },
      });
    }

    // Patterns
    const patRows = db
      .prepare(
        `SELECT id, title, quality_score, created_at
         FROM brain_patterns
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(minWeight, Math.ceil(perSubstrateLimit * 0.2)) as PatternRow[];

    for (const row of patRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'pattern',
        substrate: 'brain',
        label: row.title,
        weight: row.quality_score ?? undefined,
        meta: { created_at: row.created_at },
      });
    }

    // Learnings
    const learnRows = db
      .prepare(
        `SELECT id, title, quality_score, created_at
         FROM brain_learnings
         WHERE (quality_score IS NULL OR quality_score >= ?)
         ORDER BY quality_score DESC, created_at DESC
         LIMIT ?`,
      )
      .all(minWeight, Math.ceil(perSubstrateLimit * 0.15)) as LearningRow[];

    for (const row of learnRows) {
      nodes.push({
        id: `brain:${row.id}`,
        kind: 'learning',
        substrate: 'brain',
        label: row.title,
        weight: row.quality_score ?? undefined,
        meta: { created_at: row.created_at },
      });
    }

    // Edges from brain_page_edges (only between nodes we loaded)
    const nodeIds = new Set(nodes.map((n) => n.id));
    // Strip prefix for DB lookup — edges reference raw IDs
    const rawIds = new Set([...nodeIds].map((id) => id.replace(/^brain:/, '')));

    const pageEdgeRows = db
      .prepare(`SELECT from_id, to_id, edge_type, weight FROM brain_page_edges`)
      .all() as PageEdgeRow[];

    for (const row of pageEdgeRows) {
      if (rawIds.has(row.from_id) && rawIds.has(row.to_id)) {
        edges.push({
          source: `brain:${row.from_id}`,
          target: `brain:${row.to_id}`,
          type: row.edge_type,
          weight: row.weight ?? 0.5,
          substrate: 'brain',
        });
      }
    }

    // Cross-substrate: decision → task edges (soft FK via context_task_id)
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
