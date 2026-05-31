/**
 * Public API for the agents domain — promoted from internal to public barrel.
 *
 * These functions are consumed by CLI commands (`packages/cleo`) and Studio
 * routes (`packages/studio`) and are therefore part of the stable public
 * surface of `@cleocode/core/agents`.
 *
 * Internally they compose over the existing registry, health-monitor, and
 * capacity modules. The `AgentRegistryAccessor` class remains in
 * `@cleocode/core/internal` for callers that need the full CRUD interface
 * with global-DB access; this surface provides the commonly needed subset.
 *
 * @packageDocumentation
 * @task T9615
 * @epic T9592
 */

import { getProjectRoot } from '../paths.js';
import { AgentRegistryAccessor } from '../store/agent-registry-accessor.js';
import type { AgentInstanceRow } from '../store/schema/agent-schema.js';
import {
  deregisterAgent,
  getAgentInstance,
  type ListAgentFilters,
  listAgentInstances,
} from './registry.js';
// registerAgent, RegisterAgentOptions, AgentInstanceRow, ListAgentFilters are already
// exported from ./registry.js via agents/index.ts.
// We do NOT re-export them here to avoid duplicate-export conflicts.

// ---------------------------------------------------------------------------
// listAgents
// ---------------------------------------------------------------------------

/** Options for {@link listAgents}. */
export interface ListAgentsOptions extends ListAgentFilters {
  /** Project root path; defaults to resolved root. */
  projectPath?: string;
}

/** Result of {@link listAgents}. */
export interface ListAgentsResult {
  /** Matching agent instances. */
  agents: AgentInstanceRow[];
  /** Total count before limit. */
  total: number;
}

/**
 * List agent instances registered in the project database.
 *
 * @param opts - Optional status, type, and pagination filters
 * @returns List of matching agent instances and total count
 *
 * @example
 * ```typescript
 * const { agents } = await listAgents({ status: 'active' });
 * console.log(`${agents.length} active agents`);
 * ```
 *
 * @task T9615
 */
export async function listAgents(opts: ListAgentsOptions = {}): Promise<ListAgentsResult> {
  const { projectPath, ...filters } = opts;
  const agents = await listAgentInstances(filters, projectPath);
  return { agents, total: agents.length };
}

// ---------------------------------------------------------------------------
// getAgent
// ---------------------------------------------------------------------------

/**
 * Look up a single agent instance by identifier.
 *
 * @param id - Agent instance identifier
 * @param projectPath - Optional project root path
 * @returns The {@link AgentInstanceRow} if found, or `null`
 *
 * @example
 * ```typescript
 * const agent = await getAgent('agt_abc123');
 * if (agent) console.log(`Status: ${agent.status}`);
 * ```
 *
 * @task T9615
 */
export async function getAgent(id: string, projectPath?: string): Promise<AgentInstanceRow | null> {
  return getAgentInstance(id, projectPath);
}

// ---------------------------------------------------------------------------
// removeAgent
// ---------------------------------------------------------------------------

/**
 * Deregister an agent instance, marking it as stopped.
 *
 * Idempotent — calling with an already-stopped agent returns the existing
 * row unchanged without error.
 *
 * @param id - Agent instance identifier
 * @param projectPath - Optional project root path
 * @returns The final state of the agent row, or `null` if not found
 *
 * @example
 * ```typescript
 * await removeAgent('agt_abc123');
 * ```
 *
 * @task T9615
 */
export async function removeAgent(
  id: string,
  projectPath?: string,
): Promise<AgentInstanceRow | null> {
  return deregisterAgent(id, projectPath);
}

// ---------------------------------------------------------------------------
// rotateAgentKey
// ---------------------------------------------------------------------------

/** Result of {@link rotateAgentKey}. */
export interface RotateAgentKeyResult {
  /** The agent whose key was rotated. */
  agentId: string;
  /**
   * Redacted new API key in the form `XXXXXXXX...rotated`.
   * The full key is stored encrypted in the global agent database.
   */
  newApiKey: string;
}

/**
 * Rotate the API key for a SignalDock-registered agent.
 *
 * Calls the SignalDock `/agents/:id/rotate-key` endpoint, re-derives a new
 * encrypted key via the T310 KDF, and persists it to the global agent store.
 * Only SignalDock-backed agents support key rotation; local agents will throw.
 *
 * @param agentId - Business-level agent identifier (e.g. `"cleo-prime"`)
 * @param projectPath - Optional project root path for accessor initialisation
 * @returns Redacted new key string confirming the rotation succeeded
 *
 * @example
 * ```typescript
 * const result = await rotateAgentKey('cleo-prime');
 * console.log(`Rotated: ${result.newApiKey}`);
 * ```
 *
 * @task T9615
 */
export async function rotateAgentKey(
  agentId: string,
  projectPath?: string,
): Promise<RotateAgentKeyResult> {
  const accessor = new AgentRegistryAccessor(projectPath ?? getProjectRoot());
  return accessor.rotateKey(agentId);
}
