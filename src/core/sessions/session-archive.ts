/**
 * Archive old/ended sessions.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';

/**
 * Archive old/ended sessions.
 * Identifies ended and suspended sessions older than the threshold.
 * With SQLite, all sessions live in a single table — "archiving" marks them
 * as identified for potential cleanup rather than moving between arrays.
 */
export async function archiveSessions(
  projectRoot: string,
  olderThan?: string,
): Promise<{ archived: string[]; count: number }> {
  const accessor = await getAccessor(projectRoot);

  const sessions = await accessor.loadSessions();

  if (!sessions || sessions.length === 0) {
    return { archived: [], count: 0 };
  }

  const archivedIds: string[] = [];

  for (const session of sessions) {
    if (session.status === 'active') continue;
    // Only archive ended, orphaned, or suspended sessions
    if (session.status !== 'ended' && session.status !== 'orphaned' && session.status !== 'suspended') continue;

    // Check age threshold
    if (olderThan) {
      const sessionDate = session.endedAt || session.startedAt;
      if (sessionDate && new Date(sessionDate) > new Date(olderThan)) {
        continue;
      }
    }

    archivedIds.push(session.id);
  }

  return { archived: archivedIds, count: archivedIds.length };
}
