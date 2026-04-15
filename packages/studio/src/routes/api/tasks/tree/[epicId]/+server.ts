/**
 * GET /api/tasks/tree/[epicId] — full epic hierarchy (epic → tasks → subtasks).
 *
 * Returns nested tree up to 3 levels deep.
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
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

function buildTree(
  parentId: string,
  allRows: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    type: string;
    parent_id: string | null;
    pipeline_stage: string | null;
    size: string | null;
    verification_json: string | null;
    acceptance_json: string | null;
    created_at: string;
    completed_at: string | null;
    position: number;
  }>,
  depth: number,
): TreeNode[] {
  if (depth > 3) return [];
  return allRows
    .filter((r) => r.parent_id === parentId)
    .sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at))
    .map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      type: r.type,
      pipeline_stage: r.pipeline_stage,
      size: r.size,
      verification_json: r.verification_json,
      acceptance_json: r.acceptance_json,
      created_at: r.created_at,
      completed_at: r.completed_at,
      children: buildTree(r.id, allRows, depth + 1),
    }));
}

export const GET: RequestHandler = ({ locals, params }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  const { epicId } = params;

  try {
    // Check epic exists
    const epic = db
      .prepare(
        `SELECT id, title, status, priority, type, pipeline_stage, size,
                verification_json, acceptance_json, created_at, completed_at, parent_id, position
         FROM tasks WHERE id = ?`,
      )
      .get(epicId) as
      | {
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
          parent_id: string | null;
          position: number;
        }
      | undefined;

    if (!epic) {
      return json({ error: 'not found' }, { status: 404 });
    }

    // Recursively collect all descendants using a CTE
    const allDescendants = db
      .prepare(
        `WITH RECURSIVE descendants(id, title, status, priority, type, parent_id,
                pipeline_stage, size, verification_json, acceptance_json,
                created_at, completed_at, position) AS (
          SELECT id, title, status, priority, type, parent_id,
                 pipeline_stage, size, verification_json, acceptance_json,
                 created_at, completed_at, position
          FROM tasks WHERE parent_id = ?
          UNION ALL
          SELECT t.id, t.title, t.status, t.priority, t.type, t.parent_id,
                 t.pipeline_stage, t.size, t.verification_json, t.acceptance_json,
                 t.created_at, t.completed_at, t.position
          FROM tasks t
          INNER JOIN descendants d ON t.parent_id = d.id
          LIMIT 500
        )
        SELECT * FROM descendants`,
      )
      .all(epicId) as Array<{
      id: string;
      title: string;
      status: string;
      priority: string;
      type: string;
      parent_id: string | null;
      pipeline_stage: string | null;
      size: string | null;
      verification_json: string | null;
      acceptance_json: string | null;
      created_at: string;
      completed_at: string | null;
      position: number;
    }>;

    const children = buildTree(epicId, allDescendants, 1);

    // Summary stats
    const all = [epic, ...allDescendants];
    const stats = {
      total: all.length,
      done: all.filter((t) => t.status === 'done').length,
      active: all.filter((t) => t.status === 'active').length,
      pending: all.filter((t) => t.status === 'pending').length,
      archived: all.filter((t) => t.status === 'archived').length,
    };

    return json({
      epic: { ...epic, children },
      stats,
    });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
