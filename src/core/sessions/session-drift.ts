/**
 * Compute context drift score for a session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session } from '../../types/session.js';
import type { TaskFileExt } from './types.js';

export interface ContextDriftResult {
  score: number;
  factors: string[];
  completedInScope: number;
  totalInScope: number;
  outOfScope: number;
}

/**
 * Collect all descendant task IDs for a given parent task.
 */
function collectDescendantIds(
  parentId: string,
  tasks: Array<{ id: string; [key: string]: unknown }>,
): Set<string> {
  const result = new Set<string>();

  for (const task of tasks) {
    if (task.parentId === parentId) {
      result.add(task.id);
      const grandchildren = collectDescendantIds(task.id, tasks);
      for (const gc of grandchildren) {
        result.add(gc);
      }
    }
  }

  return result;
}

/**
 * Compute context drift score for the current session.
 * Compares session progress against original scope by counting
 * completed vs total tasks in scope, and detecting out-of-scope work.
 */
export async function getContextDrift(
  projectRoot: string,
  params?: { sessionId?: string },
): Promise<ContextDriftResult> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  // Find the active session (or specified session)
  let session: Session | undefined;

  if (params?.sessionId) {
    const sessions = await accessor.loadSessions();
    session = sessions.find((s) => s.id === params.sessionId);
    if (!session) {
      throw new CleoError(
        ExitCode.SESSION_NOT_FOUND,
        `Session '${params.sessionId}' not found`,
      );
    }
  } else {
    const activeSessionId = current._meta?.activeSession;
    if (activeSessionId) {
      const sessions = await accessor.loadSessions();
      session = sessions.find((s) => s.id === activeSessionId);
    }
  }

  const tasks = current.tasks || [];
  const factors: string[] = [];

  // If no session with scope, compute a basic drift from focus state
  if (!session) {
    const focusTask = current.focus?.currentTask;
    if (!focusTask) {
      return {
        score: 0,
        factors: ['No active session or focus'],
        completedInScope: 0,
        totalInScope: 0,
        outOfScope: 0,
      };
    }

    const rootTaskId = focusTask;
    const inScopeIds = collectDescendantIds(rootTaskId, tasks);
    inScopeIds.add(rootTaskId);

    const inScopeTasks = tasks.filter((t) => inScopeIds.has(t.id));
    const completedInScope = inScopeTasks.filter(
      (t) => t.status === 'done',
    ).length;
    const totalInScope = inScopeTasks.length;

    const score =
      totalInScope > 0
        ? Math.round((completedInScope / totalInScope) * 100)
        : 0;
    factors.push('Single-session mode (focus-based scope)');
    if (completedInScope === 0)
      factors.push('No tasks completed in scope yet');

    return { score, factors, completedInScope, totalInScope, outOfScope: 0 };
  }

  // Multi-session: use session scope to determine in-scope tasks
  const rootTaskId = session.scope.rootTaskId ?? session.scope.epicId ?? '';
  const inScopeIds = new Set<string>();

  if (
    session.scope.explicitTaskIds &&
    session.scope.explicitTaskIds.length > 0
  ) {
    for (const id of session.scope.explicitTaskIds) {
      inScopeIds.add(id);
    }
  } else {
    inScopeIds.add(rootTaskId);
    if (session.scope.includeDescendants !== false) {
      const descendants = collectDescendantIds(rootTaskId, tasks);
      for (const id of descendants) {
        inScopeIds.add(id);
      }
    }
  }

  if (session.scope.excludeTaskIds) {
    for (const id of session.scope.excludeTaskIds) {
      inScopeIds.delete(id);
    }
  }

  const inScopeTasks = tasks.filter((t) => inScopeIds.has(t.id));
  const completedInScope = inScopeTasks.filter(
    (t) => t.status === 'done',
  ).length;
  const totalInScope = inScopeTasks.length;

  // Detect out-of-scope work: tasks completed during session that are NOT in scope
  let outOfScope = 0;
  const sessionStartTime = new Date(session.startedAt).getTime();
  for (const task of tasks) {
    if (!inScopeIds.has(task.id) && task.status === 'done') {
      const completedAt =
        typeof task.completedAt === 'string'
          ? new Date(task.completedAt).getTime()
          : 0;
      if (completedAt >= sessionStartTime) {
        outOfScope++;
      }
    }
  }

  // Calculate drift score (0 = no progress, 100 = all done in scope)
  let score = 0;
  if (totalInScope > 0) {
    const progressRatio = completedInScope / totalInScope;
    const driftPenalty =
      outOfScope > 0 ? Math.min(outOfScope / totalInScope, 0.5) : 0;
    score = Math.round(
      Math.max(0, Math.min(100, progressRatio * 100 - driftPenalty * 50)),
    );
  }

  if (totalInScope === 0) factors.push('No tasks found in session scope');
  if (completedInScope === 0 && totalInScope > 0)
    factors.push('No tasks completed in scope yet');
  if (completedInScope === totalInScope && totalInScope > 0)
    factors.push('All in-scope tasks completed');
  if (outOfScope > 0)
    factors.push(
      `${outOfScope} task(s) completed outside of session scope`,
    );
  if (outOfScope === 0 && completedInScope > 0)
    factors.push('All completed work is within scope');
  if (session.scope.type)
    factors.push(`Scope type: ${session.scope.type}`);

  return { score, factors, completedInScope, totalInScope, outOfScope };
}
