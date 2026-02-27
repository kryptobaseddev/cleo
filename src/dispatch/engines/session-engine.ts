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
  isMultiSession as coreIsMultiSession,
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
import type {
  SessionRecord,
  SessionsFileExt,
  TaskFileExt,
  DecisionRecord,
} from '../../core/sessions/types.js';
import type { TaskWorkState } from '../../types/task.js';
import {
  currentTask,
  startTask,
  stopTask,
} from '../../core/task-work/index.js';
import { engineError, type EngineResult } from './_error.js';

// Re-export types for consumers
export type { SessionRecord, DecisionRecord };

// Re-export EngineResult for consumers
export type { EngineResult };

/**
 * Check if multi-session mode is enabled.
 * @task T4782
 */
export async function isMultiSession(projectRoot: string): Promise<boolean> {
  return coreIsMultiSession(projectRoot);
}

/**
 * Get current session status.
 * Note: This function has engine-specific logic for combining single-session
 * and multi-session views, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionStatus(
  projectRoot: string,
): Promise<
  EngineResult<{
    hasActiveSession: boolean;
    multiSessionEnabled: boolean;
    session?: SessionRecord | null;
    taskWork?: TaskWorkState | null;
  }>
> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    const multiSession = current._meta?.multiSessionEnabled === true;

    if (multiSession) {
      const sessionsData = await accessor.loadSessions();
      const sessions = sessionsData as unknown as SessionsFileExt;
      const active = sessions?.sessions?.find((s) => s.status === 'active');

      return {
        success: true,
        data: {
          hasActiveSession: !!active,
          multiSessionEnabled: true,
          session: active || null,
          taskWork: null,
        },
      };
    }

    return {
      success: true,
      data: {
        hasActiveSession: !!current.focus?.currentTask,
        multiSessionEnabled: false,
        session: null,
        taskWork: (current.focus as TaskWorkState | undefined) || null,
      },
    };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * List sessions (multi-session mode).
 * Note: This function has engine-specific logic for synthetic single-session
 * fallback, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionList(
  projectRoot: string,
  params?: { active?: boolean; limit?: number },
): Promise<EngineResult<SessionRecord[]>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    const multiSession = current._meta?.multiSessionEnabled === true;

    if (!multiSession) {
      // Single-session mode: return synthetic session if focus is set
      if (current.focus?.currentTask) {
        const syntheticSession: SessionRecord = {
          id: current._meta?.activeSession || 'default',
          status: 'active',
          scope: { type: 'task', rootTaskId: current.focus.currentTask },
          focus: {
            currentTask: current.focus.currentTask,
            currentPhase: current.focus.currentPhase,
          },
          startedAt: new Date().toISOString(),
          lastActivity: new Date().toISOString(),
        };
        return { success: true, data: [syntheticSession] };
      }
      return { success: true, data: [] };
    }

    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;

    if (!sessions) {
      return { success: true, data: [] };
    }

    let result = sessions.sessions || [];

    if (params?.active === true) {
      result = result.filter((s) => s.status === 'active');
    } else if (params?.active === false) {
      result = result.filter((s) => s.status !== 'active');
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
): Promise<EngineResult<SessionRecord>> {
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
 * and multi-session session file updates, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionStart(
  projectRoot: string,
  params: {
    scope: string;
    name?: string;
    autoStart?: boolean;
    startTask?: string;
    /** @deprecated Use startTask instead. */
    focus?: string;
    /** Enable full query+mutation audit logging for behavioral grading. */
    grade?: boolean;
  },
): Promise<EngineResult<SessionRecord>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    // Parse scope (e.g., "epic:T001" -> { type: 'epic', rootTaskId: 'T001' })
    const scopeParts = params.scope.split(':');
    const scopeType = scopeParts[0] || 'task';
    const rootTaskId = scopeParts[1] || '';

    if (!rootTaskId) {
      return engineError('E_INVALID_INPUT', 'Scope must include a task ID (e.g., epic:T001)');
    }

    // Verify root task exists
    const rootTask = current.tasks?.find((t) => t.id === rootTaskId);
    if (!rootTask) {
      return engineError('E_NOT_FOUND', `Root task '${rootTaskId}' not found`);
    }

    const now = new Date().toISOString();
    const sessionId = generateSessionId();

    // T4959: Chain linking — find most recent ended session for same scope
    let previousSessionId: string | null = null;
    {
      const sessionsData = await accessor.loadSessions();
      const sessions = sessionsData as unknown as SessionsFileExt;
      // Search both sessions and legacy sessionHistory for chain linking
      const allSessions = [
        ...(sessions?.sessions || []),
        ...(sessions?.sessionHistory || []),
      ];
      const sameScope = allSessions
        .filter((s) =>
          s.status === 'ended' &&
          s.endedAt &&
          s.scope?.rootTaskId === rootTaskId &&
          s.scope?.type === scopeType,
        )
        .sort((a, b) =>
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

    const newSession: SessionRecord = {
      id: sessionId,
      status: 'active',
      name: params.name,
      scope: {
        type: scopeType,
        rootTaskId,
        includeDescendants: true,
      },
      focus: {
        currentTask: params.startTask || params.focus || (params.autoStart ? rootTaskId : null),
        currentPhase: null,
        previousTask: null,
      },
      startedAt: now,
      lastActivity: now,
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
    if (!current.focus) {
      current.focus = {
        currentTask: null,
        currentPhase: null,
        blockedUntil: null,
        sessionNote: null,
        sessionNotes: [],
        nextAction: null,
        primarySession: null,
      };
    }

    const startingTask = params.startTask || params.focus;
    if (startingTask) {
      current.focus.currentTask = startingTask;
    } else if (params.autoStart) {
      current.focus.currentTask = rootTaskId;
    }

    if (current._meta) {
      current._meta.lastSessionId = sessionId;
      current._meta.activeSession = sessionId;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    (current as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTaskFile(taskData);

    // Always write to sessions.json so resume/suspend can find the session.
    // Previously only written when multi-session enabled, but session resume
    // always looks in sessions.json regardless of multi-session mode.
    {
      const sessionsData = await accessor.loadSessions();
      const sessions = sessionsData as unknown as SessionsFileExt;

      if (!sessions.sessions) sessions.sessions = [];

      // T4959: Set chain fields on new session
      if (previousSessionId) {
        newSession.previousSessionId = previousSessionId;

        // Update predecessor's nextSessionId
        const allSessionArrays = [sessions.sessions, sessions.sessionHistory || []];
        for (const arr of allSessionArrays) {
          const pred = arr.find((s) => s.id === previousSessionId);
          if (pred) {
            pred.nextSessionId = sessionId;
            break;
          }
        }
      }

      if (agentIdentifier) {
        newSession.agentIdentifier = agentIdentifier;
      }

      sessions.sessions.push(newSession);
      if (sessions._meta) {
        sessions._meta.lastModified = now;
        sessions._meta.lastSessionId = sessionId;
        sessions._meta.totalSessionsCreated =
          (sessions._meta.totalSessionsCreated || 0) + 1;
      }

      await accessor.saveSessions(sessionsData);
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
        const sessionsData2 = await accessor.loadSessions();
        const sessions2 = sessionsData2 as unknown as SessionsFileExt;
        const allSessions2 = [
          ...(sessions2?.sessions || []),
          ...(sessions2?.sessionHistory || []),
        ];
        const pred = allSessions2.find((s) => s.id === previousSessionId);
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
          await accessor.saveSessions(sessionsData2);
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

    return { success: true, data: enrichedSession as SessionRecord };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * End the current session.
 * Note: This function has engine-specific logic for task file focus management
 * and session history management, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionEnd(
  projectRoot: string,
  notes?: string,
): Promise<EngineResult<{ sessionId: string; ended: boolean }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    const sessionId = current._meta?.activeSession || 'default';
    const now = new Date().toISOString();

    // Clear grade mode env vars when session ends
    if (process.env.CLEO_SESSION_GRADE === 'true') {
      delete process.env.CLEO_SESSION_GRADE;
      delete process.env.CLEO_SESSION_ID;
    }

    // Clear focus
    if (current.focus) {
      current.focus.currentTask = null;
      if (notes) {
        if (!current.focus.sessionNotes) current.focus.sessionNotes = [];
        current.focus.sessionNotes.push({ timestamp: now, note: notes });
      }
    }

    if (current._meta) {
      current._meta.activeSession = null;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    (current as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTaskFile(taskData);

    // Always update sessions.json — sessionStart always writes there
    // (see sessionStart comment: "Always write to sessions.json so resume/suspend can find the session")
    if (sessionId !== 'default') {
      const sessionsData = await accessor.loadSessions();
      const sessions = sessionsData as unknown as SessionsFileExt;
      if (sessions) {
        const session = sessions.sessions.find(
          (s) => s.id === sessionId,
        );
        if (session) {
          session.status = 'ended';
          session.endedAt = now;
          session.lastActivity = now;

          // Update in-place — do NOT splice to sessionHistory.
          // SQLite saveSessions only persists data.sessions;
          // splicing would delete the ended session and its handoff/debrief data.

          if (sessions._meta) {
            sessions._meta.lastModified = now;
          }

          await accessor.saveSessions(sessionsData);
        }
      }
    }

    return { success: true, data: { sessionId, ended: true } };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Resume an ended or suspended session.
 * Note: This function has engine-specific logic for session history management
 * and task file focus sync, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionResume(
  projectRoot: string,
  sessionId: string,
): Promise<EngineResult<SessionRecord>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    // Sessions are always written to sessions.json (even without multi-session mode),
    // so resume can always look them up there.
    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;

    if (!sessions) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    // Look in sessions list (all sessions live here; sessionHistory is legacy)
    let session = sessions.sessions.find((s) => s.id === sessionId);

    // Fallback: check sessionHistory for legacy data
    if (!session && sessions.sessionHistory) {
      const histIndex = sessions.sessionHistory.findIndex(
        (s) => s.id === sessionId,
      );
      if (histIndex !== -1) {
        session = sessions.sessionHistory[histIndex];
        // Move from legacy history back to sessions
        sessions.sessionHistory.splice(histIndex, 1);
        sessions.sessions.push(session);
      }
    }

    if (!session) {
      return engineError('E_NOT_FOUND', `Session '${sessionId}' not found`);
    }

    if (session.status === 'active') {
      return { success: true, data: session };
    }

    if (session.status === 'archived') {
      return engineError('E_INVALID_INPUT', `Session '${sessionId}' is archived and cannot be resumed`);
    }

    const now = new Date().toISOString();

    session.status = 'active';
    session.lastActivity = now;
    session.suspendedAt = null;
    session.endedAt = null;
    session.resumeCount = (session.resumeCount || 0) + 1;

    // Update task file to reflect active session
    if (current._meta) {
      current._meta.activeSession = sessionId;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    if (session.focus?.currentTask && current.focus) {
      current.focus.currentTask = session.focus.currentTask;
    }

    (current as Record<string, unknown>).lastUpdated = now;

    if (sessions._meta) {
      sessions._meta.lastModified = now;
    }

    await accessor.saveTaskFile(taskData);
    await accessor.saveSessions(sessionsData);

    return { success: true, data: session };
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}

/**
 * Garbage collect old sessions.
 * Note: This function has engine-specific logic for multi-session GC
 * with session history management, so it remains in the engine layer.
 * @task T4782
 */
export async function sessionGc(
  projectRoot: string,
  maxAgeDays: number = 1,
): Promise<EngineResult<{ orphaned: string[]; removed: string[] }>> {
  try {
    const accessor = await getAccessor(projectRoot);
    const taskData = await accessor.loadTaskFile();
    const current = taskData as unknown as TaskFileExt;

    const multiSession = current._meta?.multiSessionEnabled === true;
    if (!multiSession) {
      return { success: true, data: { orphaned: [], removed: [] } };
    }

    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;

    if (!sessions) {
      return { success: true, data: { orphaned: [], removed: [] } };
    }

    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const orphaned: string[] = [];
    const removed: string[] = [];

    // Mark stale active sessions as orphaned
    for (const session of sessions.sessions) {
      if (session.status === 'active') {
        const lastActive = new Date(
          session.lastActivity || session.startedAt,
        ).getTime();
        if (now - lastActive > maxAgeMs) {
          session.status = 'ended';
          session.endedAt = new Date().toISOString();
          session.lastActivity = new Date().toISOString();
          orphaned.push(session.id);
        }
      }
    }

    // Remove very old ended sessions
    sessions.sessions = sessions.sessions.filter((s) => {
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

    // Also clean old session history
    if (sessions.sessionHistory) {
      sessions.sessionHistory = sessions.sessionHistory.filter((s) => {
        const endedAt = s.endedAt
          ? new Date(s.endedAt).getTime()
          : new Date(s.startedAt).getTime();
        if (now - endedAt > thirtyDaysMs) {
          if (!removed.includes(s.id)) {
            removed.push(s.id);
          }
          return false;
        }
        return true;
      });
    }

    if (orphaned.length > 0 || removed.length > 0) {
      if (sessions._meta) {
        sessions._meta.lastModified = new Date().toISOString();
      }
      await accessor.saveSessions(sessionsData);
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
): Promise<EngineResult<SessionRecord>> {
  try {
    const result = await suspendSession(projectRoot, sessionId, reason);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('not active')
        ? 'E_INVALID_STATE'
        : message.includes('requires multi-session')
          ? 'E_NOT_SUPPORTED'
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
): Promise<EngineResult<{ removed: string[]; cleaned: boolean }>> {
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
): Promise<EngineResult<SessionRecord>> {
  try {
    const result = await switchSession(projectRoot, sessionId);
    return { success: true, data: result };
  } catch (err: unknown) {
    const message = (err as Error).message;
    const code = message.includes('not found')
      ? 'E_NOT_FOUND'
      : message.includes('archived')
        ? 'E_INVALID_STATE'
        : message.includes('requires multi-session')
          ? 'E_NOT_SUPPORTED'
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
    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;
    const allSessions = [
      ...(sessions?.sessions || []),
      ...(sessions?.sessionHistory || []),
    ];
    const session = allSessions.find((s) => s.id === sessionId);

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
      await accessor.saveSessions(sessionsData);
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
    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;
    const allSessions = [
      ...(sessions?.sessions || []),
      ...(sessions?.sessionHistory || []),
    ];
    const session = allSessions.find((s) => s.id === sessionId);
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
    const sessionsData = await accessor.loadSessions();
    const sessions = sessionsData as unknown as SessionsFileExt;
    const allSessions = [
      ...(sessions?.sessions || []),
      ...(sessions?.sessionHistory || []),
    ];
    const sessionMap = new Map(allSessions.map((s) => [s.id, s]));

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
