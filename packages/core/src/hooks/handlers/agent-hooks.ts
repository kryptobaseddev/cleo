/**
 * Agent (Subagent) Lifecycle Hook Handlers
 *
 * Captures SubagentStart and SubagentStop events to BRAIN so that
 * multi-agent orchestration runs leave an auditable trail of which
 * subagents were spawned, what tasks they were assigned, and how
 * they completed.
 *
 * Gated behind brain.autoCapture config. Never throws — all errors are
 * swallowed so that brain capture never blocks agent orchestration.
 *
 * Auto-registers on module load.
 *
 * @task T166
 * @epic T134
 */

import { hooks } from '../registry.js';
import type { SubagentStartPayload, SubagentStopPayload } from '../types.js';

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
 * Handle SubagentStart — log subagent spawn as a BRAIN observation.
 *
 * Records the agent ID, role, and task assignment so orchestrators can
 * trace which agents were active in a given session.
 *
 * Gated behind brain.autoCapture config. Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - SubagentStart event payload.
 *
 * @task T166
 * @epic T134
 */
export async function handleSubagentStart(
  projectRoot: string,
  payload: SubagentStartPayload,
): Promise<void> {
  if (!(await isAutoCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  const rolePart = payload.role ? ` role=${payload.role}` : '';
  const taskPart = payload.taskId ? ` task=${payload.taskId}` : '';

  try {
    await observeBrain(projectRoot, {
      text: `Subagent spawned: ${payload.agentId}${rolePart}${taskPart}`,
      title: `Subagent start: ${payload.agentId}`,
      type: 'discovery',
      sourceSessionId: payload.sessionId,
      sourceType: 'agent',
    });
  } catch (err) {
    if (!isMissingBrainSchemaError(err)) throw err;
  }
}

/**
 * Handle SubagentStop — log subagent completion result as a BRAIN observation.
 *
 * Records the agent ID, completion status, assigned task, and optional
 * summary reference so orchestrators can audit subagent outcomes.
 *
 * Gated behind brain.autoCapture config. Never throws.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - SubagentStop event payload.
 *
 * @task T166
 * @epic T134
 */
export async function handleSubagentStop(
  projectRoot: string,
  payload: SubagentStopPayload,
): Promise<void> {
  if (!(await isAutoCaptureEnabled(projectRoot))) return;

  const { observeBrain } = await import('../../memory/brain-retrieval.js');

  const statusPart = payload.status ? ` status=${payload.status}` : '';
  const taskPart = payload.taskId ? ` task=${payload.taskId}` : '';
  const summaryPart = payload.summary ? `\nSummary: ${payload.summary}` : '';

  try {
    await observeBrain(projectRoot, {
      text: `Subagent completed: ${payload.agentId}${statusPart}${taskPart}${summaryPart}`,
      title: `Subagent stop: ${payload.agentId}`,
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
  id: 'brain-subagent-start',
  event: 'SubagentStart',
  handler: handleSubagentStart,
  priority: 100,
});

hooks.register({
  id: 'brain-subagent-stop',
  event: 'SubagentStop',
  handler: handleSubagentStop,
  priority: 100,
});
