/**
 * Session handoff computation and persistence.
 *
 * Creates structured handoff data when a session ends, containing:
 * - Last focused task
 * - Tasks completed and created
 * - Decisions recorded
 * - Next suggested tasks
 * - Open blockers and bugs
 * - Human override notes
 *
 * @task T4915
 * @epic T4914
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { SessionRecord, SessionsFileExt, TaskFileExt } from './types.js';
import { getDecisionLog } from './decisions.js';

/**
 * Handoff data schema - structured state for session transition.
 */
export interface HandoffData {
  /** Last task being worked on */
  lastTask: string | null;
  /** @deprecated Use lastTask instead. */
  lastFocus?: string | null;
  /** Tasks completed in session */
  tasksCompleted: string[];
  /** Tasks created in session */
  tasksCreated: string[];
  /** Count of decisions recorded */
  decisionsRecorded: number;
  /** Top-3 from tasks.next */
  nextSuggested: string[];
  /** Tasks with blockers */
  openBlockers: string[];
  /** Open bugs */
  openBugs: string[];
  /** Human override note */
  note?: string;
  /** Human override next action */
  nextAction?: string;
}

/**
 * Options for computing handoff data.
 */
export interface ComputeHandoffOptions {
  sessionId: string;
  /** Optional human note override */
  note?: string;
  /** Optional human next action override */
  nextAction?: string;
}

/**
 * Compute handoff data for a session.
 * Gathers all session statistics and auto-computes structured state.
 */
export async function computeHandoff(
  projectRoot: string,
  options: ComputeHandoffOptions,
): Promise<HandoffData> {
  const accessor = await getAccessor(projectRoot);

  // Load session data
  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;
  const allSessions: SessionRecord[] = [
    ...(sessions?.sessions || []),
    ...(sessions?.sessionHistory || []),
  ];

  const session = allSessions.find((s) => s.id === options.sessionId);
  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${options.sessionId}' not found`,
    );
  }

  // Load task data for scope analysis
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  // Get decisions recorded during this session
  const decisions = await getDecisionLog(projectRoot, { sessionId: options.sessionId });

  // Compute handoff data
  const handoff: HandoffData = {
    lastTask: session.focus?.currentTask ?? null,
    lastFocus: session.focus?.currentTask ?? null,
    tasksCompleted: session.stats?.tasksCompleted
      ? [String(session.stats.tasksCompleted)]
      : [],
    tasksCreated: session.stats?.tasksCreated
      ? [String(session.stats.tasksCreated)]
      : [],
    decisionsRecorded: decisions.length,
    nextSuggested: computeNextSuggested(session, current),
    openBlockers: findOpenBlockers(current, session),
    openBugs: findOpenBugs(current, session),
  };

  // Apply human overrides
  if (options.note) {
    handoff.note = options.note;
  }
  if (options.nextAction) {
    handoff.nextAction = options.nextAction;
  }

  return handoff;
}

/**
 * Compute top-3 next suggested tasks.
 * Prioritizes uncompleted tasks within the session scope.
 */
function computeNextSuggested(
  session: SessionRecord,
  current: TaskFileExt,
): string[] {
  const suggestions: string[] = [];

  if (!current.tasks) return suggestions;

  // Filter to tasks in scope
  const scopeTaskIds = getScopeTaskIds(session, current);

  // Get uncompleted tasks in scope
  const pendingTasks = current.tasks.filter(
    (t) =>
      scopeTaskIds.has(t.id) &&
      t.status !== 'done' &&
      t.status !== 'completed' &&
      t.status !== 'archived' &&
      t.status !== 'cancelled',
  );

  // Sort by priority and created date
  const priorityOrder: Record<string, number> = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
  };

  pendingTasks.sort((a, b) => {
    const priorityDiff =
      (priorityOrder[a.priority as string] ?? 99) -
      (priorityOrder[b.priority as string] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;
    const aCreated = typeof a.createdAt === 'string' ? a.createdAt : '1970-01-01T00:00:00Z';
    const bCreated = typeof b.createdAt === 'string' ? b.createdAt : '1970-01-01T00:00:00Z';
    return new Date(aCreated).getTime() - new Date(bCreated).getTime();
  });

  // Take top 3
  return pendingTasks.slice(0, 3).map((t) => t.id);
}

/**
 * Find tasks with blockers in the session scope.
 */
function findOpenBlockers(
  current: TaskFileExt,
  session: SessionRecord,
): string[] {
  const blockers: string[] = [];

  if (!current.tasks) return blockers;

  const scopeTaskIds = getScopeTaskIds(session, current);

  // Find blocked tasks in scope
  const blockedTasks = current.tasks.filter(
    (t) => scopeTaskIds.has(t.id) && t.status === 'blocked',
  );

  return blockedTasks.map((t) => t.id);
}

/**
 * Find open bugs in the session scope.
 */
