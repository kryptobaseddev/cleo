/**
 * Cleo — standalone facade for @cleocode/core
 *
 * Provides a project-bound API covering all 10 domains: tasks, sessions,
 * memory, orchestration, lifecycle, release, and admin.
 *
 * @example
 * // Pattern 1: Full instance
 * const cleo = await Cleo.init('./my-project');
 * await cleo.tasks.add({ title: 'Build API', description: 'REST endpoints' });
 *
 * @example
 * // Pattern 3: Custom store backend
 * const cleo = await Cleo.init('./my-project', { store: new MyCustomAccessor(connString) });
 *
 * @epic T5716
 */

import path from 'node:path';

// Tasks
import { addTask } from '../../../src/core/tasks/add.js';
import { archiveTasks } from '../../../src/core/tasks/archive.js';
import { completeTask } from '../../../src/core/tasks/complete.js';
import { deleteTask } from '../../../src/core/tasks/delete.js';
import { findTasks } from '../../../src/core/tasks/find.js';
import { listTasks } from '../../../src/core/tasks/list.js';
import { showTask } from '../../../src/core/tasks/show.js';
import { updateTask } from '../../../src/core/tasks/update.js';

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
} from '../../../src/core/sessions/index.js';

// Memory
import {
  fetchBrainEntries,
  observeBrain,
  searchBrainCompact,
  timelineBrain,
} from '../../../src/core/memory/brain-retrieval.js';
import { hybridSearch, searchBrain } from '../../../src/core/memory/brain-search.js';

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
} from '../../../src/core/orchestration/index.js';

// Lifecycle
import {
  checkGate,
  completeStage,
  failGate,
  getLifecycleHistory,
  getLifecycleStatus,
  passGate,
  PIPELINE_STAGES,
  resetStage,
  skipStage,
  startStage,
} from '../../../src/core/lifecycle/index.js';

// Release
import {
  bumpVersionFromConfig,
  calculateNewVersion,
  commitRelease,
  prepareRelease,
  pushRelease,
  rollbackRelease,
  tagRelease,
} from '../../../src/core/release/index.js';

// Admin
import { exportTasks } from '../../../src/core/admin/export.js';
import { importTasks } from '../../../src/core/admin/import.js';

// Store
import { createDataAccessor, getAccessor } from '../../../src/store/data-accessor.js';
import type { DataAccessor } from '../../../src/store/data-accessor.js';

// ============================================================================
// Re-export namespaces for direct access
// ============================================================================

export { tasks, sessions, memory, lifecycle } from '../../../src/core/index.js';

// ============================================================================
// Domain API interfaces
// ============================================================================

export interface TasksAPI {
  add(params: {
    title: string;
    description: string;
    parent?: string;
    priority?: string;
    type?: string;
    size?: string;
    phase?: string;
    labels?: string[];
    depends?: string[];
    notes?: string;
  }): Promise<unknown>;
  find(params: { query?: string; id?: string; status?: string; limit?: number }): Promise<unknown>;
  show(taskId: string): Promise<unknown>;
  list(params?: {
    status?: string;
    priority?: string;
    parentId?: string;
    phase?: string;
    limit?: number;
  }): Promise<unknown>;
  update(params: {
    taskId: string;
    title?: string;
    status?: string;
    priority?: string;
    description?: string;
    notes?: string;
  }): Promise<unknown>;
  complete(params: { taskId: string; notes?: string }): Promise<unknown>;
  delete(params: { taskId: string; force?: boolean }): Promise<unknown>;
  archive(params?: { before?: string; taskIds?: string[]; dryRun?: boolean }): Promise<unknown>;
}

export interface SessionsAPI {
  start(params: { name: string; scope: string; agent?: string }): Promise<unknown>;
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
  /** Suspend a specific session. */
  suspend(sessionId: string, reason?: string): Promise<unknown>;
  briefing(params?: { maxNextTasks?: number; scope?: string }): Promise<unknown>;
  /** Compute handoff for a specific session. */
  handoff(sessionId: string, options?: { note?: string; nextAction?: string }): Promise<unknown>;
  gc(maxAgeHours?: number): Promise<unknown>;
  /** Record a decision. Requires sessionId, taskId, decision, and rationale. */
  recordDecision(params: {
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternatives?: string[];
  }): Promise<unknown>;
  /** Record an assumption. Requires assumption and confidence. */
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
  observe(params: { text: string; title?: string; type?: string }): Promise<unknown>;
  find(params: {
    query: string;
    limit?: number;
    tables?: string[];
  }): Promise<unknown>;
  fetch(params: { ids: string[] }): Promise<unknown>;
  timeline(params: {
    anchor: string;
    depthBefore?: number;
    depthAfter?: number;
  }): Promise<unknown>;
  search(query: string, options?: { limit?: number }): Promise<unknown>;
  hybridSearch(query: string, options?: unknown): Promise<unknown>;
}

