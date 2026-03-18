/**
 * TodoWrite merge logic — merge Claude TodoWrite state back to CLEO tasks.
 *
 * Extracted from CLI extract command to live in @cleocode/core.
 * Uses core task operations (completeTask, updateTask, addTask) instead
 * of direct task object mutations.
 *
 * @task T4551
 * @epic T4545
 */

import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ExitCode } from '@cleocode/contracts';
import type { DataAccessor } from '../store/data-accessor.js';
import { getAccessor } from '../store/data-accessor.js';
import { readJson } from '../store/json.js';
import { getCleoDir } from '../paths.js';
import { CleoError } from '../errors.js';
import { completeTask } from '../tasks/complete.js';
import { updateTask } from '../tasks/update.js';
import { addTask } from '../tasks/add.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** TodoWrite item as exported by Claude. */
export interface TodoWriteItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** TodoWrite state file format. */
export interface TodoWriteState {
  todos: TodoWriteItem[];
}

/** Sync session state (persisted in .cleo/sync/todowrite-session.json). */
export interface SyncSessionState {
  injected_tasks: string[];
  injectedPhase?: string;
  task_metadata?: Record<string, { phase?: string }>;
}

/** Detected changes from TodoWrite state. */
export interface ChangeSet {
  completed: string[];
  progressed: string[];
  newTasks: string[];
  removed: string[];
}

/** Options for the merge operation. */
export interface TodoWriteMergeOptions {
  /** Path to the TodoWrite JSON state file. */
  file: string;
  /** Show changes without modifying tasks. */
  dryRun?: boolean;
  /** Default phase for newly created tasks. */
  defaultPhase?: string;
  /** Working directory (project root). */
  cwd?: string;
  /** Optional DataAccessor override. */
  accessor?: DataAccessor;
}

/** Result of the merge operation. */
export interface TodoWriteMergeResult {
  dryRun: boolean;
  changes: {
    completed: number;
    progressed: number;
    new: number;
    removed: number;
    applied: number;
  };
  sessionCleared: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse task ID from content prefix: "[T001] ..." -> "T001".
 */
function parseTaskId(content: string): string | null {
  const match = content.match(/^\[T(\d+)\]/);
  return match ? `T${match[1]}` : null;
}

/**
 * Strip ID and status prefixes from content.
 */
function stripPrefixes(content: string): string {
  return content
    .replace(/^\[T\d+\]\s*/, '')
    .replace(/^\[!\]\s*/, '')
    .replace(/^\[BLOCKED\]\s*/, '');
}

/**
 * Analyze TodoWrite state and detect changes against injected task IDs.
 */
export function analyzeChanges(todowriteState: TodoWriteState, injectedIds: string[]): ChangeSet {
  const foundIds: string[] = [];
  const completed: string[] = [];
  const progressed: string[] = [];
  const newTasks: string[] = [];

  for (const item of todowriteState.todos) {
    const taskId = parseTaskId(item.content);

    if (taskId) {
      foundIds.push(taskId);
      if (item.status === 'completed') {
        completed.push(taskId);
      } else if (item.status === 'in_progress') {
        progressed.push(taskId);
      }
    } else {
      const cleanTitle = stripPrefixes(item.content);
      if (cleanTitle.trim()) {
        newTasks.push(cleanTitle);
      }
    }
  }

  const foundSet = new Set(foundIds);
  const removed = injectedIds.filter((id) => !foundSet.has(id));

  return { completed, progressed, newTasks, removed };
}

// ---------------------------------------------------------------------------
// Core merge function
// ---------------------------------------------------------------------------

/**
 * Merge TodoWrite state back to CLEO tasks.
 *
 * Reads a TodoWrite JSON file, detects completed/progressed/new tasks,
 * and applies changes through core task operations (completeTask, updateTask, addTask).
 */
export async function mergeTodoWriteState(
  options: TodoWriteMergeOptions,
): Promise<TodoWriteMergeResult> {
  const { file, dryRun = false, defaultPhase, cwd } = options;
  const acc = options.accessor ?? (await getAccessor(cwd));

  // Validate input file exists
  try {
    await stat(file);
  } catch {
    throw new CleoError(ExitCode.NOT_FOUND, `File not found: ${file}`);
  }

  // Parse TodoWrite state
  const content = await readFile(file, 'utf-8');
  let todowriteState: TodoWriteState;
  try {
    todowriteState = JSON.parse(content) as TodoWriteState;
  } catch {
    throw new CleoError(ExitCode.INVALID_INPUT, `Invalid JSON in ${file}`);
  }

  if (!todowriteState.todos || !Array.isArray(todowriteState.todos)) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'File must contain a "todos" array');
  }

  // Load sync session state
  const cleoDir = getCleoDir(cwd);
  const stateFile = join(cleoDir, 'sync', 'todowrite-session.json');
  let sessionState: SyncSessionState | null = null;
  try {
    sessionState = await readJson<SyncSessionState>(stateFile);
  } catch {
    // No session state — that's fine
  }

  const injectedIds = sessionState?.injected_tasks ?? [];

  // Analyze changes
  const changes = analyzeChanges(todowriteState, injectedIds);

  const totalChanges =
    changes.completed.length + changes.progressed.length + changes.newTasks.length;

  if (totalChanges === 0) {
    return {
      dryRun,
      changes: {
        completed: 0,
        progressed: 0,
        new: 0,
        removed: changes.removed.length,
        applied: 0,
      },
      sessionCleared: false,
    };
  }

  let appliedCount = 0;

  if (!dryRun) {
    // Load task data once for existence checks
    const data = await acc.loadTaskFile();

    // Apply completed tasks via core completeTask
    for (const taskId of changes.completed) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      if (task.status === 'done') continue;

      try {
        await completeTask(
          { taskId, notes: 'Completed via TodoWrite session sync' },
          cwd,
          acc,
        );
        appliedCount++;
      } catch {
        // Task may have dependency issues — skip silently during merge
      }
    }

    // Apply progressed tasks via core updateTask
    for (const taskId of changes.progressed) {
      const task = data.tasks.find((t) => t.id === taskId);
      if (!task) continue;
      if (task.status !== 'pending' && task.status !== 'blocked') continue;

      try {
        await updateTask(
          { taskId, status: 'active', notes: 'Progressed during TodoWrite session' },
          cwd,
          acc,
        );
        appliedCount++;
      } catch {
        // Skip tasks that can't be updated
      }
    }

    // Create new tasks via core addTask
    for (const title of changes.newTasks) {
      try {
        await addTask(
          {
            title,
            description: 'Created during TodoWrite session',
            labels: ['session-created'],
            ...(defaultPhase ? { phase: defaultPhase, addPhase: true } : {}),
          },
          cwd,
          acc,
        );
        appliedCount++;
      } catch {
        // Skip tasks that fail validation (e.g. duplicate title)
      }
    }

    // Clean up session state
    try {
      await rm(stateFile);
    } catch {
      // ignore
    }
  }

  return {
    dryRun,
    changes: {
      completed: changes.completed.length,
      progressed: changes.progressed.length,
      new: changes.newTasks.length,
      removed: changes.removed.length,
      applied: dryRun ? 0 : appliedCount,
    },
    sessionCleared: !dryRun,
  };
}
