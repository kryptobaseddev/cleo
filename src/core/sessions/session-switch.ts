/**
 * Switch to a different session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { Session } from '../../types/session.js';
import type { TaskFileExt } from './types.js';

/**
 * Switch to a different session.
 * Suspends the current active session and activates the target.
 * Throws if multi-session mode is not enabled, session not found, or archived.
 */
export async function switchSession(
  projectRoot: string,
  sessionId: string,
): Promise<Session> {
  const accessor = await getAccessor(projectRoot);
  const taskData = await accessor.loadTaskFile();
  const current = taskData as unknown as TaskFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;
  if (!multiSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      'Session switch requires multi-session mode',
    );
  }

  const sessions = await accessor.loadSessions();

  // Find target session
  const targetSession = sessions.find((s) => s.id === sessionId);

  if (!targetSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  if ((targetSession.status as string) === 'archived') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' is archived and cannot be switched to`,
    );
  }

  const now = new Date().toISOString();

  // Suspend the current active session (if different from target)
  const currentActiveId = current._meta?.activeSession;
  if (currentActiveId && currentActiveId !== sessionId) {
    const currentSession = sessions.find(
      (s) => s.id === currentActiveId,
    );
    if (currentSession && currentSession.status === 'active') {
      currentSession.status = 'suspended';
      (currentSession as unknown as Record<string, unknown>).suspendedAt = now;
      if (currentSession.stats) {
        currentSession.stats.suspendCount =
          (currentSession.stats.suspendCount || 0) + 1;
      }
    }
  }

  // Activate the target session
  targetSession.status = 'active';
  (targetSession as unknown as Record<string, unknown>).suspendedAt = null;
  targetSession.endedAt = undefined;
  targetSession.resumeCount = (targetSession.resumeCount || 0) + 1;

  // Update todo.json
  if (current._meta) {
    current._meta.activeSession = sessionId;
    current._meta.generation = (current._meta.generation || 0) + 1;
  }

  if (targetSession.taskWork?.taskId && current.focus) {
    current.focus.currentTask = targetSession.taskWork.taskId;
  }

  current.lastUpdated = now;

  await accessor.saveTaskFile(taskData);
  await accessor.saveSessions(sessions);

  return targetSession;
}
