/**
 * Task work management operations (start/stop/current).
 * @task T4462
 * @task T4750
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TaskFile } from '../../types/task.js';
import { getTaskPath, getLogPath, getBackupDir } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Result of getting current task. */
export interface TaskCurrentResult {
  currentTask: string | null;
  currentPhase: string | null;
  sessionNote: string | null;
  nextAction: string | null;
}

/** Result of starting work on a task. */
export interface TaskStartResult {
  taskId: string;
  taskTitle: string;
  previousTask: string | null;
}

/** Task work history entry. */
export interface TaskWorkHistoryEntry {
  taskId: string;
  timestamp: string;
}

/**
 * Show current task work state.
 * @task T4462
 * @task T4750
 */
export async function currentTask(cwd?: string, accessor?: DataAccessor): Promise<TaskCurrentResult> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));

  const focus = data.focus ?? {};

  return {
    currentTask: focus.currentTask ?? null,
    currentPhase: focus.currentPhase ?? null,
    sessionNote: focus.sessionNote ?? null,
    nextAction: focus.nextAction ?? null,
  };
}

/**
 * Start working on a specific task.
 * @task T4462
 * @task T4750
 */
export async function startTask(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<TaskStartResult> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }

  const taskPath = getTaskPath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(taskPath);

  // Verify task exists
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${taskId}`,
      { fix: `Use 'cleo find "${taskId}"' to search` },
    );
  }

  const previousTask = data.focus?.currentTask ?? null;

  // Update focus
  if (!data.focus) {
    data.focus = {};
  }
  data.focus.currentTask = taskId;
  data.focus.currentPhase = task.phase ?? null;

  // Add to session notes for work history tracking
  const noteEntry = {
    note: `Started work on ${taskId}: ${task.title}`,
    timestamp: new Date().toISOString(),
  };
  if (!data.focus.sessionNotes) {
    data.focus.sessionNotes = [];
  }
  data.focus.sessionNotes.push(noteEntry);

  // Update metadata
  const now = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    await accessor.saveTaskFile(data);
  } else {
    await saveJson(taskPath, data, { backupDir });
  }

  await logOperation(logPath, 'task_start', taskId, {
    previousTask,
    title: task.title,
  }, accessor);

  return {
    taskId,
    taskTitle: task.title,
    previousTask,
  };
}

/**
 * Stop working on the current task.
 * @task T4462
 * @task T4750
 */
export async function stopTask(cwd?: string, accessor?: DataAccessor): Promise<{ previousTask: string | null }> {
  const taskPath = getTaskPath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(taskPath);

  const previousTask = data.focus?.currentTask ?? null;

  if (!data.focus) {
    return { previousTask: null };
  }

  data.focus.currentTask = null;
  data.focus.nextAction = null;

  const now = new Date().toISOString();
  data._meta.checksum = computeChecksum(data.tasks);
  data.lastUpdated = now;

  if (accessor) {
    await accessor.saveTaskFile(data);
  } else {
    await saveJson(taskPath, data, { backupDir });
  }

  await logOperation(logPath, 'task_stop', previousTask ?? 'none', {
    previousTask,
  }, accessor);

  return { previousTask };
}

/**
 * Get task work history from session notes.
 * @task T4462
 * @task T4750
 */
export async function getWorkHistory(cwd?: string, accessor?: DataAccessor): Promise<TaskWorkHistoryEntry[]> {
  const data = accessor
    ? await accessor.loadTaskFile()
    : await readJsonRequired<TaskFile>(getTaskPath(cwd));

  const notes = data.focus?.sessionNotes ?? [];
  const history: TaskWorkHistoryEntry[] = [];

  for (const note of notes) {
    // Match both old "Focus set to" and new "Started work on" patterns
    const match = note.note.match(/^(?:Focus set to|Started work on) (T\d+)/);
    if (match) {
      history.push({
        taskId: match[1]!,
        timestamp: note.timestamp,
      });
    }
  }

  return history.reverse(); // Most recent first
}

// ---- Backward-compatible aliases (deprecated) ----

/** @deprecated Use TaskCurrentResult instead. */
export type FocusShowResult = TaskCurrentResult;
/** @deprecated Use TaskStartResult instead. */
export type FocusSetResult = TaskStartResult;
/** @deprecated Use TaskWorkHistoryEntry instead. */
export type FocusHistoryEntry = TaskWorkHistoryEntry;

/** @deprecated Use currentTask() instead. */
export const showFocus = currentTask;
/** @deprecated Use startTask() instead. */
export const setFocus = startTask;
/** @deprecated Use stopTask() instead. */
export const clearFocus = stopTask;
/** @deprecated Use getWorkHistory() instead. */
export const getFocusHistory = getWorkHistory;
