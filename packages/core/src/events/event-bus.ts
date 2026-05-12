/**
 * CLEO Observability — Vendor-Agnostic Agent Event Bus (ADR-071 / T1651).
 *
 * Provides `appendEvent` — a zero-dependency SDK operation that emits
 * structured lifecycle events from autonomous workers. Two transports:
 *
 * - **Conduit** (default, `CLEO_EVENTS_TRANSPORT=conduit`):
 *   Publishes to the `agent.events.<agentId>` topic via LocalTransport
 *   (SQLite) or HttpTransport (cloud), enabling live streaming and
 *   distributed orchestration.
 *
 * - **File** (`CLEO_EVENTS_TRANSPORT=file`):
 *   Appends NDJSON lines to `.cleo/agent-events/<agentId>.jsonl`.
 *   Zero-infra fallback for bare harnesses that cannot initialize Conduit.
 *
 * When Conduit init fails, the function automatically falls back to the
 * file transport and logs a `[events] WARN` line (silent degradation).
 *
 * ## Event Schema
 *
 * All events conform to {@link CleoAgentEvent}. Stable `kind` values:
 * `spawn`, `heartbeat`, `tool-start`, `tool-end`, `commit`, `blocked`, `complete`.
 *
 * @see ADR-071
 * @task T1135
 * @task T1651
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Event schema
// ---------------------------------------------------------------------------

/**
 * Stable event kinds for the CLEO agent observability bus.
 *
 * - `spawn`      — worker has started and loaded its task context.
 * - `heartbeat`  — periodic ping (every N seconds or on phase transition).
 * - `tool-start` — a tool call is about to be executed.
 * - `tool-end`   — a tool call returned (includes exit code / result size).
 * - `commit`     — worker committed code to its branch.
 * - `blocked`    — worker is waiting on a dependency or HITL approval.
 * - `complete`   — worker finished; manifest appended.
 *
 * @task T1651
 */
export type CleoAgentEventKind =
  | 'spawn'
  | 'heartbeat'
  | 'tool-start'
  | 'tool-end'
  | 'commit'
  | 'blocked'
  | 'complete';

/**
 * Stable envelope for all agent lifecycle events (ADR-071).
 *
 * `payload` is kind-specific but always serializable to JSON. Workers MUST
 * NOT include secrets or PII in `payload`.
 */
export interface CleoAgentEvent {
  /** Discriminated union for the event type. */
  kind: CleoAgentEventKind;
  /** Task the worker is executing. */
  taskId: string;
  /** Agent identity string (e.g. `cleo-worker-T1234`). */
  agentId: string;
  /** ISO-8601 timestamp of the event. */
  timestamp: string;
  /** Optional kind-specific structured payload. */
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------

/** Transport mode for agent event emission. */
export type EventTransportMode = 'conduit' | 'file';

/**
 * Resolve the active transport mode.
 *
 * Priority:
 * 1. `CLEO_EVENTS_TRANSPORT` environment variable (`conduit` | `file`).
 * 2. Default: `conduit`.
 */
export function resolveEventTransportMode(): EventTransportMode {
  const env = process.env['CLEO_EVENTS_TRANSPORT'];
  if (env === 'file') return 'file';
  return 'conduit';
}

// ---------------------------------------------------------------------------
// File transport (fallback / bare-harness path)
// ---------------------------------------------------------------------------

/**
 * Append a `CleoAgentEvent` as an NDJSON line to the agent's event log.
 *
 * Log path: `<projectRoot>/.cleo/agent-events/<agentId>.jsonl`.
 * The directory is created if absent (best-effort; failure is swallowed).
 */
async function appendEventToFile(event: CleoAgentEvent, projectRoot: string): Promise<void> {
  const dir = join(projectRoot, '.cleo', 'agent-events');
  try {
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await appendFile(join(dir, `${event.agentId}.jsonl`), line, 'utf-8');
  } catch {
    // File transport is best-effort — never throw from observability code.
  }
}

// ---------------------------------------------------------------------------
// Conduit transport
// ---------------------------------------------------------------------------

/**
 * Publish a `CleoAgentEvent` to the `agent.events.<agentId>` Conduit topic.
 *
 * Uses LocalTransport directly (SQLite-backed conduit.db) to avoid the
 * AgentRegistryAPI dependency. If LocalTransport is unavailable (no
 * conduit.db in project root), returns false so the caller falls back to
 * file transport.
 *
 * Returns `true` on success, `false` if Conduit is unavailable.
 */
async function appendEventToConduit(event: CleoAgentEvent, _projectRoot: string): Promise<boolean> {
  try {
    const { LocalTransport } = await import('../conduit/local-transport.js');
    if (!LocalTransport.isAvailable()) return false;
    const transport = new LocalTransport();
    const topic = `agent.events.${event.agentId}`;
    await transport.connect({ agentId: event.agentId, apiKey: '', apiBaseUrl: '' });
    await transport.publishToTopic(topic, JSON.stringify(event), { kind: 'notify' });
    await transport.disconnect();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Append a structured lifecycle event from an autonomous worker.
 *
 * Transport is selected by {@link resolveEventTransportMode}:
 * - `conduit` (default): publishes to `agent.events.<agentId>` topic.
 * - `file`: appends to `.cleo/agent-events/<agentId>.jsonl`.
 *
 * Conduit failures silently fall back to file transport and log a warning.
 * All failures are swallowed — observability code MUST NOT crash a worker.
 *
 * @param kind        - Event kind (see {@link CleoAgentEventKind}).
 * @param taskId      - Task the worker is executing.
 * @param agentId     - Agent identity string.
 * @param projectRoot - Absolute path to the project root.
 * @param payload     - Optional kind-specific structured payload.
 *
 * @example
 * ```typescript
 * await appendEvent('heartbeat', 'T1234', 'cleo-worker-T1234', '/mnt/projects/foo');
 * await appendEvent('tool-start', 'T1234', 'cleo-worker-T1234', '/mnt/projects/foo', { tool: 'Bash' });
 * ```
 *
 * @task T1651
 */
export async function appendEvent(
  kind: CleoAgentEventKind,
  taskId: string,
  agentId: string,
  projectRoot: string,
  payload?: Record<string, unknown>,
): Promise<void> {
  const event: CleoAgentEvent = {
    kind,
    taskId,
    agentId,
    timestamp: new Date().toISOString(),
    payload,
  };

  const mode = resolveEventTransportMode();

  if (mode === 'file') {
    await appendEventToFile(event, projectRoot);
    return;
  }

  // Conduit-first with file fallback.
  const ok = await appendEventToConduit(event, projectRoot);
  if (!ok) {
    process.stderr.write(
      `[events] WARN: Conduit unavailable — falling back to file transport for ${event.kind} (${taskId})\n`,
    );
    await appendEventToFile(event, projectRoot);
  }
}
