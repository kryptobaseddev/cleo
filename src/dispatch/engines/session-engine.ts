/**
 * Session Engine — thin wrapper layer.
 *
 * Delegates all business logic to src/core/sessions/ and src/core/task-work/.
 * Each function catches errors from core and wraps them into EngineResult.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import {
  showSession,
  suspendSession,
  getSessionHistory,
  cleanupSessions,
  getSessionStats,
  switchSession,
  archiveSessions,
  getContextDrift,
  recordDecision,
  getDecisionLog,
  recordAssumption,
  computeHandoff,
  persistHandoff,
  getLastHandoff,
  computeBriefing,
} from '../../core/sessions/index.js';
import { generateSessionId } from '../../core/sessions/session-id.js';
import type { HandoffData } from '../../core/sessions/handoff.js';
import { computeDebrief, type DebriefData } from '../../core/sessions/handoff.js';
import type { SessionBriefing } from '../../core/sessions/briefing.js';
import type { DecisionRecord } from '../../core/sessions/types.js';
import type { Session } from '../../types/session.js';
import type { TaskWorkState } from '../../types/task.js';
import {
  currentTask,
  startTask,
  stopTask,
} from '../../core/task-work/index.js';
import { engineError, type EngineResult } from './_error.js';

// Re-export types for consumers
export type { Session as SessionRecord };
export type { DecisionRecord };

// Re-export EngineResult for consumers
export type { EngineResult };

/**
 * Get current session status.
 * @task T4782
 */
export async function sessionStatus(
  projectRoot: string,
): Promise<
  EngineResult<{
    hasActiveSession: boolean;
    session?: Session | null;
    taskWork?: TaskWorkState | null;
  }>
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();

    const sessions = await accessor.loadSessions();
    const active = sessions.find((s: Session) => s.status === 'active');

    return {
      success: true,
      data: {
        hasActiveSession: !!active,
        session: active || null,
        taskWork: (taskData.focus as TaskWorkState | undefined) || null,
      },
    };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * List sessions.
 * @task T4782
 */
