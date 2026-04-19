/**
 * Facade API interfaces for the Cleo class.
 *
 * These define the public API surface that consumers (e.g. CleoOS) use
 * to interact with @cleocode/core via the `Cleo` facade. Defined here
 * in contracts so downstream packages can import types without depending
 * on core directly.
 *
 * @module facade
 */

import type { ConduitMessage } from './conduit.js';
import type {
  DataAccessor,
  ExternalTask,
  ExternalTaskLink,
  ReconcileOptions,
  ReconcileResult,
  Task,
  TaskPriority,
  TaskSize,
  TaskStatus,
  TaskType,
} from './index.js';

// ============================================================================
// Supporting types (previously scattered across core modules)
// ============================================================================

// --- Brain / Memory ---

/** Observation type categories for brain entries. */
export const BRAIN_OBSERVATION_TYPES = [
  'discovery',
  'change',
  'feature',
  'bugfix',
  'decision',
  'refactor',
] as const;

/** Brain observation type. */
export type BrainObservationType = (typeof BRAIN_OBSERVATION_TYPES)[number];

/** Options for hybrid (FTS + vector + graph) brain search. */
export interface HybridSearchOptions {
  /** Weight for full-text search results (0-1). */
  ftsWeight?: number;
  /** Weight for vector similarity results (0-1). */
  vecWeight?: number;
  /** Weight for graph-based results (0-1). */
  graphWeight?: number;
  /** Maximum number of results to return. */
  limit?: number;
}

// --- Admin / Import ---

/** Strategy for handling duplicate tasks during import. */
export type DuplicateStrategy = 'skip' | 'overwrite' | 'rename';

/** Parameters for task import operations. */
export interface ImportParams {
  /** Path to the import file. */
  file: string;
  /** Parent task ID for imported tasks. */
  parent?: string;
  /** Phase assignment for imported tasks. */
  phase?: string;
  /** Strategy when a duplicate task ID is found. */
  onDuplicate?: DuplicateStrategy;
  /** Label to add to all imported tasks. */
  addLabel?: string;
  /** If true, simulate the import without persisting. */
  dryRun?: boolean;
  /** Working directory for resolving paths. */
  cwd?: string;
}

// --- Agents ---

/** Agent instance status values. */
export const AGENT_INSTANCE_STATUSES = [
  'starting',
  'active',
  'idle',
  'error',
  'crashed',
  'stopped',
] as const;

/** Agent instance status type. */
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

/** Agent type classification values. */
export const AGENT_TYPES = [
  'orchestrator',
  'executor',
  'researcher',
  'architect',
  'validator',
  'documentor',
  'custom',
] as const;

/** Agent type classification. */
export type AgentType = (typeof AGENT_TYPES)[number];

/**
 * Row shape for the `agent_instances` table.
 *
 * Manually defined to avoid Drizzle dependency in contracts.
 * Must stay in sync with `packages/core/src/agents/agent-schema.ts`.
 */
export interface AgentInstanceRow {
  /** Unique agent instance ID. */
  id: string;
  /** Agent type classification. */
  agentType: AgentType;
  /** Current status. */
  status: AgentInstanceStatus;
  /** Associated session ID (nullable). */
  sessionId: string | null;
  /** Associated task ID (nullable). */
  taskId: string | null;
  /** ISO timestamp when the agent started. */
  startedAt: string;
  /** ISO timestamp of the last heartbeat. */
  lastHeartbeat: string;
  /** ISO timestamp when the agent stopped (nullable). */
  stoppedAt: string | null;
  /** Number of errors encountered. */
  errorCount: number;
  /** Total tasks completed by this agent. */
  totalTasksCompleted: number;
  /** Agent capacity as a string (e.g. "1.0"). */
  capacity: string;
  /** JSON-encoded metadata. */
  metadataJson: string | null;
  /** Parent agent ID for hierarchical orchestration (nullable). */
  parentAgentId: string | null;
}

/** Options for registering a new agent instance. */
export interface RegisterAgentOptions {
  /** Agent type classification. */
  agentType: AgentType;
  /** Session to associate with. */
  sessionId?: string;
  /** Task to associate with. */
  taskId?: string;
  /** Parent agent ID for hierarchical orchestration. */
  parentAgentId?: string;
  /** Arbitrary metadata. */
  metadata?: Record<string, unknown>;
}

