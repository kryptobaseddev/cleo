/**
 * JSON StoreProvider implementation.
 *
 * Wraps existing JSON file operations (tasks, sessions, task work) behind
 * the StoreProvider interface. This allows the CLI and MCP engine to
 * use StoreProvider for all data access, switchable between JSON and SQLite.
 *
 * @task T4644
 * @epic T4638
 */

import type { StoreProvider, TaskFilters, SessionFilters } from './provider.js';
import type { Task } from '../types/task.js';
import type { Session } from '../types/session.js';
import { createJsonDataAccessor } from './json-data-accessor.js';
import type { DataAccessor } from './data-accessor.js';

// Task operations
import { addTask } from '../core/tasks/add.js';
import { showTask } from '../core/tasks/show.js';
import { updateTask } from '../core/tasks/update.js';
import { completeTask } from '../core/tasks/complete.js';
import { listTasks } from '../core/tasks/list.js';
import { findTasks } from '../core/tasks/find.js';
import { archiveTasks } from '../core/tasks/archive.js';
import { deleteTask } from '../core/tasks/delete.js';

// Session operations
import {
  startSession,
  endSession,
  sessionStatus,
  listSessions,
  resumeSession,
  gcSessions,
} from '../core/sessions/index.js';

// Task work operations
import { startTask, currentTask, stopTask, getWorkHistory } from '../core/task-work/index.js';

// Label operations
import { listLabels, showLabelTasks, getLabelStats } from '../core/tasks/labels.js';

// Relationship operations
import { suggestRelated, addRelation, discoverRelated, listRelations } from '../core/tasks/relates.js';

// Analysis operations
import { analyzeTaskPriority } from '../core/tasks/analyze.js';

/**
 * Create a JSON-backed StoreProvider.
 *
 * Delegates to existing core module functions that read/write JSON files.
 * A JsonDataAccessor is created once and passed to all core calls, ensuring
 * consistent storage access throughout the provider's lifetime.
 *
 * @task T4644
 * @epic T4638
 */
