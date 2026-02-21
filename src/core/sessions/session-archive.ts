/**
 * Archive old/ended sessions.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import type { SessionsFileExt, TodoFileExt } from './types.js';

/**
 * Archive old/ended sessions.
 * Moves ended and suspended sessions older than the threshold to archived status.
 */
export async function archiveSessions(
  projectRoot: string,
  olderThan?: string,
): Promise<{ archived: string[]; count: number }> {
  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTodoFile();
  const current = todoData as unknown as TodoFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;
  if (!multiSession) {
    return { archived: [], count: 0 };
  }

  const sessions = (await accessor.loadSessions()) as unknown as SessionsFileExt;

  if (!sessions) {
    return { archived: [], count: 0 };
  }

  const now = new Date();
  const archivedIds: string[] = [];

  // Process both active sessions list and history
  const allSessionLists = [sessions.sessions, sessions.sessionHistory || []];

  for (const list of allSessionLists) {
    for (const session of list) {
      if (session.status === 'active' || session.status === 'archived') continue;

      // Check age threshold
      if (olderThan) {
        const sessionDate =
          session.endedAt ||
          session.suspendedAt ||
          session.lastActivity ||
          session.startedAt;
        if (sessionDate && new Date(sessionDate) > new Date(olderThan)) {
          continue;
        }
      }

      session.status = 'archived';
      session.archivedAt = now.toISOString();
      archivedIds.push(session.id);
    }
  }

  if (archivedIds.length > 0) {
    // Move archived sessions from active list to history
    const toMove = sessions.sessions.filter((s) => s.status === 'archived');
    if (!sessions.sessionHistory) sessions.sessionHistory = [];
    sessions.sessionHistory.push(...toMove);
    sessions.sessions = sessions.sessions.filter(
      (s) => s.status !== 'archived',
    );

    if (sessions._meta) {
      sessions._meta.lastModified = now.toISOString();
    }
    await accessor.saveSessions(sessions as any);
  }

  return { archived: archivedIds, count: archivedIds.length };
}
