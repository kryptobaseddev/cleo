/**
 * Active-Work Capture Hook Handlers
 *
 * Captures dispatch mutation events to BRAIN during active work, closing
 * the gap between lifecycle-only capture (session end, task complete) and
 * continuous capture. Only WRITE operations that represent meaningful work
 * are captured — reads and operations already handled by lifecycle hooks
 * are skipped to avoid flooding brain.db.
 *
 * Disabled by default. Enable via:
 *   - Config: brain.captureWork = true  (checked first)
 *   - Env:    CLEO_BRAIN_CAPTURE_WORK=true  (overrides config)
 *
 * Auto-registers on module load.
 *
 * @task T142
 */

import { hooks } from '../registry.js';
import type { PromptSubmitPayload, ResponseCompletePayload } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Check whether active-work capture is enabled.
 *
 * Resolution order (first truthy wins):
 *   1. CLEO_BRAIN_CAPTURE_WORK env var (explicit override)
 *   2. brain.captureWork project config value
 *
 * Defaults to false when neither is set.
 */
async function isWorkCaptureEnabled(projectRoot: string): Promise<boolean> {
  const envOverride = process.env['CLEO_BRAIN_CAPTURE_WORK'];
  if (envOverride !== undefined) {
    return envOverride === 'true';
  }
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.captureWork ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Smart-filter: which mutations to capture
// ---------------------------------------------------------------------------

/**
 * Mutations that represent novel work not already captured by lifecycle hooks.
 *
 * Excluded (already captured elsewhere):
 *   - tasks.complete  → task-hooks.ts (PostToolUse)
 *   - session.start   → session-hooks.ts (SessionStart)
 *   - session.end     → session-hooks.ts (SessionEnd)
 *   - memory.brain.observe → observeBrain itself writes to brain; self-loop
 *
 * All query gateway operations are excluded by the gateway check before
 * this set is consulted.
 */
const CAPTURE_OPERATIONS = new Set<string>([
  'tasks.add',
  'tasks.update',
  'tasks.move',
  'tasks.link',
  'tasks.unlink',
  'tasks.label',
  'tasks.unlabel',
  'tasks.note',
]);

/**
 * Determine whether a mutate operation should be captured.
 *
 * Only `mutate` gateway operations in CAPTURE_OPERATIONS are captured.
 * All `query` gateway calls are skipped (reads produce no novel work).
 *
 * @param gateway - 'query' or 'mutate'
 * @param domain  - e.g. 'tasks'
 * @param operation - e.g. 'add'
 */
function shouldCapture(gateway: string, domain: string, operation: string): boolean {
  if (gateway !== 'mutate') return false;
  const key = `${domain}.${operation}`;
  return CAPTURE_OPERATIONS.has(key);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle PromptSubmit — log incoming mutation intents to BRAIN.
 *
 * Only fires for mutate operations in CAPTURE_OPERATIONS.
 * Gated behind brain.captureWork config (or CLEO_BRAIN_CAPTURE_WORK env).
 *
 * @param projectRoot - Absolute path to the project root
 * @param payload     - PromptSubmit event payload
 */
export async function handleWorkPromptSubmit(
  projectRoot: string,
  payload: PromptSubmitPayload,
): Promise<void> {
  if (!shouldCapture(payload.gateway, payload.domain, payload.operation)) return;
  if (!(await isWorkCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Dispatch intent: ${payload.gateway}:${payload.domain}.${payload.operation}${payload.source ? ` (from ${payload.source})` : ''}`,
      title: `Work intent: ${payload.domain}.${payload.operation}`,
      type: 'discovery',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle ResponseComplete — capture completed mutations to BRAIN.
 *
 * Only fires for successful mutate operations in CAPTURE_OPERATIONS.
 * Failures are skipped — the intent was already captured by handleWorkPromptSubmit.
 * Gated behind brain.captureWork config (or CLEO_BRAIN_CAPTURE_WORK env).
 *
 * @param projectRoot - Absolute path to the project root
 * @param payload     - ResponseComplete event payload
 */
export async function handleWorkResponseComplete(
  projectRoot: string,
  payload: ResponseCompletePayload,
): Promise<void> {
  if (!shouldCapture(payload.gateway, payload.domain, payload.operation)) return;
  // Only capture successful completions — failures are noise
  if (!payload.success) return;
  if (!(await isWorkCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    const durationNote = payload.durationMs != null ? ` (${payload.durationMs}ms)` : '';
    await observeBrain(projectRoot, {
      text: `Dispatch complete: ${payload.gateway}:${payload.domain}.${payload.operation}${durationNote}`,
      title: `Work done: ${payload.domain}.${payload.operation}`,
      type: 'change',
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

// Register at lower priority (90) than lifecycle hooks (100) so lifecycle
// handlers always run first.
hooks.register({
  id: 'work-capture-prompt-submit',
  event: 'PromptSubmit',
  handler: handleWorkPromptSubmit,
  priority: 90,
});

hooks.register({
  id: 'work-capture-response-complete',
  event: 'ResponseComplete',
  handler: handleWorkResponseComplete,
  priority: 90,
});
