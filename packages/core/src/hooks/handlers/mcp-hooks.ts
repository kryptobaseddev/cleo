/**
 * MCP Prompt/Response Hook Handlers - Wave 2 of T5237
 *
 * Handlers for onPromptSubmit, onResponseComplete, and system Notification
 * events that capture ALL gateway operations (read and write) to BRAIN.
 * By default, NO brain capture (too noisy). Enable via:
 *   - Config: brain.captureMcp = true  (checked first)
 *   - Env:    CLEO_BRAIN_CAPTURE_MCP=true  (overrides config)
 * Auto-registers on module load.
 *
 * Note: File-change Notification events (those with filePath + changeType) are
 * handled by file-hooks.ts. This module handles message-bearing system
 * notifications (Notification payloads with a message field).
 *
 * @task T166
 */

import { hooks } from '../registry.js';
import type {
  NotificationPayload,
  PromptSubmitPayload,
  ResponseCompletePayload,
} from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Check whether MCP-level brain capture is enabled.
 *
 * Resolution order (first truthy wins):
 *   1. CLEO_BRAIN_CAPTURE_MCP env var (explicit override)
 *   2. brain.captureMcp project config value
 *
 * Defaults to false when neither is set (too noisy for normal operation).
 */
async function isBrainCaptureEnabled(projectRoot: string): Promise<boolean> {
  const envOverride = process.env['CLEO_BRAIN_CAPTURE_MCP'];
  if (envOverride !== undefined) {
    return envOverride === 'true';
  }
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.captureMcp ?? false;
  } catch {
    return false;
  }
}

/**
 * Handle PromptSubmit - optionally capture ALL gateway prompt events to BRAIN.
 *
 * No-op by default. Enable via brain.captureMcp config or CLEO_BRAIN_CAPTURE_MCP env.
 * For selective mutation-only capture, use work-capture-hooks.ts instead.
 */
export async function handlePromptSubmit(
  projectRoot: string,
  payload: PromptSubmitPayload,
): Promise<void> {
  if (!(await isBrainCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Prompt submitted: ${payload.gateway}:${payload.domain}.${payload.operation}${payload.source ? ` from ${payload.source}` : ''}`,
      title: `Prompt: ${payload.domain}.${payload.operation}`,
      type: 'discovery',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle ResponseComplete - optionally capture ALL gateway response events to BRAIN.
 *
 * No-op by default. Enable via brain.captureMcp config or CLEO_BRAIN_CAPTURE_MCP env.
 * For selective mutation-only capture, use work-capture-hooks.ts instead.
 */
export async function handleResponseComplete(
  projectRoot: string,
  payload: ResponseCompletePayload,
): Promise<void> {
  if (!(await isBrainCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Response ${payload.success ? 'success' : 'failed'}: ${payload.gateway}:${payload.domain}.${payload.operation}${payload.durationMs != null ? ` (${payload.durationMs}ms)` : ''}${payload.errorCode ? ` error: ${payload.errorCode}` : ''}`,
      title: `Response: ${payload.domain}.${payload.operation}`,
      type: payload.success ? 'discovery' : 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

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

  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    if (!config.brain?.autoCapture) return;
  } catch {
    return;
  }

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

// Register handlers on module load
hooks.register({
  id: 'brain-prompt-submit',
  event: 'PromptSubmit',
  handler: handlePromptSubmit,
  priority: 100,
});

hooks.register({
  id: 'brain-response-complete',
  event: 'ResponseComplete',
  handler: handleResponseComplete,
  priority: 100,
});

// Lower priority (90) so file-hooks.ts (100) runs first for Notification events
hooks.register({
  id: 'brain-system-notification',
  event: 'Notification',
  handler: handleSystemNotification,
  priority: 90,
});
