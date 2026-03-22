/**
 * Agent Health Monitoring -- Heartbeat and crash detection for live agent instances.
 *
 * Provides the public-facing health API specified by T039:
 *   - `recordHeartbeat`    — update last_heartbeat for a live agent
 *   - `checkAgentHealth`   — check health of a specific agent by ID
 *   - `detectStaleAgents`  — find agents whose heartbeat is older than threshold
 *   - `detectCrashedAgents` — find active agents with no heartbeat for >3 min
 *
 * These functions delegate to the lower-level `registry.ts` primitives
 * (`heartbeat`, `checkAgentHealth`, `listAgentInstances`) and add the
 * named, task-spec-aligned surface required for T039.
 *
 * @module agents/health-monitor
 * @task T039
 * @epic T038
 */

import type { AgentInstanceRow, AgentInstanceStatus } from './agent-schema.js';
import { heartbeat, listAgentInstances, markCrashed } from './registry.js';

// ============================================================================
// Constants
// ============================================================================

/** Default heartbeat interval (30 seconds) per BRAIN spec. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Default staleness threshold: 3 minutes without a heartbeat. */
export const STALE_THRESHOLD_MS = 3 * 60_000;

/** Statuses considered "alive" for health-check purposes. */
const ALIVE_STATUSES: AgentInstanceStatus[] = ['starting', 'active', 'idle'];

// ============================================================================
// Types
// ============================================================================

/**
 * Health status of a specific agent instance.
 */
export interface AgentHealthStatus {
  /** Agent instance ID. */
  agentId: string;
  /** Current DB status. */
  status: AgentInstanceStatus;
  /** ISO timestamp of the last recorded heartbeat. */
  lastHeartbeat: string;
  /** Milliseconds since the last heartbeat (at call time). */
  heartbeatAgeMs: number;
  /** Whether the agent is considered healthy (heartbeat within threshold). */
  healthy: boolean;
  /** Whether the agent is considered stale (heartbeat older than threshold). */
  stale: boolean;
  /** Threshold used for staleness determination (ms). */
  thresholdMs: number;
}

// ============================================================================
// recordHeartbeat
// ============================================================================

/**
 * Record a heartbeat for an agent instance.
 *
 * Updates `last_heartbeat` to the current time and returns the agent's
 * current {@link AgentInstanceStatus}. Returns `null` if the agent does not
 * exist or is already in a terminal state (`stopped` / `crashed`).
 *
 * This is the primary mechanism by which long-running agents signal liveness.
 * Call this every {@link HEARTBEAT_INTERVAL_MS} (30 s) from the agent loop.
 *
 * @param agentId - The agent instance ID (e.g. `agt_20260322120000_a1b2c3`)
 * @param cwd - Working directory used to resolve the tasks.db path (optional)
 * @returns The agent's current status, or `null` if not found / terminal
 *
 * @remarks
 * Terminal agents (`stopped`, `crashed`) will NOT have their heartbeat
 * updated — the existing status is returned as-is so callers can detect
 * external shutdown signals.
 *
 * @example
 * ```ts
 * // Inside the agent's main loop:
 * const heartbeatTimer = setInterval(async () => {
 *   const status = await recordHeartbeat(agentId);
 *   if (status === 'stopped' || status === null) {
 *     // Orchestrator shut us down — exit cleanly
 *     clearInterval(heartbeatTimer);
 *     process.exit(0);
 *   }
 * }, HEARTBEAT_INTERVAL_MS);
 * ```
 */
export async function recordHeartbeat(
  agentId: string,
  cwd?: string,
): Promise<AgentInstanceStatus | null> {
  return heartbeat(agentId, cwd);
}

// ============================================================================
// checkAgentHealth
// ============================================================================

/**
 * Check the health of a specific agent instance by ID.
 *
 * Queries the agent's current record and returns a structured
 * {@link AgentHealthStatus} describing staleness, heartbeat age, and
 * whether the agent is considered healthy relative to `thresholdMs`.
 *
 * Returns `null` if the agent ID is not found in the database.
 *
 * @param agentId - The agent instance ID to check
 * @param thresholdMs - Staleness threshold in milliseconds (default: 3 minutes)
 * @param cwd - Working directory used to resolve the tasks.db path (optional)
 * @returns {@link AgentHealthStatus} or `null` if the agent does not exist
 *
 * @remarks
 * Returns null if the agent is not found. A non-null result includes
 * staleness status based on the threshold comparison.
 *
 * @example
 * ```ts
 * const health = await checkAgentHealth('agt_20260322120000_a1b2c3');
 * if (health && health.stale) {
 *   console.log(`Agent stale for ${health.heartbeatAgeMs}ms — presumed crashed`);
 * }
 * ```
 */
export async function checkAgentHealth(
  agentId: string,
  thresholdMs: number = STALE_THRESHOLD_MS,
  cwd?: string,
): Promise<AgentHealthStatus | null> {
  const all = await listAgentInstances(undefined, cwd);
  const agent = all.find((a) => a.id === agentId);
  if (!agent) return null;

  return buildHealthStatus(agent, thresholdMs);
}

