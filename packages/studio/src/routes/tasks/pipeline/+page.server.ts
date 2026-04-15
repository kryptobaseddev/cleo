/**
 * Pipeline page server load — tasks grouped by pipeline_stage for kanban.
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

/** Ordered canonical pipeline stages. */
const PIPELINE_STAGES = [
  'research',
  'specification',
  'decomposition',
  'design',
  'implementation',
  'testing',
  'validation',
  'review',
  'release',
  'done',
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number] | 'unassigned';

export interface PipelineTask {
  id: string;
  title: string;
  status: string;
  priority: string;
  type: string;
  parent_id: string | null;
  size: string | null;
  verification_json: string | null;
}

export interface PipelineColumn {
  id: string;
  label: string;
  count: number;
  tasks: PipelineTask[];
}

export const load: PageServerLoad = ({ locals }) => {
  const db = getTasksDb(locals.projectCtx);

  if (!db) {
    return { columns: [] };
  }

  try {
    const rows = db
      .prepare(
        `SELECT id, title, status, priority, type, parent_id, size,
                pipeline_stage, verification_json
         FROM tasks
         WHERE status != 'archived'
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
           created_at DESC`,
      )
      .all() as Array<PipelineTask & { pipeline_stage: string | null }>;

    const buckets: Record<string, PipelineTask[]> = {};
    for (const stage of [...PIPELINE_STAGES, 'unassigned']) {
      buckets[stage] = [];
    }

    for (const row of rows) {
      const stage = row.pipeline_stage ?? 'unassigned';
      const target = buckets[stage] ?? buckets['unassigned'];
      const { pipeline_stage: _, ...rest } = row;
      void _;
      target.push(rest as PipelineTask);
    }

    const columns: PipelineColumn[] = [...PIPELINE_STAGES].map((s) => ({
      id: s,
      label: s.charAt(0).toUpperCase() + s.slice(1),
      count: buckets[s].length,
      tasks: buckets[s],
    }));

    if (buckets['unassigned'].length > 0) {
      columns.push({
        id: 'unassigned',
        label: 'Unassigned',
        count: buckets['unassigned'].length,
        tasks: buckets['unassigned'],
      });
    }

    return { columns };
  } catch {
    return { columns: [] };
  }
};