export interface OrchestrationAPI {
  start(epicId: string): Promise<unknown>;
  analyze(epicId: string): Promise<unknown>;
  readyTasks(epicId: string): Promise<unknown>;
  nextTask(epicId: string): Promise<unknown>;
  context(epicId: string): Promise<unknown>;
  dependencyGraph(tasks: unknown[]): unknown;
  epicStatus(epicId: string, title: string, children: unknown[]): unknown;
  progress(tasks: unknown[]): unknown;
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
  prepare(params: unknown): Promise<unknown>;
  commit(params: unknown): Promise<unknown>;
  tag(params: unknown): Promise<unknown>;
  push(params: unknown): Promise<unknown>;
  rollback(params: unknown): Promise<unknown>;
  calculateVersion(current: string, bumpType: string): string;
  bumpVersion(): Promise<unknown>;
}

export interface AdminAPI {
  export(params?: unknown): Promise<unknown>;
  import(params: unknown): Promise<unknown>;
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

/**
 * High-level project-bound facade for CLEO core.
 *
 * All operations are scoped to the project root provided at construction.
 * For lower-level access, use the namespace exports directly:
 *   import { tasks, sessions, memory } from '@cleocode/core';
 */
export class Cleo {
  /** Public project root — accessible by callers. */
  readonly projectRoot: string;

  private readonly _store: DataAccessor | null;

  private constructor(projectRoot: string, store: DataAccessor | null) {
    this.projectRoot = projectRoot;
    this._store = store;
  }

  /**
   * Create a project-bound Cleo instance (async, preferred).
   * Pre-creates a DataAccessor for efficient multi-operation use.
   */
  static async init(projectRoot: string, options?: CleoInitOptions): Promise<Cleo> {
    const resolvedRoot = path.resolve(projectRoot);
    const store = options?.store ?? (await getAccessor(resolvedRoot));
    return new Cleo(resolvedRoot, store);
  }

  /**
   * Create a project-bound Cleo instance synchronously.
   * DataAccessor is created lazily per operation.
   * For pre-created accessor, use Cleo.init() instead.
   */
  static forProject(projectRoot: string): Cleo {
    const resolvedRoot = path.resolve(projectRoot);
    return new Cleo(resolvedRoot, null);
  }

  // ==========================================================================
  // Tasks domain
  // ==========================================================================

