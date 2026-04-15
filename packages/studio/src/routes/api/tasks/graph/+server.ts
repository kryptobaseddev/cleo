/**
 * GET /api/tasks/graph?epic=T### — nodes + edges for all deps within an epic.
 *
 * Returns a sigma-ready graph payload:
 *   { nodes: NodeEntry[], edges: EdgeEntry[] }
 *
 * Nodes include status/priority so the client can color-code them.
 * Edges represent task_dependencies rows (task_id depends_on depends_on).
 *
 * If `taskId` is provided as a query param, returns only the 1-hop
 * neighbourhood (the task itself + direct upstream + direct downstream).
 *
 * Query params:
 *   epic=T###     — all deps within an epic subtree
 *   taskId=T###   — 1-hop neighbourhood for a single task
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

interface GraphNode {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  /** true if this is the focal task when taskId is provided */
  isFocus: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
}

interface GraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const GET: RequestHandler = ({ locals, url }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const epicId = url.searchParams.get('epic');
  const taskId = url.searchParams.get('taskId');

  if (!epicId && !taskId) {
    return json({ error: 'epic or taskId query param required' }, { status: 400 });
  }

  try {
    if (taskId) {
      // 1-hop neighbourhood
      const upstream = db
        .prepare(
          `SELECT t.id, t.title, t.status, t.priority, t.type
           FROM tasks t
           INNER JOIN task_dependencies td ON td.depends_on = t.id
           WHERE td.task_id = ?`,
        )
        .all(taskId) as Array<{
        id: string;
        title: string;
        status: string;
        priority: string;
        type: string;
      }>;

      const downstream = db
        .prepare(
          `SELECT t.id, t.title, t.status, t.priority, t.type
           FROM tasks t
           INNER JOIN task_dependencies td ON td.task_id = t.id
           WHERE td.depends_on = ?`,
        )
        .all(taskId) as Array<{
        id: string;
        title: string;
        status: string;
        priority: string;
        type: string;
      }>;

      const focus = db
        .prepare('SELECT id, title, status, priority, type FROM tasks WHERE id = ?')
        .get(taskId) as
        | { id: string; title: string; status: string; priority: string; type: string }
        | undefined;

      if (!focus) {
        return json({ error: 'task not found' }, { status: 404 });
      }

      const nodeMap = new Map<string, GraphNode>();
      nodeMap.set(focus.id, { ...focus, isFocus: true });
      for (const t of upstream) {
        if (!nodeMap.has(t.id)) nodeMap.set(t.id, { ...t, isFocus: false });
      }
      for (const t of downstream) {
        if (!nodeMap.has(t.id)) nodeMap.set(t.id, { ...t, isFocus: false });
      }

      // Edges: upstream → focus, focus → downstream
      const edges: GraphEdge[] = [
        ...upstream.map((t) => ({ source: t.id, target: taskId })),
        ...downstream.map((t) => ({ source: taskId, target: t.id })),
      ];

      const response: GraphResponse = {
        nodes: Array.from(nodeMap.values()),
        edges,
      };
      return json(response);
    }

    // Epic-wide graph: collect all descendant IDs then fetch their dep edges
    if (epicId) {
      const allDescendants = db
        .prepare(
          `WITH RECURSIVE desc(id) AS (
            SELECT id FROM tasks WHERE id = ? OR parent_id = ?
            UNION ALL
            SELECT t.id FROM tasks t INNER JOIN desc d ON t.parent_id = d.id
            LIMIT 1000
          )
          SELECT id FROM desc`,
        )
        .all(epicId, epicId) as Array<{ id: string }>;

      if (allDescendants.length === 0) {
        return json({ nodes: [], edges: [] });
      }

      const ids = allDescendants.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');

      const nodes = db
        .prepare(
          `SELECT id, title, status, priority, type
           FROM tasks WHERE id IN (${placeholders})`,
        )
        .all(...ids) as Array<{
        id: string;
        title: string;
        status: string;
        priority: string;
        type: string;
      }>;

      // Only include edges where BOTH endpoints are within the epic subtree
      const idSet = new Set(ids);
      const depsRaw = db
        .prepare(
          `SELECT task_id, depends_on
           FROM task_dependencies
           WHERE task_id IN (${placeholders})`,
        )
        .all(...ids) as Array<{ task_id: string; depends_on: string }>;

      const edges: GraphEdge[] = depsRaw
        .filter((r) => idSet.has(r.depends_on))
        .map((r) => ({ source: r.depends_on, target: r.task_id }));

      const response: GraphResponse = {
        nodes: nodes.map((n) => ({ ...n, isFocus: false })),
        edges,
      };
      return json(response);
    }

    return json({ nodes: [], edges: [] });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
