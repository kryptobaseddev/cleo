/**
 * Compute session statistics.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { SessionRecord, SessionsFileExt, TaskFileExt } from './types.js';

export interface SessionStatsResult {
  totalSessions: number;
  activeSessions: number;
  suspendedSessions: number;
  endedSessions: number;
  archivedSessions: number;
  totalTasksCompleted: number;
  totalFocusChanges: number;
  averageResumeCount: number;
  session?: {
    id: string;
    status: string;
    tasksCompleted: number;
    focusChanges: number;
    resumeCount: number;
    durationMinutes: number;
  };
}

/**
 * Compute session statistics, optionally for a specific session.
 * Throws CleoError if a specific session is requested but not found.
 */
export async function getSessionStats(
  projectRoot: string,
  sessionId?: string,
): Promise<SessionStatsResult> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;

  if (!multiSession) {
    // Single-session mode: return basic stats
    return {
      totalSessions: current.focus?.currentTask ? 1 : 0,
      activeSessions: current.focus?.currentTask ? 1 : 0,
      suspendedSessions: 0,
      endedSessions: 0,
      archivedSessions: 0,
      totalTasksCompleted: 0,
      totalFocusChanges: 0,
      averageResumeCount: 0,
    };
  }

  const sessionsFile = (await accessor.loadSessions()) as unknown as SessionsFileExt;

  if (!sessionsFile) {
    return {
      totalSessions: 0,
      activeSessions: 0,
      suspendedSessions: 0,
      endedSessions: 0,
      archivedSessions: 0,
      totalTasksCompleted: 0,
      totalFocusChanges: 0,
      averageResumeCount: 0,
    };
  }

  const allSessions: SessionRecord[] = [
    ...(sessionsFile.sessions || []),
    ...(sessionsFile.sessionHistory || []),
  ];

  // If specific session requested
  if (sessionId) {
    const session = allSessions.find((s) => s.id === sessionId);
    if (!session) {
      throw new CleoError(
        ExitCode.SESSION_NOT_FOUND,
        `Session '${sessionId}' not found`,
      );
    }

    const startedAt = new Date(session.startedAt).getTime();
    const endedAt = session.endedAt
      ? new Date(session.endedAt).getTime()
      : Date.now();
    const durationMinutes = Math.round((endedAt - startedAt) / (1000 * 60));

    return {
      totalSessions: allSessions.length,
      activeSessions: allSessions.filter((s) => s.status === 'active').length,
      suspendedSessions: allSessions.filter((s) => s.status === 'suspended').length,
      endedSessions: allSessions.filter((s) => s.status === 'ended').length,
      archivedSessions: allSessions.filter((s) => s.status === 'archived').length,
      totalTasksCompleted: allSessions.reduce(
        (sum, s) => sum + (s.stats?.tasksCompleted ?? 0),
        0,
      ),
      totalFocusChanges: allSessions.reduce(
        (sum, s) => sum + (s.stats?.focusChanges ?? 0),
        0,
      ),
      averageResumeCount:
        allSessions.length > 0
          ? Math.round(
              (allSessions.reduce(
                (sum, s) => sum + (s.resumeCount ?? 0),
                0,
              ) /
                allSessions.length) *
                100,
            ) / 100
          : 0,
      session: {
        id: session.id,
        status: session.status,
        tasksCompleted: session.stats?.tasksCompleted ?? 0,
        focusChanges: session.stats?.focusChanges ?? 0,
        resumeCount: session.resumeCount ?? 0,
        durationMinutes,
      },
    };
  }

  const activeSessions = allSessions.filter((s) => s.status === 'active').length;
  const suspendedSessions = allSessions.filter((s) => s.status === 'suspended').length;
  const endedSessions = allSessions.filter((s) => s.status === 'ended').length;
  const archivedSessions = allSessions.filter((s) => s.status === 'archived').length;
  const totalTasksCompleted = allSessions.reduce(
    (sum, s) => sum + (s.stats?.tasksCompleted ?? 0),
    0,
  );
  const totalFocusChanges = allSessions.reduce(
    (sum, s) => sum + (s.stats?.focusChanges ?? 0),
    0,
  );
  const averageResumeCount =
    allSessions.length > 0
      ? Math.round(
          (allSessions.reduce(
            (sum, s) => sum + (s.resumeCount ?? 0),
            0,
          ) /
            allSessions.length) *
            100,
        ) / 100
      : 0;

  return {
    totalSessions: allSessions.length,
    activeSessions,
    suspendedSessions,
    endedSessions,
    archivedSessions,
    totalTasksCompleted,
    totalFocusChanges,
    averageResumeCount,
  };
}
