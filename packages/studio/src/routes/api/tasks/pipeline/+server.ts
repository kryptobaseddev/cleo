/**
 * GET /api/tasks/pipeline — tasks grouped by pipeline_stage.
 *
 * Returns a map of stage → tasks[], plus counts per stage.
 * Only non-archived tasks are included.
 */

import { json } from '@sveltejs/kit';
import { getTasksDb } from '$lib/server/db/connections.js';
import type { RequestHandler } from './$types';

/** Ordered list of all pipeline stages (RCASD-IVTR+C). Must match TASK_PIPELINE_STAGES in core. */
const PIPELINE_STAGES = [
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
  'implementation',
  'validation',
  'testing',
  'release',
  'contribution',
] as const;

export const GET: RequestHandler = ({ locals }) => {
  const db = getTasksDb(locals.projectCtx);
  if (!db) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  try {
    const rows = db
      .prepare(
        `SELECT id, title, status, priority, type, parent_id,
                pipeline_stage, size, verification_json, acceptance_json,
                created_at, updated_at, completed_at
         FROM tasks
         WHERE status != 'archived'
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC`,
      )
      .all() as Array<{
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
      updated_at: string;
      completed_at: string | null;
    }>;

    // Group tasks by pipeline_stage; unassigned goes into 'unassigned'
    const columns: Record<string, typeof rows> = {};
    for (const stage of [...PIPELINE_STAGES, 'unassigned']) {
      columns[stage] = [];
    }

    for (const row of rows) {
      const stage = row.pipeline_stage ?? 'unassigned';
      if (columns[stage]) {
        columns[stage].push(row);
      } else {
        // unknown stage — put in unassigned
        columns['unassigned'].push(row);
      }
    }

    const stages = PIPELINE_STAGES.map((s) => ({
      id: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
      count: columns[s].length,
      tasks: columns[s],
    }));

    if (columns['unassigned'].length > 0) {
      stages.push({
        id: 'unassigned',
        label: 'Unassigned',
        count: columns['unassigned'].length,
        tasks: columns['unassigned'],
      });
    }

    return json({ stages });
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
