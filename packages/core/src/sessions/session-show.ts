/**
 * Show a specific session by ID.
 *
 * @task T4782
 * @epic T4654
 * @task T1450 — normalized (projectRoot, params) signature
 */

import type { Session, SessionShowParams } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';

/**
 * Show a specific session by ID.
 * Normalized Core signature: (projectRoot, params) → Result.
 * @task T1450
 */
export async function showSession(
  projectRoot: string,
  params: SessionShowParams,
): Promise<Session> {
  const accessor = await getTaskAccessor(projectRoot);
  const sessions = await accessor.loadSessions();

  const session = sessions.find((s) => s.id === params.sessionId);
  if (session) {
    return session;
  }

  throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${params.sessionId}' not found`);
}
