/**
 * Store provider abstraction layer.
 *
 * Defines the StoreProvider interface that both JSON and SQLite stores implement.
 * CLI and MCP engine use StoreProvider — switchable via config.
 *
 * Config flag: storage.engine: "json" | "sqlite" in .cleo/config.json
 * Default: "sqlite" for new projects, "json" for existing (until migrated).
 *
 * @epic T4454
 * @task W1-T6
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../core/paths.js';
import type { Task, TaskStatus, TaskType } from '../types/task.js';
import type { Session } from '../types/session.js';
import type { DataAccessor } from './data-accessor.js';
import { getAccessor } from './data-accessor.js';

// Domain operation types - re-exported from core modules
import type { AddTaskOptions, AddTaskResult } from '../core/tasks/add.js';
import type { CompleteTaskOptions, CompleteTaskResult } from '../core/tasks/complete.js';
import type { UpdateTaskOptions, UpdateTaskResult } from '../core/tasks/update.js';
import type { DeleteTaskOptions, DeleteTaskResult } from '../core/tasks/delete.js';
import type { FindTasksOptions, FindTasksResult } from '../core/tasks/find.js';
import type { ListTasksOptions, ListTasksResult } from '../core/tasks/list.js';
import type { ArchiveTasksOptions, ArchiveTasksResult } from '../core/tasks/archive.js';
import type { FocusShowResult, FocusSetResult, FocusHistoryEntry } from '../core/focus/index.js';
import type { AnalysisResult } from '../core/tasks/analyze.js';

// Re-export domain operation types for CLI consumers
export type {
  AddTaskOptions, AddTaskResult,
  CompleteTaskOptions, CompleteTaskResult,
  UpdateTaskOptions, UpdateTaskResult,
  DeleteTaskOptions, DeleteTaskResult,
  FindTasksOptions, FindTasksResult,
  ListTasksOptions, ListTasksResult,
  ArchiveTasksOptions, ArchiveTasksResult,
  FocusShowResult, FocusSetResult, FocusHistoryEntry,
  AnalysisResult,
};

/**
 * Store engine type.
 * 'dual' writes to both JSON and SQLite, reads from SQLite with JSON fallback.
 * @task T4647
 */
export type StoreEngine = 'json' | 'sqlite' | 'dual';

/** Common task filter options. */
export interface TaskFilters {
  status?: TaskStatus;
  parentId?: string | null;
  type?: TaskType;
  phase?: string;
  limit?: number;
}

/** Common session filter options. */
export interface SessionFilters {
  active?: boolean;
  limit?: number;
}

/**
 * Store provider interface.
 * Both JSON and SQLite stores implement this contract.
 */
export interface StoreProvider {
  readonly engine: StoreEngine;

  // Task CRUD
  createTask(task: Task): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<Task | null>;
  deleteTask(taskId: string): Promise<boolean>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  findTasks(query: string, limit?: number): Promise<Task[]>;
  archiveTask(taskId: string, reason?: string): Promise<boolean>;

  // Session CRUD
  createSession(session: Session): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  updateSession(sessionId: string, updates: Partial<Session>): Promise<Session | null>;
  listSessions(filters?: SessionFilters): Promise<Session[]>;
  endSession(sessionId: string, note?: string): Promise<Session | null>;

  // Focus
  setFocus(sessionId: string, taskId: string): Promise<void>;
  getFocus(sessionId: string): Promise<{ taskId: string | null; since: string | null }>;
  clearFocus(sessionId: string): Promise<void>;

  // Lifecycle
  close(): Promise<void>;

  // ---- High-level domain operations ----
  // These wrap core business logic (validation, ID generation, logging, etc.)
  // and are the primary API for CLI commands and MCP engine.
  // @task T4656
  // @epic T4654