/** Agent capacity information. */
export interface AgentCapacity {
  /** Agent instance ID. */
  agentId: string;
  /** Agent type classification. */
  agentType: AgentType;
  /** Current status of the agent. */
  status: AgentInstanceStatus;
  /** Number of tasks currently assigned to this agent. */
  activeTasks: number;
  /** Number of additional tasks this agent can accept (max - active). */
  remainingCapacity: number;
  /** Maximum tasks this agent can hold. */
  maxCapacity: number;
  /** Whether this agent can accept new tasks. */
  available: boolean;
}

/** Agent health status from heartbeat monitoring. */
export interface AgentHealthStatus {
  /** Agent instance ID. */
  agentId: string;
  /** Current DB status. */
  status: AgentInstanceStatus;
  /** ISO timestamp of the last recorded heartbeat. */
  lastHeartbeat: string;
  /** Milliseconds since the last recorded heartbeat (at call time). */
  heartbeatAgeMs: number;
  /** Whether the agent is considered healthy (heartbeat within threshold). */
  healthy: boolean;
  /** Whether the agent is considered stale (heartbeat older than threshold). */
  stale: boolean;
  /** Threshold used for staleness determination (ms). */
  thresholdMs: number;
}

// --- Intelligence ---

/** Severity classification for blast radius. */
export type BlastRadiusSeverity = 'isolated' | 'moderate' | 'widespread' | 'critical';

/** A single task predicted to be affected by a change. */
export interface ImpactedTask {
  /** Task ID. */
  id: string;
  /** Task title. */
  title: string;
  /** Current task status. */
  status: string;
  /** Current task priority. */
  priority: string;
  /** Severity of exposure to the change. */
  exposure: 'direct' | 'dependent' | 'transitive';
  /** Number of downstream tasks that depend on this task. */
  downstreamCount: number;
  /** Why this task is predicted to be affected. */
  reason: string;
}

/** Full impact prediction report for a free-text change description. */
export interface ImpactReport {
  /** The original free-text change description. */
  change: string;
  /** Tasks directly matched by the change description (fuzzy search). */
  matchedTasks: ImpactedTask[];
  /** All tasks predicted to be affected, ordered by exposure severity. */
  affectedTasks: ImpactedTask[];
  /** Total count of distinct affected tasks (including direct matches). */
  totalAffected: number;
  /** Human-readable summary of predicted impact scope. */
  summary: string;
}

/** Quantified scope of a task's impact across the project. */
export interface BlastRadius {
  /** Number of direct dependents. */
  directCount: number;
  /** Number of transitive dependents (full downstream tree). */
  transitiveCount: number;
  /** Number of distinct epics affected. */
  epicCount: number;
  /** Percentage of the total project impacted (0-100). */
  projectPercentage: number;
  /** Classification of impact severity. */
  severity: BlastRadiusSeverity;
}

// ============================================================================
// Task work types
// ============================================================================

/** Result of starting work on a task. */
export interface TaskStartResult {
  /** The task ID that was started. */
  taskId: string;
  /** The task title. */
  title: string;
  /** Previous task ID if one was active (auto-stopped). */
  previousTask?: string | null;
}

// ============================================================================
// Facade API interfaces
// ============================================================================

/** Tasks domain API. */
export interface TasksAPI {
  /** Add a new task. */
  add(params: {
    title: string;
    description: string;
    parent?: string;
    priority?: TaskPriority;
    type?: TaskType;
    size?: TaskSize;
    phase?: string;
    labels?: string[];
    depends?: string[];
    notes?: string;
  }): Promise<unknown>;
  /** Find tasks by query, ID, status, or limit. */
  find(params: {
    query?: string;
    id?: string;
    status?: TaskStatus;
    limit?: number;
  }): Promise<unknown>;
  /** Show full details of a task. */
  show(taskId: string): Promise<unknown>;
  /**
   * List tasks with optional filters.
   *
   * @remarks
   * - `type` narrows by {@link TaskType} (`epic` | `task` | `subtask`).
   * - `excludeArchived` is a convenience flag that translates to
   *   `excludeStatus: ['archived']` in the underlying query. Default `false`
   *   for backward compatibility; pass `true` from surfaces (e.g. Studio
   *   kanban) that must hide archived rows.
   * - `sortByPriority` opts into `ORDER BY priority` (critical → low) instead
   *   of the default position-based ordering. Used by Studio's /tasks and
   *   /tasks/pipeline views to preserve the historic priority-first sort.
   */
  list(params?: {
    status?: TaskStatus;
    priority?: TaskPriority;
    type?: TaskType;
    parentId?: string;
    phase?: string;
    limit?: number;
    excludeArchived?: boolean;
    sortByPriority?: boolean;
  }): Promise<unknown>;
  /** Update task fields. */
  update(params: {
    taskId: string;
    title?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    description?: string;
    notes?: string;
  }): Promise<unknown>;
  /** Complete a task with optional notes. */
  complete(params: { taskId: string; notes?: string }): Promise<unknown>;
  /** Delete a task. */
  delete(params: { taskId: string; force?: boolean }): Promise<unknown>;
  /** Archive tasks by date or IDs. */
  archive(params?: { before?: string; taskIds?: string[]; dryRun?: boolean }): Promise<unknown>;
  /** Start working on a specific task (sets focus). */
  start(taskId: string): Promise<unknown>;
  /** Stop working on the current task (clears focus). */
  stop(): Promise<{ previousTask: string | null }>;
  /** Get the current task work state. */
  current(): Promise<unknown>;
}

