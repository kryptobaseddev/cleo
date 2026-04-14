/**
 * Task Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture task lifecycle events to BRAIN via memory.observe.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh after task completion.
 * T554: Triggers LLM observer after task completion when observation count ≥ threshold.
 */

import { hooks } from '../registry.js';
import type { PostToolUsePayload, PreToolUsePayload } from '../types.js';
import { isMissingBrainSchemaError } from './handler-helpers.js';
import { maybeRefreshMemoryBridge } from './memory-bridge-refresh.js';

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
 * T554: Fire-and-forget LLM observer when observation count ≥ threshold.
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

  // T554: Fire-and-forget observer — runs after observation is stored so the
  // new observation is included in the count. setImmediate ensures the task
  // complete response reaches the caller before the LLM call begins.
  setImmediate(async () => {
    try {
      const { runObserver } = await import('../../memory/observer-reflector.js');
      await runObserver(projectRoot);
    } catch {
      // Observer errors must never surface to the task complete flow
    }
  });

  // T555: Correlate retrieval outcomes against this task completion.
  // Fire-and-forget: quality score adjustments must never block the response.
  setImmediate(async () => {
    try {
      const { correlateOutcomes } = await import('../../memory/quality-feedback.js');
      await correlateOutcomes(projectRoot);
    } catch {
      // Quality correlation errors must never surface to the task complete flow
    }
  });

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