  /** Add a task with full validation, ID generation, and logging. */
  addTask(options: AddTaskOptions): Promise<AddTaskResult>;
  /** Complete a task with dependency checks and optional auto-completion. */
  completeTask(options: CompleteTaskOptions): Promise<CompleteTaskResult>;
  /** Update a task with rich options (addLabels, removeDepends, etc.). */
  richUpdateTask(options: UpdateTaskOptions): Promise<UpdateTaskResult>;
  /** Show a task by ID (throws CleoError if not found). */
  showTask(taskId: string): Promise<Task>;
  /** Delete a task with force/cascade options. */
  richDeleteTask(options: DeleteTaskOptions): Promise<DeleteTaskResult>;
  /** Find tasks with fuzzy/ID/exact search and filtering. */
  richFindTasks(options: FindTasksOptions): Promise<FindTasksResult>;
  /** List tasks with full filtering and pagination. */
  richListTasks(options: ListTasksOptions): Promise<ListTasksResult>;
  /** Archive tasks in batch with filtering options. */
  richArchiveTasks(options: ArchiveTasksOptions): Promise<ArchiveTasksResult>;

  // High-level session operations
  /** Start a new session with scope, auto-focus, etc. */
  startSession(options: {
    name: string;
    scope: string;
    autoFocus?: boolean;
    focus?: string;
    agent?: string;
  }): Promise<Session>;
  /** End a session, optionally by ID with a note. */
  richEndSession(options?: { sessionId?: string; note?: string }): Promise<Session>;
  /** Get the current active session status. */
  sessionStatus(): Promise<Session | null>;
  /** Resume a previously ended session. */
  resumeSession(sessionId: string): Promise<Session>;
  /** List sessions with status/limit filters. */
  richListSessions(options?: { status?: string; limit?: number }): Promise<Session[]>;
  /** Garbage collect old sessions. */
  gcSessions(maxAgeHours?: number): Promise<{ orphaned: string[]; removed: string[] }>;

  // High-level focus operations (no session ID needed)
  /** Show current focus state. */
  showFocus(): Promise<FocusShowResult>;
  /** Set focus to a task by ID. */
  richSetFocus(taskId: string): Promise<FocusSetResult>;
  /** Clear current focus. */
  richClearFocus(): Promise<{ previousTask: string | null }>;
  /** Get focus history. */
  getFocusHistory(): Promise<FocusHistoryEntry[]>;

  // Label operations
  /** List all labels with task counts. */
  listLabels(): Promise<Array<{ label: string; count: number; statuses: Record<string, number> }>>;
  /** Show tasks with a specific label. */
  showLabelTasks(label: string): Promise<Record<string, unknown>>;
  /** Get detailed label statistics. */
  getLabelStats(): Promise<Record<string, unknown>>;

  // Relationship operations
  /** Suggest related tasks based on shared attributes. */
  suggestRelated(taskId: string, opts?: { threshold?: number }): Promise<Record<string, unknown>>;
  /** Add a relationship between two tasks. */
  addRelation(from: string, to: string, type: string, reason: string): Promise<Record<string, unknown>>;
  /** Discover related tasks using various methods. */
  discoverRelated(taskId: string): Promise<Record<string, unknown>>;
  /** List existing relations for a task. */
  listRelations(taskId: string): Promise<Record<string, unknown>>;

  // Analysis operations
  /** Analyze task priority with leverage scoring. */
  analyzeTaskPriority(opts?: { autoFocus?: boolean }): Promise<AnalysisResult>;
}

/**
 * Create high-level domain operation methods that delegate to core modules.
 * An accessor is created once and passed to every core call, ensuring that
 * the configured storage engine (JSON, SQLite, dual) is actually used.
 *
 * @task T4656
 * @epic T4654
 */
