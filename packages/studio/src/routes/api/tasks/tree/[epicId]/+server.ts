/**
 * GET /api/tasks/tree/[epicId] — full epic hierarchy (epic → tasks → subtasks).
 *
 * Returns nested tree up to 3 levels deep.
 *
 * T9617 refactor: zero raw SQL — delegates to `taskTree` + `showTask` from
 * `@cleocode/core/tasks`. The `epic` field preserves the pre-T9617 shape
 * with a `children` array built from the FlatTreeNode tree returned by core.
 *
 * @task T9617
 */

import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { showTask, type TaskDetail, taskTree } from '@cleocode/core/tasks';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

interface TreeNode {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  pipeline_stage: string | null;
  size: string | null;
  verification_json: string | null;
  acceptance_json: string | null;
  created_at: string;
  completed_at: string | null;
  children: TreeNode[];
}

/**
 * Convert a core FlatTreeNode into the legacy TreeNode shape.
 * Core FlatTreeNode does not carry all the fields (verification_json,
 * acceptance_json, etc.) so we accept them as `null` for now.
 * The Studio tree view only uses id/title/status/priority for rendering.
 */
function flatNodeToTreeNode(
  node: {
    id: string;
    title: string;
    status: string;
    type?: string;
    priority: string;
    children: (typeof node)[];
  },
  depth: number,
): TreeNode {
  return {
    id: node.id,
    title: node.title,
    status: node.status,
    priority: node.priority,
    type: node.type ?? 'task',
    pipeline_stage: null, // core-first-allowed: not in FlatTreeNode
    size: null, // core-first-allowed: not in FlatTreeNode
    verification_json: null, // core-first-allowed: not in FlatTreeNode
    acceptance_json: null, // core-first-allowed: not in FlatTreeNode
    created_at: new Date().toISOString(), // core-first-allowed: not in FlatTreeNode
    completed_at: null, // core-first-allowed: not in FlatTreeNode
    children: depth < 3 ? node.children.map((c) => flatNodeToTreeNode(c, depth + 1)) : [],
  };
}

export const GET: RequestHandler = async ({ locals, params }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { epicId } = params;

  try {
    const accessor = await getTaskAccessor(ctx.projectPath);

    // Fetch the epic itself to verify existence and get full field data.
    let epicDetail: TaskDetail;
    try {
      epicDetail = await showTask(epicId, ctx.projectPath, accessor);
    } catch (err) {
      const e = err as { code?: number };
      if (e?.code === 4) {
        return json({ error: 'not found' }, { status: 404 });
      }
      throw err;
    }

    // Use core taskTree to build the hierarchy rooted at this epic.
    const treeResult = await taskTree(ctx.projectPath, epicId);
    if (!treeResult.success) {
      return json({ error: treeResult.error?.message ?? 'Failed to build tree' }, { status: 500 });
    }

    const { tree } = treeResult.data;

    // The root of the tree IS the epic node itself (taskTree with taskId returns
    // a single-root tree). Build children from it.
    const rootNode = tree[0];
    const children: TreeNode[] = rootNode?.children.map((c) => flatNodeToTreeNode(c, 1)) ?? [];

    // Build summary stats from the flat tree (including the epic itself).
    const allFlatNodes: Array<{ status: string }> = [epicDetail];
    function collectAll(nodes: typeof tree): void {
      for (const n of nodes) {
        allFlatNodes.push(n);
        collectAll(n.children);
      }
    }
    if (rootNode) collectAll(rootNode.children);

    const stats = {
      total: allFlatNodes.length,
      done: allFlatNodes.filter((t) => t.status === 'done').length,
      active: allFlatNodes.filter((t) => t.status === 'active').length,
      pending: allFlatNodes.filter((t) => t.status === 'pending').length,
      archived: allFlatNodes.filter((t) => t.status === 'archived').length,
    };

    // Project epic into the legacy response shape.
    const epic: TreeNode = {
      id: epicDetail.id,
      title: epicDetail.title,
      status: epicDetail.status,
      priority: epicDetail.priority,
      type: epicDetail.type ?? 'epic',
      pipeline_stage: epicDetail.pipelineStage ?? null,
      size: epicDetail.size ?? null,
      verification_json:
        epicDetail.verification !== undefined && epicDetail.verification !== null
          ? JSON.stringify(epicDetail.verification)
          : null,
      acceptance_json:
        epicDetail.acceptance && epicDetail.acceptance.length > 0
          ? JSON.stringify(epicDetail.acceptance)
          : null,
      created_at: epicDetail.createdAt,
      completed_at: epicDetail.completedAt ?? null,
      children,
    };

    return json({ epic, stats });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
