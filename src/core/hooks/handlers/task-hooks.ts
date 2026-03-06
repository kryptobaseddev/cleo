/**
 * Task Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture task lifecycle events to BRAIN via memory.observe.
 * Auto-registers on module load.
 */

import { hooks } from '../registry.js';
import type { OnToolStartPayload, OnToolCompletePayload } from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Handle onToolStart (maps to task.start in CLEO)
 */
export async function handleToolStart(
  projectRoot: string,
  payload: OnToolStartPayload
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Started work on ${payload.taskId}: ${payload.taskTitle}`,
      title: `Task start: ${payload.taskId}`,
      type: 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle onToolComplete (maps to task.complete in CLEO)
 */
export async function handleToolComplete(
  projectRoot: string,
  payload: OnToolCompletePayload
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Task ${payload.taskId} completed with status: ${payload.status}`,
      title: `Task complete: ${payload.taskId}`,
      type: 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// Register handlers
hooks.register({
  id: 'brain-tool-start',
  event: 'onToolStart',
  handler: handleToolStart,
  priority: 100,
});

hooks.register({
  id: 'brain-tool-complete',
  event: 'onToolComplete',
  handler: handleToolComplete,
  priority: 100,
});