function findOpenBugs(
  current: TaskFileExt,
  session: SessionRecord,
): string[] {
  const bugs: string[] = [];

  if (!current.tasks) return bugs;

  const scopeTaskIds = getScopeTaskIds(session, current);

  // Find bug-type tasks that aren't closed
  const bugTasks = current.tasks.filter(
    (t) =>
      scopeTaskIds.has(t.id) &&
      (t.type === 'bug' || (Array.isArray(t.labels) && t.labels.some((l: string) => l === 'bug'))) &&
      t.status !== 'done' &&
      t.status !== 'completed' &&
      t.status !== 'archived' &&
      t.status !== 'cancelled',
  );

  return bugTasks.map((t) => t.id);
}

/**
 * Get set of task IDs within the session scope.
 */
function getScopeTaskIds(
  session: SessionRecord,
  current: TaskFileExt,
): Set<string> {
  const taskIds = new Set<string>();

  if (!current.tasks) return taskIds;

  const rootTaskId = session.scope.rootTaskId;

  if (session.scope.type === 'global') {
    // Global scope: all tasks
    current.tasks.forEach((t) => taskIds.add(t.id));
  } else {
    // Epic/task scope: root task and descendants
    const addDescendants = (taskId: string) => {
      taskIds.add(taskId);
      current.tasks?.forEach((t) => {
        if (t.parentId === taskId) {
          addDescendants(t.id);
        }
      });
    };

    addDescendants(rootTaskId);

    // Also include explicitly scoped tasks if present
    if (session.scope.explicitTaskIds) {
      session.scope.explicitTaskIds.forEach((id) => taskIds.add(id));
    }
  }

  return taskIds;
}

/**
 * Persist handoff data to a session.
 */
export async function persistHandoff(
  projectRoot: string,
  sessionId: string,
  handoff: HandoffData,
): Promise<void> {
  const accessor = await getAccessor(projectRoot);
  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;

  if (!sessions) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      'Sessions file not found',
    );
  }

  // Find in active sessions or history
  let session = sessions.sessions?.find((s) => s.id === sessionId);

  if (!session && sessions.sessionHistory) {
    session = sessions.sessionHistory.find((s) => s.id === sessionId);
  }

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  // Store handoff data as JSON string for persistence compatibility
  (session as unknown as Record<string, unknown>).handoffJson = JSON.stringify(handoff);

  await accessor.saveSessions(sessionsData);
}

/**
 * Get handoff data for a session.
 */
export async function getHandoff(
  projectRoot: string,
  sessionId: string,
): Promise<HandoffData | null> {
  const accessor = await getAccessor(projectRoot);
  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;

  if (!sessions) return null;

  // Find in active sessions or history
  let session = sessions.sessions?.find((s) => s.id === sessionId);

  if (!session && sessions.sessionHistory) {
    session = sessions.sessionHistory.find((s) => s.id === sessionId);
  }

  if (!session) return null;

  // Try to get handoff from handoffJson property
  const handoffJson = (session as unknown as Record<string, unknown>).handoffJson;
  if (typeof handoffJson === 'string') {
    try {
      return JSON.parse(handoffJson) as HandoffData;
    } catch {
      // Fall through to null
    }
  }

  return null;
}

/**
 * Get handoff data for the most recent ended session.
 * Filters by scope if provided.
 */
export async function getLastHandoff(
  projectRoot: string,
  scope?: { type: string; epicId?: string },
): Promise<{ sessionId: string; handoff: HandoffData } | null> {
  const accessor = await getAccessor(projectRoot);
  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;

  if (!sessions) return null;

  // Get all sessions including history, sorted by end time
  const allSessions: Array<SessionRecord & { _source: 'active' | 'history' }> = [
    ...(sessions.sessions || []).map((s) => ({ ...s, _source: 'active' as const })),
    ...(sessions.sessionHistory || []).map((s) => ({ ...s, _source: 'history' as const })),
  ];

  // Filter to ended sessions
  let endedSessions = allSessions.filter((s) => s.status === 'ended' && s.endedAt);

  // Filter by scope if provided
  if (scope) {
    endedSessions = endedSessions.filter((s) => {
      if (scope.type === 'global') {
        return s.scope.type === 'global';
      }
      return s.scope.type === scope.type && s.scope.rootTaskId === scope.epicId;
    });
  }

  // Sort by endedAt descending (most recent first)
  endedSessions.sort(
    (a, b) =>
      new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime(),
  );

  // Find first with handoff data
  for (const session of endedSessions) {
    const handoffJson = (session as unknown as Record<string, unknown>).handoffJson;
    if (typeof handoffJson === 'string') {
      try {
        const handoff = JSON.parse(handoffJson) as HandoffData;
        return { sessionId: session.id, handoff };
      } catch {
        // Skip invalid handoff data
      }
    }
  }

  // If no handoff found but we have an ended session, return null
  return null;
}