export function createJsonStoreProvider(cwd?: string): StoreProvider {
  // Create a JSON accessor once (lazy, cached), shared by all domain operations.
  let _accessorPromise: Promise<DataAccessor> | null = null;
  function getAcc(): Promise<DataAccessor> {
    if (!_accessorPromise) {
      _accessorPromise = createJsonDataAccessor(cwd);
    }
    return _accessorPromise;
  }

  return {
    engine: 'json',

    // ---- Task CRUD ----

    createTask: async (task: Task): Promise<Task> => {
      const acc = await getAcc();
      const result = await addTask({
        title: task.title,
        status: task.status,
        priority: task.priority,
        type: task.type,
        parentId: task.parentId,
        size: task.size ?? undefined,
        phase: task.phase,
        description: task.description,
        labels: task.labels,
        depends: task.depends,
      }, cwd, acc);
      return result.task;
    },

    getTask: async (taskId: string): Promise<Task | null> => {
      try {
        const acc = await getAcc();
        const detail = await showTask(taskId, cwd, acc);
        return detail;
      } catch {
        return null;
      }
    },

    updateTask: async (taskId: string, updates: Partial<Task>): Promise<Task | null> => {
      try {
        const acc = await getAcc();
        const result = await updateTask({
          taskId,
          title: updates.title,
          status: updates.status,
          priority: updates.priority,
          type: updates.type,
          size: updates.size ?? undefined,
          phase: updates.phase,
          description: updates.description,
          labels: updates.labels,
          depends: updates.depends,
          blockedBy: updates.blockedBy,
        }, cwd, acc);
        return result.task;
      } catch {
        return null;
      }
    },

    deleteTask: async (taskId: string): Promise<boolean> => {
      try {
        const acc = await getAcc();
        await deleteTask({ taskId, force: true }, cwd, acc);
        return true;
      } catch {
        return false;
      }
    },

    listTasks: async (filters?: TaskFilters): Promise<Task[]> => {
      const acc = await getAcc();
      const result = await listTasks({
        status: filters?.status,
        parentId: filters?.parentId ?? undefined,
        type: filters?.type,
        phase: filters?.phase,
        limit: filters?.limit,
      }, cwd, acc);
      return result.tasks;
    },

    findTasks: async (query: string, limit?: number): Promise<Task[]> => {
      const acc = await getAcc();
      const result = await findTasks({ query, limit }, cwd, acc);
      // findTasks returns FindResult (minimal fields), but StoreProvider expects Task.
      // We need to fetch full task details for each result.
      const tasks: Task[] = [];
      for (const r of result.results) {
        try {
          const detail = await showTask(r.id, cwd, acc);
          tasks.push(detail);
        } catch {
          // Skip tasks that can't be loaded
        }
      }
      return tasks;
    },

    archiveTask: async (taskId: string, _reason?: string): Promise<boolean> => {
      try {
        const acc = await getAcc();
        const result = await archiveTasks({ taskIds: [taskId] }, cwd, acc);
        return result.archived.includes(taskId);
      } catch {
        return false;
      }
    },

    // ---- Session CRUD ----

    createSession: async (session: Session): Promise<Session> => {
      const acc = await getAcc();
      const result = await startSession({
        name: session.name,
        scope: session.scope.type === 'epic' && session.scope.epicId
          ? `epic:${session.scope.epicId}`
          : 'global',
        startTask: session.taskWork?.taskId ?? undefined,
        agent: session.agent ?? undefined,
      }, cwd, acc);
      return result;
    },

    getSession: async (sessionId: string): Promise<Session | null> => {
      const acc = await getAcc();
      const sessions = await listSessions({}, cwd, acc);
      return sessions.find(s => s.id === sessionId) ?? null;
    },

    updateSession: async (sessionId: string, updates: Partial<Session>): Promise<Session | null> => {
      const acc = await getAcc();
      // JSON sessions don't have a generic update; status changes go through end/resume
      if (updates.status === 'ended') {
        try {
          const result = await endSession({ sessionId }, cwd, acc);
          return result;
        } catch {
          return null;
        }
      }
      if (updates.status === 'active') {
        try {
          const result = await resumeSession(sessionId, cwd, acc);
          return result;
        } catch {
          return null;
        }
      }
      // For other updates, return the session as-is
      const sessions = await listSessions({}, cwd, acc);
      return sessions.find(s => s.id === sessionId) ?? null;
    },

    listSessions: async (filters?: SessionFilters): Promise<Session[]> => {
      const acc = await getAcc();
      const opts: { status?: string; limit?: number } = {};
      if (filters?.active) opts.status = 'active';
      if (filters?.limit) opts.limit = filters.limit;
      return listSessions(opts, cwd, acc);
    },

    endSession: async (sessionId: string, note?: string): Promise<Session | null> => {
      try {
        const acc = await getAcc();
        return await endSession({ sessionId, note }, cwd, acc);
      } catch {
        return null;
      }
    },

    // ---- Task work (session-level) ----

    startTaskOnSession: async (_sessionId: string, taskId: string): Promise<void> => {
      const acc = await getAcc();
      await startTask(taskId, cwd, acc);
    },

    getCurrentTaskForSession: async (_sessionId: string): Promise<{ taskId: string | null; since: string | null }> => {
      const acc = await getAcc();
      const current = await currentTask(cwd, acc);
      return {
        taskId: current.currentTask,
        since: null, // JSON storage doesn't track 'since' per session
      };
    },

    stopTaskOnSession: async (_sessionId: string): Promise<void> => {
      const acc = await getAcc();
      await stopTask(cwd, acc);
    },

    // ---- Lifecycle ----

    close: async (): Promise<void> => {
      // No-op for JSON provider -- no connections to close
    },

    // ---- High-level domain operations ----
    // All domain ops pass the accessor so the correct storage engine is used.
    // @task T4656
    // @epic T4654

    addTask: async (options) => { const acc = await getAcc(); return addTask(options, cwd, acc); },
    completeTask: async (options) => { const acc = await getAcc(); return completeTask(options, cwd, acc); },
    richUpdateTask: async (options) => { const acc = await getAcc(); return updateTask(options, cwd, acc); },
    showTask: async (taskId) => { const acc = await getAcc(); return showTask(taskId, cwd, acc); },
    richDeleteTask: async (options) => { const acc = await getAcc(); return deleteTask(options, cwd, acc); },
    richFindTasks: async (options) => { const acc = await getAcc(); return findTasks(options, cwd, acc); },
    richListTasks: async (options) => { const acc = await getAcc(); return listTasks(options, cwd, acc); },
    richArchiveTasks: async (options) => { const acc = await getAcc(); return archiveTasks(options, cwd, acc); },

    startSession: async (options) => { const acc = await getAcc(); return startSession(options, cwd, acc); },
    richEndSession: async (options) => { const acc = await getAcc(); return endSession(options, cwd, acc); },
    sessionStatus: async () => { const acc = await getAcc(); return sessionStatus(cwd, acc); },
    resumeSession: async (sessionId) => { const acc = await getAcc(); return resumeSession(sessionId, cwd, acc); },
    richListSessions: async (options) => { const acc = await getAcc(); return listSessions(options, cwd, acc); },
    gcSessions: async (maxAgeHours) => { const acc = await getAcc(); return gcSessions(maxAgeHours, cwd, acc); },

    currentTask: async () => { const acc = await getAcc(); return currentTask(cwd, acc); },
    startTask: async (taskId: string) => { const acc = await getAcc(); return startTask(taskId, cwd, acc); },
    stopTask: async () => { const acc = await getAcc(); return stopTask(cwd, acc); },
    getWorkHistory: async () => { const acc = await getAcc(); return getWorkHistory(cwd, acc); },

    listLabels: async () => { const acc = await getAcc(); return listLabels(cwd, acc); },
    showLabelTasks: async (label) => { const acc = await getAcc(); return showLabelTasks(label, cwd, acc); },
    getLabelStats: async () => { const acc = await getAcc(); return getLabelStats(cwd, acc); },

    suggestRelated: async (taskId, opts) => { const acc = await getAcc(); return suggestRelated(taskId, { ...opts, cwd }, acc); },
    addRelation: async (from, to, type, reason) => { const acc = await getAcc(); return addRelation(from, to, type, reason, cwd, acc); },
    discoverRelated: async (taskId) => { const acc = await getAcc(); return discoverRelated(taskId, cwd, acc); },
    listRelations: async (taskId) => { const acc = await getAcc(); return listRelations(taskId, cwd, acc); },

    analyzeTaskPriority: async (opts) => { const acc = await getAcc(); return analyzeTaskPriority({ ...opts, cwd }, acc); },
  };
}
