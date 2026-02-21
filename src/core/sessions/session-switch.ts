/**
 * Switch to a different session.
 *
 * @task T4782
 * @epic T4654
 */

import { getAccessor } from '../../store/data-accessor.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { SessionRecord, SessionsFileExt, TodoFileExt } from './types.js';

/**
 * Switch to a different session.
 * Suspends the current active session and activates the target.
 * Throws if multi-session mode is not enabled, session not found, or archived.
 */
export async function switchSession(
  projectRoot: string,
  sessionId: string,
): Promise<SessionRecord> {
  const accessor = await getAccessor(projectRoot);
  const todoData = await accessor.loadTodoFile();
  const current = todoData as unknown as TodoFileExt;

  const multiSession = current._meta?.multiSessionEnabled === true;
  if (!multiSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      'Session switch requires multi-session mode',
    );
  }

  const sessions = (await accessor.loadSessions()) as unknown as SessionsFileExt;

  if (!sessions) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  // Find target session
  let targetSession = sessions.sessions.find((s) => s.id === sessionId);
  let fromHistory = false;

  if (!targetSession && sessions.sessionHistory) {
    const histIndex = sessions.sessionHistory.findIndex(
      (s) => s.id === sessionId,
    );
    if (histIndex !== -1) {
      targetSession = sessions.sessionHistory[histIndex];
      sessions.sessionHistory.splice(histIndex, 1);
      fromHistory = true;
    }
  }

  if (!targetSession) {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' not found`,
    );
  }

  if (targetSession.status === 'archived') {
    throw new CleoError(
      ExitCode.SESSION_NOT_FOUND,
      `Session '${sessionId}' is archived and cannot be switched to`,
    );
  }

  const now = new Date().toISOString();

  // Suspend the current active session (if different from target)
  const currentActiveId = current._meta?.activeSession;
  if (currentActiveId && currentActiveId !== sessionId) {
    const currentSession = sessions.sessions.find(
      (s) => s.id === currentActiveId,
    );
    if (currentSession && currentSession.status === 'active') {
      currentSession.status = 'suspended';
      currentSession.suspendedAt = now;
      currentSession.lastActivity = now;
      if (currentSession.stats) {
        currentSession.stats.suspendCount =
          (currentSession.stats.suspendCount || 0) + 1;
      }
    }
  }

  // Activate the target session
  targetSession.status = 'active';
  targetSession.lastActivity = now;
  targetSession.suspendedAt = null;
  targetSession.endedAt = null;
  targetSession.resumeCount = (targetSession.resumeCount || 0) + 1;

  if (fromHistory) {
    sessions.sessions.push(targetSession);
  }

  // Update todo.json
  if (current._meta) {
    current._meta.activeSession = sessionId;
    current._meta.generation = (current._meta.generation || 0) + 1;
  }

  if (targetSession.focus?.currentTask && current.focus) {
    current.focus.currentTask = targetSession.focus.currentTask;
  }

  current.lastUpdated = now;

  if (sessions._meta) {
    sessions._meta.lastModified = now;
  }

  await accessor.saveTodoFile(todoData);
  await accessor.saveSessions(sessions as any);

  return targetSession;
}