// ============================================================================
// detectStaleAgents
// ============================================================================

/**
 * Find all non-terminal agents whose last heartbeat is older than `thresholdMs`.
 *
 * "Stale" means an agent with status `starting`, `active`, or `idle` has
 * not sent a heartbeat within the threshold window. This is a precursor to
 * crash detection — a stale agent may still recover if it is under heavy load.
 *
 * Agents with status `stopped` or `crashed` are excluded — they are already
 * in a terminal state and do not participate in the heartbeat protocol.
 *
 * @param thresholdMs - Staleness threshold in ms (default: 3 minutes / 180 000 ms)
 * @param cwd - Working directory used to resolve the tasks.db path (optional)
 * @returns Array of {@link AgentHealthStatus} for each stale agent, sorted by
 *   heartbeat age descending (most-stale first)
 *
 * @remarks
 * The default threshold matches the crash-detection window specified in T039:
 * "timeout detection after 3 minutes".
 *
 * @example
 * ```ts
 * const stale = await detectStaleAgents();
 * for (const s of stale) {
 *   console.log(`${s.agentId} has been stale for ${s.heartbeatAgeMs / 1000}s`);
 * }
 * ```
 */
export async function detectStaleAgents(
  thresholdMs: number = STALE_THRESHOLD_MS,
  cwd?: string,
): Promise<AgentHealthStatus[]> {
  const agents = await listAgentInstances({ status: ALIVE_STATUSES }, cwd);

  return agents
    .map((a) => buildHealthStatus(a, thresholdMs))
    .filter((s) => s.stale)
    .sort((a, b) => b.heartbeatAgeMs - a.heartbeatAgeMs);
}

// ============================================================================
// detectCrashedAgents
// ============================================================================

/**
 * Find agents with status `active` whose heartbeat has been silent for
 * longer than `thresholdMs`, and mark them as `crashed` in the database.
 *
 * An agent is considered crashed when it:
 * 1. Has status `active` (not `idle`, `starting`, `stopped`, or `crashed`)
 * 2. Has not sent a heartbeat for longer than `thresholdMs`
 *
 * Each detected agent is immediately marked `crashed` via {@link markCrashed},
 * incrementing its error count and writing a reason to `agent_error_log`.
 *
 * @param thresholdMs - Crash threshold in ms (default: 3 minutes / 180 000 ms)
 * @param cwd - Working directory used to resolve the tasks.db path (optional)
 * @returns Array of agent instance rows for each agent that was just marked
 *   `crashed`, sorted by last heartbeat ascending (oldest first).
 *
 * @remarks
 * This function is WRITE-side: it mutates the database. Callers should run
 * it on a schedule (e.g. every 60 s) from an orchestrator or health watchdog.
 * For a read-only view, use {@link detectStaleAgents} instead.
 *
 * @example
 * ```ts
 * // Inside an orchestrator health watchdog:
 * const crashed = await detectCrashedAgents();
 * if (crashed.length > 0) {
 *   logger.warn({ crashed: crashed.map(a => a.id) }, 'Agents marked crashed');
 * }
 * ```
 */
export async function detectCrashedAgents(
  thresholdMs: number = STALE_THRESHOLD_MS,
  cwd?: string,
): Promise<AgentInstanceRow[]> {
  // Only consider agents that are explicitly 'active' — idle/starting agents
  // may not yet have established a regular heartbeat interval.
  const activeAgents = await listAgentInstances({ status: 'active' }, cwd);
  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  const crashed: AgentInstanceRow[] = [];

  for (const agent of activeAgents) {
    if (agent.lastHeartbeat < cutoff) {
      const updated = await markCrashed(
        agent.id,
        `Heartbeat timeout — no heartbeat for >${Math.round(thresholdMs / 1000)}s`,
        cwd,
      );
      if (updated) {
        crashed.push(updated);
      }
    }
  }

  // Sort oldest-heartbeat first (most severely stale)
  crashed.sort((a, b) => {
    const aHb = a.lastHeartbeat ?? '';
    const bHb = b.lastHeartbeat ?? '';
    return aHb < bHb ? -1 : aHb > bHb ? 1 : 0;
  });

  return crashed;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build an {@link AgentHealthStatus} from a raw agent row.
 */
function buildHealthStatus(agent: AgentInstanceRow, thresholdMs: number): AgentHealthStatus {
  const lastHeartbeatMs = new Date(agent.lastHeartbeat).getTime();
  const heartbeatAgeMs = Date.now() - lastHeartbeatMs;
  const stale = ALIVE_STATUSES.includes(agent.status as AgentInstanceStatus)
    ? heartbeatAgeMs > thresholdMs
    : false;
  const healthy = !stale && ALIVE_STATUSES.includes(agent.status as AgentInstanceStatus);

  return {
    agentId: agent.id,
    status: agent.status as AgentInstanceStatus,
    lastHeartbeat: agent.lastHeartbeat,
    heartbeatAgeMs,
    healthy,
    stale,
    thresholdMs,
  };
}
