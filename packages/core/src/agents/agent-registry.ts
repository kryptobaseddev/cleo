/**
 * Agent registry with capacity tracking for load balancing.
 *
 * Provides task-count-based capacity queries, specialization lookup,
 * and performance recording on top of the existing `agent_instances` schema.
 *
 * Capacity model: each agent has a maximum of {@link MAX_TASKS_PER_AGENT}
 * concurrent tasks. "Remaining capacity" is that constant minus the number of
 * tasks currently assigned to an active agent instance.
 *
 * Specializations are stored as a `specializations` array inside the agent's
 * `metadata_json` column. Use {@link updateAgentSpecializations} to write them.
 *
 * Performance recording delegates to the existing `recordAgentExecution`
 * function in `execution-learning.ts` and wraps it with a simpler metrics
 * interface suited for load-balancer callers.
 *
 * @module agents/agent-registry
 * @task T041
 * @epic T038
 */

import { and, eq, inArray } from 'drizzle-orm';
import { getDb } from '../store/sqlite.js';
import { type AgentInstanceRow, type AgentType, agentInstances } from './agent-schema.js';
import {
  type AgentExecutionEvent,
  type AgentExecutionOutcome,
  recordAgentExecution,
} from './execution-learning.js';
import { listAgentInstances } from './registry.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum number of tasks that can be concurrently assigned to one agent.
 * Used as the upper bound for task-count-based capacity calculation.
 */
export const MAX_TASKS_PER_AGENT = 5;

// ============================================================================
// Types
// ============================================================================

/**
 * Task-count-based capacity for a single agent instance.
 */
export interface AgentCapacity {
  /** Agent instance ID. */
  agentId: string;
  /** Agent type classification. */
  agentType: AgentType;
  /** Current status of the agent. */
  status: AgentInstanceRow['status'];
  /** Number of tasks currently assigned to this agent. */
  activeTasks: number;
  /** Number of additional tasks this agent can accept (max - active). */
  remainingCapacity: number;
  /** Maximum tasks this agent can hold ({@link MAX_TASKS_PER_AGENT}). */
  maxCapacity: number;
  /** Whether this agent can accept new tasks. */
  available: boolean;
}

/**
 * Metrics provided when recording agent performance.
 */
export interface AgentPerformanceMetrics {
  /** Task ID that was processed. */
  taskId: string;
  /** Task type label (e.g. "epic", "task", "subtask"). */
  taskType: string;
  /** Outcome of the agent's work on the task. */
  outcome: AgentExecutionOutcome;
  /** Optional task labels for richer pattern classification. */
  taskLabels?: string[];
  /** Session ID the agent was operating under. */
  sessionId?: string;
  /** Duration of execution in milliseconds. */
  durationMs?: number;
  /** Error message if outcome is "failure". */
  errorMessage?: string;
  /** Error classification if outcome is "failure". */
  errorType?: 'retriable' | 'permanent' | 'unknown';
}

// ============================================================================
// Capacity queries
// ============================================================================

/**
 * Get task-count-based remaining capacity for an agent.
 *
 * Remaining capacity = {@link MAX_TASKS_PER_AGENT} minus the number of tasks
 * currently routed to this agent instance (tracked via the `task_id` column
 * on `agent_instances` — each instance handles one task at a time; child agents
 * spawned by an orchestrator appear as sibling rows referencing the same
 * `parent_agent_id`).
 *
 * For capacity purposes the "active tasks" count is derived from the number of
 * non-terminal sibling rows that share the same `parent_agent_id` as this
 * agent, plus 1 for the agent's own current task when `task_id` is set.
 *
 * @remarks
 * Agents in terminal states (`stopped`, `crashed`) always return 0 remaining
 * capacity because they cannot accept work.
 *
 * @param agentId - Agent instance ID (agt_...) to check
 * @param cwd - Working directory used to resolve tasks.db path
 * @returns Capacity breakdown or null if the agent does not exist
 *
 * @example
 * ```ts
 * const cap = await getAgentCapacity('agt_20260321120000_ab12cd', '/project');
 * if (cap && cap.available) {
 *   console.log(`Agent can take ${cap.remainingCapacity} more tasks`);
 * }
 * ```
 */
