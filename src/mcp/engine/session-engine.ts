/**
 * Session Engine
 *
 * Native TypeScript implementation of session lifecycle operations.
 * Supports both single-session (focus in todo.json) and multi-session
 * (separate sessions.json) modes.
 *
 * Supports: status, list, show, focus.get, focus.set, focus.clear, start, end,
 *           resume, gc, suspend, history, cleanup
 */

import { readJsonFile, writeJsonFileAtomic, withFileLock, getDataPath } from './store.js';
import { randomBytes} from 'crypto';
import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join} from 'path';

/**
 * Session object matching sessions.schema.json
 */
export interface SessionRecord {
  id: string;
  status: 'active' | 'suspended' | 'ended' | 'archived';
  agentId?: string;
  name?: string;
  scope: {
    type: string;
    rootTaskId: string;
    phaseFilter?: string | null;
    labelFilter?: string[] | null;
    includeDescendants?: boolean;
    maxDepth?: number | null;
    explicitTaskIds?: string[] | null;
    excludeTaskIds?: string[] | null;
    computedTaskIds?: string[];
    computedAt?: string;
  };
  focus: {
    currentTask?: string | null;
    currentPhase?: string | null;
    previousTask?: string | null;
    sessionNote?: string | null;
    nextAction?: string | null;
    blockedReason?: string | null;
    focusHistory?: Array<{ taskId: string; timestamp: string }>;
  };
  startedAt: string;
  lastActivity: string;
  suspendedAt?: string | null;
  endedAt?: string | null;
  archivedAt?: string | null;
  resumeCount?: number;
  stats?: {
    tasksCompleted: number;
    tasksCreated: number;
    tasksUpdated: number;
    focusChanges: number;
    totalActiveMinutes: number;
    suspendCount: number;
  };
}

/**
 * Focus state from todo.json (single-session mode)
 */
interface FocusState {
  currentTask: string | null;
  currentPhase: string | null;
  blockedUntil: string | null;
  sessionNote: string | null;
  sessionNotes: unknown[];
  nextAction: string | null;
  primarySession: string | null;
}

/**
 * The sessions.json structure
 */
interface SessionsFile {
  version?: string;
  project?: string;
  _meta?: {
    schemaVersion: string;
    checksum: string;
    lastModified: string;
    totalSessionsCreated?: number;
    lastSessionId?: string | null;
  };
  config?: Record<string, unknown>;
  sessions: SessionRecord[];
  sessionHistory?: SessionRecord[];
}

/**
 * Todo.json structure (subset for session operations)
 */
interface TodoFile {
  focus?: FocusState;
  _meta?: {
    schemaVersion: string;
    checksum?: string;
    configVersion?: string;
    lastSessionId?: string | null;
    activeSession?: string | null;
    multiSessionEnabled?: boolean;
    activeSessionCount?: number;
    sessionsFile?: string | null;
    generation?: number;
    [key: string]: unknown;
  };
  tasks?: Array<{ id: string; status: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

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
 * Generate a session ID matching CLEO format: session_YYYYMMDD_HHMMSS_<hex6>
 */
function generateSessionId(): string {
  const now = new Date();
  const date = now.toISOString().replace(/[-:T]/g, '').substring(0, 8);
  const time = now.toISOString().replace(/[-:T]/g, '').substring(8, 14);
  const hex = randomBytes(3).toString('hex');
  return `session_${date}_${time}_${hex}`;
}

/**
 * Check if multi-session mode is enabled
 */
export function isMultiSession(projectRoot: string): boolean {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);
  return todo?._meta?.multiSessionEnabled === true;
}

/**
 * Get current session status
 */
export function sessionStatus(
  projectRoot: string
): EngineResult<{
  hasActiveSession: boolean;
  multiSessionEnabled: boolean;
  session?: SessionRecord | null;
  focus?: FocusState | null;
}> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const multiSession = todo._meta?.multiSessionEnabled === true;

  if (multiSession) {
    const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
    const sessions = readJsonFile<SessionsFile>(sessionsPath);
    const active = sessions?.sessions?.find((s) => s.status === 'active');

    return {
      success: true,
      data: {
        hasActiveSession: !!active,
        multiSessionEnabled: true,
        session: active || null,
        focus: null,
      },
    };
  }

  return {
    success: true,
    data: {
      hasActiveSession: !!todo.focus?.currentTask,
      multiSessionEnabled: false,
      session: null,
      focus: todo.focus || null,
    },
  };
}

/**
 * List sessions (multi-session mode)
 */
