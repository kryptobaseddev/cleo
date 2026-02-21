/**
 * Suspend an active session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { SessionRecord, SessionsFileExt, TodoFileExt } from './types.js';

/**
 * Suspend an active session.
 * Sets status to 'suspended' and records the reason.
 * Throws if multi-session mode is not enabled or session not found/not active.
 */
export async function suspendSession(
  projectRoot: string,
  sessionId: string,
  reason?: string,
): Promise<SessionRecord> {
  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTodoFile();
  const current = todoData as unknown as TodoFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;

  if (!multiSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      'Session suspend requires multi-session mode',
    );
  }

  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;

  if (!sessions) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  const session = sessions.sessions.find((s) => s.id === sessionId);

  if (!session) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  if (session.status !== 'active') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' is ${session.status}, not active`,
    );
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
    (current as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTodoFile(todoData);
  }

  if (sessions._meta) {
    sessions._meta.lastModified = now;
  }

  await accessor.saveSessions(sessionsData);

  return session;
}
