/**
 * GET /api/tasks/graph?epic=T### — nodes + edges for all deps within an epic.
 *
 * Returns a sigma-ready graph payload:
 *   { nodes: NodeEntry[], edges: EdgeEntry[] }
 *
 * Nodes include status/priority so the client can color-code them.
 * Edges represent task dependency relationships (source depends_on → target).
 *
 * If `taskId` is provided as a query param, returns only the 1-hop
 * neighbourhood (the task itself + direct upstream + direct downstream).
 *
 * Query params:
 *   epic=T###     — all deps within an epic subtree
 *   taskId=T###   — 1-hop neighbourhood for a single task
 *
 * T9617 refactor: zero raw SQL — delegates to core APIs:
 *   - 1-hop mode uses `taskDeps` from `@cleocode/core/tasks`
 *   - epic mode uses `taskTree` to collect all descendant IDs and their
 *     `depends` edges, then filters edges to the epic subtree
 *
 * @task T9617
 */

import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { showTask, taskDeps, taskTree } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
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

/** Recursively collect all FlatTreeNodes into a flat array. */
function collectFlatNodes(
  nodes: Array<{
    id: string;
    title: string;
    status: string;
    type?: string;
    priority: string;
    depends: string[];
    children: typeof nodes;
  }>,
): Array<{
  id: string;
  title: string;
  status: string;
  type?: string;
  priority: string;
  depends: string[];
}> {
  const result: typeof nodes = [];
  for (const n of nodes) {
    result.push(n);
    result.push(...collectFlatNodes(n.children));
  }
  return result;
}

export const GET: RequestHandler = async ({ locals, url }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const epicId = url.searchParams.get('epic');
  const taskId = url.searchParams.get('taskId');

  if (!epicId && !taskId) {
    return json({ error: 'epic or taskId query param required' }, { status: 400 });
  }

  try {
    const accessor = await getTaskAccessor(ctx.projectPath);

    if (taskId) {
      // 1-hop neighbourhood via core taskDeps.
      const depsResult = await taskDeps(ctx.projectPath, taskId);
      if (!depsResult.success) {
        if (depsResult.error?.code === 'E_NOT_FOUND') {
          return json({ error: 'task not found' }, { status: 404 });
        }
        return json({ error: depsResult.error?.message ?? 'Failed to load deps' }, { status: 500 });
      }

      // Load the focal task itself for its full fields.
      const focusTask = await accessor.loadSingleTask(taskId);
      if (!focusTask) {
        return json({ error: 'task not found' }, { status: 404 });
      }

      const { dependsOn, dependedOnBy } = depsResult.data;

      const nodeMap = new Map<string, GraphNode>();

      nodeMap.set(focusTask.id, {
        id: focusTask.id,
        title: focusTask.title,
        status: focusTask.status,
        priority: focusTask.priority,
        type: focusTask.type ?? 'task',
        isFocus: true,
      });

      for (const t of dependsOn) {
        if (!nodeMap.has(t.id)) {
          nodeMap.set(t.id, {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: 'medium', // core-first-allowed: priority not in taskDeps dep entries
            type: 'task',
            isFocus: false,
          });
        }
      }

      for (const t of dependedOnBy) {
        if (!nodeMap.has(t.id)) {
          nodeMap.set(t.id, {
            id: t.id,
            title: t.title,
            status: t.status,
            priority: 'medium', // core-first-allowed: priority not in taskDeps dep entries
            type: 'task',
            isFocus: false,
          });
        }
      }

      // Edges: upstream → focus, focus → downstream
      const edges: GraphEdge[] = [
        ...dependsOn.map((t) => ({ source: t.id, target: taskId })),
        ...dependedOnBy.map((t) => ({ source: taskId, target: t.id })),
      ];

      const response: GraphResponse = {
        nodes: Array.from(nodeMap.values()),
        edges,
      };
      return json(response);
    }

    // Epic-wide graph: collect all descendants then build dep edges.
    if (epicId) {
      // Verify the epic exists.
      const epicDetail = await showTask(epicId, ctx.projectPath, accessor).catch((err) => {
        const e = err as { code?: number };
        if (e?.code === 4) return null;
        throw err;
      });
      if (!epicDetail) {
        return json({ nodes: [], edges: [] });
      }

      // Use taskTree to get all descendants with their depends arrays.
      const treeResult = await taskTree(ctx.projectPath, epicId);
      if (!treeResult.success) {
        return json({ nodes: [], edges: [] });
      }

      const { tree } = treeResult.data;
      const rootNode = tree[0];
      if (!rootNode) {
        return json({ nodes: [], edges: [] });
      }

      // Collect all descendants (the epic root + all nested nodes).
      const allDescendants = collectFlatNodes(rootNode.children);
      const epicNode = {
        id: rootNode.id,
        title: rootNode.title,
        status: rootNode.status,
        type: rootNode.type ?? 'epic',
        priority: rootNode.priority,
        depends: rootNode.depends,
        children: rootNode.children,
      };
      const allNodes = [epicNode, ...allDescendants];
      const idSet = new Set(allNodes.map((n) => n.id));

      const nodes: GraphNode[] = allNodes.map((n) => ({
        id: n.id,
        title: n.title,
        status: n.status,
        priority: n.priority,
        type: n.type ?? 'task',
        isFocus: false,
      }));

      // Build edges from the depends arrays — only include edges where both
      // endpoints are within the epic subtree.
      const edges: GraphEdge[] = [];
      for (const n of allNodes) {
        for (const depId of n.depends) {
          if (idSet.has(depId)) {
            // Edge direction: dependency → dependent (source depends_on → target)
            edges.push({ source: depId, target: n.id });
          }
        }
      }

      const response: GraphResponse = { nodes, edges };
      return json(response);
    }

    return json({ nodes: [], edges: [] });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