  get tasks(): TasksAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      add: (params) =>
        addTask(
          {
            title: params.title,
            description: params.description,
            parentId: params.parent,
            priority: params.priority as never,
            type: params.type as never,
            size: params.size as never,
            phase: params.phase,
            labels: params.labels,
            depends: params.depends,
            notes: params.notes,
          },
          root,
          store,
        ),
      find: (params) =>
        findTasks(
          {
            query: params.query,
            id: params.id,
            status: params.status as never,
            limit: params.limit,
          },
          root,
          store,
        ),
      show: (taskId) => showTask(taskId, root, store),
      list: (params) =>
        listTasks(
          {
            status: params?.status as never,
            priority: params?.priority as never,
            parentId: params?.parentId,
            phase: params?.phase,
            limit: params?.limit,
          },
          root,
          store,
        ),
      update: (params) =>
        updateTask(
          {
            taskId: params.taskId,
            title: params.title,
            status: params.status as never,
            priority: params.priority as never,
            description: params.description,
            notes: params.notes,
          },
          root,
          store,
        ),
      complete: (params) =>
        completeTask({ taskId: params.taskId, notes: params.notes }, root, store),
      delete: (params) =>
        deleteTask({ taskId: params.taskId, force: params.force }, root, store),
      archive: (params) =>
        archiveTasks(
          {
            before: params?.before,
            taskIds: params?.taskIds,
            dryRun: params?.dryRun,
          },
          root,
          store,
        ),
    };
  }

  // ==========================================================================
  // Sessions domain
  // ==========================================================================

  get sessions(): SessionsAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      start: (params) =>
        startSession(
          { name: params.name, scope: params.scope, agent: params.agent },
          root,
          store,
        ),
      end: (params) => endSession({ note: params?.note }, root, store),
      status: () => sessionStatus(root, store),
      resume: (sessionId) => resumeSession(sessionId, root, store),
      list: (params) =>
        listSessions({ status: params?.status, limit: params?.limit }, root, store),
      find: (params) =>
        findSessions(store, {
          status: params?.status,
          scope: params?.scope,
          query: params?.query,
          limit: params?.limit,
        }),
      show: (sessionId) => showSession(root, sessionId),
      suspend: (sessionId, reason) => suspendSession(root, sessionId as string, reason),
      briefing: (params) =>
        computeBriefing(root, {
          maxNextTasks: params?.maxNextTasks,
          scope: params?.scope,
        }),
      handoff: (sessionId, options) =>
        computeHandoff(root, {
          sessionId: sessionId as string,
          note: options?.note,
          nextAction: options?.nextAction,
        }),
      gc: (maxAgeHours) => gcSessions(maxAgeHours, root, store),
      recordDecision: (params) =>
        recordDecision(root, {
          sessionId: params.sessionId,
          taskId: params.taskId,
          decision: params.decision,
          rationale: params.rationale,
          alternatives: params.alternatives,
        }),
      recordAssumption: (params) =>
        recordAssumption(root, {
          assumption: params.assumption,
          confidence: params.confidence,
          sessionId: params.sessionId,
          taskId: params.taskId,
        }),
      contextDrift: (params) => getContextDrift(root, params),
      decisionLog: (params) =>
        getDecisionLog(root, { sessionId: params?.sessionId, taskId: params?.taskId }),
      lastHandoff: (scope) => getLastHandoff(root, scope),
    };
  }

  // ==========================================================================
  // Memory domain
  // ==========================================================================

  get memory(): MemoryAPI {
    const root = this.projectRoot;
    return {
      observe: (params) =>
        observeBrain(root, {
          text: params.text,
          title: params.title,
          type: params.type as never,
        }),
      find: (params) =>
        searchBrainCompact(root, {
          query: params.query,
          limit: params.limit,
          tables: params.tables as never,
        }),
      fetch: (params) => fetchBrainEntries(root, { ids: params.ids }),
      timeline: (params) =>
        timelineBrain(root, {
          anchor: params.anchor,
          depthBefore: params.depthBefore,
          depthAfter: params.depthAfter,
        }),
      search: (query, options) => searchBrain(root, query, { limit: options?.limit }),
      hybridSearch: (query, options) => hybridSearch(query, root, options as never),
    };
  }

  // ==========================================================================
  // Orchestration domain
  // ==========================================================================

  get orchestration(): OrchestrationAPI {
    const root = this.projectRoot;
    const store = this._store ?? undefined;
    return {
      start: (epicId) => startOrchestration(epicId, root, store),
      analyze: (epicId) => analyzeEpic(epicId, root, store),
      readyTasks: (epicId) => getReadyTasks(epicId, root, store),
      nextTask: (epicId) => getNextTask(epicId, root, store),
      context: (epicId) => getOrchestratorContext(epicId, root, store),
      dependencyGraph: (tasks) => buildDependencyGraph(tasks as never),
      epicStatus: (epicId, title, children) =>
        computeEpicStatus(epicId, title, children as never),
      progress: (tasks) => computeProgress(tasks as never),
    };
  }

  // ==========================================================================
  // Lifecycle domain
  // ==========================================================================

  get lifecycle(): LifecycleAPI {
    const root = this.projectRoot;
    return {
      status: (epicId) => getLifecycleStatus(epicId, root),
      startStage: (epicId, stage) => startStage(epicId, stage, root),
      completeStage: (epicId, stage, artifacts) =>
        completeStage(epicId, stage, artifacts, root),
      skipStage: (epicId, stage, reason) => skipStage(epicId, stage, reason, root),
      checkGate: (epicId, targetStage) => checkGate(epicId, targetStage, root),
      history: (epicId) => getLifecycleHistory(epicId, root),
      resetStage: (epicId, stage, reason) => resetStage(epicId, stage, reason, root),
      passGate: (epicId, gateName, agent) =>
        passGate(epicId, gateName, agent, undefined, root),
      failGate: (epicId, gateName, reason) => failGate(epicId, gateName, reason, root),
      stages: PIPELINE_STAGES,
    };
  }

  // ==========================================================================
  // Release domain
  // ==========================================================================

  get release(): ReleaseAPI {
    const root = this.projectRoot;
    return {
      prepare: (params) => prepareRelease(params as never),
      commit: (params) => commitRelease(params as never),
      tag: (params) => tagRelease(params as never),
      push: (params) => pushRelease(params as never),
      rollback: (params) => rollbackRelease(params as never),
      calculateVersion: (current, bumpType) =>
        calculateNewVersion(current, bumpType as never),
      bumpVersion: () => bumpVersionFromConfig(root),
    };
  }

  // ==========================================================================
  // Admin domain
  // ==========================================================================

  get admin(): AdminAPI {
    const root = this.projectRoot;
    return {
      export: (params) => exportTasks({ cwd: root, ...(params as object) }),
      import: (params) => importTasks({ cwd: root, ...(params as object) } as never),
    };
  }
}

// Re-export types consumers need for Pattern 3
export type { DataAccessor };
export { getAccessor, createDataAccessor };

// Legacy type alias for backward compatibility
export type CleoTasksApi = TasksAPI;
