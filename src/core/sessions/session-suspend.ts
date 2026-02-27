/**
 * Suspend an active session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session } from '../../types/session.js';
import type { TaskFileExt } from './types.js';

/**
 * Suspend an active session.
 * Sets status to 'suspended' and records the reason.
 * Throws if multi-session mode is not enabled or session not found/not active.
 */
export async function suspendSession(
  projectRoot: string,
  sessionId: string,
  reason?: string,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;

  if (!multiSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      'Session suspend requires multi-session mode',
    );
  }

  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === sessionId);

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
  (session as unknown as Record<string, unknown>).suspendedAt = now;

  if (session.stats) {
    session.stats.suspendCount = (session.stats.suspendCount || 0) + 1;
  }

  if (reason) {
    if (!session.notes) session.notes = [];
    session.notes.push(reason);
  }

  // Clear active session in todo.json if this was the active one
  if (current._meta?.activeSession === sessionId) {
    current._meta.activeSession = null;
    current._meta.generation = (current._meta.generation || 0) + 1;
    (current as Record<string, unknown>).lastUpdated = now;
    await accessor.saveTaskFile(taskData);
  }

  await accessor.saveSessions(sessions);

  return session;
}
