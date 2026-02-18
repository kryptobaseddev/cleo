/**
 * Focus management operations.
 * @task T4462
 * @epic T4454
 */

import { readJsonRequired, saveJson, computeChecksum } from '../../store/json.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import type { TodoFile } from '../../types/task.js';
import { getTodoPath, getLogPath, getBackupDir } from '../paths.js';
import { logOperation } from '../tasks/add.js';
import type { DataAccessor } from '../../store/data-accessor.js';

/** Result of getting focus. */
export interface FocusShowResult {
  currentTask: string | null;
  currentPhase: string | null;
  sessionNote: string | null;
  nextAction: string | null;
}

/** Result of focus set. */
export interface FocusSetResult {
  taskId: string;
  taskTitle: string;
  previousTask: string | null;
}

/** Focus history entry. */
export interface FocusHistoryEntry {
  taskId: string;
  timestamp: string;
}

/**
 * Show current focus state.
 * @task T4462
 */
export async function showFocus(cwd?: string, accessor?: DataAccessor): Promise<FocusShowResult> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));

  const focus = data.focus ?? {};

  return {
    currentTask: focus.currentTask ?? null,
    currentPhase: focus.currentPhase ?? null,
    sessionNote: focus.sessionNote ?? null,
    nextAction: focus.nextAction ?? null,
  };
}

/**
 * Set focus to a specific task.
 * @task T4462
 */
export async function setFocus(taskId: string, cwd?: string, accessor?: DataAccessor): Promise<FocusSetResult> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }

  const todoPath = getTodoPath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

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

  // Add to session notes for focus history tracking
  const noteEntry = {
    note: `Focus set to ${taskId}: ${task.title}`,
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
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir });
  }

  await logOperation(logPath, 'focus_set', taskId, {
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
 * Clear current focus.
 * @task T4462
 */
export async function clearFocus(cwd?: string, accessor?: DataAccessor): Promise<{ previousTask: string | null }> {
  const todoPath = getTodoPath(cwd);
  const logPath = getLogPath(cwd);
  const backupDir = getBackupDir(cwd);

  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(todoPath);

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
    await accessor.saveTodoFile(data);
  } else {
    await saveJson(todoPath, data, { backupDir });
  }

  await logOperation(logPath, 'focus_cleared', previousTask ?? 'none', {
    previousTask,
  }, accessor);

  return { previousTask };
}

/**
 * Get focus history from session notes.
 * @task T4462
 */
export async function getFocusHistory(cwd?: string, accessor?: DataAccessor): Promise<FocusHistoryEntry[]> {
  const data = accessor
    ? await accessor.loadTodoFile()
    : await readJsonRequired<TodoFile>(getTodoPath(cwd));

  const notes = data.focus?.sessionNotes ?? [];
  const history: FocusHistoryEntry[] = [];

  for (const note of notes) {
    const match = note.note.match(/^Focus set to (T\d+)/);
    if (match) {
      history.push({
        taskId: match[1]!,
        timestamp: note.timestamp,
      });
    }
  }

  return history.reverse(); // Most recent first
}
