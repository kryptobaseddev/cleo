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

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session } from '../../types/session.js';
import type { TaskFileExt } from './types.js';
import { getDecisionLog } from './decisions.js';

const execFileAsync = promisify(execFile);

/**
 * Handoff data schema - structured state for session transition.
 */
export interface HandoffData {
  /** Last task being worked on */
  lastTask: string | null;
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
  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === options.sessionId);
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
  const lastTaskId = session.taskWork?.taskId ?? null;
  const handoff: HandoffData = {
    lastTask: lastTaskId,
    tasksCompleted: session.tasksCompleted ?? [],
    tasksCreated: session.tasksCreated ?? [],
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
  session: Session,
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
  session: Session,
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
  session: Session,
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
  session: Session,
  current: TaskFileExt,
): Set<string> {
  const taskIds = new Set<string>();

  if (!current.tasks) return taskIds;

  if (session.scope.type === 'global') {
    // Global scope: all tasks
    current.tasks.forEach((t) => taskIds.add(t.id));
  } else {
    // Epic/task scope: root task and descendants
    // Prefer rootTaskId (engine-layer), fall back to epicId (core-layer)
    const rootId = session.scope.rootTaskId ?? session.scope.epicId;
    if (!rootId) {
      // No root ID, fall back to global
      current.tasks.forEach((t) => taskIds.add(t.id));
      return taskIds;
    }

    const addDescendants = (taskId: string) => {
      taskIds.add(taskId);
      current.tasks?.forEach((t) => {
        if (t.parentId === taskId) {
          addDescendants(t.id);
        }
      });
    };

    addDescendants(rootId);

    // Include explicitTaskIds if present in scope (runtime safe access for engine-layer sessions)
    const explicitIds = (session.scope as unknown as Record<string, unknown>).explicitTaskIds;
    if (Array.isArray(explicitIds)) {
      explicitIds.forEach((id) => { if (typeof id === 'string') taskIds.add(id); });
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
  const sessions = await accessor.loadSessions();

  // Find session in active sessions
  const session = sessions.find((s) => s.id === sessionId);

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  // Store handoff data as JSON string on the typed Session field
  session.handoffJson = JSON.stringify(handoff);

  await accessor.saveSessions(sessions);
}

/**
 * Get handoff data for a session.
 */
export async function getHandoff(
  projectRoot: string,
  sessionId: string,
): Promise<HandoffData | null> {
  const accessor = await getAccessor(projectRoot);
  const sessions = await accessor.loadSessions();

  // Find session
  const session = sessions.find((s) => s.id === sessionId);

  if (!session) return null;

  // Try to get handoff from handoffJson property
  if (typeof session.handoffJson === 'string') {
    try {
      return JSON.parse(session.handoffJson) as HandoffData;
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
  const sessions = await accessor.loadSessions();

  // Filter to ended sessions
  let endedSessions = sessions.filter((s) => s.status === 'ended' && s.endedAt);

  // Filter by scope if provided
  if (scope) {
    endedSessions = endedSessions.filter((s) => {
      if (scope.type === 'global') {
        return s.scope.type === 'global';
      }
      // Match against both epicId and rootTaskId for cross-layer compatibility
      const scopeRootId = scope.epicId ?? (scope as unknown as Record<string, unknown>).rootTaskId;
      const sessionRootId = s.scope.rootTaskId ?? s.scope.epicId;
      return s.scope.type === scope.type && sessionRootId === scopeRootId;
    });
  }

  // Sort by endedAt descending (most recent first)
  endedSessions.sort(
    (a, b) =>
      new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime(),
  );

  // Find first with handoff data (check handoffJson, then debriefJson fallback)
  for (const session of endedSessions) {
    if (typeof session.handoffJson === 'string') {
      try {
        const handoff = JSON.parse(session.handoffJson) as HandoffData;
        return { sessionId: session.id, handoff };
      } catch {
        // Skip invalid handoff data
      }
    }
    // T4959: debriefJson is a superset containing handoff as a nested field
    if (typeof session.debriefJson === 'string') {
      try {
        const debrief = JSON.parse(session.debriefJson);
        if (debrief?.handoff) {
          return { sessionId: session.id, handoff: debrief.handoff as HandoffData };
        }
      } catch {
        // Skip invalid debrief data
      }
    }
  }

  return null;
}

// =============================================================================
// RICH DEBRIEF (T4959)
// =============================================================================

/**
 * Git state snapshot captured at session end.
 */
export interface GitState {
  branch: string;
  commitCount: number;
  lastCommitHash: string | null;
  uncommittedChanges: boolean;
}

/**
 * Decision summary for debrief output.
 */
export interface DebriefDecision {
  id: string;
  decision: string;
  rationale: string;
  taskId: string;
}

/**
 * Rich debrief data — superset of HandoffData.
 * Captures comprehensive session state for cross-conversation continuity.
 *
 * @epic T4959
 */
export interface DebriefData {
  /** Standard handoff data (backward compat). */
  handoff: HandoffData;
  /** Session that produced this debrief. */
  sessionId: string;
  /** Agent/conversation identifier (if known). */
  agentIdentifier: string | null;
  /** Session start time. */
  startedAt: string;
  /** Session end time. */
  endedAt: string;
  /** Duration in minutes. */
  durationMinutes: number;
  /** Decisions made during the session. */
  decisions: DebriefDecision[];
  /** Git state at session end (best-effort). */
  gitState: GitState | null;
  /** Position in the session chain (1-based). */
  chainPosition: number;
  /** Total length of the session chain. */
  chainLength: number;
}

/**
 * Options for computing debrief data.
 */
export interface ComputeDebriefOptions extends ComputeHandoffOptions {
  /** Agent/conversation identifier. */
  agentIdentifier?: string | null;
  /** Session start time. */
  startedAt?: string;
  /** Session end time. */
  endedAt?: string;
}

/**
 * Compute rich debrief data for a session.
 * Builds on computeHandoff() and adds decisions, git state, chain position.
 *
 * @epic T4959
 */
export async function computeDebrief(
  projectRoot: string,
  options: ComputeDebriefOptions,
): Promise<DebriefData> {
  // Start with the standard handoff
  const handoff = await computeHandoff(projectRoot, options);

  // Load decisions
  const decisions = await getDecisionLog(projectRoot, { sessionId: options.sessionId });
  const debriefDecisions: DebriefDecision[] = decisions.map((d) => ({
    id: d.id,
    decision: d.decision,
    rationale: d.rationale,
    taskId: d.taskId,
  }));

  // Capture git state (best-effort)
  const gitState = await captureGitState(projectRoot);

  // Compute chain position
  const { position, length } = await computeChainPosition(projectRoot, options.sessionId);

  const now = new Date().toISOString();
  const startedAt = options.startedAt ?? now;
  const endedAt = options.endedAt ?? now;
  const durationMinutes = Math.round(
    (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60000,
  );

  return {
    handoff,
    sessionId: options.sessionId,
    agentIdentifier: options.agentIdentifier ?? null,
    startedAt,
    endedAt,
    durationMinutes,
    decisions: debriefDecisions,
    gitState,
    chainPosition: position,
    chainLength: length,
  };
}

/**
 * Capture git state via safe shell execution.
 * Returns null on any failure (no git, not a repo, etc.).
 */
async function captureGitState(projectRoot: string): Promise<GitState | null> {
  try {
    const execOpts = { cwd: projectRoot, timeout: 5000 };

    // Get current branch
    const { stdout: branch } = await execFileAsync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'], execOpts,
    );

    // Get commit count on current branch
    const { stdout: countStr } = await execFileAsync(
      'git', ['rev-list', '--count', 'HEAD'], execOpts,
    );

    // Get last commit hash
    const { stdout: hash } = await execFileAsync(
      'git', ['rev-parse', '--short', 'HEAD'], execOpts,
    );

    // Check for uncommitted changes
    const { stdout: statusOut } = await execFileAsync(
      'git', ['status', '--porcelain'], execOpts,
    );

    return {
      branch: branch.trim(),
      commitCount: parseInt(countStr.trim(), 10) || 0,
      lastCommitHash: hash.trim() || null,
      uncommittedChanges: statusOut.trim().length > 0,
    };
  } catch {
    return null;
  }
}

/**
 * Compute chain position by walking the previousSessionId links.
 */
async function computeChainPosition(
  projectRoot: string,
  sessionId: string,
): Promise<{ position: number; length: number }> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();

    const sessionMap = new Map(sessions.map((s) => [s.id, s]));

    // Walk backward to find chain start
    let current = sessionId;
    let position = 1;
    const visited = new Set<string>();
    while (true) {
      visited.add(current);
      const session = sessionMap.get(current);
      if (!session?.previousSessionId || visited.has(session.previousSessionId)) break;
      current = session.previousSessionId;
      position++;
    }

    // Walk forward from chain start to count total length
    let length = position;
    const startSession = sessionMap.get(sessionId);
    let fwd = startSession?.nextSessionId;
    while (fwd && !visited.has(fwd)) {
      visited.add(fwd);
      length++;
      const s = sessionMap.get(fwd);
      fwd = s?.nextSessionId ?? undefined;
    }

    return { position, length };
  } catch {
    return { position: 1, length: 1 };
  }
}
