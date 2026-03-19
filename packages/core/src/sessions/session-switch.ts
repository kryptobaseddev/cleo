/**
 * Switch to a different session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../store/data-accessor.js';
import { ExitCode } from '@cleocode/contracts';
import type { Session, TaskWorkState } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/**
 * Switch to a different session.
 * Suspends the current active session and activates the target.
 * Throws if session not found or archived.
 */
export async function switchSession(projectRoot: string, sessionId: string): Promise<Session> {
  const accessor = await getAccessor(projectRoot);

  const sessions = await accessor.loadSessions();

  // Find target session
  const targetSession = sessions.find((s) => s.id === sessionId);

  if (!targetSession) {
    throw new CleoError(ExitCode.SESSION_NOT_FOUND, `Session '${sessionId}' not found`);
  }

  if ((targetSession.status as string) === 'archived') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' is archived and cannot be switched to`,
    );
  }

  const now = new Date().toISOString();

  // Suspend the current active session (if different from target)
  const currentActive = await accessor.getActiveSession();
  if (currentActive && currentActive.id !== sessionId) {
    currentActive.status = 'suspended';
    Object.assign(currentActive, { suspendedAt: now });
    if (currentActive.stats) {
      currentActive.stats.suspendCount = (currentActive.stats.suspendCount || 0) + 1;
    }
    await accessor.upsertSingleSession(currentActive);
  }

  // Activate the target session
  targetSession.status = 'active';
  Object.assign(targetSession, { suspendedAt: null });
  targetSession.endedAt = undefined;
  targetSession.resumeCount = (targetSession.resumeCount || 0) + 1;

  // Update focus if target session has a task
  if (targetSession.taskWork?.taskId) {
    const focus = (await accessor.getMetaValue<TaskWorkState>('focus_state')) ?? ({} as TaskWorkState);
    focus.currentTask = targetSession.taskWork.taskId;
    await accessor.setMetaValue('focus_state', focus);
  }

  await accessor.upsertSingleSession(targetSession);

  return targetSession;
}
