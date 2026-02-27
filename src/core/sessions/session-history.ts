/**
 * Session history with focus changes and completed tasks.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import type { Session } from '../../types/session.js';

export interface SessionHistoryEntry {
  id: string;
  name?: string;
  status: string;
  startedAt: string;
  endedAt?: string | null;
  tasksCompleted: number;
  focusChanges: number;
  focusHistory: Array<{ taskId: string; timestamp: string }>;
}

export interface SessionHistoryParams {
  sessionId?: string;
  limit?: number;
}

/**
 * List session history with focus changes and completed tasks.
 * If sessionId is provided, returns history for that specific session.
 * Otherwise, returns history across all sessions.
 */
export async function getSessionHistory(
  projectRoot: string,
  params?: SessionHistoryParams,
): Promise<{ sessions: SessionHistoryEntry[] }> {
  const accessor = await getAccessor(projectRoot);

  // Verify project is initialized by loading todo file
  await accessor.loadTaskFile();

  const allSessions: Session[] = await accessor.loadSessions();

  if (allSessions.length === 0) {
    return { sessions: [] };
  }

  let filtered = allSessions;

  if (params?.sessionId) {
    filtered = filtered.filter((s) => s.id === params.sessionId);
  }

  // Sort by startedAt descending (most recent first)
  filtered.sort(
    (a, b) =>
      new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  );

  if (params?.limit && params.limit > 0) {
    filtered = filtered.slice(0, params.limit);
  }

  const result = filtered.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.status,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    tasksCompleted: s.stats?.tasksCompleted || 0,
    focusChanges: s.stats?.focusChanges || 0,
    focusHistory: [],
  }));

  return { sessions: result };
}