async function createDomainOps(cwd?: string, accessor?: DataAccessor): Promise<Pick<StoreProvider,
  'addTask' | 'completeTask' | 'richUpdateTask' | 'showTask' |
  'richDeleteTask' | 'richFindTasks' | 'richListTasks' | 'richArchiveTasks' |
  'startSession' | 'richEndSession' | 'sessionStatus' | 'resumeSession' |
  'richListSessions' | 'gcSessions' |
  'showFocus' | 'richSetFocus' | 'richClearFocus' | 'getFocusHistory' |
  'listLabels' | 'showLabelTasks' | 'getLabelStats' |
  'suggestRelated' | 'addRelation' | 'discoverRelated' | 'listRelations' |
  'analyzeTaskPriority'
>> {
  const { addTask } = await import('../core/tasks/add.js');
  const { completeTask } = await import('../core/tasks/complete.js');
  const { updateTask } = await import('../core/tasks/update.js');
  const { showTask } = await import('../core/tasks/show.js');
  const { deleteTask } = await import('../core/tasks/delete.js');
  const { findTasks } = await import('../core/tasks/find.js');
  const { listTasks } = await import('../core/tasks/list.js');
  const { archiveTasks } = await import('../core/tasks/archive.js');
  const labels = await import('../core/tasks/labels.js');
  const relates = await import('../core/tasks/relates.js');
  const { analyzeTaskPriority } = await import('../core/tasks/analyze.js');
  const sessions = await import('../core/sessions/index.js');
  const focus = await import('../core/focus/index.js');

  // Resolve accessor once; all domain ops share the same instance.
  // If not provided, auto-detect from config (getAccessor).
  const acc = accessor ?? await getAccessor(cwd);

  return {
    addTask: (options) => addTask(options, cwd, acc),
    completeTask: (options) => completeTask(options, cwd, acc),
    richUpdateTask: (options) => updateTask(options, cwd, acc),
    showTask: (taskId) => showTask(taskId, cwd, acc),
    richDeleteTask: (options) => deleteTask(options, cwd, acc),
    richFindTasks: (options) => findTasks(options, cwd, acc),
    richListTasks: (options) => listTasks(options, cwd, acc),
    richArchiveTasks: (options) => archiveTasks(options, cwd, acc),
    listLabels: () => labels.listLabels(cwd, acc),
    showLabelTasks: (label) => labels.showLabelTasks(label, cwd, acc),
    getLabelStats: () => labels.getLabelStats(cwd, acc),
    suggestRelated: (taskId, opts) => relates.suggestRelated(taskId, { ...opts, cwd }, acc),
    addRelation: (from, to, type, reason) => relates.addRelation(from, to, type, reason, cwd, acc),
    discoverRelated: (taskId) => relates.discoverRelated(taskId, cwd, acc),
    listRelations: (taskId) => relates.listRelations(taskId, cwd, acc),
    analyzeTaskPriority: (opts) => analyzeTaskPriority({ ...opts, cwd }, acc),
    startSession: (options) => sessions.startSession(options, cwd, acc),
    richEndSession: (options) => sessions.endSession(options, cwd, acc),
    sessionStatus: () => sessions.sessionStatus(cwd, acc),
    resumeSession: (sessionId) => sessions.resumeSession(sessionId, cwd, acc),
    richListSessions: (options) => sessions.listSessions(options, cwd, acc),
    gcSessions: (maxAgeHours) => sessions.gcSessions(maxAgeHours, cwd, acc),
    showFocus: () => focus.showFocus(cwd, acc),
    richSetFocus: (taskId) => focus.setFocus(taskId, cwd, acc),
    richClearFocus: () => focus.clearFocus(cwd, acc),
    getFocusHistory: () => focus.getFocusHistory(cwd, acc),
  };
}

/**
 * Detect the configured storage engine from .cleo/config.json.
 * Falls back to 'json' if no config or if tasks.db doesn't exist yet.
 * @task T4647
 */
export function detectStoreEngine(cwd?: string): StoreEngine {
  const cleoDir = getCleoDirAbsolute(cwd);

  // Check config for explicit setting
  const configPath = join(cleoDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const engine = config?.storage?.engine;
      if (engine === 'sqlite' || engine === 'json' || engine === 'dual') return engine;
    } catch {
      // Fall through to auto-detection
    }
  }

  // Auto-detect: if tasks.db exists, use sqlite; otherwise json
  const dbPath = join(cleoDir, 'tasks.db');
  if (existsSync(dbPath)) return 'sqlite';

  // Default: json (backward compatible)
  return 'json';
}

