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
import type { Session, SessionHandoffShowParams, Task } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getAccessor } from '../store/data-accessor.js';
import { insertHandoffEntry } from '../store/session-store.js';
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
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${options.sessionId}' not found`);
  }

  // Load tasks directly from SQLite via DataAccessor
  const { tasks } = await accessor.queryTasks({});

  // Get decisions recorded during this session
  const decisions = await getDecisionLog(projectRoot, { sessionId: options.sessionId });

  // Compute handoff data
  const lastTaskId = session.taskWork?.taskId ?? null;
  const handoff: HandoffData = {
    lastTask: lastTaskId,
    tasksCompleted: session.tasksCompleted ?? [],
    tasksCreated: session.tasksCreated ?? [],
    decisionsRecorded: decisions.length,
    nextSuggested: computeNextSuggested(session, tasks),
    openBlockers: findOpenBlockers(tasks, session),
    openBugs: findOpenBugs(tasks, session),
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
function computeNextSuggested(session: Session, tasks: Task[]): string[] {
  // Filter to tasks in scope
  const scopeTaskIds = getScopeTaskIds(session, tasks);

  // Get uncompleted tasks in scope
  const pendingTasks = tasks.filter(
    (t) =>
      scopeTaskIds.has(t.id) &&
      t.status !== 'done' &&
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
      (priorityOrder[a.priority ?? 'medium'] ?? 99) - (priorityOrder[b.priority ?? 'medium'] ?? 99);
    if (priorityDiff !== 0) return priorityDiff;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });

  // Take top 3
  return pendingTasks.slice(0, 3).map((t) => t.id);
}

/**
 * Find tasks with blockers in the session scope.
 */
function findOpenBlockers(tasks: Task[], session: Session): string[] {
  const scopeTaskIds = getScopeTaskIds(session, tasks);

  return tasks.filter((t) => scopeTaskIds.has(t.id) && t.status === 'blocked').map((t) => t.id);
}

/**
 * Find open bugs in the session scope.
 */
function findOpenBugs(tasks: Task[], session: Session): string[] {
  const scopeTaskIds = getScopeTaskIds(session, tasks);

  return tasks
    .filter(
      (t) =>
        scopeTaskIds.has(t.id) &&
        (t.labels ?? []).includes('bug') &&
        t.status !== 'done' &&
        t.status !== 'archived' &&
        t.status !== 'cancelled',
    )
    .map((t) => t.id);
}

/**
 * Get set of task IDs within the session scope.
 */
function getScopeTaskIds(session: Session, tasks: Task[]): Set<string> {
  const taskIds = new Set<string>();

  if (session.scope.type === 'global') {
    for (const t of tasks) {
      taskIds.add(t.id);
    }
    return taskIds;
  }

  // Epic/task scope: root task and descendants
  const rootId = session.scope.rootTaskId ?? session.scope.epicId;
  if (!rootId) {
    // No root ID, fall back to global
    for (const t of tasks) {
      taskIds.add(t.id);
    }
    return taskIds;
  }

  const addDescendants = (taskId: string) => {
    taskIds.add(taskId);
    for (const t of tasks) {
      if (t.parentId === taskId) {
        addDescendants(t.id);
      }
    }
  };

  addDescendants(rootId);

  // Include explicitTaskIds if present in scope
  if (session.scope.explicitTaskIds) {
    for (const id of session.scope.explicitTaskIds) {
      taskIds.add(id);
    }
  }

  return taskIds;
}

/**
 * Persist handoff data to a session (write-once, append-only).
 *
 * Writes the handoff JSON into `session_handoff_entries` via an INSERT.
 * The table enforces write-once semantics at the SQL level:
 *   - A UNIQUE constraint on `session_id` rejects duplicate calls.
 *   - A BEFORE UPDATE trigger makes rows physically immutable.
 *   - An AFTER INSERT trigger mirrors the value to `sessions.handoff_json`
 *     so all existing read paths continue to work without modification.
 *
 * Throws `CleoError(SESSION_NOT_FOUND)` when the session does not exist.
 * Throws `CleoError(HANDOFF_ALREADY_PERSISTED)` when a handoff was already
 * written for this session (surfaced from the UNIQUE constraint violation).
 *
 * @task T1609
 */
export async function persistHandoff(
  projectRoot: string,
  sessionId: string,
  handoff: HandoffData,
): Promise<void> {
  const accessor = await getAccessor(projectRoot);
  const sessions = await accessor.loadSessions();

  // Verify session exists before attempting the INSERT.
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${sessionId}' not found`);
  }

  const handoffJson = JSON.stringify(handoff);

  try {
    // INSERT into session_handoff_entries.
    // The AFTER INSERT trigger mirrors the value into sessions.handoff_json.
    await insertHandoffEntry(sessionId, handoffJson, projectRoot);
  } catch (err: unknown) {
    // Translate the UNIQUE constraint violation into a domain error so callers
    // don't have to inspect raw SQLite error messages.
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('UNIQUE constraint failed')) {
      throw new CleoError(
        ExitCode.ALREADY_EXISTS,
        `Handoff already persisted for session '${sessionId}'. ` +
          'session_handoff_entries is write-once (T1609).',
      );
    }
    throw err;
  }
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
  scope?: { type: string; epicId?: string; rootTaskId?: string },
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
      const scopeRootId = scope.epicId ?? scope.rootTaskId;
      const sessionRootId = s.scope.rootTaskId ?? s.scope.epicId;
      return s.scope.type === scope.type && sessionRootId === scopeRootId;
    });
  }

  // Sort by endedAt descending (most recent first)
  endedSessions.sort((a, b) => new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime());

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
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      execOpts,
    );

    // Get commit count on current branch
    const { stdout: countStr } = await execFileAsync(
      'git',
      ['rev-list', '--count', 'HEAD'],
      execOpts,
    );

    // Get last commit hash
    const { stdout: hash } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], execOpts);

    // Check for uncommitted changes
    const { stdout: statusOut } = await execFileAsync('git', ['status', '--porcelain'], execOpts);

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

/**
 * Normalized Core entry point for session.handoff.show dispatch op.
 * Converts the wire-format scope string to the internal scope object,
 * then delegates to getLastHandoff.
 * @task T1450
 */
export async function sessionHandoffShow(
  projectRoot: string,
  params: SessionHandoffShowParams,
): Promise<{ sessionId: string; handoff: HandoffData } | null> {
  let scope: { type: string; epicId?: string } | undefined;
  if (params.scope) {
    if (params.scope === 'global') {
      scope = { type: 'global' };
    } else if (params.scope.startsWith('epic:')) {
      scope = { type: 'epic', epicId: params.scope.replace('epic:', '') };
    }
  }
  return getLastHandoff(projectRoot, scope);
}
