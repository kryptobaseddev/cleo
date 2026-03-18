/**
 * MCP Prompt/Response Hook Handlers - Wave 2 of T5237
 *
 * Handlers for onPromptSubmit and onResponseComplete events.
 * By default, NO brain capture (too noisy). Brain observation is
 * opt-in via CLEO_BRAIN_CAPTURE_MCP=true environment variable.
 * Auto-registers on module load.
 */

import { hooks } from '../registry.js';
import type { OnPromptSubmitPayload, OnResponseCompletePayload } from '../types.js';

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Check if brain capture is enabled for MCP events.
 * Defaults to false (too noisy for normal operation).
 */
function isBrainCaptureEnabled(): boolean {
  return process.env['CLEO_BRAIN_CAPTURE_MCP'] === 'true';
}

/**
 * Handle onPromptSubmit - optionally capture prompt events to BRAIN
 *
 * No-op by default. Set CLEO_BRAIN_CAPTURE_MCP=true to enable.
 */
export async function handlePromptSubmit(
  projectRoot: string,
  payload: OnPromptSubmitPayload,
): Promise<void> {
  if (!isBrainCaptureEnabled()) return;

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
 * Handle onResponseComplete - optionally capture response events to BRAIN
 *
 * No-op by default. Set CLEO_BRAIN_CAPTURE_MCP=true to enable.
 */
export async function handleResponseComplete(
  projectRoot: string,
  payload: OnResponseCompletePayload,
): Promise<void> {
  if (!isBrainCaptureEnabled()) return;

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

// Register handlers on module load
hooks.register({
  id: 'brain-prompt-submit',
  event: 'onPromptSubmit',
  handler: handlePromptSubmit,
  priority: 100,
});

hooks.register({
  id: 'brain-response-complete',
  event: 'onResponseComplete',
  handler: handleResponseComplete,
  priority: 100,
});
