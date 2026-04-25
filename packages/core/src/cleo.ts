/**
 * Cleo — standalone facade for @cleocode/core
 *
 * Provides a project-bound API covering all 12 domain getter properties:
 * tasks, sessions, memory, orchestration, lifecycle, release, admin,
 * sticky, nexus, sync, agents, and intelligence.
 *
 * @example
 * const cleo = await Cleo.init('./my-project');
 * await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
 *
 * @example
 * // Custom store backend
 * const cleo = await Cleo.init('./my-project', { store: myCustomAccessor });
 */

import './lib/suppress-sqlite-warning.js';

import path from 'node:path';
import type {
  AdminAPI,
  AgentsAPI,
  CleoInitOptions,
  DataAccessor,
  IntelligenceAPI,
  LifecycleAPI,
  MemoryAPI,
  NexusAPI,
  OrchestrationAPI,
  ReleaseAPI,
  SessionsAPI,
  StickyAPI,
  SyncAPI,
  TasksAPI,
} from '@cleocode/contracts';
// Admin
import { exportTasks } from './admin/export.js';
import { importTasks } from './admin/import.js';
// Agents
import {
  checkAgentHealth,
  deregisterAgent,
  detectCrashedAgents,
  getAgentCapacity,
  heartbeat,
  isOverloaded,
  listAgentInstances,
  registerAgent,
} from './agents/index.js';
// Intelligence
import { calculateBlastRadius, predictImpact } from './intelligence/index.js';
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
import { computeTaskRollup, computeTaskRollups } from './lifecycle/rollup.js';
// Memory
import {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from './memory/brain-retrieval.js';
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
// Nexus workspace (ORCH-PLAN Phase B)
import {
  parseDirective,
  routeDirective,
  workspaceAgents,
  workspaceStatus,
} from './nexus/workspace.js';
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
// Session snapshots (Phase 3: persistence)
import { restoreSession, serializeSession } from './sessions/snapshot.js';
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
// Domain API interfaces — re-exported from @cleocode/contracts/facade
// ============================================================================

export type {
  AdminAPI,
  AgentsAPI,
  CleoInitOptions,
  IntelligenceAPI,
  LifecycleAPI,
  MemoryAPI,
  NexusAPI,
  OrchestrationAPI,
  ReleaseAPI,
  SessionsAPI,
  StickyAPI,
  SyncAPI,
  TasksAPI,
} from '@cleocode/contracts';

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
            type: p?.type,
            parentId: p?.parentId,
            phase: p?.phase,
            limit: p?.limit,
            excludeArchived: p?.excludeArchived,
            sortByPriority: p?.sortByPriority,
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
    return {
      start: (p) => startSession(root, { name: p.name, scope: p.scope, startTask: p.startTask }),
      end: (p) => endSession(root, { note: p?.note }),
      status: () => sessionStatus(root, {}),
      resume: (id) => resumeSession(root, { sessionId: id }),
      list: (p) => listSessions(root, { status: p?.status, limit: p?.limit }),
      find: (p) =>
        findSessions(root, {
          status: p?.status,
          scope: p?.scope,
          query: p?.query,
          limit: p?.limit,
        }),
      show: (id) => showSession(root, { sessionId: id }),
      suspend: (id, reason) => suspendSession(root, { sessionId: id, reason }),
      briefing: (p) => computeBriefing(root, { maxNextTasks: p?.maxNextTasks, scope: p?.scope }),
      handoff: (id, opts) =>
        computeHandoff(root, { sessionId: id, note: opts?.note, nextAction: opts?.nextAction }),
      gc: (hours) => gcSessions(hours, root, store),
      recordDecision: (p) => recordDecision(root, p),
      recordAssumption: (p) => recordAssumption(root, p),
      contextDrift: (p) => getContextDrift(root, p ?? {}),
      decisionLog: (p) => getDecisionLog(root, { sessionId: p?.sessionId, taskId: p?.taskId }),
      lastHandoff: (scope) => getLastHandoff(root, scope),
      serialize: (p) =>
        serializeSession(root, {
          sessionId: p?.sessionId,
          maxObservations: p?.maxObservations,
        }),
      restore: (snapshot, p) =>
        restoreSession(root, snapshot as import('./sessions/snapshot.js').SessionSnapshot, {
          agent: p?.agent,
          activate: p?.activate,
        }),
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
    const resolveAccessor = (): Promise<DataAccessor> =>
      this._store !== null ? Promise.resolve(this._store) : getAccessor(root);
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
      // T948: expose rollup so Studio + CLI share a single canonical
      // projection for "what is the state of this task?".
      computeRollup: async (taskId) => computeTaskRollup(taskId, await resolveAccessor()),
      computeRollupsBatch: async (taskIds) => computeTaskRollups(taskIds, await resolveAccessor()),
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
      export: (p) => exportTasks(root, p ?? {}),
      import: (p) => importTasks(root, p),
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
      route: (message) => {
        const directive = parseDirective(message);
        if (!directive) return Promise.resolve([]);
        return routeDirective(directive);
      },
      workspaceStatus: () => workspaceStatus(),
      workspaceAgents: () => workspaceAgents(),
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
