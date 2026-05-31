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

// Conduit factory — creates a messaging Conduit from an agent registry.
export { createConduit } from '../conduit/factory.js';
// Agent doctor — orphan-row detection and reconciliation.
export {
  type BuildDoctorReportOptions,
  buildDoctorReport,
  type ReconcileDoctorOptions,
  type ReconcileDoctorResult,
  reconcileDoctor,
} from '../store/agent-doctor.js';
// Agent installer — .cant/.cantz archive → registry row pipeline.
export {
  type InstallAgentFromCantInput,
  type InstallAgentFromCantResult,
  installAgentFromCant,
} from '../store/agent-install.js';
// === Agent store layer (T9620 — CORE-first promotion from @cleocode/core/internal) ===
// Agent registry accessor — cross-DB CRUD (global signaldock.db + project conduit.db).
// CLI agent commands (`packages/cleo`) consume these via @cleocode/core/agents.
export {
  AgentRegistryAccessor,
  attachAgentToProject,
  detachAgentFromProject,
  getProjectAgentRef,
  listAgentsForProject,
  lookupAgent,
} from '../store/agent-registry-accessor.js';
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
} from '../store/schema/agent-schema.js';
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
// Meta-agent invocation shim (T1272 / T1273 — ADR-055 D034 agent-architect)
export {
  type InvokeMetaAgentOptions,
  invokeAgentArchitect,
  invokeMetaAgent,
  type MetaAgentResult,
  type MetaAgentTokens,
} from './invoke-meta-agent.js';
// === Public API (T9615 — CORE-first promotion) ===
// Exposes registerAgent, listAgents, getAgent, removeAgent, rotateAgentKey
// as stable @cleocode/core/agents surface, wrapping the registry primitives.
export * from './public-api.js';
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
// Agent-templates SDK helpers (ADR-068 / T1929 / T1935)
export {
  type AgentTemplatesLocation,
  resolveAgentTemplates,
  resolveMetaAgentsDir,
  // Deprecated aliases — back-compat until v2027.x (T1935)
  resolveStarterBundle,
  resolveStarterBundleAgentsDir,
  resolveStarterBundleIdentityFile,
  resolveStarterBundleTeamFile,
} from './resolveAgentTemplates.js';
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
// Seed-agent installer (T897 / T1238 / T1239 / T1241)
export {
  type EnsureSeedAgentsInstalledOptions,
  ensureSeedAgentsInstalled,
  type RerouteLegacyDb,
  type RerouteLegacyStarterBundleResult,
  rerouteLegacyStarterBundlePaths,
  SEED_VERSION_MARKER_FILENAME,
  type SeedInstallDispatcher,
  type SeedInstallResult,
  type SeedInstallSource,
} from './seed-install.js';
// Variable substitution (T1238 — mustache {{var}} template engine)
export {
  DefaultVariableResolver,
  defaultResolver,
  type LoadProjectContextResult,
  loadProjectContext,
  type SubstituteCantAgentBodyResult,
  substituteCantAgentBody,
} from './variable-substitution.js';
