/**
 * JSON StoreProvider implementation.
 *
 * Wraps existing JSON file operations (tasks, sessions, focus) behind
 * the StoreProvider interface. This allows the CLI and MCP engine to
 * use StoreProvider for all data access, switchable between JSON and SQLite.
 *
 * @task T4644
 * @epic T4638
 */

import type { StoreProvider, TaskFilters, SessionFilters } from './provider.js';
import type { Task } from '../types/task.js';
import type { Session } from '../types/session.js';

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

// Focus operations
import { setFocus, showFocus, clearFocus, getFocusHistory } from '../core/focus/index.js';

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
 * This is a thin wrapper -- the real logic lives in the core modules.
 *
 * @task T4644
 * @epic T4638
 */
export function createJsonStoreProvider(cwd?: string): StoreProvider {
  return {
    engine: 'json',

    // ---- Task CRUD ----

    createTask: async (task: Task): Promise<Task> => {
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
      }, cwd);
      return result.task;
    },

    getTask: async (taskId: string): Promise<Task | null> => {
      try {
        const detail = await showTask(taskId, cwd);
        return detail;
      } catch {
        return null;
      }
    },

    updateTask: async (taskId: string, updates: Partial<Task>): Promise<Task | null> => {
      try {
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
        }, cwd);
        return result.task;
      } catch {
        return null;
      }
    },

    deleteTask: async (taskId: string): Promise<boolean> => {
      try {
        await deleteTask({ taskId, force: true }, cwd);
        return true;
      } catch {
        return false;
      }
    },

    listTasks: async (filters?: TaskFilters): Promise<Task[]> => {
      const result = await listTasks({
        status: filters?.status,
        parentId: filters?.parentId ?? undefined,
        type: filters?.type,
        phase: filters?.phase,
        limit: filters?.limit,
      }, cwd);
      return result.tasks;
    },

    findTasks: async (query: string, limit?: number): Promise<Task[]> => {
      const result = await findTasks({ query, limit }, cwd);
      // findTasks returns FindResult (minimal fields), but StoreProvider expects Task.
      // We need to fetch full task details for each result.
      const tasks: Task[] = [];
      for (const r of result.results) {
        try {
          const detail = await showTask(r.id, cwd);
          tasks.push(detail);
        } catch {
          // Skip tasks that can't be loaded
        }
      }
      return tasks;
    },

    archiveTask: async (taskId: string, _reason?: string): Promise<boolean> => {
      try {
        const result = await archiveTasks({ taskIds: [taskId] }, cwd);
        return result.archived.includes(taskId);
      } catch {
        return false;
      }
    },

    // ---- Session CRUD ----

    createSession: async (session: Session): Promise<Session> => {
      const result = await startSession({
        name: session.name,
        scope: session.scope.type === 'epic' && session.scope.epicId
          ? `epic:${session.scope.epicId}`
          : 'global',
        focus: session.focus?.taskId ?? undefined,
        agent: session.agent ?? undefined,
      }, cwd);
      return result;
    },

    getSession: async (sessionId: string): Promise<Session | null> => {
      const sessions = await listSessions({}, cwd);
      return sessions.find(s => s.id === sessionId) ?? null;
    },

    updateSession: async (sessionId: string, updates: Partial<Session>): Promise<Session | null> => {
      // JSON sessions don't have a generic update; status changes go through end/resume
      if (updates.status === 'ended') {
        try {
          const result = await endSession({ sessionId }, cwd);
          return result;
        } catch {
          return null;
        }
      }
      if (updates.status === 'active') {
        try {
          const result = await resumeSession(sessionId, cwd);
          return result;
        } catch {
          return null;
        }
      }
      // For other updates, return the session as-is
      const sessions = await listSessions({}, cwd);
      return sessions.find(s => s.id === sessionId) ?? null;
    },

    listSessions: async (filters?: SessionFilters): Promise<Session[]> => {
      const opts: { status?: string; limit?: number } = {};
      if (filters?.active) opts.status = 'active';
      if (filters?.limit) opts.limit = filters.limit;
      return listSessions(opts, cwd);
    },

    endSession: async (sessionId: string, note?: string): Promise<Session | null> => {
      try {
        return await endSession({ sessionId, note }, cwd);
      } catch {
        return null;
      }
    },

    // ---- Focus ----

    setFocus: async (_sessionId: string, taskId: string): Promise<void> => {
      await setFocus(taskId, cwd);
    },

    getFocus: async (_sessionId: string): Promise<{ taskId: string | null; since: string | null }> => {
      const focus = await showFocus(cwd);
      return {
        taskId: focus.currentTask,
        since: null, // JSON focus doesn't track 'since' per session
      };
    },

    clearFocus: async (_sessionId: string): Promise<void> => {
      await clearFocus(cwd);
    },

    // ---- Lifecycle ----

    close: async (): Promise<void> => {
      // No-op for JSON provider -- no connections to close
    },

    // ---- High-level domain operations ----
    // @task T4656
    // @epic T4654

    addTask: (options) => addTask(options, cwd),
    completeTask: (options) => completeTask(options, cwd),
    richUpdateTask: (options) => updateTask(options, cwd),
    showTask: (taskId) => showTask(taskId, cwd),
    richDeleteTask: (options) => deleteTask(options, cwd),
    richFindTasks: (options) => findTasks(options, cwd),
    richListTasks: (options) => listTasks(options, cwd),
    richArchiveTasks: (options) => archiveTasks(options, cwd),

    startSession: (options) => startSession(options, cwd),
    richEndSession: (options) => endSession(options, cwd),
    sessionStatus: () => sessionStatus(cwd),
    resumeSession: (sessionId) => resumeSession(sessionId, cwd),
    richListSessions: (options) => listSessions(options, cwd),
    gcSessions: (maxAgeHours) => gcSessions(maxAgeHours, cwd),

    showFocus: () => showFocus(cwd),
    richSetFocus: (taskId) => setFocus(taskId, cwd),
    richClearFocus: () => clearFocus(cwd),
    getFocusHistory: () => getFocusHistory(cwd),

    listLabels: () => listLabels(cwd),
    showLabelTasks: (label) => showLabelTasks(label, cwd),
    getLabelStats: () => getLabelStats(cwd),

    suggestRelated: (taskId, opts) => suggestRelated(taskId, { ...opts, cwd }),
    addRelation: (from, to, type, reason) => addRelation(from, to, type, reason, cwd),
    discoverRelated: (taskId) => discoverRelated(taskId, cwd),
    listRelations: (taskId) => listRelations(taskId, cwd),

    analyzeTaskPriority: (opts) => analyzeTaskPriority({ ...opts, cwd }),
  };
}
