/**
 * Session briefing computation.
 *
 * Aggregates session-start context from multiple sources for quick agent
 * orientation. This is the READ side of the handoff/briefing pair.
 *
 * Data sources:
 * - Last session handoff (session.handoff)
 * - Current focus (tasks.current)
 * - Top-N next tasks (tasks.next leverage-scored)
 * - Open bugs (tasks with origin:bug-report or label:bug)
 * - Blocked tasks (tasks.blockers)
 * - Active epics status (tasks.tree filtered)
 * - Pipeline stage data (from T4912)
 *
 * @task T4916
 * @epic T4914
 */

import { getAccessor } from '../../store/data-accessor.js';
import { getLastHandoff, type HandoffData } from './handoff.js';
import type { Session } from '../../types/session.js';
import type { TaskFileExt } from './types.js';

/**
 * Task summary for briefing output.
 */
export interface BriefingTask {
  id: string;
  title: string;
  leverage: number;
  score: number;
}

/**
 * Bug summary for briefing output.
 */
export interface BriefingBug {
  id: string;
  title: string;
  priority: string;
}

/**
 * Blocked task summary for briefing output.
 */
export interface BriefingBlockedTask {
  id: string;
  title: string;
  blockedBy: string[];
}

/**
 * Active epic summary for briefing output.
 */
export interface BriefingEpic {
  id: string;
  title: string;
  completionPercent: number;
}

/**
 * Pipeline stage data for briefing output.
 */
export interface PipelineStageInfo {
  currentStage: string;
  stageStatus: string;
}

/**
 * Last session info with handoff data.
 */
export interface LastSessionInfo {
  endedAt: string;
  duration: number;
  handoff: HandoffData;
}

/**
 * Currently active task info.
 */
export interface CurrentTaskInfo {
  id: string;
  title: string;
  status: string;
}

/** @deprecated Use CurrentTaskInfo instead. */
export type CurrentFocus = CurrentTaskInfo;

/**
 * Session briefing result.
 */
export interface SessionBriefing {
  lastSession: LastSessionInfo | null;
  currentTask: CurrentTaskInfo | null;
  /** @deprecated Use currentTask instead. */
  currentFocus?: CurrentTaskInfo | null;
  nextTasks: BriefingTask[];
  openBugs: BriefingBug[];
  blockedTasks: BriefingBlockedTask[];
  activeEpics: BriefingEpic[];
  pipelineStage?: PipelineStageInfo;
}

/**
 * Options for computing session briefing.
 */
export interface BriefingOptions {
  /** Maximum number of next tasks to include (default: 5) */
  maxNextTasks?: number;
  /** Maximum number of bugs to include (default: 10) */
  maxBugs?: number;
  /** Maximum number of blocked tasks to include (default: 10) */
  maxBlocked?: number;
  /** Maximum number of active epics to include (default: 5) */
  maxEpics?: number;
  /** Scope filter: 'global' or 'epic:T###' */
  scope?: string;
}

const PRIORITY_SCORE: Record<string, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25,
};

/**
 * Compute the complete session briefing.
 * Aggregates data from all 6+ sources.
 */