export function sessionList(
  projectRoot: string,
  params?: { active?: boolean; limit?: number }
): EngineResult<SessionRecord[]> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const multiSession = todo._meta?.multiSessionEnabled === true;

  if (!multiSession) {
    // Single-session mode: return synthetic session if focus is set
    if (todo.focus?.currentTask) {
      const syntheticSession: SessionRecord = {
        id: todo._meta?.activeSession || 'default',
        status: 'active',
        scope: { type: 'task', rootTaskId: todo.focus.currentTask },
        focus: {
          currentTask: todo.focus.currentTask,
          currentPhase: todo.focus.currentPhase,
        },
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      };
      return { success: true, data: [syntheticSession] };
    }
    return { success: true, data: [] };
  }

  const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
  const sessions = readJsonFile<SessionsFile>(sessionsPath);

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
}

/**
 * Show a specific session
 */
export function sessionShow(
  projectRoot: string,
  sessionId: string
): EngineResult<SessionRecord> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
  const sessions = readJsonFile<SessionsFile>(sessionsPath);

  if (!sessions) {
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
    };
  }

  const session = sessions.sessions?.find((s) => s.id === sessionId);
  if (!session) {
    // Check history
    const historical = sessions.sessionHistory?.find((s) => s.id === sessionId);
    if (historical) {
      return { success: true, data: historical };
    }
    return {
      success: false,
      error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
    };
  }

  return { success: true, data: session };
}

/**
 * Get current focus
 */
export function focusGet(
  projectRoot: string
): EngineResult<{ currentTask: string | null; currentPhase: string | null }> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  return {
    success: true,
    data: {
      currentTask: todo.focus?.currentTask || null,
      currentPhase: todo.focus?.currentPhase || null,
    },
  };
}

/**
 * Set focus to a specific task
 */
export async function focusSet(
  projectRoot: string,
  taskId: string
): Promise<EngineResult<{ taskId: string; previousTask: string | null }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ taskId: string; previousTask: string | null }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
        };
      }

      // Verify task exists
      const taskExists = current.tasks?.some((t) => t.id === taskId);
      if (!taskExists) {
        return {
          success: false,
          error: { code: 'E_NOT_FOUND', message: `Task '${taskId}' not found` },
        };
      }

      const previousTask = current.focus?.currentTask || null;

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

      current.focus.currentTask = taskId;
      current.lastUpdated = new Date().toISOString();
      if (current._meta) {
        current._meta.generation = (current._meta.generation || 0) + 1;
      }

      writeJsonFileAtomic(todoPath, current);

      return { success: true, data: { taskId, previousTask } };
    }
  ) as EngineResult<{ taskId: string; previousTask: string | null }>;
}

/**
 * Clear current focus
 */
export async function focusClear(
  projectRoot: string
): Promise<EngineResult<{ cleared: boolean; previousTask: string | null }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ cleared: boolean; previousTask: string | null }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
        };
      }

      const previousTask = current.focus?.currentTask || null;

      if (current.focus) {
        current.focus.currentTask = null;
      }

      current.lastUpdated = new Date().toISOString();
      if (current._meta) {
        current._meta.generation = (current._meta.generation || 0) + 1;
      }

      writeJsonFileAtomic(todoPath, current);

      return { success: true, data: { cleared: true, previousTask } };
    }
  ) as EngineResult<{ cleared: boolean; previousTask: string | null }>;
}

/**
 * Start a new session
 */