/** Sessions domain API. */
export interface SessionsAPI {
  /** Start a new session. */
  start(params: {
    name: string;
    scope: string;
    agent?: string;
    startTask?: string;
  }): Promise<unknown>;
  /** End the current session. */
  end(params?: { note?: string }): Promise<unknown>;
  /** Get current session status. */
  status(): Promise<unknown>;
  /** Resume an existing session. */
  resume(sessionId: string): Promise<unknown>;
  /** List sessions with optional filters. */
  list(params?: { status?: string; limit?: number }): Promise<unknown>;
  /** Find sessions by criteria. */
  find(params?: {
    status?: string;
    scope?: string;
    query?: string;
    limit?: number;
  }): Promise<unknown>;
  /** Show full details of a session. */
  show(sessionId: string): Promise<unknown>;
  /** Suspend a session. */
  suspend(sessionId: string, reason?: string): Promise<unknown>;
  /** Compute session briefing. */
  briefing(params?: { maxNextTasks?: number; scope?: string }): Promise<unknown>;
  /** Compute session handoff. */
  handoff(sessionId: string, options?: { note?: string; nextAction?: string }): Promise<unknown>;
  /** Garbage-collect stale sessions. */
  gc(maxAgeHours?: number): Promise<unknown>;
  /** Record a decision in a session. */
  recordDecision(params: {
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  }): Promise<unknown>;
  /** Record an assumption. */
  recordAssumption(params: {
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
    sessionId?: string;
    taskId?: string;
  }): Promise<unknown>;
  /** Get context drift metrics. */
  contextDrift(params?: { sessionId?: string }): Promise<unknown>;
  /** Get decision log. */
  decisionLog(params?: { sessionId?: string; taskId?: string }): Promise<unknown>;
  /** Get last handoff for a scope. */
  lastHandoff(scope?: { type: string; epicId?: string }): Promise<unknown>;
  /** Serialize a session into a complete snapshot for persistence. */
  serialize(params?: { sessionId?: string; maxObservations?: number }): Promise<unknown>;
  /** Restore a session from a previously serialized snapshot. */
  restore(snapshot: unknown, params?: { agent?: string; activate?: boolean }): Promise<unknown>;
}

/** Memory/Brain domain API. */
export interface MemoryAPI {
  /** Record a brain observation. */
  observe(params: { text: string; title?: string; type?: BrainObservationType }): Promise<unknown>;
  /** Find brain entries by query. */
  find(params: {
    query: string;
    limit?: number;
    tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  }): Promise<unknown>;
  /** Fetch brain entries by IDs. */
  fetch(params: { ids: string[] }): Promise<unknown>;
  /** Get temporal context around an anchor entry. */
  timeline(params: { anchor: string; depthBefore?: number; depthAfter?: number }): Promise<unknown>;
  /** Search brain entries. */
  search(query: string, options?: { limit?: number }): Promise<unknown>;
  /** Hybrid search combining FTS, vector, and graph. */
  hybridSearch(query: string, options?: HybridSearchOptions): Promise<unknown>;
}

/** Orchestration domain API. */
export interface OrchestrationAPI {
  /** Start orchestration for an epic. */
  start(epicId: string): Promise<unknown>;
  /** Analyze an epic's structure and dependencies. */
  analyze(epicId: string): Promise<unknown>;
  /** Get tasks ready to execute in an epic. */
  readyTasks(epicId: string): Promise<unknown>;
  /** Get the next recommended task in an epic. */
  nextTask(epicId: string): Promise<unknown>;
  /** Get orchestrator context for an epic. */
  context(epicId: string): Promise<unknown>;
  /** Build a dependency graph from tasks. */
  dependencyGraph(tasks: Task[]): unknown;
  /** Compute epic status summary. */
  epicStatus(epicId: string, title: string, children: Task[]): unknown;
  /** Compute progress metrics for tasks. */
  progress(tasks: Task[]): unknown;
}