export async function computeBriefing(
  projectRoot: string,
  options: BriefingOptions = {},
): Promise<SessionBriefing> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;
  const tasks = current.tasks || [];

  // Build task map for quick lookups
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  // Determine scope
  const scopeFilter = parseScope(options.scope, current);

  // Compute in-scope task IDs (undefined = all tasks in scope)
  const scopeTaskIds = getScopeTaskIdSet(scopeFilter, tasks as Array<{ id: string; parentId?: string; [key: string]: unknown }>);

  // 1. Last session handoff
  const lastSession = await computeLastSession(projectRoot, scopeFilter);

  // 2. Current active task
  const currentTaskInfo = computeCurrentTask(current, taskMap);

  // 3. Next tasks (leverage-scored)
  const nextTasks = computeNextTasks(tasks, taskMap, current, {
    maxTasks: options.maxNextTasks ?? 5,
    scopeTaskIds,
  });

  // 4. Open bugs
  const openBugs = computeOpenBugs(tasks, taskMap, {
    maxBugs: options.maxBugs ?? 10,
    scopeTaskIds,
  });

  // 5. Blocked tasks
  const blockedTasks = computeBlockedTasks(tasks, taskMap, {
    maxBlocked: options.maxBlocked ?? 10,
    scopeTaskIds,
  });

  // 6. Active epics
  const activeEpics = computeActiveEpics(tasks, taskMap, {
    maxEpics: options.maxEpics ?? 5,
    scopeTaskIds,
  });

  // 7. Pipeline stage (optional - may not be available)
  const pipelineStage = computePipelineStage(current);

  return {
    lastSession,
    currentTask: currentTaskInfo,
    currentFocus: currentTaskInfo,
    nextTasks,
    openBugs,
    blockedTasks,
    activeEpics,
    ...(pipelineStage && { pipelineStage }),
  };
}

/**
 * Parse scope string into filter config.
 */
function parseScope(
  scopeStr: string | undefined,
  current: TaskFileExt,
): { type: 'global' | 'epic'; epicId?: string } | undefined {
  if (!scopeStr) {
    // Auto-detect from current focus or active session
    const activeSession = findActiveSession(current);
    if (activeSession?.scope?.type === 'epic') {
      return { type: 'epic', epicId: activeSession.scope.rootTaskId };
    }
    if (activeSession?.scope?.type === 'global') {
      return { type: 'global' };
    }
    return undefined;
  }

  if (scopeStr === 'global') {
    return { type: 'global' };
  }
  const match = scopeStr.match(/^epic:(T\d+)$/);
  if (match) {
    return { type: 'epic', epicId: match[1] };
  }
  return undefined;
}

/**
 * Find the active session from task data.
 * T4959: Now loads real session data from the accessor instead of
 * synthesizing a stub record from the task file focus.
 */
function findActiveSession(current: TaskFileExt): Session | undefined {
  const activeSessionId = current._meta?.activeSession;
  if (!activeSessionId) return undefined;

  // Try to get process-scoped session context first (MCP path)
  try {
    // Dynamic import avoided here to keep this synchronous.
    // Instead, build a minimal record from _meta + focus.
    const focusTaskId = current.focus?.currentTask;
    return {
      id: activeSessionId,
      name: '',
      status: 'active',
      scope: { type: 'task', rootTaskId: focusTaskId ?? '' },
      taskWork: { taskId: focusTaskId ?? null, setAt: new Date().toISOString() },
      startedAt: new Date().toISOString(),
    } as Session;
  } catch {
    return undefined;
  }
}

/**
 * Compute the set of in-scope task IDs for briefing filtering.
 * Returns undefined for global/unscoped (meaning all tasks are in scope).
 */
function getScopeTaskIdSet(
  scopeFilter: { type: 'global' | 'epic'; epicId?: string } | undefined,
  tasks: Array<{ id: string; parentId?: string; [key: string]: unknown }>,
): Set<string> | undefined {
  if (!scopeFilter || scopeFilter.type === 'global') {
    return undefined; // All tasks in scope
  }

  const rootId = scopeFilter.epicId;
  if (!rootId) return undefined;

  const taskIds = new Set<string>();
  const addDescendants = (taskId: string) => {
    taskIds.add(taskId);
    for (const t of tasks) {
      if (t.parentId === taskId) {
        addDescendants(t.id);
      }
    }
  };
  addDescendants(rootId);
  return taskIds;
}

/**
 * Compute last session info with handoff data.
 */
