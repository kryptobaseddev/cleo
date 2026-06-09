/**
 * Server load for the read-only agent-lifecycle Kanban dispatcher board
 * (`/tasks/kanban` · T11925 · M6 read-only v1).
 *
 * Reads through the EXISTING Studio data layer — the same narrow
 * `@cleocode/core` subpath imports the `/api/tasks` endpoint uses
 * (`listTasks` + `computeTaskViews`) plus `listSessions` for the
 * active-worker signal. NO gateway-client, NO M5 dependency, NO new
 * `@cleocode/core` import surface beyond the ones the existing endpoints
 * already pull (`tasks/list`, `tasks`, `store/data-accessor`, `sessions`).
 *
 * Each task is projected onto an {@link AgentLifecycleSignal}, resolved to
 * exactly one of the seven dispatcher lanes via {@link resolveAgentLifecycleLane}
 * (T11926), and bundled into a presentational {@link BoardCard}. The lane
 * columns are emitted server-side so the page renders instantly; the client
 * subscribes to the existing SSE stream (`/api/tasks/events`) to know when to
 * re-fetch (T11925 — live refresh).
 *
 * @task T11925
 * @epic T11559
 */

import type { Task, TaskStatus } from '@cleocode/contracts';
import { listSessions } from '@cleocode/core/sessions';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { computeTaskViews } from '@cleocode/core/tasks';
import { listTasks } from '@cleocode/core/tasks/list';
import type { BoardCard, BoardLane } from '$lib/components/board/board-types.js';
import {
  AGENT_LIFECYCLE_LANE_HINTS,
  AGENT_LIFECYCLE_LANE_LABELS,
  AGENT_LIFECYCLE_LANES,
  type AgentLifecycleLane,
  type AgentLifecycleSignal,
  resolveAgentLifecycleLane,
} from '$lib/components/tasks/agent-lifecycle-lane.js';
import type { PageServerLoad } from './$types';

/** A lane column shipped to the client: lane meta + its bucketed cards. */
export interface KanbanLaneColumn {
  /** Lane definition (id/label/hint). */
  lane: BoardLane;
  /** Cards routed to this lane, in priority order. */
  cards: BoardCard[];
  /** Card count for the header chip. */
  count: number;
}

/** Envelope returned by the load. */
export interface KanbanPageData {
  /** The seven lane columns, in canonical order. */
  columns: KanbanLaneColumn[];
  /** Total tasks across every lane (after archived exclusion). */
  total: number;
  /** Set when the project's tasks.db is unavailable. */
  error?: string;
}

/** Build the ordered, board-ready lane definitions from the lane taxonomy. */
function buildLanes(): BoardLane[] {
  return AGENT_LIFECYCLE_LANES.map((id) => ({
    id,
    label: AGENT_LIFECYCLE_LANE_LABELS[id],
    hint: AGENT_LIFECYCLE_LANE_HINTS[id],
  }));
}

/**
 * Project a core `Task` + its `TaskView` slice + the active-worker set onto
 * the framework-free {@link AgentLifecycleSignal} the resolver consumes.
 *
 * @param task - The core task row.
 * @param view - Aligned `TaskView` (gates, readyToComplete, nextAction), or undefined.
 * @param activeWorkerIds - Set of task ids currently claimed by an active session.
 * @returns The normalised signal bundle.
 */
