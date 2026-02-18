/**
 * Session management operations.
 * @task T4463
 * @epic T4454
 */

import { randomBytes } from 'node:crypto';
import { readJson, saveJson } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session, SessionsFile, SessionScope, SessionScopeType } from '../../types/session.js';
import { getSessionsPath, getBackupDir } from '../paths.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Options for starting a session. */
export interface StartSessionOptions {
  name: string;
  scope: string; // e.g. "epic:T001" or "global"
  autoFocus?: boolean;
  focus?: string;
  agent?: string;
}

/** Options for ending a session. */
export interface EndSessionOptions {
  sessionId?: string;
  note?: string;
}

/** Options for listing sessions. */
export interface ListSessionsOptions {
  status?: string;
  limit?: number;
}

/**
 * Parse a scope string into a SessionScope.
 * @task T4463
 */
export function parseScope(scopeStr: string): SessionScope {
  if (scopeStr === 'global') {
    return { type: 'global' as SessionScopeType };
  }
  const match = scopeStr.match(/^epic:(T\d+)$/);
  if (match) {
    return { type: 'epic' as SessionScopeType, epicId: match[1] };
  }
  throw new CleoError(
    ExitCode.SCOPE_INVALID,
    `Invalid scope format: ${scopeStr}. Use 'epic:T###' or 'global'.`,
  );
}

/**
 * Generate a session ID.
 * @task T4463
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${randomBytes(3).toString('hex')}`;
}

/**
 * Read or create sessions file.
 * @task T4463
 */
async function readSessions(cwd?: string, accessor?: DataAccessor): Promise<SessionsFile> {
  if (accessor) {
    const data = await accessor.loadSessions() as SessionsFile;
    if (data && data.sessions) return data;
    return {
      version: '1.0.0',
      sessions: [],
      _meta: {
        schemaVersion: '1.0.0',
        lastUpdated: new Date().toISOString(),
      },
    };
  }
  const sessionsPath = getSessionsPath(cwd);
  const data = await readJson<SessionsFile>(sessionsPath);
  if (data) return data;

  return {
    version: '1.0.0',
    sessions: [],
    _meta: {
      schemaVersion: '1.0.0',
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Save sessions file.
 * @task T4463
 */
async function saveSessions(data: SessionsFile, cwd?: string, accessor?: DataAccessor): Promise<void> {
  data._meta.lastUpdated = new Date().toISOString();
  if (accessor) {
    await accessor.saveSessions(data);
    return;
  }
  const sessionsPath = getSessionsPath(cwd);
  const backupDir = getBackupDir(cwd);
  await saveJson(sessionsPath, data, { backupDir });
}

/**
 * Start a new session.
 * @task T4463
 */
export async function startSession(options: StartSessionOptions, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const scope = parseScope(options.scope);
  const data = await readSessions(cwd, accessor);

  // Check for conflicting active sessions
  const activeSessions = data.sessions.filter(s => s.status === 'active');
  for (const active of activeSessions) {
    if (
      active.scope.type === scope.type &&
      active.scope.epicId === scope.epicId
    ) {
      throw new CleoError(
        ExitCode.SCOPE_CONFLICT,
        `Active session already exists for scope ${options.scope}: ${active.id}`,
        {
          fix: `Resume with 'cleo session resume ${active.id}' or end it first`,
          alternatives: [
            { action: 'Resume existing', command: `cleo session resume ${active.id}` },
            { action: 'End existing', command: `cleo session end` },
          ],
        },
      );
    }
  }

  const session: Session = {
    id: generateSessionId(),
    name: options.name,
    status: 'active',
    scope,
    focus: {
      taskId: options.focus ?? null,
      setAt: options.focus ? new Date().toISOString() : null,
    },
    startedAt: new Date().toISOString(),
    agent: options.agent ?? null,
    notes: [],
    tasksCompleted: [],
    tasksCreated: [],
  };

  data.sessions.push(session);
  await saveSessions(data, cwd, accessor);

  return session;
}

/**
 * End a session.
 * @task T4463
 */
export async function endSession(options: EndSessionOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const data = await readSessions(cwd, accessor);

  let session: Session | undefined;

  if (options.sessionId) {
    session = data.sessions.find(s => s.id === options.sessionId);
  } else {
    // Find most recent active session
    session = data.sessions
      .filter(s => s.status === 'active')
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  }

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      options.sessionId
        ? `Session not found: ${options.sessionId}`
        : 'No active session found',
      { fix: "Use 'cleo session list' to see available sessions" },
    );
  }

  if (session.status !== 'active') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session ${session.id} is already ${session.status}`,
    );
  }

  session.status = 'ended';
  session.endedAt = new Date().toISOString();

  if (options.note) {
    if (!session.notes) session.notes = [];
    session.notes.push(options.note);
  }

  await saveSessions(data, cwd, accessor);

  return session;
}

/**
 * Get current session status.
 * @task T4463
 */
export async function sessionStatus(cwd?: string, accessor?: DataAccessor): Promise<Session | null> {
  const data = await readSessions(cwd, accessor);

  const active = data.sessions
    .filter(s => s.status === 'active')
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];

  return active ?? null;
}

/**
 * Resume an existing session.
 * @task T4463
 */
export async function resumeSession(sessionId: string, cwd?: string, accessor?: DataAccessor): Promise<Session> {
  const data = await readSessions(cwd, accessor);

  const session = data.sessions.find(s => s.id === sessionId);
  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session not found: ${sessionId}`,
      { fix: "Use 'cleo session list' to see available sessions" },
    );
  }

  if (session.status === 'active') {
    return session; // Already active
  }

  if (session.status === 'orphaned' || session.status === 'ended') {
    session.status = 'active';
    session.endedAt = null;
    if (!session.notes) session.notes = [];
    session.notes.push(`Resumed at ${new Date().toISOString()}`);

    await saveSessions(data, cwd, accessor);
  }

  return session;
}

/**
 * List sessions with optional filtering.
 * @task T4463
 */
export async function listSessions(options: ListSessionsOptions = {}, cwd?: string, accessor?: DataAccessor): Promise<Session[]> {
  const data = await readSessions(cwd, accessor);

  let sessions = data.sessions;

  if (options.status) {
    sessions = sessions.filter(s => s.status === options.status);
  }

  // Sort by start time, most recent first
  sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

  if (options.limit) {
    sessions = sessions.slice(0, options.limit);
  }

  return sessions;
}

/**
 * Garbage collect old sessions.
 * Marks orphaned sessions that have been active too long.
 * @task T4463
 */
export async function gcSessions(maxAgeHours: number = 24, cwd?: string, accessor?: DataAccessor): Promise<{ orphaned: string[]; removed: string[] }> {
  const data = await readSessions(cwd, accessor);
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  const orphaned: string[] = [];
  const removed: string[] = [];

  for (const session of data.sessions) {
    if (session.status === 'active') {
      const age = now - new Date(session.startedAt).getTime();
      if (age > maxAgeMs) {
        session.status = 'orphaned';
        session.endedAt = new Date().toISOString();
        orphaned.push(session.id);
      }
    }
  }

  // Remove very old ended/orphaned sessions (> 30 days)
  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  data.sessions = data.sessions.filter(s => {
    if (s.status === 'active') return true;
    const endedAt = s.endedAt ? new Date(s.endedAt).getTime() : new Date(s.startedAt).getTime();
    if (now - endedAt > thirtyDaysMs) {
      removed.push(s.id);
      return false;
    }
    return true;
  });

  if (orphaned.length > 0 || removed.length > 0) {
    await saveSessions(data, cwd, accessor);
  }

  return { orphaned, removed };
}
