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
import type { HandoffData } from '../../core/sessions/handoff.js';
import type { SessionBriefing } from '../../core/sessions/briefing.js';
import type {
  SessionRecord,
  SessionsFileExt,
  TaskFileExt,
  DecisionRecord,
} from '../../core/sessions/types.js';
import {
  currentTask,
  startTask,
  stopTask,
} from '../../core/task-work/index.js';

// Re-export types for consumers
export type { SessionRecord, DecisionRecord };

/**
 * Engine result wrapper
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

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
    taskWork?: Record<string, unknown> | null;
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
        taskWork: (current.focus as Record<string, unknown> | undefined) || null,
      },
    };
  } catch {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return { success: false, error: { code, message } };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return { success: false, error: { code, message } };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
      return {
        success: false,
        error: {
          code: 'E_INVALID_INPUT',
          message: 'Scope must include a task ID (e.g., epic:T001)',
        },
      };
    }

    // Verify root task exists
    const rootTask = current.tasks?.find((t) => t.id === rootTaskId);
    if (!rootTask) {
      return {
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          message: `Root task '${rootTaskId}' not found`,
        },
      };
    }

    const now = new Date().toISOString();
    const { randomBytes } = await import('node:crypto');
    const date = now.replace(/[-:T]/g, '').substring(0, 8);
    const time = now.replace(/[-:T]/g, '').substring(8, 14);
    const hex = randomBytes(3).toString('hex');
    const sessionId = `session_${date}_${time}_${hex}`;

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
        currentTask: params.focus || (params.autoStart ? rootTaskId : null),
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

    if (params.focus) {
      current.focus.currentTask = params.focus;
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
      sessions.sessions.push(newSession);
      if (sessions._meta) {
        sessions._meta.lastModified = now;
        sessions._meta.lastSessionId = sessionId;
        sessions._meta.totalSessionsCreated =
          (sessions._meta.totalSessionsCreated || 0) + 1;
      }

      await accessor.saveSessions(sessionsData);
    }

    // Enable grade mode: set env vars so audit middleware logs queries too.
    // CLEO_SESSION_GRADE_ID is the stable grade attribution var — immune to
    // subagent session.start calls that overwrite CLEO_SESSION_ID.
    if (params.grade) {
      process.env.CLEO_SESSION_GRADE = 'true';
      process.env.CLEO_SESSION_GRADE_ID = sessionId;
      process.env.CLEO_SESSION_ID = sessionId;
    }

    return { success: true, data: newSession };
  } catch {
    return {
      success: false,
      error: {
        code: 'E_NOT_INITIALIZED',
        message: 'Task database not initialized',
      },
    };
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
      delete process.env.CLEO_SESSION_GRADE_ID;
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

    // Update sessions.json if multi-session
    if (current._meta?.multiSessionEnabled && sessionId !== 'default') {
      const sessionsData = await accessor.loadSessions();
      const sessions = sessionsData as unknown as SessionsFileExt;
      if (sessions) {
        const sessionIndex = sessions.sessions.findIndex(
          (s) => s.id === sessionId,
        );
        if (sessionIndex !== -1) {
          const session = sessions.sessions[sessionIndex];
          session.status = 'ended';
          session.endedAt = now;
          session.lastActivity = now;

          // Move to history
          if (!sessions.sessionHistory) sessions.sessionHistory = [];
          sessions.sessionHistory.push(session);
          sessions.sessions.splice(sessionIndex, 1);

          if (sessions._meta) {
            sessions._meta.lastModified = now;
          }

          await accessor.saveSessions(sessionsData);
        }
      }
    }

    return { success: true, data: { sessionId, ended: true } };
  } catch {
    return {
      success: false,
      error: {
        code: 'E_NOT_INITIALIZED',
        message: 'Task database not initialized',
      },
    };
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
      return {
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          message: `Session '${sessionId}' not found`,
        },
      };
    }

    // Look in active sessions list first
    let session = sessions.sessions.find((s) => s.id === sessionId);
    let fromHistory = false;

    // Check session history if not found in active list
    if (!session && sessions.sessionHistory) {
      const histIndex = sessions.sessionHistory.findIndex(
        (s) => s.id === sessionId,
      );
      if (histIndex !== -1) {
        session = sessions.sessionHistory[histIndex];
        sessions.sessionHistory.splice(histIndex, 1);
        fromHistory = true;
      }
    }

    if (!session) {
      return {
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          message: `Session '${sessionId}' not found`,
        },
      };
    }

    if (session.status === 'active') {
      return { success: true, data: session };
    }

    if (session.status === 'archived') {
      return {
        success: false,
        error: {
          code: 'E_INVALID_STATE',
          message: `Session '${sessionId}' is archived and cannot be resumed`,
        },
      };
    }

    const now = new Date().toISOString();

    session.status = 'active';
    session.lastActivity = now;
    session.suspendedAt = null;
    session.endedAt = null;
    session.resumeCount = (session.resumeCount || 0) + 1;

    if (fromHistory) {
      sessions.sessions.push(session);
    }

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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return { success: false, error: { code, message } };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message },
    };
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
    return { success: false, error: { code, message } };
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
    return { success: false, error: { code, message } };
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
    return { success: false, error: { code, message } };
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
    return { success: false, error: { code, message } };
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
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'Task database not initialized' },
    };
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
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_NOT_INITIALIZED';
    return {
      success: false,
      error: { code, message },
    };
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
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL';
    return {
      success: false,
      error: { code, message },
    };
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
    const code = message.includes('not found') ? 'E_NOT_FOUND' : 'E_INTERNAL';
    return {
      success: false,
      error: { code, message },
    };
  }
}