function toSignal(
  task: Task,
  view:
    | {
        gatesStatus: { implemented: boolean; testsPassed: boolean; qaPassed: boolean };
        readyToComplete: boolean;
        nextAction: string;
      }
    | undefined,
  activeWorkerIds: ReadonlySet<string>,
): AgentLifecycleSignal {
  const depends = task.depends ?? [];
  // `nextAction === 'blocked-on-deps'` is the canonical unmet-dep signal from
  // computeTaskView. When present we know ≥1 dep is unsatisfied; otherwise (and
  // when deps exist) they are resolved.
  const blockedOnDeps = view?.nextAction === 'blocked-on-deps';
  const unmetDependsCount = depends.length === 0 ? 0 : blockedOnDeps ? depends.length : 0;

  return {
    status: task.status,
    blockedBy: task.blockedBy ?? null,
    depends,
    unmetDependsCount,
    gates: view?.gatesStatus ?? null,
    readyToComplete: view?.readyToComplete ?? false,
    // PR-awaiting / HITL are M5-era orchestration signals not yet surfaced by
    // the existing read-only data layer — left false here. The Review lane is
    // still reached via gates / readyToComplete. Wire these in when the
    // orchestrate metadata lands (see TODO(T11929) in the page component).
    prAwaiting: false,
    hitlPending: false,
    workerActive: activeWorkerIds.has(task.id),
    nextAction: view?.nextAction,
  };
}

/** Project a core `Task` onto a presentational {@link BoardCard}. */
function toCard(task: Task, workerActive: boolean): BoardCard {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    size: task.size ?? null,
    verificationJson:
      task.verification !== undefined && task.verification !== null
        ? JSON.stringify(task.verification)
        : null,
    workerActive,
  };
}

export const load: PageServerLoad = async ({ locals }): Promise<KanbanPageData> => {
  const ctx = locals.projectCtx;
  const lanes = buildLanes();
  const emptyColumns: KanbanLaneColumn[] = lanes.map((lane) => ({ lane, cards: [], count: 0 }));

  if (!ctx.tasksDbExists) {
    return { columns: emptyColumns, total: 0, error: 'tasks.db unavailable' };
  }

  try {
    const accessor = await getTaskAccessor(ctx.projectPath);
    const result = await listTasks(
      { excludeArchived: true, sortByPriority: true, limit: 1000 },
      ctx.projectPath,
      accessor,
    );
    const tasks = result.tasks;
    const ids = tasks.map((t) => t.id);
    const views = await computeTaskViews(ids, accessor);
    const viewById = new Map(views.map((v) => [v.id, v]));

    // Active-worker signal: tasks claimed by a currently-active session.
    let activeWorkerIds: ReadonlySet<string> = new Set<string>();
    try {
      const activeSessions = await listSessions(ctx.projectPath, { status: 'active' });
      activeWorkerIds = new Set(
        activeSessions
          .map((s) => s.taskWork?.taskId ?? null)
          .filter((id): id is string => id !== null),
      );
    } catch {
      // Sessions unavailable — running lane still reached via status='active'.
    }

    // Resolve each task to a lane and bucket. Tasks arrive priority-sorted, so
    // each lane's cards stay priority-ordered for free.
    const byLane = new Map<AgentLifecycleLane, BoardCard[]>();
    for (const lane of AGENT_LIFECYCLE_LANES) byLane.set(lane, []);

    let total = 0;
    for (const task of tasks) {
      // Skip statuses the dispatcher board does not surface (archived already
      // excluded by listTasks; proposed is pre-lifecycle).
      if (!isSurfacedStatus(task.status)) continue;
      const view = viewById.get(task.id);
      const workerActive = activeWorkerIds.has(task.id);
      const signal = toSignal(task, view, activeWorkerIds);
      const lane = resolveAgentLifecycleLane(signal);
      byLane.get(lane)?.push(toCard(task, workerActive));
      total += 1;
    }

    const columns: KanbanLaneColumn[] = lanes.map((lane) => {
      const cards = byLane.get(lane.id as AgentLifecycleLane) ?? [];
      return { lane, cards, count: cards.length };
    });

    return { columns, total };
  } catch (err) {
    return { columns: emptyColumns, total: 0, error: String(err) };
  }
};

/** Statuses surfaced on the dispatcher board (everything except pre-lifecycle / archived). */
function isSurfacedStatus(status: TaskStatus): boolean {
  return status !== 'archived' && status !== 'proposed';
}
