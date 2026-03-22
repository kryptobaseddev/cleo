/**
 * Cleo — standalone facade for @cleocode/core
 *
 * Provides a project-bound API covering all 10 canonical domains:
 * tasks, sessions, memory, orchestration, lifecycle, release, admin,
 * check, sticky, and nexus.
 *
 * @example
 * const cleo = await Cleo.init('./my-project');
 * await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
 *
 * @example
 * // Custom store backend
 * const cleo = await Cleo.init('./my-project', { store: myCustomAccessor });
 */

import path from 'node:path';
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
} from '@cleocode/contracts';
// Admin
import { exportTasks } from './admin/export.js';
import type { ImportParams } from './admin/import.js';
import { importTasks } from './admin/import.js';
// Agents
import {
  type AgentCapacity,
  type AgentHealthStatus,
  type AgentInstanceRow,
  checkAgentHealth,
  deregisterAgent,
  detectCrashedAgents,
  getAgentCapacity,
  heartbeat,
  isOverloaded,
  listAgentInstances,
  type RegisterAgentOptions,
  registerAgent,
} from './agents/index.js';
// Intelligence
import {
  type BlastRadius,
  calculateBlastRadius,
  type ImpactReport,
  predictImpact,
} from './intelligence/index.js';
// Lifecycle
import {
  checkGate,
  completeStage,
  failGate,
  getLifecycleHistory,
  getLifecycleStatus,
  PIPELINE_STAGES,
  passGate,
  resetStage,
  skipStage,
  startStage,
} from './lifecycle/index.js';
import type { BrainObservationType } from './memory/brain-retrieval.js';
// Memory
import {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from './memory/brain-retrieval.js';
import type { HybridSearchOptions } from './memory/brain-search.js';
import { hybridSearch, searchBrain } from './memory/brain-search.js';
// Nexus
import { discoverRelated, searchAcrossProjects } from './nexus/discover.js';
import { setPermission } from './nexus/permissions.js';
import {
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
} from './nexus/registry.js';
import { getSharingStatus } from './nexus/sharing/index.js';
// Orchestration
import {
  analyzeEpic,
  buildDependencyGraph,
  computeEpicStatus,
  computeProgress,
  getNextTask,
  getOrchestratorContext,
  getReadyTasks,
  startOrchestration,
} from './orchestration/index.js';
// Reconciliation (sync)
import { reconcile } from './reconciliation/index.js';
import {
  getLinksByProvider,
  getLinksByTaskId,
  removeLinksByProvider,
} from './reconciliation/link-store.js';

// Release
import {
  bumpVersionFromConfig,
  calculateNewVersion,
  commitRelease,
  prepareRelease,
  pushRelease,
  rollbackRelease,
  tagRelease,
} from './release/index.js';
// Sessions
import {
  computeBriefing,
  computeHandoff,
  endSession,
  findSessions,
  gcSessions,
  getContextDrift,
  getDecisionLog,
  getLastHandoff,
  listSessions,
  recordAssumption,
  recordDecision,
  resumeSession,
  sessionStatus,
  showSession,
  startSession,
  suspendSession,
} from './sessions/index.js';
// Sticky
import {
  addSticky,
  archiveSticky,
  convertStickyToMemory,
  convertStickyToTask,
  getSticky,
  listStickies,
  purgeSticky,
} from './sticky/index.js';
// Store
import { getAccessor } from './store/data-accessor.js';
// Task Work (start/stop/current)
import { currentTask, startTask, stopTask } from './task-work/index.js';
// Tasks
import { addTask } from './tasks/add.js';
import { archiveTasks } from './tasks/archive.js';
import { completeTask } from './tasks/complete.js';
import { deleteTask } from './tasks/delete.js';
import { findTasks } from './tasks/find.js';
import { listTasks } from './tasks/list.js';
import { showTask } from './tasks/show.js';
import { updateTask } from './tasks/update.js';

// ============================================================================
// Domain API interfaces
// ============================================================================

export interface TasksAPI {
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
  find(params: {
    query?: string;
    id?: string;
    status?: TaskStatus;
    limit?: number;
  }): Promise<unknown>;
  show(taskId: string): Promise<unknown>;
  list(params?: {
    status?: TaskStatus;
    priority?: TaskPriority;
    parentId?: string;
    phase?: string;
    limit?: number;
  }): Promise<unknown>;
  update(params: {
    taskId: string;
    title?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    description?: string;
    notes?: string;
  }): Promise<unknown>;
  complete(params: { taskId: string; notes?: string }): Promise<unknown>;
  delete(params: { taskId: string; force?: boolean }): Promise<unknown>;
  archive(params?: { before?: string; taskIds?: string[]; dryRun?: boolean }): Promise<unknown>;
  /** Start working on a specific task (sets focus). */
  start(taskId: string): Promise<unknown>;
  /** Stop working on the current task (clears focus). */
  stop(): Promise<{ previousTask: string | null }>;
  /** Get the current task work state. */
  current(): Promise<unknown>;
}

export interface SessionsAPI {
  start(params: {
    name: string;
    scope: string;
    agent?: string;
    startTask?: string;
  }): Promise<unknown>;
  end(params?: { note?: string }): Promise<unknown>;
  status(): Promise<unknown>;
  resume(sessionId: string): Promise<unknown>;
  list(params?: { status?: string; limit?: number }): Promise<unknown>;
  find(params?: {
    status?: string;
    scope?: string;
    query?: string;
    limit?: number;
  }): Promise<unknown>;
  show(sessionId: string): Promise<unknown>;
  suspend(sessionId: string, reason?: string): Promise<unknown>;
  briefing(params?: { maxNextTasks?: number; scope?: string }): Promise<unknown>;
  handoff(sessionId: string, options?: { note?: string; nextAction?: string }): Promise<unknown>;
  gc(maxAgeHours?: number): Promise<unknown>;
  recordDecision(params: {
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  }): Promise<unknown>;
  recordAssumption(params: {
    assumption: string;
    confidence: 'high' | 'medium' | 'low';
    sessionId?: string;
    taskId?: string;
  }): Promise<unknown>;
  contextDrift(params?: { sessionId?: string }): Promise<unknown>;
  decisionLog(params?: { sessionId?: string; taskId?: string }): Promise<unknown>;
  lastHandoff(scope?: { type: string; epicId?: string }): Promise<unknown>;
}

export interface MemoryAPI {
  observe(params: { text: string; title?: string; type?: BrainObservationType }): Promise<unknown>;
  find(params: {
    query: string;
    limit?: number;
    tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  }): Promise<unknown>;
  fetch(params: { ids: string[] }): Promise<unknown>;
  timeline(params: { anchor: string; depthBefore?: number; depthAfter?: number }): Promise<unknown>;
  search(query: string, options?: { limit?: number }): Promise<unknown>;
  hybridSearch(query: string, options?: HybridSearchOptions): Promise<unknown>;
}

export interface OrchestrationAPI {
  start(epicId: string): Promise<unknown>;
  analyze(epicId: string): Promise<unknown>;
  readyTasks(epicId: string): Promise<unknown>;
  nextTask(epicId: string): Promise<unknown>;
  context(epicId: string): Promise<unknown>;
  dependencyGraph(tasks: Task[]): unknown;
  epicStatus(epicId: string, title: string, children: Task[]): unknown;
  progress(tasks: Task[]): unknown;
}

export interface LifecycleAPI {
  status(epicId: string): Promise<unknown>;
  startStage(epicId: string, stage: string): Promise<unknown>;
  completeStage(epicId: string, stage: string, artifacts?: string[]): Promise<unknown>;
  skipStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  checkGate(epicId: string, targetStage: string): Promise<unknown>;
  history(epicId: string): Promise<unknown>;
  resetStage(epicId: string, stage: string, reason: string): Promise<unknown>;
  passGate(epicId: string, gateName: string, agent?: string): Promise<unknown>;
  failGate(epicId: string, gateName: string, reason?: string): Promise<unknown>;
  stages: readonly string[];
}

export interface ReleaseAPI {
  prepare(params: { version: string; tasks?: string[]; notes?: string }): Promise<unknown>;
  commit(params: { version: string }): Promise<unknown>;
  tag(params: { version: string }): Promise<unknown>;
  push(params: { version: string; remote?: string; explicitPush?: boolean }): Promise<unknown>;
  rollback(params: { version: string; reason?: string }): Promise<unknown>;
  calculateVersion(current: string, bumpType: string): string;
  bumpVersion(): Promise<unknown>;
}

export interface AdminAPI {
  export(params?: Record<string, unknown>): Promise<unknown>;
  import(params: Omit<ImportParams, 'cwd'>): Promise<unknown>;
}

export interface StickyAPI {
  add(params: {
    content: string;
    tags?: string[];
    priority?: string;
    color?: string;
  }): Promise<unknown>;
  show(stickyId: string): Promise<unknown>;
  list(params?: {
    status?: string;
    color?: string;
    priority?: string;
    limit?: number;
  }): Promise<unknown>;
  archive(stickyId: string): Promise<unknown>;
  purge(stickyId: string): Promise<unknown>;
  convert(params: {
    stickyId: string;
    targetType: 'task' | 'memory' | 'task_note' | 'session_note';
    title?: string;
    memoryType?: string;
    taskId?: string;
  }): Promise<unknown>;
}

export interface NexusAPI {
  init(): Promise<unknown>;
  register(params: { path: string; name?: string; permissions?: string }): Promise<unknown>;
  unregister(params: { name: string }): Promise<unknown>;
  list(): Promise<unknown>;
  show(params: { name: string }): Promise<unknown>;
  sync(params?: { name?: string }): Promise<unknown>;
  discover(params: { query: string; method?: string; limit?: number }): Promise<unknown>;
  search(params: { pattern: string; project?: string; limit?: number }): Promise<unknown>;
  setPermission(params: { name: string; level: 'read' | 'write' | 'execute' }): Promise<unknown>;
  sharingStatus(): Promise<unknown>;
}

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

export interface IntelligenceAPI {
  /** Predict impact of a change description on related tasks. */
  predictImpact(change: string): Promise<ImpactReport>;
  /** Calculate blast radius for a task change. */
  blastRadius(taskId: string): Promise<BlastRadius>;
}

// ============================================================================
// Init options
// ============================================================================

export interface CleoInitOptions {
  store?: DataAccessor;
  caamp?: boolean;
}

// ============================================================================
// Cleo facade class
// ============================================================================

export class Cleo {
  readonly projectRoot: string;
  private readonly _store: DataAccessor | null;

  private constructor(projectRoot: string, store: DataAccessor | null) {
    this.projectRoot = projectRoot;
    this._store = store;
  }

  static async init(projectRoot: string, options?: CleoInitOptions): Promise<Cleo> {
    const resolvedRoot = path.resolve(projectRoot);
    const store = options?.store ?? (await getAccessor(resolvedRoot));
    return new Cleo(resolvedRoot, store);
  }

  static forProject(projectRoot: string): Cleo {
    return new Cleo(path.resolve(projectRoot), null);
  }

  // === Tasks ===
  get tasks(): TasksAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      add: (p) =>
        addTask(
          {
            title: p.title,
            description: p.description,
            parentId: p.parent,
            priority: p.priority,
            type: p.type,
            size: p.size,
            phase: p.phase,
            labels: p.labels,
            depends: p.depends,
            notes: p.notes,
          },
          root,
          store,
        ),
      find: (p) =>
        findTasks({ query: p.query, id: p.id, status: p.status, limit: p.limit }, root, store),
      show: (taskId) => showTask(taskId, root, store),
      list: (p) =>
        listTasks(
          {
            status: p?.status,
            priority: p?.priority,
            parentId: p?.parentId,
            phase: p?.phase,
            limit: p?.limit,
          },
          root,
          store,
        ),
      update: (p) =>
        updateTask(
          {
            taskId: p.taskId,
            title: p.title,
            status: p.status,
            priority: p.priority,
            description: p.description,
            notes: p.notes,
          },
          root,
          store,
        ),
      complete: (p) => completeTask({ taskId: p.taskId, notes: p.notes }, root, store),
      delete: (p) => deleteTask({ taskId: p.taskId, force: p.force }, root, store),
      archive: (p) =>
        archiveTasks({ before: p?.before, taskIds: p?.taskIds, dryRun: p?.dryRun }, root, store),
      start: (taskId) => startTask(taskId, root, store),
      stop: () => stopTask(root, store),
      current: () => currentTask(root, store),
    };
  }

  // === Sessions ===
  get sessions(): SessionsAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      start: (p) =>
        startSession(
          { name: p.name, scope: p.scope, agent: p.agent, startTask: p.startTask },
          root,
          store,
        ),
      end: (p) => endSession({ note: p?.note }, root, store),
      status: () => sessionStatus(root, store),
      resume: (id) => resumeSession(id, root, store),
      list: (p) => listSessions({ status: p?.status, limit: p?.limit }, root, store),
      find: async (p) =>
        findSessions(store ?? (await getAccessor(root)), {
          status: p?.status,
          scope: p?.scope,
          query: p?.query,
          limit: p?.limit,
        }),
      show: (id) => showSession(root, id),
      suspend: (id, reason) => suspendSession(root, id, reason),
      briefing: (p) => computeBriefing(root, { maxNextTasks: p?.maxNextTasks, scope: p?.scope }),
      handoff: (id, opts) =>
        computeHandoff(root, { sessionId: id, note: opts?.note, nextAction: opts?.nextAction }),
      gc: (hours) => gcSessions(hours, root, store),
      recordDecision: (p) => recordDecision(root, p),
      recordAssumption: (p) => recordAssumption(root, p),
      contextDrift: (p) => getContextDrift(root, p),
      decisionLog: (p) => getDecisionLog(root, { sessionId: p?.sessionId, taskId: p?.taskId }),
      lastHandoff: (scope) => getLastHandoff(root, scope),
    };
  }

  // === Memory ===
  get memory(): MemoryAPI {
    const root = this.projectRoot;
    return {
      observe: (p) => observeBrain(root, { text: p.text, title: p.title, type: p.type }),
      find: (p) => searchBrainCompact(root, { query: p.query, limit: p.limit, tables: p.tables }),
      fetch: (p) => fetchBrainEntries(root, { ids: p.ids }),
      timeline: (p) =>
        timelineBrain(root, {
          anchor: p.anchor,
          depthBefore: p.depthBefore,
          depthAfter: p.depthAfter,
        }),
      search: (query, opts) => searchBrain(root, query, { limit: opts?.limit }),
      hybridSearch: (query, opts) => hybridSearch(query, root, opts),
    };
  }

  // === Orchestration ===
  get orchestration(): OrchestrationAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      start: (epicId) => startOrchestration(epicId, root, store),
      analyze: (epicId) => analyzeEpic(epicId, root, store),
      readyTasks: (epicId) => getReadyTasks(epicId, root, store),
      nextTask: (epicId) => getNextTask(epicId, root, store),
      context: (epicId) => getOrchestratorContext(epicId, root, store),
      dependencyGraph: (t) => buildDependencyGraph(t),
      epicStatus: (id, title, children) => computeEpicStatus(id, title, children),
      progress: (t) => computeProgress(t),
    };
  }

  // === Lifecycle ===
  get lifecycle(): LifecycleAPI {
    const root = this.projectRoot;
    return {
      status: (epicId) => getLifecycleStatus(epicId, root),
      startStage: (epicId, stage) => startStage(epicId, stage, root),
      completeStage: (epicId, stage, artifacts) => completeStage(epicId, stage, artifacts, root),
      skipStage: (epicId, stage, reason) => skipStage(epicId, stage, reason, root),
      checkGate: (epicId, target) => checkGate(epicId, target, root),
      history: (epicId) => getLifecycleHistory(epicId, root),
      resetStage: (epicId, stage, reason) => resetStage(epicId, stage, reason, root),
      passGate: (epicId, gate, agent) => passGate(epicId, gate, agent, undefined, root),
      failGate: (epicId, gate, reason) => failGate(epicId, gate, reason, root),
      stages: PIPELINE_STAGES,
    };
  }

  // === Release ===
  get release(): ReleaseAPI {
    const root = this.projectRoot;
    return {
      prepare: (p) => prepareRelease(p.version, p.tasks, p.notes, async () => [], root),
      commit: (p) => commitRelease(p.version, root),
      tag: (p) => tagRelease(p.version, root),
      push: (p) => pushRelease(p.version, p.remote, root, { explicitPush: p.explicitPush }),
      rollback: (p) => rollbackRelease(p.version, p.reason, root),
      calculateVersion: (cur, bump) => calculateNewVersion(cur, bump),
      bumpVersion: async () => bumpVersionFromConfig(root),
    };
  }

  // === Admin ===
  get admin(): AdminAPI {
    const root = this.projectRoot;
    return {
      export: (p) => exportTasks({ cwd: root, ...p }),
      import: (p) => importTasks({ ...p, cwd: root }),
    };
  }

  // === Sticky ===
  get sticky(): StickyAPI {
    const root = this.projectRoot;
    return {
      add: (p) =>
        addSticky(
          {
            content: p.content,
            tags: p.tags,
            priority: p.priority as 'low' | 'medium' | 'high' | undefined,
            color: p.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
          },
          root,
        ),
      show: (id) => getSticky(id, root),
      list: (p) =>
        listStickies(
          {
            status: p?.status as 'active' | 'converted' | 'archived' | undefined,
            color: p?.color as 'yellow' | 'blue' | 'green' | 'red' | 'purple' | undefined,
            priority: p?.priority as 'low' | 'medium' | 'high' | undefined,
            limit: p?.limit,
          },
          root,
        ),
      archive: (id) => archiveSticky(id, root),
      purge: (id) => purgeSticky(id, root),
      convert: (p) => {
        if (p.targetType === 'task') return convertStickyToTask(p.stickyId, p.title, root);
        if (p.targetType === 'memory') return convertStickyToMemory(p.stickyId, p.memoryType, root);
        return convertStickyToTask(p.stickyId, p.title, root);
      },
    };
  }

  // === Nexus ===
  get nexus(): NexusAPI {
    return {
      init: () => nexusInit(),
      register: (p) =>
        nexusRegister(p.path, p.name, p.permissions as 'read' | 'write' | 'execute' | undefined),
      unregister: (p) => nexusUnregister(p.name),
      list: () => nexusList(),
      show: (p) => nexusGetProject(p.name),
      sync: (p) => (p?.name ? nexusSync(p.name) : nexusSyncAll()),
      discover: (p) => discoverRelated(p.query, p.method, p.limit),
      search: (p) => searchAcrossProjects(p.pattern, p.project, p.limit),
      setPermission: (p) => setPermission(p.name, p.level),
      sharingStatus: () => getSharingStatus(),
    };
  }

  // === Agents ===
  get agents(): AgentsAPI {
    const root = this.projectRoot;
    return {
      register: (opts) => registerAgent(opts, root),
      deregister: (agentId) => deregisterAgent(agentId, root),
      health: (agentId) => checkAgentHealth(agentId, undefined, root),
      detectCrashed: (thresholdMs) => detectCrashedAgents(thresholdMs, root),
      recordHeartbeat: (agentId) => heartbeat(agentId, root),
      capacity: (agentId) => getAgentCapacity(agentId, root),
      isOverloaded: (threshold) => isOverloaded(threshold, root),
      list: (p) =>
        listAgentInstances(
          {
            status: p?.status as 'active' | 'idle' | 'crashed' | undefined,
            agentType: p?.agentType as import('./agents/index.js').AgentType | undefined,
          },
          root,
        ),
    };
  }

  // === Intelligence ===
  get intelligence(): IntelligenceAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      predictImpact: (change) => predictImpact(change, root, store ?? undefined),
      blastRadius: (taskId) => calculateBlastRadius(taskId, store ?? undefined, root),
    };
  }

  // === Sync (Task Reconciliation) ===
  get sync(): SyncAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      reconcile: (p) =>
        reconcile(
          p.externalTasks,
          {
            providerId: p.providerId,
            cwd: root,
            dryRun: p.dryRun,
            conflictPolicy: p.conflictPolicy,
            defaultPhase: p.defaultPhase,
            defaultLabels: p.defaultLabels,
          },
          store,
        ),
      getLinks: (providerId) => getLinksByProvider(providerId, root),
      getTaskLinks: (taskId) => getLinksByTaskId(taskId, root),
      removeProviderLinks: (providerId) => removeLinksByProvider(providerId, root),
    };
  }
}
