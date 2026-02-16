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
  };
}
