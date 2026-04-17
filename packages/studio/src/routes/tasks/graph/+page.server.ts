/**
 * Tasks Relations Graph — server load.
 *
 * Ships a compact nodes+edges payload describing the task hierarchy
 * (`parent_id` edges) plus depends and blocked_by overlay edges. The
 * client renders it as a lightweight 2D force-directed SVG graph (no
 * heavy 3D libs) so the page stays navigable on any device.
 *
 * Query params:
 *   - `?archived=1` — include archived rows (default: excluded to match
 *                     the Tasks Dashboard convention).
 *   - `?epic=TXXX`  — restrict the graph to one epic's subtree (reachable
 *                     descendants of TXXX via parent_id).
 *
 * @task T879
 * @epic T876 (owner-labelled T900)
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

export interface GraphNode {
  id: string;
  title: string;
  type: string | null;
  status: string;
  priority: string;
  pipelineStage: string | null;
  parentId: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  /** Kind of relationship — 'parent' (hierarchy), 'blocks' or 'depends' (overlay). */
  kind: 'parent' | 'blocks' | 'depends';
}

export interface GraphFilters {
  showArchived: boolean;
  epic: string | null;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  filters: GraphFilters;
  /** Totals so the header can display a quick summary. */
  counts: {
    nodes: number;
    parentEdges: number;
    blocksEdges: number;
    dependsEdges: number;
  };
}

/**
 * Minimal DB shape — kept local so we can test against an in-memory sqlite
 * without pulling the full SvelteKit locals type.
 */
export interface GraphDbLike {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Compute the graph payload from a SQLite tasks.db.
 *
 * Pure function for testability. Keeps the load() handler a thin adapter
 * over `getTasksDb` + this builder.
 *
 * @task T879
 */
export function _computeGraph(
  db: GraphDbLike,
  options: { includeArchived?: boolean; epicSubtree?: string | null } = {},
): GraphData {
  const { includeArchived = false, epicSubtree = null } = options;
  const statusFilter = includeArchived ? '' : `WHERE status != 'archived'`;

  // ------------------------------------------------------------------
  // 1. Load node set
  // ------------------------------------------------------------------
  const rawNodes = db
    .prepare(
      `SELECT id, title, type, status, priority, pipeline_stage AS pipelineStage, parent_id AS parentId, blocked_by
         FROM tasks
         ${statusFilter}`,
    )
    .all() as Array<
    GraphNode & {
      blocked_by: string | null;
    }
  >;

  // ------------------------------------------------------------------
  // 2. Optional subtree restriction (reachable-descendants of `epic`)
  //    Walk the `parentId` graph downward from `epicSubtree` and keep
  //    only nodes in that set (plus the epic itself).
  // ------------------------------------------------------------------
  let nodes = rawNodes;
  if (epicSubtree) {
    const allById = new Map(rawNodes.map((n) => [n.id, n] as const));
    // reverse index: parentId → children[]
    const childrenOf = new Map<string, Array<(typeof rawNodes)[number]>>();
    for (const n of rawNodes) {
      if (!n.parentId) continue;
      const list = childrenOf.get(n.parentId) ?? [];
      list.push(n);
      childrenOf.set(n.parentId, list);
    }
    const keep = new Set<string>();
    const stack = [epicSubtree];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (keep.has(id)) continue;
      keep.add(id);
      const kids = childrenOf.get(id) ?? [];
      for (const kid of kids) stack.push(kid.id);
    }
    nodes = rawNodes.filter((n) => keep.has(n.id)).filter((n) => allById.has(n.id));
  }

  const nodeIds = new Set(nodes.map((n) => n.id));

  // ------------------------------------------------------------------
  // 3. Parent edges (hierarchy)
  // ------------------------------------------------------------------
  const parentEdges: GraphEdge[] = [];
  for (const n of nodes) {
    if (n.parentId && nodeIds.has(n.parentId)) {
      parentEdges.push({ source: n.parentId, target: n.id, kind: 'parent' });
    }
  }

  // ------------------------------------------------------------------
  // 4. blocked_by edges (overlay)
  //    blocked_by is stored either as a plain comma-separated string or as
  //    a JSON array of IDs — handle both shapes defensively.
  // ------------------------------------------------------------------
  const blocksEdges: GraphEdge[] = [];
  for (const n of rawNodes) {
    if (!nodeIds.has(n.id) || !n.blocked_by) continue;
    const raw = n.blocked_by.trim();
    let ids: string[] = [];
    if (raw.startsWith('[')) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
      } catch {
        // fall through to CSV
      }
    }
    if (ids.length === 0)
      ids = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    for (const blocker of ids) {
      if (nodeIds.has(blocker)) {
        blocksEdges.push({ source: blocker, target: n.id, kind: 'blocks' });
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. depends edges from task_dependencies (overlay)
  // ------------------------------------------------------------------
  const depRows = db
    .prepare(`SELECT task_id AS taskId, depends_on AS dependsOn FROM task_dependencies`)
    .all() as Array<{ taskId: string; dependsOn: string }>;
  const dependsEdges: GraphEdge[] = [];
  for (const d of depRows) {
    if (nodeIds.has(d.taskId) && nodeIds.has(d.dependsOn)) {
      dependsEdges.push({ source: d.dependsOn, target: d.taskId, kind: 'depends' });
    }
  }

  const edges = [...parentEdges, ...blocksEdges, ...dependsEdges];

  return {
    nodes,
    edges,
    filters: { showArchived: includeArchived, epic: epicSubtree },
    counts: {
      nodes: nodes.length,
      parentEdges: parentEdges.length,
      blocksEdges: blocksEdges.length,
      dependsEdges: dependsEdges.length,
    },
  };
}

export const load: PageServerLoad = ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);
  const showArchived = url.searchParams.get('archived') === '1';
  const epic = url.searchParams.get('epic');

  if (!db) {
    return {
      graph: {
        nodes: [],
        edges: [],
        filters: { showArchived, epic },
        counts: { nodes: 0, parentEdges: 0, blocksEdges: 0, dependsEdges: 0 },
      } satisfies GraphData,
    };
  }

  try {
    const graph = _computeGraph(db as unknown as GraphDbLike, {
      includeArchived: showArchived,
      epicSubtree: epic,
    });
    return { graph };
  } catch {
    return {
      graph: {
        nodes: [],
        edges: [],
        filters: { showArchived, epic },
        counts: { nodes: 0, parentEdges: 0, blocksEdges: 0, dependsEdges: 0 },
      } satisfies GraphData,
    };
  }
};
