/**
 * System Notification Hook Handler
 *
 * Captures message-bearing system notifications as BRAIN observations.
 * File-change notifications (filePath + changeType) are handled by
 * file-hooks.ts; this module only handles Notification payloads with
 * a `message` field.
 *
 * Gated behind brain.autoCapture config. Never throws.
 * Auto-registers on module load.
 *
 * @task T166
 */

import { hooks } from '../registry.js';
import type { NotificationPayload } from '../types.js';
import { isAutoCaptureEnabled, isMissingBrainSchemaError } from './handler-helpers.js';

/**
 * Handle Notification — capture system notifications as BRAIN observations.
 *
 * Only fires for Notification payloads that carry a message field (i.e. system
 * notifications). File-change notifications (filePath + changeType) are
 * handled exclusively by file-hooks.ts and are skipped here to avoid
 * double-capture.
 *
 * Gated behind brain.autoCapture config. Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - Notification event payload.
 *
 * @task T166
 */
export async function handleSystemNotification(
  projectRoot: string,
  payload: NotificationPayload,
): Promise<void> {
  // File-change notifications are handled by file-hooks.ts
  if (payload.filePath || payload.changeType) return;
  // Only handle message-bearing system notifications
  if (!payload.message) return;
  if (!(await isAutoCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `System notification: ${payload.message}`,
      title: `Notification: ${payload.message.slice(0, 60)}`,
      type: 'discovery',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// Lower priority (90) so file-hooks.ts (100) runs first for Notification events
hooks.register({
  id: 'brain-system-notification',
  event: 'Notification',
  handler: handleSystemNotification,
  priority: 90,
});
