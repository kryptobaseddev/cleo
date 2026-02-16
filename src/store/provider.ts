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

/** Store engine type. */
export type StoreEngine = 'json' | 'sqlite';

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
 */
export function detectStoreEngine(cwd?: string): StoreEngine {
  const cleoDir = getCleoDirAbsolute(cwd);

  // Check config for explicit setting
  const configPath = join(cleoDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const engine = config?.storage?.engine;
      if (engine === 'sqlite' || engine === 'json') return engine;
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
 */
export async function createStoreProvider(
  engine?: StoreEngine,
  cwd?: string,
): Promise<StoreProvider> {
  const resolvedEngine = engine ?? detectStoreEngine(cwd);

  if (resolvedEngine === 'sqlite') {
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

  // JSON store - delegates to existing core module functions
  const { createJsonStoreProvider } = await import('./json-provider.js');
  return createJsonStoreProvider(cwd);
}