export async function getAgentCapacity(
  agentId: string,
  cwd?: string,
): Promise<AgentCapacity | null> {
  const db = await getDb(cwd);

  const agent = await db.select().from(agentInstances).where(eq(agentInstances.id, agentId)).get();

  if (!agent) return null;

  // Terminal agents have zero capacity
  const isTerminal = agent.status === 'stopped' || agent.status === 'crashed';
  if (isTerminal) {
    return {
      agentId: agent.id,
      agentType: agent.agentType,
      status: agent.status,
      activeTasks: 0,
      remainingCapacity: 0,
      maxCapacity: MAX_TASKS_PER_AGENT,
      available: false,
    };
  }

  // Count active child agents (subtasks delegated by this agent)
  const children = await db
    .select({ id: agentInstances.id })
    .from(agentInstances)
    .where(
      and(
        eq(agentInstances.parentAgentId, agentId),
        inArray(agentInstances.status, ['starting', 'active', 'idle', 'error']),
      ),
    )
    .all();

  // The agent itself counts as 1 active task when it has a task assigned
  const selfTask = agent.taskId != null ? 1 : 0;
  const activeTasks = selfTask + children.length;
  const remainingCapacity = Math.max(0, MAX_TASKS_PER_AGENT - activeTasks);

  return {
    agentId: agent.id,
    agentType: agent.agentType,
    status: agent.status,
    activeTasks,
    remainingCapacity,
    maxCapacity: MAX_TASKS_PER_AGENT,
    available: remainingCapacity > 0,
  };
}

/**
 * List all non-terminal agents sorted by remaining task capacity (descending).
 *
 * Returns agents with the most available slots first, enabling callers to
 * select the least-loaded agent for new work assignment.
 *
 * @remarks
 * Only agents in `active` or `idle` states are included — `starting` agents
 * are excluded because they may not yet be ready to accept work.
 * Terminal agents (`stopped`, `crashed`) are always omitted.
 *
 * @param agentType - Optional filter to limit results to one agent type
 * @param cwd - Working directory used to resolve tasks.db path
 * @returns Array of capacity entries sorted highest remaining capacity first
 *
 * @example
 * ```ts
 * const agents = await getAgentsByCapacity('executor', '/project');
 * const best = agents[0]; // most available slots
 * if (best && best.available) {
 *   await assignTask(best.agentId, taskId);
 * }
 * ```
 */
export async function getAgentsByCapacity(
  agentType?: AgentType,
  cwd?: string,
): Promise<AgentCapacity[]> {
  const filters: Parameters<typeof listAgentInstances>[0] = agentType
    ? { status: ['active', 'idle'] as ('active' | 'idle')[], agentType }
    : { status: ['active', 'idle'] as ('active' | 'idle')[] };

  const activeAgents = await listAgentInstances(filters, cwd);

  const capacities = await Promise.all(
    activeAgents.map((agent) => getAgentCapacity(agent.id, cwd)),
  );

  return capacities
    .filter((c): c is AgentCapacity => c !== null)
    .sort((a, b) => b.remainingCapacity - a.remainingCapacity);
}

// ============================================================================
// Specializations
// ============================================================================

/**
 * Metadata shape stored in the agent_instances.metadata_json column.
 * Only the subset relevant to specializations is typed here.
 *
 * @internal
 */
interface AgentMetadata {
  specializations?: string[];
  [key: string]: unknown;
}

/**
 * Get the specialization/skills list for an agent.
 *
 * Specializations are stored as a string array under the `specializations`
 * key in the agent's `metadata_json` column. An empty array is returned when
 * the field is absent or the agent is not found.
 *
 * @remarks
 * Write specializations with {@link updateAgentSpecializations} when
 * registering or updating an agent. The metadata column is a free-form JSON
 * blob — specializations are one namespaced key inside it.
 *
 * @param agentId - Agent instance ID (agt_...)
 * @param cwd - Working directory used to resolve tasks.db path
 * @returns Array of specialization strings (empty if none recorded)
 *
 * @example
 * ```ts
 * const skills = await getAgentSpecializations('agt_20260321120000_ab12cd', '/project');
 * // ['typescript', 'testing', 'documentation']
 * if (skills.includes('typescript')) {
 *   console.log('Agent can handle TypeScript tasks');
 * }
 * ```
 */
