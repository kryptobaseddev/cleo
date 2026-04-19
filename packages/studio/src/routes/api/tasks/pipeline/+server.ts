/**
 * GET /api/tasks/pipeline — tasks grouped by pipeline stage (canonical).
 *
 * T948 refactor: groups by `TaskRollupPayload.pipelineStage` — the SAME
 * projection the /tasks endpoint and Studio kanban use. This closes the
 * owner-flagged drift where `/api/tasks` and `/api/tasks/pipeline`
 * disagreed about which stage a task lived on.
 *
 * Response shape:
 *   {
 *     stages: Array<{ id, label, count, tasks: LegacyRow[], rollups: TaskRollupPayload[] }>,
 *   }
 *
 * The `tasks` array preserves the pre-T948 snake_case row contract so the
 * Svelte pipeline UI (`pipeline/+page.svelte`) can keep reading
 * `row.verification_json` without changes.
 *
 * Narrow subpath imports (`@cleocode/core/tasks/list`,
 * `@cleocode/core/lifecycle/rollup`, `@cleocode/core/store/data-accessor`)
 * are used intentionally — importing the full `@cleocode/core/sdk` facade
 * transitively drags in llmtxt + loro-crdt WASM and breaks Vite bundling.
 *
 * @task T948
 */

import type { Task, TaskRollupPayload } from '@cleocode/contracts';
import { computeTaskRollups } from '@cleocode/core/lifecycle/rollup';
import { getAccessor } from '@cleocode/core/store/data-accessor';
import { listTasks } from '@cleocode/core/tasks/list';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Ordered canonical pipeline column IDs. Mirrors the RCASD-IVTR+C chain
 * from `@cleocode/core` with terminal display buckets appended.
 *
 * Kept in string form (no import from core) so the Studio server runtime
 * stays free of CLI-only imports — the facade boundary is respected.
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
  'contribution',
] as const;

type PipelineStageId = (typeof PIPELINE_STAGES)[number] | 'unassigned';

/** Legacy snake_case row shape preserved for UI back-compat (see T873). */
export interface PipelineRow {
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
}

/** Stage bucket in the response envelope. */
export interface PipelineStageBucket {
  /** Stage id (research, implementation, …) or `unassigned`. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** Number of tasks in this bucket. */
  count: number;
  /** Legacy row shape for back-compat. */
  tasks: PipelineRow[];
  /** Canonical rollup projection for every task in this bucket. */
  rollups: TaskRollupPayload[];
}

/** Envelope returned by GET /api/tasks/pipeline. */
export interface PipelineResponse {
  stages: PipelineStageBucket[];
}

/** Project a core `Task` row into the pre-T948 snake_case shape. */
export function _toPipelineRow(task: Task): PipelineRow {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    type: task.type ?? 'task',
    parent_id: task.parentId ?? null,
    pipeline_stage: task.pipelineStage ?? null,
    size: task.size ?? null,
    verification_json:
      task.verification !== undefined && task.verification !== null
        ? JSON.stringify(task.verification)
        : null,
    acceptance_json:
      task.acceptance !== undefined && task.acceptance.length > 0
        ? JSON.stringify(task.acceptance)
        : null,
    created_at: task.createdAt,
    updated_at: task.updatedAt ?? task.createdAt,
    completed_at: task.completedAt ?? null,
  };
}

/**
 * Decide which stage bucket a task belongs in. Uses the canonical rollup
 * `pipelineStage` as the authoritative signal. `null` → 'unassigned', any
 * unknown value also falls back to 'unassigned' so new stages introduced by
 * core don't crash the Studio UI before the whitelist is updated.
 */
export function _resolveStage(rollup: TaskRollupPayload): PipelineStageId {
  const stage = rollup.pipelineStage;
  if (stage === null) return 'unassigned';
  return (PIPELINE_STAGES as readonly string[]).includes(stage)
    ? (stage as PipelineStageId)
    : 'unassigned';
}

/** Capitalise the first letter of a stage id for a human label. */
export function _labelFor(stage: string): string {
  if (stage === 'unassigned') return 'Unassigned';
  return stage.charAt(0).toUpperCase() + stage.slice(1);
}

export const GET: RequestHandler = async ({ locals }) => {
  const ctx = locals.projectCtx;
  if (!ctx.tasksDbExists) {
    return json({ error: 'tasks.db unavailable' }, { status: 503 });
  }

  try {
    const accessor = await getAccessor(ctx.projectPath);
    const result = await listTasks(
      {
        excludeArchived: true,
        sortByPriority: true,
        limit: 1000,
      },
      ctx.projectPath,
      accessor,
    );

    const tasks = result.tasks;
    const ids = tasks.map((t) => t.id);
    const rollups = await computeTaskRollups(ids, accessor);

    // Build a parallel lookup so we can zip Task ↔ TaskRollup in one pass.
    const rollupById = new Map<string, TaskRollupPayload>();
    for (const r of rollups) rollupById.set(r.id, r);

    // Initialize all stage buckets (including unassigned) so the UI always
    // receives a stable shape — even stages with zero tasks are present.
    const stageMap = new Map<
      PipelineStageId,
      { tasks: PipelineRow[]; rollups: TaskRollupPayload[] }
    >();
    for (const s of [...PIPELINE_STAGES, 'unassigned'] as PipelineStageId[]) {
      stageMap.set(s, { tasks: [], rollups: [] });
    }

    for (const task of tasks) {
      const rollup = rollupById.get(task.id);
      if (rollup === undefined) continue;
      const stage = _resolveStage(rollup);
      const bucket = stageMap.get(stage);
      if (bucket === undefined) continue;
      bucket.tasks.push(_toPipelineRow(task));
      bucket.rollups.push(rollup);
    }

    // Emit canonical stages first (in order), then unassigned only if non-empty.
    const stages: PipelineStageBucket[] = PIPELINE_STAGES.map((s) => {
      const bucket = stageMap.get(s) ?? { tasks: [], rollups: [] };
      return {
        id: s,
        label: _labelFor(s),
        count: bucket.tasks.length,
        tasks: bucket.tasks,
        rollups: bucket.rollups,
      };
    });

    const unassigned = stageMap.get('unassigned');
    if (unassigned !== undefined && unassigned.tasks.length > 0) {
      stages.push({
        id: 'unassigned',
        label: 'Unassigned',
        count: unassigned.tasks.length,
        tasks: unassigned.tasks,
        rollups: unassigned.rollups,
      });
    }

    const body: PipelineResponse = { stages };
    return json(body);
  } catch (err) {
    return json({ error: String(err) }, { status: 500 });
  }
};
