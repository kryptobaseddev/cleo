/**
 * Suspend an active session.
 *
 * @task T4782
 * @epic T4654
 * @task T1450 — normalized (projectRoot, params) signature
 */

import type { Session } from '@cleocode/contracts';
import { ExitCode, type SessionSuspendParams } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { getAccessor } from '../store/data-accessor.js';

/**
 * Suspend an active session.
 * Normalized Core signature: (projectRoot, params) → Result.
 * Sets status to 'suspended' and records the reason.
 * Throws if session not found or not active.
 * @task T1450
 */
export async function suspendSession(
  projectRoot: string,
  params: SessionSuspendParams,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);

  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === params.sessionId);

  if (!session) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${params.sessionId}' not found`);
  }

  if (session.status !== 'active') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${params.sessionId}' is ${session.status}, not active`,
    );
  }

  const now = new Date().toISOString();

  session.status = 'suspended';
  Object.assign(session, { suspendedAt: now });

  if (session.stats) {
    session.stats.suspendCount = (session.stats.suspendCount || 0) + 1;
  }

  if (params.reason) {
    if (!session.notes) session.notes = [];
    session.notes.push(params.reason);
  }

  await accessor.upsertSingleSession(session);

  return session;
}
