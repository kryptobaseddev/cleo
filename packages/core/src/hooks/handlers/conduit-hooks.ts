/**
 * Conduit Messaging Hook Handlers
 *
 * Captures orchestration lifecycle events (SubagentStart, SubagentStop,
 * SessionEnd) and writes structured messages to conduit.db via LocalTransport.
 * This is the DECOUPLED approach: hooks observe orchestration events without
 * any changes to the orchestrate engine itself.
 *
 * Message format (JSON string stored as conduit message content):
 *   { type, from, to, content, taskId, timestamp }
 *
 * All handlers are best-effort — failures are silently swallowed so that
 * conduit writes NEVER crash or block agent orchestration.
 *
 * Auto-registers on module load.
 *
 * @task T268
 */

import { LocalTransport } from '../../conduit/local-transport.js';
import { getLogger } from '../../logger.js';
import { hooks } from '../registry.js';
import type { SessionEndPayload, SubagentStartPayload, SubagentStopPayload } from '../types.js';

/** Well-known system agent ID used as the "from" sender for lifecycle messages. */
const SYSTEM_AGENT_ID = 'cleo-orchestrator';

/** Well-known broadcast recipient for lifecycle events. */
const BROADCAST_RECIPIENT = 'cleo-system';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the content string for a SubagentStart conduit message.
 *
 * @param payload - SubagentStart event payload.
 * @returns JSON-serialised message content string.
 */
function buildSpawnMessageContent(payload: SubagentStartPayload): string {
  return JSON.stringify({
    type: 'subagent.spawn',
    from: SYSTEM_AGENT_ID,
    to: payload.agentId,
    content: `Subagent spawned: ${payload.agentId}${payload.role ? ` (${payload.role})` : ''}`,
    taskId: payload.taskId ?? null,
    timestamp: payload.timestamp,
  });
}

/**
 * Build the content string for a SubagentStop conduit message.
 *
 * @param payload - SubagentStop event payload.
 * @returns JSON-serialised message content string.
 */
function buildCompletionMessageContent(payload: SubagentStopPayload): string {
  return JSON.stringify({
    type: 'subagent.complete',
    from: payload.agentId,
    to: BROADCAST_RECIPIENT,
    content: `Subagent completed: ${payload.agentId} status=${payload.status ?? 'unknown'}${payload.taskId ? ` task=${payload.taskId}` : ''}`,
    taskId: payload.taskId ?? null,
    timestamp: payload.timestamp,
  });
}

/**
 * Build the content string for a SessionEnd handoff conduit message.
 *
 * @param payload  - SessionEnd event payload.
 * @param nextTask - Optional next suggested task ID from the session.
 * @returns JSON-serialised message content string.
 */
function buildHandoffMessageContent(payload: SessionEndPayload, nextTask?: string): string {
  return JSON.stringify({
    type: 'session.handoff',
    from: SYSTEM_AGENT_ID,
    to: BROADCAST_RECIPIENT,
    content: `Session ended: ${payload.sessionId}${nextTask ? ` \u2014 next task: ${nextTask}` : ''}`,
    taskId: nextTask ?? null,
    timestamp: payload.timestamp,
  });
}

/**
 * Attempt to create and connect a LocalTransport for conduit.db.
 *
 * Returns null when conduit.db is unavailable (not yet initialised), or when
 * the connect call fails, so callers can bail out gracefully without throwing.
 *
 * The `transportFactory` parameter exists for testing: callers can inject a
 * mock constructor so no real conduit.db is required in unit tests.
 *
 * @param projectRoot      - Absolute path to the project root directory.
 * @param transportFactory - Optional factory used to construct the transport.
 *                           Defaults to the `LocalTransport` class.
 */
