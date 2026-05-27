/**
 * Capacity tracking and load balancing for the Agent dimension.
 *
 * Tracks per-agent capacity (0.0-1.0) and provides queries for
 * capacity-aware work distribution.
 *
 * @module agents/capacity
 */

import { eq } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import { type AgentInstanceRow, type AgentType, agentInstances } from './agent-schema.js';
import { listAgentInstances } from './registry.js';

// ============================================================================
// Capacity Updates
// ============================================================================

/**
 * Update the capacity value for an agent instance.
 *
 * @param id - Agent instance ID
 * @param capacity - New capacity value (0.0 to 1.0)
 * @param cwd - Working directory
 * @returns Updated agent row, or null if not found
 */
export async function updateCapacity(
  id: string,
  capacity: number,
  cwd?: string,
): Promise<AgentInstanceRow | null> {
  if (capacity < 0 || capacity > 1) {
    throw new Error(`Capacity must be between 0.0 and 1.0, got ${capacity}`);
  }

  const db = await getDb(cwd);
  const existing = await db.select().from(agentInstances).where(eq(agentInstances.id, id)).get();

  if (!existing) return null;

  const capacityStr = capacity.toFixed(4);
  await db.update(agentInstances).set({ capacity: capacityStr }).where(eq(agentInstances.id, id));

  return { ...existing, capacity: capacityStr };
}

// ============================================================================
// Capacity Queries
// ============================================================================

/**
 * Get the total available capacity across all active agents.
 *
 * Only considers agents in 'active' or 'idle' status.
 * Returns the sum of all capacity values.
 */
export async function getAvailableCapacity(cwd?: string): Promise<number> {
  const agents = await listAgentInstances({ status: ['active', 'idle'] }, cwd);
  return agents.reduce((sum, agent) => sum + parseCapacity(agent.capacity), 0);
}

/**
 * Find the agent with the most available capacity.
 *
 * @param agentType - Optional type filter
 * @param cwd - Working directory
 * @returns Agent with highest capacity, or null if no active agents
 */
export async function findLeastLoadedAgent(
  agentType?: AgentType,
  cwd?: string,
): Promise<AgentInstanceRow | null> {
  const filters: import('./registry.js').ListAgentFilters = agentType
    ? { status: ['active', 'idle'] as ('active' | 'idle')[], agentType }
    : { status: ['active', 'idle'] as ('active' | 'idle')[] };

  const agents = await listAgentInstances(filters, cwd);

  if (agents.length === 0) return null;

  let best = agents[0]!;
  let bestCapacity = parseCapacity(best.capacity);

  for (let i = 1; i < agents.length; i++) {
    const cap = parseCapacity(agents[i]!.capacity);
    if (cap > bestCapacity) {
      best = agents[i]!;
      bestCapacity = cap;
    }
  }

  return best;
}

/**
 * Check if the system is overloaded (total capacity below threshold).
 *
 * @param threshold - Minimum acceptable capacity (default: 0.1)
 * @param cwd - Working directory
 * @returns true if total available capacity is below the threshold
 */
export async function isOverloaded(threshold: number = 0.1, cwd?: string): Promise<boolean> {
  const capacity = await getAvailableCapacity(cwd);
  return capacity < threshold;
}

/** Capacity summary for reporting. */
export interface CapacitySummary {
  totalCapacity: number;
  activeAgentCount: number;
  averageCapacity: number;
  overloaded: boolean;
  threshold: number;
}

/**
 * Get a capacity summary across the entire agent pool.
 *
 * @param threshold - Overload threshold (default: 0.1)
 * @param cwd - Working directory
 */
export async function getCapacitySummary(
  threshold: number = 0.1,
  cwd?: string,
): Promise<CapacitySummary> {
  const agents = await listAgentInstances({ status: ['active', 'idle'] }, cwd);
  const totalCapacity = agents.reduce((sum, a) => sum + parseCapacity(a.capacity), 0);
  const activeAgentCount = agents.length;

  return {
    totalCapacity,
    activeAgentCount,
    averageCapacity: activeAgentCount > 0 ? totalCapacity / activeAgentCount : 0,
    overloaded: totalCapacity < threshold,
    threshold,
  };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Parse a capacity string to a number.
 * The DB stores capacity as TEXT to avoid floating-point representation issues.
 */
function parseCapacity(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = parseFloat(value);
  return Number.isNaN(parsed) ? 0 : Math.max(0, Math.min(1, parsed));
}
