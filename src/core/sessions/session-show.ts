/**
 * Show a specific session by ID.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session } from '../../types/session.js';

/**
 * Show a specific session.
 * Looks in active sessions first, then session history.
 * Throws CleoError if not found.
 */
export async function showSession(
  projectRoot: string,
  sessionId: string,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === sessionId);
  if (session) {
    return session;
  }

  throw new CleoError(
    ExitCode.SESSION_NOT_FOUND,
    `Session '${sessionId}' not found`,
  );
}
