/**
 * Session Engine
 *
 * Native TypeScript implementation of session lifecycle operations.
 * Supports both single-session (focus in todo.json) and multi-session
 * (separate sessions.json) modes.
 *
 * Supports: status, list, show, current, start, stop, session-start, session-end
 */

import { readJsonFile, writeJsonFileAtomic, withFileLock, getDataPath } from './store.js';
import { randomBytes, createHash } from 'crypto';

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
function isMultiSession(projectRoot: string): boolean {
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
 * Get current focused task (tasks.current)
 */
export function taskCurrentGet(
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
 * Start working on a specific task (tasks.start)
 */
export async function taskStart(
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
 * Stop working on current task (tasks.stop)
 */
export async function taskStop(
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
    autoStart?: boolean;
    startTask?: string;
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
        currentTask: params.startTask || (params.autoStart ? rootTaskId : null),
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

    if (params.startTask) {
      current.focus.currentTask = params.startTask;
    } else if (params.autoStart) {
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
