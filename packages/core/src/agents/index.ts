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

// Load-balancing registry: task-count capacity, specializations, performance recording
export {
  type AgentCapacity,
  type AgentPerformanceMetrics,
  getAgentCapacity,
  getAgentSpecializations,
  getAgentsByCapacity,
  MAX_TASKS_PER_AGENT,
  recordAgentPerformance,
  updateAgentSpecializations,
} from './agent-registry.js';
// Schema & types
export {
  AGENT_INSTANCE_STATUSES,
  AGENT_TYPES,
  type AgentErrorLogRow,
  type AgentErrorType,
  type AgentInstanceRow,
  type AgentInstanceStatus,
  type AgentType,
  agentErrorLog,
  agentInstances,
  type NewAgentErrorLogRow,
  type NewAgentInstanceRow,
} from './agent-schema.js';
// Capacity tracking
export {
  type CapacitySummary,
  findLeastLoadedAgent,
  getAvailableCapacity,
  getCapacitySummary,
  isOverloaded,
  updateCapacity,
} from './capacity.js';
// Execution learning, failure pattern tracking, and self-healing
export {
  type AgentExecutionEvent,
  type AgentExecutionOutcome,
  type AgentPerformanceSummary,
  getAgentPerformanceHistory,
  getSelfHealingSuggestions,
  type HealingSuggestion,
  processAgentLifecycleEvent,
  recordAgentExecution,
  recordFailurePattern,
  storeHealingStrategy,
} from './execution-learning.js';
// Health monitoring (T039)
export {
  type AgentHealthStatus,
  checkAgentHealth,
  detectCrashedAgents,
  detectStaleAgents,
  HEARTBEAT_INTERVAL_MS,
  recordHeartbeat,
  STALE_THRESHOLD_MS,
} from './health-monitor.js';
// Registry (CRUD, heartbeat, health, errors)
// Note: registry.checkAgentHealth (thresholdMs, cwd) -> AgentInstanceRow[] is exported
// as findStaleAgentRows to avoid conflict with health-monitor.checkAgentHealth (T039).
export {
  type AgentHealthReport,
  checkAgentHealth as findStaleAgentRows,
  classifyError,
  deregisterAgent,
  generateAgentId,
  getAgentErrorHistory,
  getAgentInstance,
  getHealthReport,
  heartbeat,
  incrementTasksCompleted,
  type ListAgentFilters,
  listAgentInstances,
  markCrashed,
  type RegisterAgentOptions,
  registerAgent,
  type UpdateStatusOptions,
  updateAgentStatus,
} from './registry.js';
// Retry & self-healing
export {
  type AgentRecoveryResult,
  calculateDelay,
  createRetryPolicy,
  DEFAULT_RETRY_POLICY,
  type RetryPolicy,
  type RetryResult,
  recoverCrashedAgents,
  shouldRetry,
  withRetry,
} from './retry.js';
// Variable substitution (T1238 — mustache {{var}} template engine)
export {
  DefaultVariableResolver,
  defaultResolver,
  type LoadProjectContextResult,
  loadProjectContext,
  type SubstituteCantAgentBodyResult,
  substituteCantAgentBody,
} from './variable-substitution.js';