/**
 * Create a store provider based on engine type.
 * @task T4647
 */
export async function createStoreProvider(
  engine?: StoreEngine,
  cwd?: string,
): Promise<StoreProvider> {
  const resolvedEngine = engine ?? detectStoreEngine(cwd);

  if (resolvedEngine === 'sqlite') {
    return createSqliteProvider(cwd);
  }

  if (resolvedEngine === 'dual') {
    return createDualWriteProvider(cwd);
  }

  // JSON store - delegates to existing core module functions
  const { createJsonStoreProvider } = await import('./json-provider.js');
  return createJsonStoreProvider(cwd);
}

/**
 * Create a pure SQLite store provider.
 * @task T4647
 */
async function createSqliteProvider(cwd?: string): Promise<StoreProvider> {
  const sqliteStore = await import('./task-store.js');
  const sessionStore = await import('./session-store.js');
  const { closeDb } = await import('./sqlite.js');
  const domainOps = await createDomainOps(cwd);

  return {
    engine: 'sqlite',
    createTask: (task) => sqliteStore.createTask(task, cwd),
    getTask: (taskId) => sqliteStore.getTask(taskId, cwd),
    updateTask: (taskId, updates) => sqliteStore.updateTask(taskId, updates, cwd),
    deleteTask: (taskId) => sqliteStore.deleteTask(taskId, cwd),
    listTasks: (filters) => sqliteStore.listTasks(filters, cwd),
    findTasks: (query, limit) => sqliteStore.findTasks(query, limit, cwd),
    archiveTask: (taskId, reason) => sqliteStore.archiveTask(taskId, reason, cwd),
    createSession: (session) => sessionStore.createSession(session, cwd),
    getSession: (sessionId) => sessionStore.getSession(sessionId, cwd),
    updateSession: (sessionId, updates) => sessionStore.updateSession(sessionId, updates, cwd),
    listSessions: (filters) => sessionStore.listSessions(filters, cwd),
    endSession: (sessionId, note) => sessionStore.endSession(sessionId, note, cwd),
    setFocus: (sessionId, taskId) => sessionStore.setFocus(sessionId, taskId, cwd),
    getFocus: (sessionId) => sessionStore.getFocus(sessionId, cwd),
    clearFocus: (sessionId) => sessionStore.clearFocus(sessionId, cwd),
    close: async () => closeDb(),
    ...domainOps,
  };
}

/**
 * Create a dual-write store provider.
 *
 * Writes to BOTH JSON and SQLite stores. Reads from SQLite, falling
 * back to JSON if the SQLite read fails. Logs discrepancies to stderr.
 *
 * @task T4647
 * @epic T4638
 */
