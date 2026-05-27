/**
 * Error Hook Handlers - Wave 2 of T5237
 *
 * Captures operation errors to BRAIN via memory.observe.
 * Includes infinite-loop guard to prevent onError triggering onError.
 * Auto-registers on module load.
 */

import { hooks } from '../registry.js';
import type { PostToolUseFailurePayload } from '../types.js';

/**
 * Handle PostToolUseFailure — capture operation errors to BRAIN.
 *
 * Includes an infinite-loop guard: if the payload carries a `_fromHook`
 * metadata marker the handler skips immediately to prevent the cycle
 * `PostToolUseFailure → observeBrain → PostToolUseFailure`. All
 * `observeBrain` errors are also silently suppressed for the same reason.
 *
 * Never throws. All brain-write errors are swallowed so error hooks
 * never block the original error path.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - PostToolUseFailure event payload.
 *
 * @task T166
 * @epic T134
 */
export async function handleError(
  projectRoot: string,
  payload: PostToolUseFailurePayload,
): Promise<void> {
  // Infinite-loop guard: skip if this error originated from a hook
  if (payload.metadata?.['_fromHook']) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  const domainOp =
    payload.domain && payload.operation ? `${payload.domain}.${payload.operation}` : 'unknown';

  try {
    await observeBrain(projectRoot, {
      text: `Error in ${domainOp}: ${payload.message}\nCode: ${payload.errorCode}${payload.gateway ? `\nGateway: ${payload.gateway}` : ''}`,
      title: `Error: ${domainOp}`,
      type: 'discovery',
      sourceType: 'agent',
    });
  } catch (_err) {
    // Silently suppress all observeBrain errors in hook context
    // to prevent re-entrant hook firing
  }
}

// Register handler on module load
hooks.register({
  id: 'brain-error',
  event: 'PostToolUseFailure',
  handler: handleError,
  priority: 100,
});
