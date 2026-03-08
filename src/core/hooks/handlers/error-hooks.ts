/**
 * Error Hook Handlers - Wave 2 of T5237
 *
 * Captures operation errors to BRAIN via memory.observe.
 * Includes infinite-loop guard to prevent onError triggering onError.
 * Auto-registers on module load.
 */

import { hooks } from '../registry.js';
import type { OnErrorPayload } from '../types.js';

/**
 * Handle onError - capture operation errors to BRAIN
 *
 * Includes infinite-loop guard: if the payload has _fromHook marker,
 * the handler skips to prevent onError -> observeBrain -> onError loops.
 * Additionally, ALL observeBrain errors are silently suppressed to prevent
 * re-entrant hook firing.
 */
export async function handleError(projectRoot: string, payload: OnErrorPayload): Promise<void> {
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
  event: 'onError',
  handler: handleError,
  priority: 100,
});
