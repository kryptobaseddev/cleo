/**
 * Suspend an active session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import type { FileMeta, Session } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * Suspend an active session.
 * Sets status to 'suspended' and records the reason.
 * Throws if session not found or not active.
 */
export async function suspendSession(
  projectRoot: string,
  sessionId: string,
  reason?: string,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);

  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === sessionId);

  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${sessionId}' not found`);
  }

  if (session.status !== 'active') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' is ${session.status}, not active`,
    );
  }

  const now = new Date().toISOString();

  session.status = 'suspended';
  Object.assign(session, { suspendedAt: now });

  if (session.stats) {
    session.stats.suspendCount = (session.stats.suspendCount || 0) + 1;
  }

  if (reason) {
    if (!session.notes) session.notes = [];
    session.notes.push(reason);
  }

  // Clear active session in task data if this was the active one
  const fileMeta = await accessor.getMetaValue<FileMeta>('file_meta');
  if (fileMeta?.activeSession === sessionId) {
    fileMeta.activeSession = null;
    fileMeta.generation = (fileMeta.generation || 0) + 1;
    await accessor.setMetaValue('file_meta', fileMeta);
  }

  await accessor.saveSessions(sessions);

  return session;
}