/** Lifecycle pipeline domain API. */
export interface LifecycleAPI {
  /** Get lifecycle status for an epic. */
  status(epicId: string): Promise<unknown>;
  /** Start a pipeline stage. */
  startStage(epicId: string, stage: string): Promise<unknown>;
  /** Complete a pipeline stage. */
  completeStage(epicId: string, stage: string, artifacts?: string[]): Promise<unknown>;
  /** Skip a pipeline stage. */
  skipStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  /** Check gate requirements for a stage. */
  checkGate(epicId: string, targetStage: string): Promise<unknown>;
  /** Get lifecycle history for an epic. */
  history(epicId: string): Promise<unknown>;
  /** Reset a pipeline stage. */
  resetStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  /** Pass a gate check. */
  passGate(epicId: string, gateName: string, agent?: string): Promise<unknown>;
  /** Fail a gate check. */
  failGate(epicId: string, gateName: string, reason?: string): Promise<unknown>;
  /** Available pipeline stages. */
  stages: readonly string[];
  /**
   * Compute the canonical {@link TaskRollupPayload} for a single task.
   *
   * @remarks
   * T948: exposes `computeTaskRollup` (core) through the facade so Studio
   * and other consumers see the same projection the CLI sees. Returns
   * `null` when the task does not exist.
   */
  computeRollup(taskId: string): Promise<TaskRollupPayload | null>;
  /**
   * Compute rollups for many tasks in a single batch.
   *
   * @remarks
   * Order preserved; missing ids omitted. See `computeTaskRollups` for
   * the underlying batched implementation.
   */
  computeRollupsBatch(taskIds: string[]): Promise<TaskRollupPayload[]>;
}

/**
 * Public rollup payload shape re-exposed on the facade.
 *
 * Mirrors `TaskRollup` from `@cleocode/core/lifecycle/rollup`. Declared in
 * contracts so downstream consumers (Studio, CleoOS) type their view layer
 * without importing core.
 *
 * @task T948
 */
export interface TaskRollupPayload {
  /** Task identifier. */
  id: string;
  /**
   * Canonical execution status — mirrors `TaskStatus` plus the forward-looking
   * `'proposed'` intake value from T947+.
   */
  execStatus: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled' | 'archived' | 'proposed';
  /** Pipeline stage the task is parked on, or null. */
  pipelineStage: string | null;
  /** Names of gates with at least one `pass` result. */
  gatesVerified: string[];
  /** Count of non-archived direct children whose status is `done`. */
  childrenDone: number;
  /** Count of non-archived direct children. */
  childrenTotal: number;
  /** Tokens parsed from `tasks.blocked_by`. */
  blockedBy: string[];
  /** ISO timestamp of the most recent activity, or null. */
  lastActivityAt: string | null;
}

/** Release management domain API. */
export interface ReleaseAPI {
  /** Prepare a release. */
  prepare(params: { version: string; tasks?: string[]; notes?: string }): Promise<unknown>;
  /** Commit a release. */
  commit(params: { version: string }): Promise<unknown>;
  /** Tag a release. */
  tag(params: { version: string }): Promise<unknown>;
  /** Push a release. */
  push(params: { version: string; remote?: string; explicitPush?: boolean }): Promise<unknown>;
  /** Rollback a release. */
  rollback(params: { version: string; reason?: string }): Promise<unknown>;
  /** Calculate new version from bump type. */
  calculateVersion(current: string, bumpType: string): string;
  /** Bump version from config. */
  bumpVersion(): Promise<unknown>;
}

/** Admin domain API. */
export interface AdminAPI {
  /** Export tasks. */
  export(params?: Record<string, unknown>): Promise<unknown>;
  /** Import tasks from file. */
  import(params: Omit<ImportParams, 'cwd'>): Promise<unknown>;
}