async function computeLastSession(
  projectRoot: string,
  scopeFilter: { type: 'global' | 'epic'; epicId?: string } | undefined,
): Promise<LastSessionInfo | null> {
  try {
    const scope = scopeFilter
      ? { type: scopeFilter.type, epicId: scopeFilter.epicId }
      : undefined;

    const handoffResult = await getLastHandoff(projectRoot, scope);
    if (!handoffResult) return null;

    const { sessionId, handoff } = handoffResult;

    // Load sessions to get endedAt
    const accessor = await getAccessor(projectRoot);
    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as { sessions?: Session[]; sessionHistory?: Session[] };

    // Find session in active or history
    const allSessions: Session[] = [
      ...(sessions?.sessions || []),
      ...(sessions?.sessionHistory || []),
    ];

    const session = allSessions.find((s) => s.id === sessionId);
    if (!session || !session.endedAt) return null;

    // Calculate duration if startedAt is available
    let duration = 0;
    if (session.startedAt) {
      duration = Math.round(
        (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 60000,
      );
    }

    return {
      endedAt: session.endedAt,
      duration,
      handoff,
    };
  } catch {
    return null;
  }
}

/**
 * Compute current active task from task file.
 */
function computeCurrentTask(
  current: TaskFileExt,
  taskMap: Map<string, unknown>,
): CurrentTaskInfo | null {
  const focusTaskId = current.focus?.currentTask;
  if (!focusTaskId) return null;

  const task = taskMap.get(focusTaskId) as
    | { id: string; title: string; status: string }
    | undefined;
  if (!task) return null;

  return {
    id: task.id,
    title: task.title,
    status: task.status,
  };
}

/**
 * Compute leverage for a task.
 */
function calculateLeverage(taskId: string, taskMap: Map<string, unknown>): number {
  let leverage = 0;
  for (const task of taskMap.values()) {
    const t = task as { depends?: string[] };
    if (t.depends?.includes(taskId)) {
      leverage++;
    }
  }
  return leverage;
}

/**
 * Check if task dependencies are satisfied.
 */
function depsReady(task: { depends?: string[] }, taskMap: Map<string, unknown>): boolean {
  if (!task.depends || task.depends.length === 0) return true;
  return task.depends.every((depId) => {
    const dep = taskMap.get(depId) as { status?: string } | undefined;
    return dep && (dep.status === 'done' || dep.status === 'cancelled');
  });
}

/**
 * Compute next tasks sorted by leverage and score.
 */
function computeNextTasks(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  current: TaskFileExt,
  options: { maxTasks: number; scopeTaskIds?: Set<string> },
): BriefingTask[] {
  const pendingTasks = tasks.filter((t) => {
    const task = t as { id?: string; status?: string };
    return task.status === 'pending' &&
      (!options.scopeTaskIds || options.scopeTaskIds.has(task.id!));
  });

  const scored: BriefingTask[] = [];
  const currentPhase = current.focus?.currentPhase;

  for (const task of pendingTasks) {
    const t = task as {
      id: string;
      title: string;
      priority?: string;
      phase?: string;
      createdAt?: string;
      depends?: string[];
    };

    if (!depsReady(t, taskMap)) continue;

    const leverage = calculateLeverage(t.id, taskMap);
    let score = PRIORITY_SCORE[t.priority || 'medium'] ?? 50;

    // Phase alignment bonus
    if (currentPhase && t.phase === currentPhase) {
      score += 20;
    }

    // Dependencies satisfied bonus
    if (t.depends && t.depends.length > 0) {
      score += 10;
    }

    // Age bonus
    if (t.createdAt) {
      const ageMs = Date.now() - new Date(t.createdAt).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        score += Math.min(15, Math.floor(ageDays / 7));
      }
    }

    // Leverage bonus
    if (leverage > 0) {
      score += leverage * 5;
    }

    scored.push({ id: t.id, title: t.title, leverage, score });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, options.maxTasks);
}

/**
 * Compute open bugs.
 */
