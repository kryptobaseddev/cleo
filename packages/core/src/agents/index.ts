/**
 * Agent dimension -- runtime tracking, health monitoring, self-healing, and capacity.
 *
 * This module provides the complete Agent dimension for the BRAIN specification:
 *
 * - **Registry**: CRUD for agent instances (register, deregister, heartbeat, queries)
 * - **Health**: Crash detection via heartbeat protocol, health reports
 * - **Self-Healing**: Retry with exponential backoff, crashed agent recovery
 * - **Capacity**: Load awareness, least-loaded agent selection, overload detection
 *
 * @module agents
 */

// Schema & types
export {
  agentErrorLog,
  AGENT_INSTANCE_STATUSES,
  agentInstances,
  AGENT_TYPES,
  type AgentErrorLogRow,
  type AgentErrorType,
  type AgentInstanceRow,
  type AgentInstanceStatus,
  type AgentType,
  type NewAgentErrorLogRow,
  type NewAgentInstanceRow,
} from './agent-schema.js';

// Registry (CRUD, heartbeat, health, errors)
export {
  checkAgentHealth,
  classifyError,
  deregisterAgent,
  generateAgentId,
  getAgentErrorHistory,
  getAgentInstance,
  getHealthReport,
  heartbeat,
  incrementTasksCompleted,
  listAgentInstances,
  markCrashed,
  registerAgent,
  updateAgentStatus,
  type AgentHealthReport,
  type ListAgentFilters,
  type RegisterAgentOptions,
  type UpdateStatusOptions,
} from './registry.js';

// Retry & self-healing
export {
  calculateDelay,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  recoverCrashedAgents,
  shouldRetry,
  withRetry,
  type AgentRecoveryResult,
  type RetryPolicy,
  type RetryResult,
} from './retry.js';

// Capacity tracking
export {
  findLeastLoadedAgent,
  getAvailableCapacity,
  getCapacitySummary,
  isOverloaded,
  updateCapacity,
  type CapacitySummary,
} from './capacity.js';
