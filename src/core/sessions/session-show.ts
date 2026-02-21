/**
 * Show a specific session by ID.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { SessionRecord, SessionsFileExt } from './types.js';

/**
 * Show a specific session.
 * Looks in active sessions first, then session history.
 * Throws CleoError if not found.
 */
export async function showSession(
  projectRoot: string,
  sessionId: string,
): Promise<SessionRecord> {
  const accessor = await getAccessor(projectRoot);
  const sessionsData = await accessor.loadSessions();
  const sessions = sessionsData as unknown as SessionsFileExt;

  if (!sessions) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  const session = sessions.sessions?.find((s) => s.id === sessionId);
  if (session) {
    return session;
  }

  // Check history
  const historical = sessions.sessionHistory?.find((s) => s.id === sessionId);
  if (historical) {
    return historical;
  }

  throw new CleoError(
    ExitCode.SESSION_NOT_FOUND,
    `Session '${sessionId}' not found`,
  );
}
