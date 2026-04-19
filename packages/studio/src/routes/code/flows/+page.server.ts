/**
 * /code/flows — execution-flow tracer.
 *
 * Surfaces entry-points + their fanout computed from `calls` edges.
 * If nexus.db contains process / flow-step rows we use them directly;
 * otherwise we compute a synthetic "flow" per entry-point by BFS-ing
 * `calls` edges up to `MAX_DEPTH` hops.
 *
 * @task T990
 * @wave 1B
 */

import { getNexusDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

/** How deep the synthetic call-graph BFS traces. */
const MAX_DEPTH = 3;
/** How many fanout nodes we emit per flow before truncation. */
const MAX_FANOUT = 60;
/** How many entry points we surface in the side list. */
const MAX_FLOWS = 64;

export interface FlowSummary {
  /** Entry-point node id. */
  id: string;
  /** Entry-point label. */
  label: string;
  /** Entry-point kind (function / method / route / …). */
  kind: string;
  /** Optional file path for the entry-point. */
  filePath: string;
  /** Nodes reached by BFS — first entry is always the entry-point. */
  reachIds: string[];
}

export interface FlowNode {
  id: string;
  label: string;
  kind: string;
  filePath: string;
  communityId: string | null;
}

export interface FlowEdge {
  source: string;
  target: string;
  type: string;
  /** Optional step index when derived from `step_in_process` edges. */
  stepIndex?: number;
}

export interface FlowsPageData {
  flows: FlowSummary[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  hasProcesses: boolean;
  empty: boolean;
}

export const load: PageServerLoad = () => {
  const db = getNexusDb();
  if (!db) {
    return {
      flows: [],
      nodes: [],
      edges: [],
      hasProcesses: false,
      empty: true,
    } satisfies FlowsPageData;
  }

  // Entry points — prefer the explicit `entry_point_of` edge when present.
  const entryRows = db
    .prepare(
      `SELECT DISTINCT n.id, n.label, n.kind, n.file_path
       FROM nexus_relations r
       JOIN nexus_nodes n ON r.source_id = n.id
       WHERE r.type = 'entry_point_of'
       LIMIT ?`,
    )
    .all(MAX_FLOWS) as {
    id: string;
    label: string;
    kind: string;
    file_path: string | null;
  }[];

  // Fallback: symbols with the highest out-degree on `calls` edges.
  let finalEntries = entryRows;
  if (entryRows.length === 0) {
    const fallback = db
      .prepare(
        `SELECT n.id, n.label, n.kind, n.file_path, COUNT(*) AS out_deg
         FROM nexus_relations r
         JOIN nexus_nodes n ON n.id = r.source_id
         WHERE r.type = 'calls'
         GROUP BY n.id
         ORDER BY out_deg DESC
         LIMIT ?`,
      )
      .all(MAX_FLOWS) as {
      id: string;
      label: string;
      kind: string;
      file_path: string | null;
      out_deg: number;
    }[];
    finalEntries = fallback.map(({ id, label, kind, file_path }) => ({
      id,
      label,
      kind,
      file_path,
    }));
  }

  const hasProcesses = entryRows.length > 0;

  // For each entry-point, BFS up to MAX_DEPTH along `calls`.
  const reach = new Map<string, string[]>();
  const allNodeIds = new Set<string>();
  for (const entry of finalEntries) {
    const reached: string[] = [entry.id];
    const seen = new Set<string>([entry.id]);
    const queue: { id: string; depth: number }[] = [{ id: entry.id, depth: 0 }];
    while (queue.length > 0 && reached.length < MAX_FANOUT) {
      const cur = queue.shift();
      if (!cur) break;
      if (cur.depth >= MAX_DEPTH) continue;
      const rows = db
        .prepare(
          `SELECT target_id
           FROM nexus_relations
           WHERE source_id = ?
             AND type IN ('calls','step_in_process','handles_route','handles_tool','fetches')
           LIMIT 20`,
        )
        .all(cur.id) as { target_id: string }[];
      for (const row of rows) {
        if (seen.has(row.target_id)) continue;
        seen.add(row.target_id);
        reached.push(row.target_id);
        queue.push({ id: row.target_id, depth: cur.depth + 1 });
        if (reached.length >= MAX_FANOUT) break;
      }
    }
    reach.set(entry.id, reached);
    for (const id of reached) allNodeIds.add(id);
  }

  // Pull full node data for every id in scope.
  const nodes: FlowNode[] = [];
  if (allNodeIds.size > 0) {
    const idList = [...allNodeIds];
    const placeholders = idList.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT id, label, kind, file_path, community_id
         FROM nexus_nodes
         WHERE id IN (${placeholders})`,
      )
      .all(...idList) as {
      id: string;
      label: string;
      kind: string;
      file_path: string | null;
      community_id: string | null;
    }[];
    for (const row of rows) {
      nodes.push({
        id: row.id,
        label: row.label,
        kind: row.kind,
        filePath: row.file_path ?? '',
        communityId: row.community_id,
      });
    }
  }

  // Pull the edges in scope.
  const edges: FlowEdge[] = [];
  if (allNodeIds.size > 0) {
    const idList = [...allNodeIds];
    const placeholders = idList.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT source_id, target_id, type, step
         FROM nexus_relations
         WHERE source_id IN (${placeholders}) AND target_id IN (${placeholders})
         LIMIT 2000`,
      )
      .all(...idList, ...idList) as {
      source_id: string;
      target_id: string;
      type: string;
      step: number | null;
    }[];
    for (const row of rows) {
      edges.push({
        source: row.source_id,
        target: row.target_id,
        type: row.type,
        stepIndex: row.step ?? undefined,
      });
    }
  }

  const flows: FlowSummary[] = finalEntries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    kind: entry.kind,
    filePath: entry.file_path ?? '',
    reachIds: reach.get(entry.id) ?? [entry.id],
  }));

  return {
    flows,
    nodes,
    edges,
    hasProcesses,
    empty: flows.length === 0,
  } satisfies FlowsPageData;
};