export async function sessionStart(
  projectRoot: string,
  params: {
    scope: string;
    name?: string;
    autoFocus?: boolean;
    focus?: string;
  }
): Promise<EngineResult<SessionRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<SessionRecord>>(todoPath, () => {
    const current = readJsonFile<TodoFile>(todoPath);
    if (!current) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
      };
    }

    // Parse scope (e.g., "epic:T001" -> { type: 'epic', rootTaskId: 'T001' })
    const scopeParts = params.scope.split(':');
    const scopeType = scopeParts[0] || 'task';
    const rootTaskId = scopeParts[1] || '';

    if (!rootTaskId) {
      return {
        success: false,
        error: { code: 'E_INVALID_INPUT', message: 'Scope must include a task ID (e.g., epic:T001)' },
      };
    }

    // Verify root task exists
    const rootTask = current.tasks?.find((t) => t.id === rootTaskId);
    if (!rootTask) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Root task '${rootTaskId}' not found` },
      };
    }

    const now = new Date().toISOString();
    const sessionId = generateSessionId();

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
        currentTask: params.focus || (params.autoFocus ? rootTaskId : null),
        currentPhase: null,
        previousTask: null,
      },
      startedAt: now,
      lastActivity: now,
      resumeCount: 0,
      stats: {
        tasksCompleted: 0,
        tasksCreated: 0,
        tasksUpdated: 0,
        focusChanges: 0,
        totalActiveMinutes: 0,
        suspendCount: 0,
      },
    };

    // Update focus in todo.json
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
    } else if (params.autoFocus) {
      current.focus.currentTask = rootTaskId;
    }

    if (current._meta) {
      current._meta.lastSessionId = sessionId;
      current._meta.activeSession = sessionId;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    current.lastUpdated = now;
    writeJsonFileAtomic(todoPath, current);

    // If multi-session enabled, also write to sessions.json
    if (current._meta?.multiSessionEnabled) {
      const sessionsPath = getDataPath(
        projectRoot,
        current._meta?.sessionsFile || 'sessions.json'
      );
      const sessions = readJsonFile<SessionsFile>(sessionsPath) || {
        _meta: {
          schemaVersion: '1.0.0',
          checksum: '',
          lastModified: now,
          totalSessionsCreated: 0,
        },
        sessions: [],
        sessionHistory: [],
      };

      sessions.sessions.push(newSession);
      if (sessions._meta) {
        sessions._meta.lastModified = now;
        sessions._meta.lastSessionId = sessionId;
        sessions._meta.totalSessionsCreated =
          (sessions._meta.totalSessionsCreated || 0) + 1;
      }

      writeJsonFileAtomic(sessionsPath, sessions);
    }

    return { success: true, data: newSession };
  }) as EngineResult<SessionRecord>;
}

/**
 * End the current session
 */
export async function sessionEnd(
  projectRoot: string,
  notes?: string
): Promise<EngineResult<{ sessionId: string; ended: boolean }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ sessionId: string; ended: boolean }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No valid todo.json found' },
        };
      }

      const sessionId = current._meta?.activeSession || 'default';
      const now = new Date().toISOString();

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

      current.lastUpdated = now;
      writeJsonFileAtomic(todoPath, current);

      // Update sessions.json if multi-session
      if (current._meta?.multiSessionEnabled && sessionId !== 'default') {
        const sessionsPath = getDataPath(
          projectRoot,
          current._meta?.sessionsFile || 'sessions.json'
        );
        const sessions = readJsonFile<SessionsFile>(sessionsPath);
        if (sessions) {
          const sessionIndex = sessions.sessions.findIndex(
            (s) => s.id === sessionId
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

            writeJsonFileAtomic(sessionsPath, sessions);
          }
        }
      }

      return { success: true, data: { sessionId, ended: true } };
    }
  ) as EngineResult<{ sessionId: string; ended: boolean }>;
}

/**
 * Resume an ended or suspended session.
 * Reactivates the session by setting status back to 'active' and updating timestamps.
 */
export async function sessionResume(
  projectRoot: string,
  sessionId: string
): Promise<EngineResult<SessionRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<SessionRecord>>(todoPath, () => {
    const current = readJsonFile<TodoFile>(todoPath);
    if (!current) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
      };
    }

    const multiSession = current._meta?.multiSessionEnabled === true;

    if (!multiSession) {
      return {
        success: false,
        error: {
          code: 'E_NOT_SUPPORTED',
          message: 'Session resume requires multi-session mode',
        },
      };
    }

    const sessionsPath = getDataPath(
      projectRoot,
      current._meta?.sessionsFile || 'sessions.json'
    );
    const sessions = readJsonFile<SessionsFile>(sessionsPath);

    if (!sessions) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    // Look in active sessions list first
    let session = sessions.sessions.find((s) => s.id === sessionId);
    let fromHistory = false;

    // Check session history if not found in active list
    if (!session && sessions.sessionHistory) {
      const histIndex = sessions.sessionHistory.findIndex((s) => s.id === sessionId);
      if (histIndex !== -1) {
        session = sessions.sessionHistory[histIndex];
        sessions.sessionHistory.splice(histIndex, 1);
        fromHistory = true;
      }
    }

    if (!session) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
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

    // Update todo.json to reflect active session
    if (current._meta) {
      current._meta.activeSession = sessionId;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    if (session.focus?.currentTask && current.focus) {
      current.focus.currentTask = session.focus.currentTask;
    }

    current.lastUpdated = now;

    if (sessions._meta) {
      sessions._meta.lastModified = now;
    }

    writeJsonFileAtomic(todoPath, current);
    writeJsonFileAtomic(sessionsPath, sessions);

    return { success: true, data: session };
  }) as EngineResult<SessionRecord>;
}

/**
 * Garbage collect old sessions.
 * Marks active sessions older than the threshold as 'orphaned'.
 * Removes ended/orphaned sessions older than 30 days.
 */
export async function sessionGc(
  projectRoot: string,
  maxAgeDays: number = 1
): Promise<EngineResult<{ orphaned: string[]; removed: string[] }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ orphaned: string[]; removed: string[] }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
        };
      }

      const multiSession = current._meta?.multiSessionEnabled === true;
      if (!multiSession) {
        return { success: true, data: { orphaned: [], removed: [] } };
      }

      const sessionsPath = getDataPath(
        projectRoot,
        current._meta?.sessionsFile || 'sessions.json'
      );
      const sessions = readJsonFile<SessionsFile>(sessionsPath);

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
          const lastActive = new Date(session.lastActivity || session.startedAt).getTime();
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
        writeJsonFileAtomic(sessionsPath, sessions);
      }

      return { success: true, data: { orphaned, removed } };
    }
  ) as EngineResult<{ orphaned: string[]; removed: string[] }>;
}

/**
 * Suspend an active session.
 * Sets status to 'suspended' and records the reason.
 */
export async function sessionSuspend(
  projectRoot: string,
  sessionId: string,
  reason?: string
): Promise<EngineResult<SessionRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<SessionRecord>>(todoPath, () => {
    const current = readJsonFile<TodoFile>(todoPath);
    if (!current) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
      };
    }

    const multiSession = current._meta?.multiSessionEnabled === true;

    if (!multiSession) {
      return {
        success: false,
        error: {
          code: 'E_NOT_SUPPORTED',
          message: 'Session suspend requires multi-session mode',
        },
      };
    }

    const sessionsPath = getDataPath(
      projectRoot,
      current._meta?.sessionsFile || 'sessions.json'
    );
    const sessions = readJsonFile<SessionsFile>(sessionsPath);

    if (!sessions) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    const session = sessions.sessions.find((s) => s.id === sessionId);

    if (!session) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    if (session.status !== 'active') {
      return {
        success: false,
        error: {
          code: 'E_INVALID_STATE',
          message: `Session '${sessionId}' is ${session.status}, not active`,
        },
      };
    }

    const now = new Date().toISOString();

    session.status = 'suspended';
    session.suspendedAt = now;
    session.lastActivity = now;

    if (session.stats) {
      session.stats.suspendCount = (session.stats.suspendCount || 0) + 1;
    }

    if (reason) {
      session.focus = session.focus || { currentTask: null, currentPhase: null };
      session.focus.sessionNote = reason;
    }

    // Clear active session in todo.json if this was the active one
    if (current._meta?.activeSession === sessionId) {
      current._meta.activeSession = null;
      current._meta.generation = (current._meta.generation || 0) + 1;
      current.lastUpdated = now;
      writeJsonFileAtomic(todoPath, current);
    }

    if (sessions._meta) {
      sessions._meta.lastModified = now;
    }

    writeJsonFileAtomic(sessionsPath, sessions);

    return { success: true, data: session };
  }) as EngineResult<SessionRecord>;
}

/**
 * List session history with focus changes and completed tasks.
 * If sessionId is provided, returns history for that specific session.
 * Otherwise, returns history across all sessions.
 */
export function sessionHistory(
  projectRoot: string,
  params?: { sessionId?: string; limit?: number }
): EngineResult<{
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
}> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const sessionsPath = getDataPath(
    projectRoot,
    todo._meta?.sessionsFile || 'sessions.json'
  );
  const sessionsFile = readJsonFile<SessionsFile>(sessionsPath);

  if (!sessionsFile) {
    return { success: true, data: { sessions: [] } };
  }

  // Combine active sessions and history
  const allSessions: SessionRecord[] = [
    ...(sessionsFile.sessions || []),
    ...(sessionsFile.sessionHistory || []),
  ];

  let filtered = allSessions;

  if (params?.sessionId) {
    filtered = filtered.filter((s) => s.id === params.sessionId);
  }

  // Sort by startedAt descending (most recent first)
  filtered.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
  );

  if (params?.limit && params.limit > 0) {
    filtered = filtered.slice(0, params.limit);
  }

  const result = filtered.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    tasksCompleted: s.stats?.tasksCompleted || 0,
    focusChanges: s.stats?.focusChanges || 0,
    focusHistory: s.focus?.focusHistory || [],
  }));

  return { success: true, data: { sessions: result } };
}

/**
 * Remove orphaned sessions and clean up stale data.
 * Removes sessions with status 'ended' or 'suspended' that have no recent activity,
 * and clears any orphaned references in todo.json.
 */
export async function sessionCleanup(
  projectRoot: string
): Promise<EngineResult<{ removed: string[]; cleaned: boolean }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ removed: string[]; cleaned: boolean }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
        };
      }

      const multiSession = current._meta?.multiSessionEnabled === true;
      if (!multiSession) {
        return { success: true, data: { removed: [], cleaned: false } };
      }

      const sessionsPath = getDataPath(
        projectRoot,
        current._meta?.sessionsFile || 'sessions.json'
      );
      const sessions = readJsonFile<SessionsFile>(sessionsPath);

      if (!sessions) {
        return { success: true, data: { removed: [], cleaned: false } };
      }

      const removed: string[] = [];
      let todoUpdated = false;

      // Remove all non-active sessions from the sessions list
      // (move ended/suspended to history, remove orphaned entirely)
      const activeSessions: SessionRecord[] = [];
      for (const session of sessions.sessions) {
        if (session.status === 'active') {
          activeSessions.push(session);
        } else if (session.status === 'ended' || session.status === 'suspended') {
          // Move to history
          if (!sessions.sessionHistory) sessions.sessionHistory = [];
          sessions.sessionHistory.push(session);
          removed.push(session.id);
        } else if (session.status === 'archived') {
          // Archived sessions are removed from active list
          removed.push(session.id);
        }
      }
      sessions.sessions = activeSessions;

      // Clean stale references in todo.json
      if (current._meta?.activeSession) {
        const activeExists = sessions.sessions.some(
          (s) => s.id === current._meta!.activeSession
        );
        if (!activeExists) {
          current._meta.activeSession = null;
          current._meta.generation = (current._meta.generation || 0) + 1;
          current.lastUpdated = new Date().toISOString();
          todoUpdated = true;
        }
      }

      if (removed.length > 0 || todoUpdated) {
        if (sessions._meta) {
          sessions._meta.lastModified = new Date().toISOString();
        }
        writeJsonFileAtomic(sessionsPath, sessions);
        if (todoUpdated) {
          writeJsonFileAtomic(todoPath, current);
        }
      }

      return {
        success: true,
        data: { removed, cleaned: removed.length > 0 || todoUpdated },
      };
    }
  ) as EngineResult<{ removed: string[]; cleaned: boolean }>;
}

/**
 * Decision record stored in decisions.jsonl
 */
export interface DecisionRecord {
  id: string;
  sessionId: string;
  taskId: string;
  decision: string;
  rationale: string;
  alternatives: string[];
  timestamp: string;
}

/**
 * Record a decision to the audit trail.
 * Appends a JSON line to `.cleo/audit/decisions.jsonl`.
 */
export function sessionRecordDecision(
  projectRoot: string,
  params: {
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  }
): EngineResult<DecisionRecord> {
  if (!params.sessionId || !params.taskId || !params.decision || !params.rationale) {
    return {
      success: false,
      error: {
        code: 'E_INVALID_INPUT',
        message: 'sessionId, taskId, decision, and rationale are required',
      },
    };
  }

  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const decisionPath = join(auditDir, 'decisions.jsonl');

  const record: DecisionRecord = {
    id: `dec-${randomBytes(8).toString('hex')}`,
    sessionId: params.sessionId,
    taskId: params.taskId,
    decision: params.decision,
    rationale: params.rationale,
    alternatives: params.alternatives || [],
    timestamp: new Date().toISOString(),
  };

  appendFileSync(decisionPath, JSON.stringify(record) + '\n', 'utf-8');

  return { success: true, data: record };
}

/**
 * Read the decision log, optionally filtered by sessionId and/or taskId.
 */
export function sessionDecisionLog(
  projectRoot: string,
  params?: { sessionId?: string; taskId?: string }
): EngineResult<DecisionRecord[]> {
  const decisionPath = join(projectRoot, '.cleo', 'audit', 'decisions.jsonl');

  if (!existsSync(decisionPath)) {
    return { success: true, data: [] };
  }

  const content = readFileSync(decisionPath, 'utf-8');
  const lines = content.split('\n').filter((line) => line.trim().length > 0);

  let entries: DecisionRecord[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line) as DecisionRecord);
    } catch {
      // Skip malformed lines
    }
  }

  if (params?.sessionId) {
    entries = entries.filter((e) => e.sessionId === params.sessionId);
  }

  if (params?.taskId) {
    entries = entries.filter((e) => e.taskId === params.taskId);
  }

  return { success: true, data: entries };
}

/**
 * Collect all descendant task IDs for a given parent task.
 */
function collectDescendantIds(
  parentId: string,
  tasks: Array<{ id: string; [key: string]: unknown }>
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
export function sessionContextDrift(
  projectRoot: string,
  params?: { sessionId?: string }
): EngineResult<{
  score: number;
  factors: string[];
  completedInScope: number;
  totalInScope: number;
  outOfScope: number;
}> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  // Find the active session (or specified session)
  let session: SessionRecord | undefined;

  if (params?.sessionId) {
    const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
    const sessionsFile = readJsonFile<SessionsFile>(sessionsPath);
    if (sessionsFile) {
      session = sessionsFile.sessions?.find((s) => s.id === params.sessionId)
        || sessionsFile.sessionHistory?.find((s) => s.id === params.sessionId);
    }
    if (!session) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${params.sessionId}' not found` },
      };
    }
  } else {
    const activeSessionId = todo._meta?.activeSession;
    if (activeSessionId && todo._meta?.multiSessionEnabled) {
      const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
      const sessionsFile = readJsonFile<SessionsFile>(sessionsPath);
      session = sessionsFile?.sessions?.find((s) => s.id === activeSessionId);
    }
  }

  const tasks = todo.tasks || [];
  const factors: string[] = [];

  // If no session with scope, compute a basic drift from focus state
  if (!session) {
    const focusTask = todo.focus?.currentTask;
    if (!focusTask) {
      return {
        success: true,
        data: { score: 0, factors: ['No active session or focus'], completedInScope: 0, totalInScope: 0, outOfScope: 0 },
      };
    }

    const rootTaskId = focusTask;
    const inScopeIds = collectDescendantIds(rootTaskId, tasks);
    inScopeIds.add(rootTaskId);

    const inScopeTasks = tasks.filter((t) => inScopeIds.has(t.id));
    const completedInScope = inScopeTasks.filter((t) => t.status === 'done').length;
    const totalInScope = inScopeTasks.length;

    const score = totalInScope > 0 ? Math.round((completedInScope / totalInScope) * 100) : 0;
    factors.push('Single-session mode (focus-based scope)');
    if (completedInScope === 0) factors.push('No tasks completed in scope yet');

    return {
      success: true,
      data: { score, factors, completedInScope, totalInScope, outOfScope: 0 },
    };
  }

  // Multi-session: use session scope to determine in-scope tasks
  const rootTaskId = session.scope.rootTaskId;
  const inScopeIds = new Set<string>();

  if (session.scope.explicitTaskIds && session.scope.explicitTaskIds.length > 0) {
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
  const completedInScope = inScopeTasks.filter((t) => t.status === 'done').length;
  const totalInScope = inScopeTasks.length;

  // Detect out-of-scope work: tasks completed during session that are NOT in scope
  let outOfScope = 0;
  const sessionStartTime = new Date(session.startedAt).getTime();
  for (const task of tasks) {
    if (!inScopeIds.has(task.id) && task.status === 'done') {
      const completedAt = typeof task.completedAt === 'string' ? new Date(task.completedAt).getTime() : 0;
      if (completedAt >= sessionStartTime) {
        outOfScope++;
      }
    }
  }

  // Calculate drift score (0 = no progress, 100 = all done in scope)
  let score = 0;
  if (totalInScope > 0) {
    const progressRatio = completedInScope / totalInScope;
    const driftPenalty = outOfScope > 0 ? Math.min(outOfScope / totalInScope, 0.5) : 0;
    score = Math.round(Math.max(0, Math.min(100, progressRatio * 100 - driftPenalty * 50)));
  }

  if (totalInScope === 0) factors.push('No tasks found in session scope');
  if (completedInScope === 0 && totalInScope > 0) factors.push('No tasks completed in scope yet');
  if (completedInScope === totalInScope && totalInScope > 0) factors.push('All in-scope tasks completed');
  if (outOfScope > 0) factors.push(`${outOfScope} task(s) completed outside of session scope`);
  if (outOfScope === 0 && completedInScope > 0) factors.push('All completed work is within scope');
  if (session.scope.type) factors.push(`Scope type: ${session.scope.type}`);

  return {
    success: true,
    data: { score, factors, completedInScope, totalInScope, outOfScope },
  };
}

