/**
 * Remove orphaned sessions and clean up stale data.
 *
 * @task T4782
 * @task T2304
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { getRawConfigValue } from '../config.js';
import type { TaskFileExt } from './types.js';

/** Default auto-end threshold when no config is set (7 days). */
const DEFAULT_AUTO_END_DAYS = 7;

/**
 * Remove orphaned sessions, auto-end stale active sessions, and clean up stale data.
 *
 * Stale active sessions (no activity beyond the configured threshold) are
 * transitioned to 'ended' with an auto-end note. The threshold is read from
 * `retention.autoEndActiveAfterDays` in the project config (default: 7 days).
 *
 * @task T2304
 */
export async function cleanupSessions(
  projectRoot: string,
): Promise<{ removed: string[]; autoEnded: string[]; cleaned: boolean }> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const sessions = await accessor.loadSessions();

  if (sessions.length === 0) {
    return { removed: [], autoEnded: [], cleaned: false };
  }

  const removed: string[] = [];
  const autoEnded: string[] = [];
  let todoUpdated = false;

  // Read auto-end threshold from config
  const configDays = await getRawConfigValue('retention.autoEndActiveAfterDays', projectRoot);
  const autoEndDays = typeof configDays === 'number' && configDays > 0
    ? configDays
    : DEFAULT_AUTO_END_DAYS;
  const autoEndMs = autoEndDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  for (const session of sessions) {
    // Auto-end stale active sessions (T2304)
    if (session.status === 'active') {
      const sessionTime = new Date(session.startedAt).getTime();
      if (now - sessionTime > autoEndMs) {
        session.status = 'ended';
        session.endedAt = new Date().toISOString();
        if (!session.notes) session.notes = [];
        session.notes.push(
          `Auto-ended: session exceeded ${autoEndDays}-day inactivity threshold`,
        );
        autoEnded.push(session.id);
      }
    }

    // Identify archived sessions to remove
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

  if (removed.length > 0 || autoEnded.length > 0 || todoUpdated) {
    await accessor.saveSessions(sessions);
    if (todoUpdated) {
      await accessor.saveTaskFile(taskData);
    }
  }

  return { removed, autoEnded, cleaned: removed.length > 0 || autoEnded.length > 0 || todoUpdated };
}
