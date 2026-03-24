/**
 * Task Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture task lifecycle events to BRAIN via memory.observe.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh after task completion.
 */

import { hooks } from '../registry.js';
import type { PostToolUsePayload, PreToolUsePayload } from '../types.js';
import { maybeRefreshMemoryBridge } from './memory-bridge-refresh.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Handle PreToolUse (maps to task.start in CLEO, canonical: was onToolStart)
 */
export async function handleToolStart(
  projectRoot: string,
  payload: PreToolUsePayload,
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
 * Handle PostToolUse (maps to task.complete in CLEO, canonical: was onToolComplete)
 *
 * T138: Refresh memory bridge after task completion.
 */
export async function handleToolComplete(
  projectRoot: string,
  payload: PostToolUsePayload,
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

  // T138: Refresh memory bridge after task completes (best-effort)
  await maybeRefreshMemoryBridge(projectRoot);
}

// Register handlers
hooks.register({
  id: 'brain-tool-start',
  event: 'PreToolUse',
  handler: handleToolStart,
  priority: 100,
});

hooks.register({
  id: 'brain-tool-complete',
  event: 'PostToolUse',
  handler: handleToolComplete,
  priority: 100,
});
