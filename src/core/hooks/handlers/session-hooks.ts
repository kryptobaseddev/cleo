/**
 * Session Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture session lifecycle events to BRAIN via memory.observe.
 * Auto-registers on module load.
 */

import { hooks } from '../registry.js';
import type { OnSessionEndPayload, OnSessionStartPayload } from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Handle onSessionStart - capture initial session context
 */
export async function handleSessionStart(
  projectRoot: string,
  payload: OnSessionStartPayload,
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Session started: ${payload.name}\nScope: ${JSON.stringify(payload.scope)}\nAgent: ${payload.agent || 'unknown'}`,
      title: `Session start: ${payload.name}`,
      type: 'discovery',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle onSessionEnd - capture session summary
 */
export async function handleSessionEnd(
  projectRoot: string,
  payload: OnSessionEndPayload,
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Session ended: ${payload.sessionId}\nDuration: ${payload.duration}s\nTasks completed: ${payload.tasksCompleted.join(', ') || 'none'}`,
      title: `Session end: ${payload.sessionId}`,
      type: 'change',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// Register handlers on module load
hooks.register({
  id: 'brain-session-start',
  event: 'onSessionStart',
  handler: handleSessionStart,
  priority: 100,
});

hooks.register({
  id: 'brain-session-end',
  event: 'onSessionEnd',
  handler: handleSessionEnd,
  priority: 100,
});