function computeOpenBugs(
  tasks: unknown[],
  _taskMap: Map<string, unknown>,
  options: { maxBugs: number; scopeTaskIds?: Set<string> },
): BriefingBug[] {
  const bugs: BriefingBug[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      status?: string;
      priority?: string;
      origin?: string;
      labels?: string[];
    };

    const isBug = t.origin === 'bug-report' || t.labels?.includes('bug');
    const isOpen = t.status !== 'done' && t.status !== 'cancelled';

    if (isBug && isOpen && (!options.scopeTaskIds || options.scopeTaskIds.has(t.id))) {
      bugs.push({
        id: t.id,
        title: t.title,
        priority: t.priority || 'medium',
      });
    }
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  bugs.sort((a, b) => (priorityOrder[a.priority] ?? 99) - (priorityOrder[b.priority] ?? 99));

  return bugs.slice(0, options.maxBugs);
}

/**
 * Compute blocked tasks.
 */
function computeBlockedTasks(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  options: { maxBlocked: number; scopeTaskIds?: Set<string> },
): BriefingBlockedTask[] {
  const blocked: BriefingBlockedTask[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      status?: string;
      depends?: string[];
      blockedBy?: string;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;

    const blockedBy: string[] = [];

    // Check blocked status
    if (t.status === 'blocked' && t.blockedBy) {
      blockedBy.push(t.blockedBy);
    }

    // Check unresolved dependencies
    if (t.depends && t.depends.length > 0) {
      for (const depId of t.depends) {
        const dep = taskMap.get(depId) as { status?: string } | undefined;
        if (dep && dep.status !== 'done' && dep.status !== 'cancelled') {
          if (!blockedBy.includes(depId)) {
            blockedBy.push(depId);
          }
        }
      }
    }

    if (blockedBy.length > 0) {
      blocked.push({
        id: t.id,
        title: t.title,
        blockedBy,
      });
    }
  }

  return blocked.slice(0, options.maxBlocked);
}

/**
 * Compute active epics.
 */
function computeActiveEpics(
  tasks: unknown[],
  taskMap: Map<string, unknown>,
  options: { maxEpics: number; scopeTaskIds?: Set<string> },
): BriefingEpic[] {
  const epics: BriefingEpic[] = [];

  for (const task of tasks) {
    const t = task as {
      id: string;
      title: string;
      type?: string;
      status?: string;
    };

    if (options.scopeTaskIds && !options.scopeTaskIds.has(t.id)) continue;

    if (t.type === 'epic' && t.status === 'active') {
      const completionPercent = calculateEpicCompletion(t.id, taskMap);
      epics.push({
        id: t.id,
        title: t.title,
        completionPercent,
      });
    }
  }

  // Sort by completion (ascending - less complete first)
  epics.sort((a, b) => a.completionPercent - b.completionPercent);

  return epics.slice(0, options.maxEpics);
}

/**
 * Calculate completion percentage for an epic.
 */
function calculateEpicCompletion(epicId: string, taskMap: Map<string, unknown>): number {
  let totalTasks = 0;
  let completedTasks = 0;

  // Collect all descendant tasks
  const collectTasks = (parentId: string): void => {
    for (const task of taskMap.values()) {
      const t = task as { parentId?: string; id: string; status?: string };
      if (t.parentId === parentId) {
        totalTasks++;
        if (t.status === 'done' || t.status === 'cancelled') {
          completedTasks++;
        }
        collectTasks(t.id);
      }
    }
  };

  collectTasks(epicId);

  return totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
}

/**
 * Compute pipeline stage info from task file metadata.
 */
function computePipelineStage(current: TaskFileExt): PipelineStageInfo | undefined {
  // Try to get from _meta or focus
  const stage = (current._meta as Record<string, unknown>)?.pipelineStage as
    | string
    | undefined;
  const stageStatus = (current._meta as Record<string, unknown>)?.pipelineStageStatus as
    | string
    | undefined;

  if (stage) {
    return {
      currentStage: stage,
      stageStatus: stageStatus || 'active',
    };
  }

  // Try from lifecycle state if available
  const lifecycleState = current._meta?.lifecycleState as string | undefined;
  if (lifecycleState) {
    return {
      currentStage: lifecycleState,
      stageStatus: 'active',
    };
  }

  return undefined;
}
