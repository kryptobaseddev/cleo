/**
 * Pipeline page server load — tasks grouped by pipeline_stage for kanban.
 *
 * Column taxonomy:
 *   - Intermediate RCASD-IVTR+C stages (research → release) mirror
 *     `TASK_PIPELINE_STAGES` in `@cleocode/core`.
 *   - `done` is the display bucket for any task with `status='done'` OR
 *     `pipeline_stage IN ('contribution','done')`. This is the T871 fix:
 *     completed tasks now always appear here, not lingering in
 *     research/implementation/release.
 *   - `cancelled` is the display bucket for any task with
 *     `status='cancelled'` OR `pipeline_stage='cancelled'`.
 *   - `unassigned` catches NULL pipeline_stage rows.
 *
 * @task T873
 * @epic T870
 */

import { getTasksDb } from '$lib/server/db/connections.js';
import type { PageServerLoad } from './$types';

/**
 * Ordered canonical pipeline column IDs. Mirrors the RCASD-IVTR+C chain
 * from `@cleocode/core` with terminal display buckets appended.
 *
 * NOTE: stays in string form (not imported from core) because the
 * SvelteKit server runtime must not pull CLI-only packages.
 */
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
  'done',
  'cancelled',
] as const;

/** Terminal pipeline-stage names (match `TERMINAL_PIPELINE_STAGES` in core). */
const TERMINAL_DONE_STAGES = new Set(['contribution', 'done']);
const TERMINAL_CANCELLED_STAGES = new Set(['cancelled']);

/** Human-readable column labels (override default Title Case where needed). */
const COLUMN_LABELS: Record<string, string> = {
  research: 'Research',
  consensus: 'Consensus',
  architecture_decision: 'Arch. Decision',
  specification: 'Specification',
  decomposition: 'Decomposition',
  implementation: 'Implementation',
  validation: 'Validation',
  testing: 'Testing',
  release: 'Release',
  done: 'Done',
  cancelled: 'Cancelled',
  unassigned: 'Unassigned',
};

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

/**
 * Decide which column a row belongs in, honouring `status` as the
 * authoritative signal for terminal tasks. This prevents the long-standing
 * drift where a `status=done` task with `pipeline_stage='research'` would
 * show up in the RESEARCH column instead of DONE.
 */
function resolveColumnId(row: { status: string; pipeline_stage: string | null }): PipelineStage {
  // Status 'done' or 'cancelled' always wins — those are the terminal user
  // signals. `pipeline_stage` is checked second so backfilled/manual
  // contribution/cancelled rows also land correctly.
  if (row.status === 'done') return 'done';
  if (row.status === 'cancelled') return 'cancelled';
  if (row.pipeline_stage && TERMINAL_DONE_STAGES.has(row.pipeline_stage)) return 'done';
  if (row.pipeline_stage && TERMINAL_CANCELLED_STAGES.has(row.pipeline_stage)) {
    return 'cancelled';
  }
  if (row.pipeline_stage && (PIPELINE_STAGES as readonly string[]).includes(row.pipeline_stage)) {
    return row.pipeline_stage as PipelineStage;
  }
  return 'unassigned';
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
      const columnId = resolveColumnId(row);
      const target = buckets[columnId] ?? buckets['unassigned'];
      const { pipeline_stage: _, ...rest } = row;
      void _;
      target.push(rest as PipelineTask);
    }

    const columns: PipelineColumn[] = [...PIPELINE_STAGES].map((s) => ({
      id: s,
      label: COLUMN_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1),
      count: buckets[s].length,
      tasks: buckets[s],
    }));

    if (buckets['unassigned'].length > 0) {
      columns.push({
        id: 'unassigned',
        label: COLUMN_LABELS['unassigned'],
        count: buckets['unassigned'].length,
        tasks: buckets['unassigned'],
      });
    }

    return { columns };
  } catch {
    return { columns: [] };
  }
};

/**
 * Exported for tests (T873).
 * Pure router used by `load` — unit-testable without a DB connection.
 */
export const __testing__ = { resolveColumnId, PIPELINE_STAGES };