/**
 * Record an assumption made during a session.
 * Appends to .cleo/audit/assumptions.jsonl (creates dir if needed).
 */
export function sessionRecordAssumption(
  projectRoot: string,
  params: {
    sessionId?: string;
    taskId?: string;
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
  }
): EngineResult<{
  id: string;
  sessionId: string;
  taskId: string | null;
  assumption: string;
  confidence: string;
  timestamp: string;
}> {
  if (!params?.assumption) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'assumption is required' },
    };
  }

  if (!params?.confidence || !['high', 'medium', 'low'].includes(params.confidence)) {
    return {
      success: false,
      error: { code: 'E_INVALID_INPUT', message: 'confidence must be one of: high, medium, low' },
    };
  }

  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const sessionId = params.sessionId || todo._meta?.activeSession || 'default';
  const id = `asm-${randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();

  const record = {
    id,
    sessionId,
    taskId: params.taskId || null,
    assumption: params.assumption,
    confidence: params.confidence,
    validatedAt: null,
    timestamp: now,
  };

  const auditDir = join(projectRoot, '.cleo', 'audit');
  if (!existsSync(auditDir)) {
    mkdirSync(auditDir, { recursive: true });
  }

  const assumptionsPath = join(auditDir, 'assumptions.jsonl');
  appendFileSync(assumptionsPath, JSON.stringify(record) + '\n', 'utf-8');

  return {
    success: true,
    data: {
      id,
      sessionId,
      taskId: params.taskId || null,
      assumption: params.assumption,
      confidence: params.confidence,
      timestamp: now,
    },
  };
}

// ===== Session Statistics =====

/**
 * Compute session statistics, optionally for a specific session.
 */
export function sessionStats(
  projectRoot: string,
  sessionId?: string
): EngineResult<{
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
}> {
  const todoPath = getDataPath(projectRoot, 'todo.json');
  const todo = readJsonFile<TodoFile>(todoPath);

  if (!todo) {
    return {
      success: false,
      error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
    };
  }

  const multiSession = todo._meta?.multiSessionEnabled === true;

  if (!multiSession) {
    // Single-session mode: return basic stats
    return {
      success: true,
      data: {
        totalSessions: todo.focus?.currentTask ? 1 : 0,
        activeSessions: todo.focus?.currentTask ? 1 : 0,
        suspendedSessions: 0,
        endedSessions: 0,
        archivedSessions: 0,
        totalTasksCompleted: 0,
        totalFocusChanges: 0,
        averageResumeCount: 0,
      },
    };
  }

  const sessionsPath = getDataPath(projectRoot, todo._meta?.sessionsFile || 'sessions.json');
  const sessionsFile = readJsonFile<SessionsFile>(sessionsPath);

  if (!sessionsFile) {
    return {
      success: true,
      data: {
        totalSessions: 0,
        activeSessions: 0,
        suspendedSessions: 0,
        endedSessions: 0,
        archivedSessions: 0,
        totalTasksCompleted: 0,
        totalFocusChanges: 0,
        averageResumeCount: 0,
      },
    };
  }

  const allSessions = [
    ...(sessionsFile.sessions || []),
    ...(sessionsFile.sessionHistory || []),
  ];

  // If specific session requested
  if (sessionId) {
    const session = allSessions.find((s) => s.id === sessionId);
    if (!session) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    const startedAt = new Date(session.startedAt).getTime();
    const endedAt = session.endedAt ? new Date(session.endedAt).getTime() : Date.now();
    const durationMinutes = Math.round((endedAt - startedAt) / (1000 * 60));

    return {
      success: true,
      data: {
        totalSessions: allSessions.length,
        activeSessions: allSessions.filter((s) => s.status === 'active').length,
        suspendedSessions: allSessions.filter((s) => s.status === 'suspended').length,
        endedSessions: allSessions.filter((s) => s.status === 'ended').length,
        archivedSessions: allSessions.filter((s) => s.status === 'archived').length,
        totalTasksCompleted: allSessions.reduce((sum, s) => sum + (s.stats?.tasksCompleted ?? 0), 0),
        totalFocusChanges: allSessions.reduce((sum, s) => sum + (s.stats?.focusChanges ?? 0), 0),
        averageResumeCount: allSessions.length > 0
          ? Math.round((allSessions.reduce((sum, s) => sum + (s.resumeCount ?? 0), 0) / allSessions.length) * 100) / 100
          : 0,
        session: {
          id: session.id,
          status: session.status,
          tasksCompleted: session.stats?.tasksCompleted ?? 0,
          focusChanges: session.stats?.focusChanges ?? 0,
          resumeCount: session.resumeCount ?? 0,
          durationMinutes,
        },
      },
    };
  }

  const activeSessions = allSessions.filter((s) => s.status === 'active').length;
  const suspendedSessions = allSessions.filter((s) => s.status === 'suspended').length;
  const endedSessions = allSessions.filter((s) => s.status === 'ended').length;
  const archivedSessions = allSessions.filter((s) => s.status === 'archived').length;
  const totalTasksCompleted = allSessions.reduce((sum, s) => sum + (s.stats?.tasksCompleted ?? 0), 0);
  const totalFocusChanges = allSessions.reduce((sum, s) => sum + (s.stats?.focusChanges ?? 0), 0);
  const averageResumeCount = allSessions.length > 0
    ? Math.round((allSessions.reduce((sum, s) => sum + (s.resumeCount ?? 0), 0) / allSessions.length) * 100) / 100
    : 0;

  return {
    success: true,
    data: {
      totalSessions: allSessions.length,
      activeSessions,
      suspendedSessions,
      endedSessions,
      archivedSessions,
      totalTasksCompleted,
      totalFocusChanges,
      averageResumeCount,
    },
  };
}

// ===== Session Switch =====

/**
 * Switch to a different session.
 * Ends/suspends the current active session and activates the target.
 */
export async function sessionSwitch(
  projectRoot: string,
  sessionId: string
): Promise<EngineResult<SessionRecord>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<SessionRecord>>(todoPath, () => {
    const current = readJsonFile<TodoFile>(todoPath);
    if (!current) {
      return {
        success: false,
        error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
      };
    }

    const multiSession = current._meta?.multiSessionEnabled === true;
    if (!multiSession) {
      return {
        success: false,
        error: { code: 'E_NOT_SUPPORTED', message: 'Session switch requires multi-session mode' },
      };
    }

    const sessionsPath = getDataPath(projectRoot, current._meta?.sessionsFile || 'sessions.json');
    const sessions = readJsonFile<SessionsFile>(sessionsPath);

    if (!sessions) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    // Find target session
    let targetSession = sessions.sessions.find((s) => s.id === sessionId);
    let fromHistory = false;

    if (!targetSession && sessions.sessionHistory) {
      const histIndex = sessions.sessionHistory.findIndex((s) => s.id === sessionId);
      if (histIndex !== -1) {
        targetSession = sessions.sessionHistory[histIndex];
        sessions.sessionHistory.splice(histIndex, 1);
        fromHistory = true;
      }
    }

    if (!targetSession) {
      return {
        success: false,
        error: { code: 'E_NOT_FOUND', message: `Session '${sessionId}' not found` },
      };
    }

    if (targetSession.status === 'archived') {
      return {
        success: false,
        error: { code: 'E_INVALID_STATE', message: `Session '${sessionId}' is archived and cannot be switched to` },
      };
    }

    const now = new Date().toISOString();

    // Suspend the current active session (if different from target)
    const currentActiveId = current._meta?.activeSession;
    if (currentActiveId && currentActiveId !== sessionId) {
      const currentSession = sessions.sessions.find((s) => s.id === currentActiveId);
      if (currentSession && currentSession.status === 'active') {
        currentSession.status = 'suspended';
        currentSession.suspendedAt = now;
        currentSession.lastActivity = now;
        if (currentSession.stats) {
          currentSession.stats.suspendCount = (currentSession.stats.suspendCount || 0) + 1;
        }
      }
    }

    // Activate the target session
    targetSession.status = 'active';
    targetSession.lastActivity = now;
    targetSession.suspendedAt = null;
    targetSession.endedAt = null;
    targetSession.resumeCount = (targetSession.resumeCount || 0) + 1;

    if (fromHistory) {
      sessions.sessions.push(targetSession);
    }

    // Update todo.json
    if (current._meta) {
      current._meta.activeSession = sessionId;
      current._meta.generation = (current._meta.generation || 0) + 1;
    }

    if (targetSession.focus?.currentTask && current.focus) {
      current.focus.currentTask = targetSession.focus.currentTask;
    }

    current.lastUpdated = now;

    if (sessions._meta) {
      sessions._meta.lastModified = now;
    }

    writeJsonFileAtomic(todoPath, current);
    writeJsonFileAtomic(sessionsPath, sessions);

    return { success: true, data: targetSession };
  }) as EngineResult<SessionRecord>;
}

// ===== Session Archive =====

/**
 * Archive old/ended sessions.
 * Moves ended and suspended sessions older than the threshold to archived status.
 */
export async function sessionArchive(
  projectRoot: string,
  olderThan?: string
): Promise<EngineResult<{ archived: string[]; count: number }>> {
  const todoPath = getDataPath(projectRoot, 'todo.json');

  return await withFileLock<EngineResult<{ archived: string[]; count: number }>>(
    todoPath,
    () => {
      const current = readJsonFile<TodoFile>(todoPath);
      if (!current) {
        return {
          success: false,
          error: { code: 'E_NOT_INITIALIZED', message: 'No todo.json found' },
        };
      }

      const multiSession = current._meta?.multiSessionEnabled === true;
      if (!multiSession) {
        return { success: true, data: { archived: [], count: 0 } };
      }

      const sessionsPath = getDataPath(projectRoot, current._meta?.sessionsFile || 'sessions.json');
      const sessions = readJsonFile<SessionsFile>(sessionsPath);

      if (!sessions) {
        return { success: true, data: { archived: [], count: 0 } };
      }

      const now = new Date();
      const archivedIds: string[] = [];

      // Process both active sessions list and history
      const allSessionLists = [sessions.sessions, sessions.sessionHistory || []];

      for (const list of allSessionLists) {
        for (const session of list) {
          if (session.status === 'active' || session.status === 'archived') continue;

          // Check age threshold
          if (olderThan) {
            const sessionDate = session.endedAt || session.suspendedAt || session.lastActivity || session.startedAt;
            if (sessionDate && new Date(sessionDate) > new Date(olderThan)) {
              continue;
            }
          }

          session.status = 'archived';
          session.archivedAt = now.toISOString();
          archivedIds.push(session.id);
        }
      }

      if (archivedIds.length > 0) {
        // Move archived sessions from active list to history
        const toMove = sessions.sessions.filter((s) => s.status === 'archived');
        if (!sessions.sessionHistory) sessions.sessionHistory = [];
        sessions.sessionHistory.push(...toMove);
        sessions.sessions = sessions.sessions.filter((s) => s.status !== 'archived');

        if (sessions._meta) {
          sessions._meta.lastModified = now.toISOString();
        }
        writeJsonFileAtomic(sessionsPath, sessions);
      }

      return {
        success: true,
        data: { archived: archivedIds, count: archivedIds.length },
      };
    }
  ) as EngineResult<{ archived: string[]; count: number }>;
}
