/**
 * Remove orphaned sessions and clean up stale data.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import type { TaskFileExt } from './types.js';

/**
 * Remove orphaned sessions and clean up stale data.
 * Removes sessions with status 'ended' or 'suspended' from the active list
 * (moves to history), and clears any orphaned references in todo.json.
 */
export async function cleanupSessions(
  projectRoot: string,
): Promise<{ removed: string[]; cleaned: boolean }> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;
  if (!multiSession) {
    return { removed: [], cleaned: false };
  }

  const sessions = await accessor.loadSessions();

  if (sessions.length === 0) {
    return { removed: [], cleaned: false };
  }

  const removed: string[] = [];
  let todoUpdated = false;

  // Identify non-active sessions to remove
  // In SQLite, status changes are persisted directly -- no history array needed
  for (const session of sessions) {
    if ((session.status as string) === 'archived') {
      removed.push(session.id);
    }
  }

  // Clean stale references in todo.json
  if (current._meta?.activeSession) {
    const activeExists = sessions.some(
      (s) => s.id === current._meta!.activeSession && s.status === 'active',
    );
    if (!activeExists) {
      current._meta.activeSession = null;
      current._meta.generation = (current._meta.generation || 0) + 1;
      current.lastUpdated = new Date().toISOString();
      todoUpdated = true;
    }
  }

  if (removed.length > 0 || todoUpdated) {
    await accessor.saveSessions(sessions);
    if (todoUpdated) {
      await accessor.saveTaskFile(taskData);
    }
  }

  return { removed, cleaned: removed.length > 0 || todoUpdated };
}
