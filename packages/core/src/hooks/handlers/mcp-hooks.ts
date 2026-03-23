/**
 * MCP Prompt/Response Hook Handlers - Wave 2 of T5237
 *
 * Handlers for onPromptSubmit and onResponseComplete events that capture
 * ALL gateway operations (read and write) to BRAIN.
 * By default, NO brain capture (too noisy). Enable via:
 *   - Config: brain.captureMcp = true  (checked first)
 *   - Env:    CLEO_BRAIN_CAPTURE_MCP=true  (overrides config)
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
 * Handle onPromptSubmit - optionally capture ALL gateway prompt events to BRAIN.
 *
 * No-op by default. Enable via brain.captureMcp config or CLEO_BRAIN_CAPTURE_MCP env.
 * For selective mutation-only capture, use work-capture-hooks.ts instead.
 */
export async function handlePromptSubmit(
  projectRoot: string,
  payload: OnPromptSubmitPayload,
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
 * Handle onResponseComplete - optionally capture ALL gateway response events to BRAIN.
 *
 * No-op by default. Enable via brain.captureMcp config or CLEO_BRAIN_CAPTURE_MCP env.
 * For selective mutation-only capture, use work-capture-hooks.ts instead.
 */
export async function handleResponseComplete(
  projectRoot: string,
  payload: OnResponseCompletePayload,
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