export async function getAgentSpecializations(agentId: string, cwd?: string): Promise<string[]> {
  const db = await getDb(cwd);
  const agent = await db
    .select({ metadataJson: agentInstances.metadataJson })
    .from(agentInstances)
    .where(eq(agentInstances.id, agentId))
    .get();

  if (!agent) return [];

  try {
    const meta = JSON.parse(agent.metadataJson ?? '{}') as AgentMetadata;
    const specs = meta.specializations;
    if (!Array.isArray(specs)) return [];
    return specs.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

/**
 * Update the specializations list stored in an agent's metadata.
 *
 * Merges the new list into the existing `metadata_json` object, preserving
 * any other keys already present. Returns the updated specializations list,
 * or null if the agent was not found.
 *
 * @remarks
 * This is a write-side companion to {@link getAgentSpecializations}. Call it
 * after {@link registerAgent} to record the skills an agent was spawned with.
 *
 * @param agentId - Agent instance ID (agt_...)
 * @param specializations - New specializations list (replaces existing)
 * @param cwd - Working directory used to resolve tasks.db path
 * @returns Updated specializations list, or null if agent not found
 *
 * @example
 * ```ts
 * await updateAgentSpecializations(
 *   'agt_20260321120000_ab12cd',
 *   ['typescript', 'testing'],
 *   '/project',
 * );
 * ```
 */
export async function updateAgentSpecializations(
  agentId: string,
  specializations: string[],
  cwd?: string,
): Promise<string[] | null> {
  const db = await getDb(cwd);
  const agent = await db
    .select({ metadataJson: agentInstances.metadataJson })
    .from(agentInstances)
    .where(eq(agentInstances.id, agentId))
    .get();

  if (!agent) return null;

  let existing: AgentMetadata = {};
  try {
    existing = JSON.parse(agent.metadataJson ?? '{}') as AgentMetadata;
  } catch {
    // Proceed with empty object if metadata is unparseable
  }

  const updated: AgentMetadata = { ...existing, specializations };
  await db
    .update(agentInstances)
    .set({ metadataJson: JSON.stringify(updated) })
    .where(eq(agentInstances.id, agentId));

  return specializations;
}

// ============================================================================
// Performance recording
// ============================================================================

/**
 * Record agent performance metrics to the BRAIN execution history.
 *
 * Translates a simplified {@link AgentPerformanceMetrics} object into the
 * {@link AgentExecutionEvent} format expected by `execution-learning.ts` and
 * delegates to {@link recordAgentExecution}. The agent type is resolved from
 * the `agent_instances` table so callers only need to supply the agent ID.
 *
 * @remarks
 * Recording is best-effort — if brain.db is unavailable the error is swallowed
 * and null is returned, consistent with the rest of the execution-learning
 * module. Agent lifecycle code is never disrupted by a brain write failure.
 *
 * @param agentId - Agent instance ID whose performance is being recorded
 * @param metrics - Performance metrics for the task that was processed
 * @param cwd - Working directory used to resolve tasks.db and brain.db paths
 * @returns The brain decision ID if recorded, null on failure or not found
 *
 * @example
 * ```ts
 * const decisionId = await recordAgentPerformance('agt_20260321120000_ab12cd', {
 *   taskId: 'T041',
 *   taskType: 'task',
 *   outcome: 'success',
 *   durationMs: 4200,
 *   sessionId: 'ses_20260321_abc',
 * }, '/project');
 * ```
 */
export async function recordAgentPerformance(
  agentId: string,
  metrics: AgentPerformanceMetrics,
  cwd?: string,
): Promise<string | null> {
  const db = await getDb(cwd);
  const agent = await db
    .select({ agentType: agentInstances.agentType, sessionId: agentInstances.sessionId })
    .from(agentInstances)
    .where(eq(agentInstances.id, agentId))
    .get();

  if (!agent) return null;

  const event: AgentExecutionEvent = {
    agentId,
    agentType: agent.agentType,
    taskId: metrics.taskId,
    taskType: metrics.taskType,
    outcome: metrics.outcome,
    taskLabels: metrics.taskLabels,
    sessionId: metrics.sessionId ?? agent.sessionId ?? undefined,
    durationMs: metrics.durationMs,
    errorMessage: metrics.errorMessage,
    errorType: metrics.errorType,
  };

  const decision = await recordAgentExecution(event, cwd);
  return decision?.id ?? null;
}
