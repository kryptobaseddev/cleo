/**
 * Session Hook Handlers - Phase 2D of T5237
 *
 * Handlers that capture session lifecycle events to BRAIN via memory.observe.
 * Auto-registers on module load.
 *
 * T138: Triggers memory bridge refresh on session start and end.
 * T139: Regenerates bridge with session scope on start.
 * T144: Extracts transcript observations on session end.
 */

import { hooks } from '../registry.js';
import type { SessionEndPayload, SessionStartPayload } from '../types.js';
import { isMissingBrainSchemaError } from './handler-helpers.js';
import { maybeRefreshMemoryBridge } from './memory-bridge-refresh.js';

/**
 * Handle SessionStart - capture initial session context
 *
 * T138: Refresh memory bridge on session start.
 * T139: Regenerate bridge with session scope context.
 */
export async function handleSessionStart(
  projectRoot: string,
  payload: SessionStartPayload,
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Session started: ${payload.name}\nScope: ${JSON.stringify(payload.scope)}\nAgent: ${payload.agent || 'unknown'}`,
      title: `Session start: ${payload.name}`,
      type: 'discovery',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }

  // T138/T139: Refresh memory bridge after session starts (best-effort)
  await maybeRefreshMemoryBridge(projectRoot);
}

/**
 * Handle SessionEnd - capture session summary
 *
 * T138: Refresh memory bridge after session ends.
 * T144: Extract transcript observations via cross-provider adapter.
 */
export async function handleSessionEnd(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  try {
    await observeBrain(projectRoot, {
      text: `Session ended: ${payload.sessionId}\nDuration: ${payload.duration}s\nTasks completed: ${payload.tasksCompleted.join(', ') || 'none'}`,
      title: `Session end: ${payload.sessionId}`,
      type: 'change',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }

  // Auto-grade session and feed insights to brain.db (best-effort)
  try {
    const { gradeSession } = await import('../../sessions/session-grade.js');
    await gradeSession(payload.sessionId, projectRoot);
  } catch {
    // Grading must never block session end
  }

  // T144: Cross-provider transcript extraction (best-effort)
  try {
    const { loadConfig } = await import('../../config.js');
    const config = await loadConfig(projectRoot);
    if (config.brain?.autoCapture) {
      const { AdapterManager } = await import('../../adapters/index.js');
      const manager = AdapterManager.getInstance(projectRoot);
      const activeAdapter = manager.getActive();
      const hookProvider = activeAdapter?.hooks;
      if (hookProvider && typeof hookProvider.getTranscript === 'function') {
        const transcript = await hookProvider.getTranscript(payload.sessionId, projectRoot);
        if (transcript) {
          const { extractFromTranscript } = await import('../../memory/auto-extract.js');
          await extractFromTranscript(projectRoot, payload.sessionId, transcript);
        }
      }
    }
  } catch {
    // Graceful no-op: transcript extraction must never block session end
  }

  // T138: Refresh memory bridge after session ends (best-effort)
  await maybeRefreshMemoryBridge(projectRoot);
}

// Register handlers on module load
hooks.register({
  id: 'brain-session-start',
  event: 'SessionStart',
  handler: handleSessionStart,
  priority: 100,
});

hooks.register({
  id: 'brain-session-end',
  event: 'SessionEnd',
  handler: handleSessionEnd,
  priority: 100,
});
