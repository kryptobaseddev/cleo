/**
 * Context Compaction Hook Handlers
 *
 * Captures PreCompact and PostCompact events to BRAIN so that agents
 * can later observe when context compactions occurred and what state
 * preceded them. This is especially useful for long sessions where
 * context is compacted multiple times.
 *
 * PreCompact saves a session context snapshot before compaction begins.
 * PostCompact records that compaction occurred and the resulting token counts.
 *
 * Gated behind brain.autoCapture config. Never throws — all errors are
 * swallowed so brain capture never blocks context compaction.
 *
 * Auto-registers on module load.
 *
 * @task T166
 * @epic T134
 */

import { hooks } from '../registry.js';
import type { PostCompactPayload, PreCompactPayload } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isMissingBrainSchemaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = String(err.message || '').toLowerCase();
  return message.includes('no such table') && message.includes('brain_');
}

/**
 * Check whether brain auto-capture is enabled.
 *
 * Resolution order (first truthy wins):
 *   1. brain.autoCapture project config value (via loadConfig cascade)
 *
 * Defaults to false when config is unreadable.
 *
 * @param projectRoot - Absolute path to the project root directory.
 */
async function isAutoCaptureEnabled(projectRoot: string): Promise<boolean> {
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    return config.brain?.autoCapture ?? false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle PreCompact — snapshot current session memory context to BRAIN.
 *
 * Fires immediately before context compaction begins. Records the token
 * count and compaction reason so the brain retains context about what
 * was in scope before compaction.
 *
 * Gated behind brain.autoCapture config. Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - PreCompact event payload.
 *
 * @task T166
 * @epic T134
 */
export async function handlePreCompact(
  projectRoot: string,
  payload: PreCompactPayload,
): Promise<void> {
  if (!(await isAutoCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  const tokensPart =
    payload.tokensBefore != null ? ` (~${payload.tokensBefore.toLocaleString()} tokens)` : '';
  const reasonPart = payload.reason ? ` Reason: ${payload.reason}` : '';

  try {
    await observeBrain(projectRoot, {
      text: `Context compaction about to begin${tokensPart}.${reasonPart}`,
      title: 'Pre-compaction context snapshot',
      type: 'discovery',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle PostCompact — record compaction completion to BRAIN.
 *
 * Fires immediately after context compaction completes. Records the
 * before/after token counts so agents can correlate observations made
 * before compaction with those made after.
 *
 * Gated behind brain.autoCapture config. Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - PostCompact event payload.
 *
 * @task T166
 * @epic T134
 */
export async function handlePostCompact(
  projectRoot: string,
  payload: PostCompactPayload,
): Promise<void> {
  if (!(await isAutoCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  const statusPart = payload.success ? 'succeeded' : 'failed';
  const beforePart =
    payload.tokensBefore != null ? ` before=${payload.tokensBefore.toLocaleString()}` : '';
  const afterPart =
    payload.tokensAfter != null ? ` after=${payload.tokensAfter.toLocaleString()}` : '';

  try {
    await observeBrain(projectRoot, {
      text: `Context compaction ${statusPart}${beforePart}${afterPart}`,
      title: 'Post-compaction record',
      type: 'change',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

hooks.register({
  id: 'brain-pre-compact',
  event: 'PreCompact',
  handler: handlePreCompact,
  priority: 100,
});

hooks.register({
  id: 'brain-post-compact',
  event: 'PostCompact',
  handler: handlePostCompact,
  priority: 100,
});