async function createDualWriteProvider(cwd?: string): Promise<StoreProvider> {
  const { createJsonStoreProvider } = await import('./json-provider.js');
  const jsonProvider = createJsonStoreProvider(cwd);
  const sqliteProvider = await createSqliteProvider(cwd);
  const domainOps = await createDomainOps(cwd);

  /** Log dual-write discrepancy to stderr. */
  function logDiscrepancy(op: string, detail: string): void {
    process.stderr.write(`[dual-write] ${op}: ${detail}\n`);
  }

  return {
    engine: 'dual' as StoreEngine,

    // --- Task CRUD: write to both, read from SQLite with JSON fallback ---

    createTask: async (task) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.createTask(task),
        jsonProvider.createTask(task),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('createTask', `SQLite write failed: ${String((sqliteResult as PromiseRejectedResult).reason)}`);
      return jsonProvider.createTask(task);
    },

    getTask: async (taskId) => {
      try {
        return await sqliteProvider.getTask(taskId);
      } catch {
        logDiscrepancy('getTask', `SQLite read failed for ${taskId}, falling back to JSON`);
        return jsonProvider.getTask(taskId);
      }
    },

    updateTask: async (taskId, updates) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.updateTask(taskId, updates),
        jsonProvider.updateTask(taskId, updates),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('updateTask', `SQLite write failed for ${taskId}`);
      return jsonProvider.updateTask(taskId, updates);
    },

    deleteTask: async (taskId) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.deleteTask(taskId),
        jsonProvider.deleteTask(taskId),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('deleteTask', `SQLite write failed for ${taskId}`);
      return jsonProvider.deleteTask(taskId);
    },

    listTasks: async (filters) => {
      try {
        return await sqliteProvider.listTasks(filters);
      } catch {
        logDiscrepancy('listTasks', 'SQLite read failed, falling back to JSON');
        return jsonProvider.listTasks(filters);
      }
    },

    findTasks: async (query, limit) => {
      try {
        return await sqliteProvider.findTasks(query, limit);
      } catch {
        logDiscrepancy('findTasks', 'SQLite read failed, falling back to JSON');
        return jsonProvider.findTasks(query, limit);
      }
    },

    archiveTask: async (taskId, reason) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.archiveTask(taskId, reason),
        jsonProvider.archiveTask(taskId, reason),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('archiveTask', `SQLite write failed for ${taskId}`);
      return jsonProvider.archiveTask(taskId, reason);
    },

    // --- Session CRUD: write to both, read from SQLite with JSON fallback ---

    createSession: async (session) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.createSession(session),
        jsonProvider.createSession(session),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('createSession', 'SQLite write failed');
      return jsonProvider.createSession(session);
    },

    getSession: async (sessionId) => {
      try {
        return await sqliteProvider.getSession(sessionId);
      } catch {
        logDiscrepancy('getSession', `SQLite read failed for ${sessionId}, falling back to JSON`);
        return jsonProvider.getSession(sessionId);
      }
    },

    updateSession: async (sessionId, updates) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.updateSession(sessionId, updates),
        jsonProvider.updateSession(sessionId, updates),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('updateSession', `SQLite write failed for ${sessionId}`);
      return jsonProvider.updateSession(sessionId, updates);
    },

    listSessions: async (filters) => {
      try {
        return await sqliteProvider.listSessions(filters);
      } catch {
        logDiscrepancy('listSessions', 'SQLite read failed, falling back to JSON');
        return jsonProvider.listSessions(filters);
      }
    },

    endSession: async (sessionId, note) => {
      const [sqliteResult] = await Promise.allSettled([
        sqliteProvider.endSession(sessionId, note),
        jsonProvider.endSession(sessionId, note),
      ]);
      if (sqliteResult.status === 'fulfilled') return sqliteResult.value;
      logDiscrepancy('endSession', `SQLite write failed for ${sessionId}`);
      return jsonProvider.endSession(sessionId, note);
    },

    // --- Focus: write to both, read from SQLite with JSON fallback ---

    setFocus: async (sessionId, taskId) => {
      await Promise.allSettled([
        sqliteProvider.setFocus(sessionId, taskId),
        jsonProvider.setFocus(sessionId, taskId),
      ]);
    },

    getFocus: async (sessionId) => {
      try {
        return await sqliteProvider.getFocus(sessionId);
      } catch {
        logDiscrepancy('getFocus', `SQLite read failed for ${sessionId}`);
        return jsonProvider.getFocus(sessionId);
      }
    },

    clearFocus: async (sessionId) => {
      await Promise.allSettled([
        sqliteProvider.clearFocus(sessionId),
        jsonProvider.clearFocus(sessionId),
      ]);
    },

    // --- Lifecycle ---

    close: async () => {
      await Promise.allSettled([
        sqliteProvider.close(),
        jsonProvider.close(),
      ]);
    },

    // --- High-level domain operations (delegate to core modules) ---
    ...domainOps,
  };
}
