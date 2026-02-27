/**
 * Remove orphaned sessions and clean up stale data.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import type { SessionRecord, SessionsFileExt, TaskFileExt } from './types.js';

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

  const sessions = (await accessor.loadSessions()) as unknown as SessionsFileExt;

  if (!sessions) {
    return { removed: [], cleaned: false };
  }

  const removed: string[] = [];
  let todoUpdated = false;

  // Remove all non-active sessions from the sessions list
  // (move ended/suspended to history, remove orphaned entirely)
  const activeSessions: SessionRecord[] = [];
  for (const session of sessions.sessions) {
    if (session.status === 'active') {
      activeSessions.push(session);
    } else if (session.status === 'ended' || session.status === 'suspended') {
      // Move to history
      if (!sessions.sessionHistory) sessions.sessionHistory = [];
      sessions.sessionHistory.push(session);
      removed.push(session.id);
    } else if (session.status === 'archived') {
      // Archived sessions are removed from active list
      removed.push(session.id);
    }
  }
  sessions.sessions = activeSessions;

  // Clean stale references in todo.json
  if (current._meta?.activeSession) {
    const activeExists = sessions.sessions.some(
      (s) => s.id === current._meta!.activeSession,
    );
    if (!activeExists) {
      current._meta.activeSession = null;
      current._meta.generation = (current._meta.generation || 0) + 1;
      current.lastUpdated = new Date().toISOString();
      todoUpdated = true;
    }
  }

  if (removed.length > 0 || todoUpdated) {
    if (sessions._meta) {
      sessions._meta.lastModified = new Date().toISOString();
    }
    await accessor.saveSessions(sessions as any);
    if (todoUpdated) {
      await accessor.saveTaskFile(taskData);
    }
  }

  return { removed, cleaned: removed.length > 0 || todoUpdated };
}
