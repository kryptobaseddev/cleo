/**
 * Sessions page server load — session history with task completions timeline.
 *
 * Reads go through `@cleocode/core` (T14330, core-first): the session rows,
 * each session's work history and the tasks they name, whose status is the
 * one tasks read with (`active` only while a claim lease is live, T14268).
 */

import type { Session, Task } from '@cleocode/contracts';
import { getTaskAccessor } from '@cleocode/core/store/data-accessor';
import { workHistory } from '@cleocode/core/store/session-store';
import type { ProjectContext } from '$lib/server/project-context.js';
import type { PageServerLoad } from './$types';

export interface WorkedTaskEntry {
  id: string;
  title: string;
  status: string;
  setAt: string;
  clearedAt: string | null;
}

export interface SessionEntry {
  id: string;
  name: string | null;
  status: string;
  agent: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  completedCount: number;
  createdCount: number;
  completedTasks: Array<{ id: string; title: string; status: string }>;
  /** Task currently active in this session (null if none or session ended). */
  currentTask: { id: string; title: string; status: string } | null;
  /** All tasks worked during this session from task_work_history. */
  workedTasks: WorkedTaskEntry[];
}

/** Sessions shown, newest first. */
const SESSION_LIMIT = 100;
/** Work-history rows read per session. */
const WORK_HISTORY_LIMIT = 500;
/** Completed tasks listed per session. */
const COMPLETED_LIMIT = 20;

/** The page's task summary. */
function brief(task: Task): { id: string; title: string; status: string } {
  return { id: task.id, title: task.title, status: task.status };
}

/**
 * The page's session entries for a project, read through `@cleocode/core`.
 * Exported for tests (T14330).
 *
 * @param ctx - The active project context.
 * @returns Newest sessions first; empty when the project has no task store.
 */
export async function _loadSessionEntries(ctx: ProjectContext): Promise<SessionEntry[]> {
  if (!ctx.tasksDbExists) return [];
  const accessor = await getTaskAccessor(ctx.projectPath);
  const rows: Session[] = (await accessor.loadSessions())
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, SESSION_LIMIT);

  // Each session's work history, oldest first (workHistory returns newest first).
  const histories = await Promise.all(
    rows.map(async (s) => (await workHistory(s.id, WORK_HISTORY_LIMIT, ctx.projectPath)).reverse()),
  );

  // Every task the page names, loaded once.
  const ids = new Set<string>();
  rows.forEach((s, i) => {
    for (const id of (s.tasksCompleted ?? []).slice(0, COMPLETED_LIMIT)) ids.add(id);
    if (s.taskWork?.taskId) ids.add(s.taskWork.taskId);
    for (const h of histories[i] ?? []) ids.add(h.taskId);
  });
  const tasks = new Map(
    (ids.size > 0 ? await accessor.loadTasks([...ids]) : []).map((t) => [t.id, t]),
  );

  const sessions: SessionEntry[] = rows.map((s, i) => {
    const completedIds = s.tasksCompleted ?? [];
    const completedTasks = completedIds
      .slice(0, COMPLETED_LIMIT)
      .map((id) => tasks.get(id))
      .filter((t): t is Task => t !== undefined)
      .map(brief);
    const current = s.taskWork?.taskId ? tasks.get(s.taskWork.taskId) : undefined;
    const workedTasks: WorkedTaskEntry[] = [];
    for (const h of histories[i] ?? []) {
      const task = tasks.get(h.taskId);
      if (!task) continue;
      workedTasks.push({
        id: task.id,
        title: task.title,
        status: task.status,
        setAt: h.setAt,
        clearedAt: h.clearedAt,
      });
    }
    const durationMs =
      s.startedAt && s.endedAt
        ? new Date(s.endedAt).getTime() - new Date(s.startedAt).getTime()
        : null;

    return {
      id: s.id,
      name: s.name ?? null,
      status: s.status,
      agent: s.agent ?? null,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      durationMs,
      completedCount: completedIds.length,
      createdCount: (s.tasksCreated ?? []).length,
      completedTasks,
      currentTask: current ? brief(current) : null,
      workedTasks,
    };
  });

  return sessions;
}

export const load: PageServerLoad = async ({ locals }) => {
  try {
    return { sessions: await _loadSessionEntries(locals.projectCtx) };
  } catch {
    return { sessions: [] };
  }
};