export async function tryGetLocalTransport(
  projectRoot: string,
  transportFactory: typeof LocalTransport = LocalTransport,
): Promise<InstanceType<typeof LocalTransport> | null> {
  try {
    if (!transportFactory.isAvailable(projectRoot)) return null;

    const transport = new transportFactory();
    await transport.connect({
      agentId: SYSTEM_AGENT_ID,
      apiKey: '',
      apiBaseUrl: 'local',
    });
    return transport;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle SubagentStart — send a spawn message to conduit.db.
 *
 * Writes a `subagent.spawn` message from `cleo-orchestrator` to the
 * spawned agent ID so orchestrators and watchers can observe the event.
 *
 * Best-effort: failures are swallowed and logged at debug level.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - SubagentStart event payload.
 */
export async function handleConduitSubagentStart(
  projectRoot: string,
  payload: SubagentStartPayload,
): Promise<void> {
  const transport = await tryGetLocalTransport(projectRoot);
  if (!transport) return;

  try {
    const content = buildSpawnMessageContent(payload);
    await transport.push(payload.agentId, content);
  } catch (err) {
    getLogger('conduit-hooks').debug(
      { err, agentId: payload.agentId },
      'conduit spawn write failed',
    );
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // Disconnect errors are ignored
    }
  }
}

/**
 * Handle SubagentStop — send a completion message to conduit.db.
 *
 * Writes a `subagent.complete` message from the stopped agent to
 * `cleo-system` so orchestrators can audit completion outcomes.
 *
 * Best-effort: failures are swallowed and logged at debug level.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - SubagentStop event payload.
 */
export async function handleConduitSubagentStop(
  projectRoot: string,
  payload: SubagentStopPayload,
): Promise<void> {
  const transport = await tryGetLocalTransport(projectRoot);
  if (!transport) return;

  try {
    const content = buildCompletionMessageContent(payload);
    await transport.push(BROADCAST_RECIPIENT, content);
  } catch (err) {
    getLogger('conduit-hooks').debug(
      { err, agentId: payload.agentId },
      'conduit complete write failed',
    );
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // Disconnect errors are ignored
    }
  }
}

/**
 * Handle SessionEnd — send a handoff message if a next task is suggested.
 *
 * Writes a `session.handoff` message to `cleo-system` when the session
 * metadata includes a `nextTask` suggestion (stored in `metadata.nextTask`).
 * The message lets waiting agents pick up where the session left off.
 *
 * Best-effort: failures are swallowed and logged at debug level.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @param payload     - SessionEnd event payload.
 */
export async function handleConduitSessionEnd(
  projectRoot: string,
  payload: SessionEndPayload,
): Promise<void> {
  const transport = await tryGetLocalTransport(projectRoot);
  if (!transport) return;

  try {
    // Extract optional next-task hint from metadata
    const nextTask =
      typeof payload.metadata?.nextTask === 'string' ? payload.metadata.nextTask : undefined;

    const content = buildHandoffMessageContent(payload, nextTask);
    await transport.push(BROADCAST_RECIPIENT, content);
  } catch (err) {
    getLogger('conduit-hooks').debug(
      { err, sessionId: payload.sessionId },
      'conduit handoff write failed',
    );
  } finally {
    try {
      await transport.disconnect();
    } catch {
      // Disconnect errors are ignored
    }
  }
}

// ---------------------------------------------------------------------------
// Auto-registration
// ---------------------------------------------------------------------------

hooks.register({
  id: 'conduit-subagent-start',
  event: 'SubagentStart',
  handler: handleConduitSubagentStart,
  // Priority 50: runs after brain capture (100) but before low-priority bookkeeping
  priority: 50,
});

hooks.register({
  id: 'conduit-subagent-stop',
  event: 'SubagentStop',
  handler: handleConduitSubagentStop,
  priority: 50,
});

hooks.register({
  id: 'conduit-session-end',
  event: 'SessionEnd',
  handler: handleConduitSessionEnd,
  // Priority 8: runs after brain (100), backup (10), but before consolidation (5)
  priority: 8,
});