/** Sticky notes domain API. */
export interface StickyAPI {
  /** Add a sticky note. */
  add(params: {
    content: string;
    tags?: string[];
    priority?: string;
    color?: string;
  }): Promise<unknown>;
  /** Show a sticky note. */
  show(stickyId: string): Promise<unknown>;
  /** List sticky notes with optional filters. */
  list(params?: {
    status?: string;
    color?: string;
    priority?: string;
    limit?: number;
  }): Promise<unknown>;
  /** Archive a sticky note. */
  archive(stickyId: string): Promise<unknown>;
  /** Purge a sticky note. */
  purge(stickyId: string): Promise<unknown>;
  /** Convert a sticky note to task or memory. */
  convert(params: {
    stickyId: string;
    targetType: 'task' | 'memory' | 'task_note' | 'session_note';
    title?: string;
    memoryType?: string;
    taskId?: string;
  }): Promise<unknown>;
}

/** Cross-project Nexus domain API. */
export interface NexusAPI {
  /** Initialize nexus for the current project. */
  init(): Promise<unknown>;
  /** Register a project in the nexus. */
  register(params: { path: string; name?: string; permissions?: string }): Promise<unknown>;
  /** Unregister a project from the nexus. */
  unregister(params: { name: string }): Promise<unknown>;
  /** List registered projects. */
  list(): Promise<unknown>;
  /** Show details of a registered project. */
  show(params: { name: string }): Promise<unknown>;
  /** Sync a project or all projects. */
  sync(params?: { name?: string }): Promise<unknown>;
  /** Discover related content across projects. */
  discover(params: { query: string; method?: string; limit?: number }): Promise<unknown>;
  /** Search across registered projects. */
  search(params: { pattern: string; project?: string; limit?: number }): Promise<unknown>;
  /** Set permission level for a project. */
  setPermission(params: { name: string; level: 'read' | 'write' | 'execute' }): Promise<unknown>;
  /** Get sharing status. */
  sharingStatus(): Promise<unknown>;
  /** Route a Conduit directive message to the correct project (ORCH-PLAN B.2). */
  route(message: ConduitMessage): Promise<unknown>;
  /** Get aggregated task status across all registered projects (ORCH-PLAN B.3). */
  workspaceStatus(): Promise<unknown>;
  /** Get all agents registered across all projects (ORCH-PLAN B.4). */
  workspaceAgents(): Promise<unknown>;
}

/** Task reconciliation / sync domain API. */
export interface SyncAPI {
  /** Reconcile external tasks with CLEO as SSoT. */
  reconcile(params: {
    externalTasks: ExternalTask[];
    providerId: string;
    dryRun?: boolean;
    conflictPolicy?: ReconcileOptions['conflictPolicy'];
    defaultPhase?: string;
    defaultLabels?: string[];
  }): Promise<ReconcileResult>;
  /** Get all external task links for a provider. */
  getLinks(providerId: string): Promise<ExternalTaskLink[]>;
  /** Get all external task links for a CLEO task. */
  getTaskLinks(taskId: string): Promise<ExternalTaskLink[]>;
  /** Remove all external task links for a provider. */
  removeProviderLinks(providerId: string): Promise<number>;
}

/** Agent registry domain API. */
export interface AgentsAPI {
  /** Register a new agent instance. */
  register(options: RegisterAgentOptions): Promise<AgentInstanceRow>;
  /** Deregister an agent instance. */
  deregister(agentId: string): Promise<AgentInstanceRow | null>;
  /** Get health status for a specific agent. */
  health(agentId: string): Promise<AgentHealthStatus | null>;
  /** Detect agents that have crashed (missed heartbeats). */
  detectCrashed(thresholdMs?: number): Promise<AgentInstanceRow[]>;
  /** Record a heartbeat for an agent. */
  recordHeartbeat(agentId: string): Promise<unknown>;
  /** Get capacity info for an agent. */
  capacity(agentId: string): Promise<AgentCapacity | null>;
  /** Check if system is overloaded (available capacity below threshold). */
  isOverloaded(threshold?: number): Promise<boolean>;
  /** List all agent instances with optional filters. */
  list(params?: { status?: string; agentType?: string }): Promise<AgentInstanceRow[]>;
}

/** Intelligence / impact analysis domain API. */
export interface IntelligenceAPI {
  /** Predict impact of a change description on related tasks. */
  predictImpact(change: string): Promise<ImpactReport>;
  /** Calculate blast radius for a task change. */
  blastRadius(taskId: string): Promise<BlastRadius>;
}

/** Options for initializing the Cleo facade. */
export interface CleoInitOptions {
  /** Custom data accessor (store backend). */
  store?: DataAccessor;
  /** Enable CAAMP injection. */
  caamp?: boolean;
}