export async function sessionList(
  projectRoot: string,
  params?: { active?: boolean; limit?: number },
): Promise<EngineResult<Session[]>> {
  try {
    const accessor = await getAccessor(projectRoot);

    let result = await accessor.loadSessions();

    if (params?.active === true) {
      result = result.filter((s: Session) => s.status === 'active');
    } else if (params?.active === false) {
      result = result.filter((s: Session) => s.status !== 'active');
    }

    if (params?.limit && params.limit > 0) {
      result = result.slice(0, params.limit);
    }

    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Show a specific session.
 * @task T4782
 */
export async function sessionShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await showSession(projectRoot, sessionId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Get current task being worked on.
 * Delegates to core/task-work/currentTask.
 * @task T4782
 */
export async function taskCurrentGet(
  projectRoot: string,
): Promise<EngineResult<{ currentTask: string | null; currentPhase: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await currentTask(undefined, accessor);
    return {
      success: true,
      data: {
        currentTask: result.currentTask,
        currentPhase: result.currentPhase,
      },
    };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Start working on a specific task.
 * Delegates to core/task-work/startTask.
 * @task T4782
 */
export async function taskStart(
  projectRoot: string,
  taskId: string,
): Promise<EngineResult<{ taskId: string; previousTask: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await startTask(taskId, undefined, accessor);
    return {
      success: true,
      data: { taskId: result.taskId, previousTask: result.previousTask },
    };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Stop working on the current task.
 * Delegates to core/task-work/stopTask.
 * @task T4782
 */
export async function taskStop(
  projectRoot: string,
): Promise<EngineResult<{ cleared: boolean; previousTask: string | null }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const result = await stopTask(undefined, accessor);
    return {
      success: true,
      data: { cleared: true, previousTask: result.previousTask },
    };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Start a new session.
 * Note: This function has engine-specific logic for task file focus management
 * and session store updates, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionStart(
  projectRoot: string,
  params: {
    scope: string;
    name?: string;
    autoStart?: boolean;
    startTask?: string;
    /** Enable full query+mutation audit logging for behavioral grading. */
    grade?: boolean;
  },
): Promise<EngineResult<Session>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();

    // Parse scope (e.g., "epic:T001" -> { type: 'epic', rootTaskId: 'T001' })
    const scopeParts = params.scope.split(':');
    const scopeType = scopeParts[0] || 'task';
    const rootTaskId = scopeParts[1] || '';

    if (!rootTaskId) {
      return engineError('E_INVALID_INPUT', 'Scope must include a task ID (e.g., epic:T001)');
    }

    // Verify root task exists
    const rootTask = taskData.tasks?.find((t) => t.id === rootTaskId);
    if (!rootTask) {
      return engineError('E_NOT_FOUND', `Root task '${rootTaskId}' not found`);
    }

    const now = new Date().toISOString();
    const sessionId = generateSessionId();

    // T4959: Chain linking — find most recent ended session for same scope
    let previousSessionId: string | null = null;
    {
      const sessions = await accessor.loadSessions();
      const sameScope = sessions
        .filter((s: Session) =>
          s.status === 'ended' &&
          s.endedAt &&
          s.scope?.rootTaskId === rootTaskId &&
          s.scope?.type === scopeType,
        )
        .sort((a: Session, b: Session) =>
          new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime(),
        );
      if (sameScope.length > 0) {
        previousSessionId = sameScope[0].id;
      }
    }

    // Resolve agent identifier from params or env
    const agentIdentifier = (params as Record<string, unknown>).agentIdentifier as string | undefined
      ?? process.env.CLEO_AGENT_ID
      ?? null;

    const startingTaskId = params.startTask || (params.autoStart ? rootTaskId : null);

    const newSession: Session = {
      id: sessionId,
      status: 'active',
      name: params.name || `session-${sessionId}`,
      scope: {
        type: scopeType,
        rootTaskId,
        includeDescendants: true,
      },
      taskWork: {
        taskId: startingTaskId,
        setAt: now,
      },
      startedAt: now,
      resumeCount: 0,
      ...(params.grade ? { gradeMode: true } : {}),
      stats: {
        tasksCompleted: 0,
        tasksCreated: 0,
        tasksUpdated: 0,
        focusChanges: 0,
        totalActiveMinutes: 0,
        suspendCount: 0,
      },
    };

    // Update focus in task file
    if (!taskData.focus) {
      taskData.focus = {
        currentTask: null,
        currentPhase: null,
        blockedUntil: null,
        sessionNote: null,
        sessionNotes: [],
        nextAction: null,
        primarySession: null,
      };
    }

    const startingTask = params.startTask;
    if (startingTask) {
      taskData.focus.currentTask = startingTask;
    } else if (params.autoStart) {
      taskData.focus.currentTask = rootTaskId;
    }

    if (taskData._meta) {
      taskData._meta.lastSessionId = sessionId;
      taskData._meta.activeSession = sessionId;
      taskData._meta.generation = (taskData._meta.generation || 0) + 1;
    }

    (taskData as unknown as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTaskFile(taskData);

    // Write to sessions store so resume/suspend can find the session.
    {
      const sessions = await accessor.loadSessions();

      // T4959: Set chain fields on new session
      if (previousSessionId) {
        newSession.previousSessionId = previousSessionId;

        // Update predecessor's nextSessionId
        const pred = sessions.find((s: Session) => s.id === previousSessionId);
        if (pred) {
          pred.nextSessionId = sessionId;
        }
      }

      if (agentIdentifier) {
        newSession.agentIdentifier = agentIdentifier;
      }

      sessions.push(newSession);

      await accessor.saveSessions(sessions);
    }

    // Enable grade mode: set env vars so audit middleware logs queries too
    if (params.grade) {
      process.env.CLEO_SESSION_GRADE = 'true';
      process.env.CLEO_SESSION_ID = sessionId;
    }

    // T4959: Auto-briefing — enrich response with briefing + predecessor debrief
    let briefing: SessionBriefing | null = null;
    let previousDebrief: DebriefData | null = null;
    try {
      briefing = await computeBriefing(projectRoot, { scope: params.scope });
    } catch {
      // Best-effort — briefing failure should not fail session start
    }

    // 5B: Load predecessor debrief/handoff and mark consumed
    let previousHandoff: HandoffData | null = null;
    if (previousSessionId) {
      try {
        const sessions2 = await accessor.loadSessions();
        const pred = sessions2.find((s: Session) => s.id === previousSessionId);
        if (pred) {
          // Try debriefJson first (rich data), then handoffJson (basic)
          if (pred.debriefJson) {
            previousDebrief = JSON.parse(pred.debriefJson as string) as DebriefData;
          } else if ((pred as unknown as Record<string, unknown>).handoffJson) {
            previousHandoff = JSON.parse((pred as unknown as Record<string, unknown>).handoffJson as string) as HandoffData;
          }
          // Always mark consumed regardless of debrief vs handoff
          pred.handoffConsumedAt = new Date().toISOString();
          pred.handoffConsumedBy = sessionId;
          await accessor.saveSessions(sessions2);
        }
      } catch {
        // Best-effort
      }
    }

    const enrichedSession = {
      ...newSession,
      ...(briefing && { briefing }),
      ...(previousDebrief && { previousDebrief }),
      ...(previousHandoff && { previousHandoff }),
    };

    return { success: true, data: enrichedSession as Session };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * End the current session.
 * Note: This function has engine-specific logic for task file focus management
 * and session store management, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionEnd(
  projectRoot: string,
  notes?: string,
): Promise<EngineResult<{ sessionId: string; ended: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();

    const sessionId = taskData._meta?.activeSession || 'default';
    const now = new Date().toISOString();

    // Clear grade mode env vars when session ends
    if (process.env.CLEO_SESSION_GRADE === 'true') {
      delete process.env.CLEO_SESSION_GRADE;
      delete process.env.CLEO_SESSION_ID;
    }

    // Clear focus
    if (taskData.focus) {
      taskData.focus.currentTask = null;
      if (notes) {
        if (!taskData.focus.sessionNotes) taskData.focus.sessionNotes = [];
        taskData.focus.sessionNotes.push({ timestamp: now, note: notes });
      }
    }

    if (taskData._meta) {
      taskData._meta.activeSession = null;
      taskData._meta.generation = (taskData._meta.generation || 0) + 1;
    }

    (taskData as unknown as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTaskFile(taskData);

    // Always update sessions.json — sessionStart always writes there
    // (see sessionStart comment: "Always write to sessions.json so resume/suspend can find the session")
    if (sessionId !== 'default') {
      const sessions = await accessor.loadSessions();
      const session = sessions.find(
        (s: Session) => s.id === sessionId,
      );
      if (session) {
        session.status = 'ended';
        session.endedAt = now;

        await accessor.saveSessions(sessions);
      }
    }

    return { success: true, data: { sessionId, ended: true } };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Resume an ended or suspended session.
 * Note: This function has engine-specific logic for task file focus sync,
 * so it remains in the engine layer.
 * @task T4782
 */
export async function sessionResume(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();

    // Look up sessions from the store.
    const sessions = await accessor.loadSessions();

    // Look in sessions list
    const session = sessions.find((s: Session) => s.id === sessionId);

    if (!session) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    if (session.status === 'active') {
      return { success: true, data: session };
    }

    if ((session.status as string) === 'archived') {
      return engineError('E_INVALID_INPUT', `Session '${sessionId}' is archived and cannot be resumed`);
    }

    const now = new Date().toISOString();

    session.status = 'active';
    session.endedAt = undefined;
    session.resumeCount = (session.resumeCount || 0) + 1;

    // Update task file to reflect active session
    if (taskData._meta) {
      taskData._meta.activeSession = sessionId;
      taskData._meta.generation = (taskData._meta.generation || 0) + 1;
    }

    if (session.taskWork?.taskId && taskData.focus) {
      taskData.focus.currentTask = session.taskWork.taskId;
    }

    (taskData as unknown as Record<string, unknown>).lastUpdated = now;

    await accessor.saveTaskFile(taskData);
    await accessor.saveSessions(sessions);

    return { success: true, data: session };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Garbage collect old sessions.
 * @task T4782
 */
export async function sessionGc(
  projectRoot: string,
  maxAgeDays: number = 1,
): Promise<EngineResult<{ orphaned: string[]; removed: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);

    let sessions = await accessor.loadSessions();

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const orphaned: string[] = [];
    const removed: string[] = [];

    // Mark stale active sessions as orphaned
    for (const session of sessions) {
      if (session.status === 'active') {
        const lastActive = new Date(
          session.endedAt || session.startedAt,
        ).getTime();
        if (now - lastActive > maxAgeMs) {
          session.status = 'ended';
          session.endedAt = new Date().toISOString();
          orphaned.push(session.id);
        }
      }
    }

    // Remove very old ended sessions
    sessions = sessions.filter((s: Session) => {
      if (s.status === 'active') return true;
      const endedAt = s.endedAt
        ? new Date(s.endedAt).getTime()
        : new Date(s.startedAt).getTime();
      if (now - endedAt > thirtyDaysMs) {
        removed.push(s.id);
        return false;
      }
      return true;
    });

    if (orphaned.length > 0 || removed.length > 0) {
      await accessor.saveSessions(sessions);
    }

    return { success: true, data: { orphaned, removed } };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Suspend an active session.
 * @task T4782
 */
export async function sessionSuspend(
  projectRoot: string,
  sessionId: string,
  reason?: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await suspendSession(projectRoot, sessionId, reason);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('not active')
        ? 'E_INVALID_STATE'
        : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * List session history with focus changes and completed tasks.
 * @task T4782
 */
export async function sessionHistory(
  projectRoot: string,
  params?: { sessionId?: string; limit?: number },
): Promise<
  EngineResult<{
    sessions: Array<{
      id: string;
      name?: string;
      status: string;
      startedAt: string;
      endedAt?: string | null;
      tasksCompleted: number;
      focusChanges: number;
      focusHistory: Array<{ taskId: string; timestamp: string }>;
    }>;
  }>
> {
  try {
    const result = await getSessionHistory(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Remove orphaned sessions and clean up stale data.
 * @task T4782
 */
export async function sessionCleanup(
  projectRoot: string,
): Promise<EngineResult<{ removed: string[]; autoEnded: string[]; cleaned: boolean }>> {
  try {
    const result = await cleanupSessions(projectRoot);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Record a decision to the audit trail.
 * @task T4782
 */
export async function sessionRecordDecision(
  projectRoot: string,
  params: {
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  },
): Promise<EngineResult<DecisionRecord>> {
  try {
    const result = await recordDecision(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError('E_INVALID_INPUT', message);
  }
}

/**
 * Read the decision log, optionally filtered by sessionId and/or taskId.
 * @task T4782
 */
export async function sessionDecisionLog(
  projectRoot: string,
  params?: { sessionId?: string; taskId?: string },
): Promise<EngineResult<DecisionRecord[]>> {
  try {
    const result = await getDecisionLog(projectRoot, params);
    return { success: true, data: result };
  } catch {
    return { success: true, data: [] };
  }
}

/**
 * Compute context drift score for the current session.
 * @task T4782
 */
export async function sessionContextDrift(
  projectRoot: string,
  params?: { sessionId?: string },
): Promise<
  EngineResult<{
    score: number;
    factors: string[];
    completedInScope: number;
    totalInScope: number;
    outOfScope: number;
  }>
> {
  try {
    const result = await getContextDrift(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Record an assumption made during a session.
 * @task T4782
 */
export async function sessionRecordAssumption(
  projectRoot: string,
  params: {
    sessionId?: string;
    taskId?: string;
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
  },
): Promise<
  EngineResult<{
    id: string;
    sessionId: string;
    taskId: string | null;
    assumption: string;
    confidence: string;
    timestamp: string;
  }>
> {
  try {
    const result = await recordAssumption(projectRoot, params);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('required') || message.includes('must be')
      ? 'E_INVALID_INPUT'
      : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Compute session statistics, optionally for a specific session.
 * @task T4782
 */
export async function sessionStats(
  projectRoot: string,
  sessionId?: string,
): Promise<
  EngineResult<{
    totalSessions: number;
    activeSessions: number;
    suspendedSessions: number;
    endedSessions: number;
    archivedSessions: number;
    totalTasksCompleted: number;
    totalFocusChanges: number;
    averageResumeCount: number;
    session?: {
      id: string;
      status: string;
      tasksCompleted: number;
      focusChanges: number;
      resumeCount: number;
      durationMinutes: number;
    };
  }>
> {
  try {
    const result = await getSessionStats(projectRoot, sessionId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Switch to a different session.
 * @task T4782
 */
export async function sessionSwitch(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Session>> {
  try {
    const result = await switchSession(projectRoot, sessionId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('archived')
        ? 'E_INVALID_STATE'
        : 'E_NOT_INITIALIZED';
    return engineError(code, message);
  }
}

/**
 * Archive old/ended sessions.
 * @task T4782
 */
export async function sessionArchive(
  projectRoot: string,
  olderThan?: string,
): Promise<EngineResult<{ archived: string[]; count: number }>> {
  try {
    const result = await archiveSessions(projectRoot, olderThan);
    return { success: true, data: result };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Get handoff data for the most recent ended session.
 * @task T4915
 */
export async function sessionHandoff(
  projectRoot: string,
  scope?: { type: string; epicId?: string },
): Promise<
  EngineResult<{ sessionId: string; handoff: HandoffData } | null>
> {
  try {
    const result = await getLastHandoff(projectRoot, scope);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError(
      message.includes('not found') ? 'E_NOT_FOUND' : 'E_NOT_INITIALIZED',
      message,
    );
  }
}

/**
 * Compute and persist handoff data for a session.
 * @task T4915
 */
export async function sessionComputeHandoff(
  projectRoot: string,
  sessionId: string,
  options?: { note?: string; nextAction?: string },
): Promise<EngineResult<HandoffData>> {
  try {
    const handoff = await computeHandoff(projectRoot, {
      sessionId,
      note: options?.note,
      nextAction: options?.nextAction,
    });
    await persistHandoff(projectRoot, sessionId, handoff);
    return { success: true, data: handoff };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError(
      message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL',
      message,
    );
  }
}

/**
 * Compute session briefing - composite view for session start.
 * Aggregates data from handoff, current focus, next tasks, bugs, blockers, and epics.
 * @task T4916
 */
export async function sessionBriefing(
  projectRoot: string,
  options?: {
    maxNextTasks?: number;
    maxBugs?: number;
    maxBlocked?: number;
    maxEpics?: number;
    scope?: string;
  },
): Promise<EngineResult<SessionBriefing>> {
  try {
    const briefing = await computeBriefing(projectRoot, options);
    return { success: true, data: briefing };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError(
      message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL',
      message,
    );
  }
}

// =============================================================================
// RICH DEBRIEF + CHAIN OPERATIONS (T4959)
// =============================================================================

/**
 * Compute and persist rich debrief data for a session.
 * Persists as both handoffJson (backward compat) and debriefJson (rich data).
 * @epic T4959
 */
export async function sessionComputeDebrief(
  projectRoot: string,
  sessionId: string,
  options?: { note?: string; nextAction?: string },
): Promise<EngineResult<DebriefData>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const session = sessions.find((s: Session) => s.id === sessionId);

    const debrief = await computeDebrief(projectRoot, {
      sessionId,
      note: options?.note,
      nextAction: options?.nextAction,
      agentIdentifier: session?.agentIdentifier ?? null,
      startedAt: session?.startedAt,
      endedAt: session?.endedAt ?? new Date().toISOString(),
    });

    // Persist both handoffJson and debriefJson
    const { persistHandoff: corePersistHandoff } = await import('../../core/sessions/handoff.js');
    await corePersistHandoff(projectRoot, sessionId, debrief.handoff);

    // Persist debriefJson via session update
    if (session) {
      session.debriefJson = JSON.stringify(debrief);
      await accessor.saveSessions(sessions);
    }

    return { success: true, data: debrief };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError(
      message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL',
      message,
    );
  }
}

/**
 * Read a session's debrief data.
 * Falls back to handoff data if no debrief is available.
 * @epic T4959
 */
export async function sessionDebriefShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<DebriefData | { handoff: unknown; fallback: true } | null>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const session = sessions.find((s: Session) => s.id === sessionId);
    if (!session) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    // Try debriefJson first
    if (session.debriefJson) {
      try {
        const debrief = JSON.parse(session.debriefJson as string) as DebriefData;
        return { success: true, data: debrief };
      } catch {
        // Fall through to handoff
      }
    }

    // Fall back to handoffJson
    if (typeof (session as unknown as Record<string, unknown>).handoffJson === 'string') {
      try {
        const handoff = JSON.parse(
          (session as unknown as Record<string, unknown>).handoffJson as string,
        );
        return { success: true, data: { handoff, fallback: true } };
      } catch {
        // No data available
      }
    }

    return { success: true, data: null };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError(
      message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL',
      message,
    );
  }
}

/**
 * Show the session chain for a given session.
 * Returns ordered list of sessions linked via previousSessionId/nextSessionId.
 * @epic T4959
 */
export async function sessionChainShow(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<Array<{
  id: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  agentIdentifier: string | null;
  position: number;
}>>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const sessions = await accessor.loadSessions();
    const sessionMap = new Map(sessions.map((s: Session) => [s.id, s]));

    const target = sessionMap.get(sessionId);
    if (!target) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    // Walk backward to chain start
    const chain: string[] = [sessionId];
    const visited = new Set<string>([sessionId]);
    let current = target.previousSessionId;
    while (current && !visited.has(current)) {
      chain.unshift(current);
      visited.add(current);
      const s = sessionMap.get(current);
      current = s?.previousSessionId ?? undefined;
    }

    // Walk forward from target
    current = target.nextSessionId;
    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      const s = sessionMap.get(current);
      current = s?.nextSessionId ?? undefined;
    }

    const result = chain.map((id, idx) => {
      const s = sessionMap.get(id);
      return {
        id,
        status: s?.status ?? 'unknown',
        startedAt: s?.startedAt ?? '',
        endedAt: s?.endedAt ?? null,
        agentIdentifier: s?.agentIdentifier ?? null,
        position: idx + 1,
      };
    });

    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    return engineError('E_INTERNAL', message);
  }
}
