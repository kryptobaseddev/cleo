/**
 * Task Hook Handlers - Phase 2D of T5237
 *
 * Task lifecycle integration without content-free BRAIN observations.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh after task completion.
 * Useful learnings are supplied explicitly by the calling agent.
 */

import { hooks } from '../registry.js';
import type { PostToolUsePayload, PreToolUsePayload } from '../types.js';
import { maybeRefreshMemoryBridge } from './memory-bridge-refresh.js';

/**
 * Handle PreToolUse (maps to task.start in CLEO, canonical: was onToolStart)
 */
export async function handleToolStart(
  _projectRoot: string,
  _payload: PreToolUsePayload,
): Promise<void> {
  // Task lifecycle belongs in task/audit records; it is not a useful memory observation.
}

/**
 * Handle PostToolUse (maps to task.complete in CLEO, canonical: was onToolComplete)
 *
 * T138: Refresh memory bridge after task completion.
 * No background LLM is required for task completion.
 */
export async function handleToolComplete(
  projectRoot: string,
  _payload: PostToolUsePayload,
): Promise<void> {
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
