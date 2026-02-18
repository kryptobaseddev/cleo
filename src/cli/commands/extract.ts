/**
 * CLI extract command - merge TodoWrite state back to CLEO.
 * Ported from scripts/extract.sh
 * @task T4551
 * @epic T4545
 */

import { Command } from 'commander';
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { formatSuccess, formatError } from '../../core/output.js';
import { CleoError } from '../../core/errors.js';
import { ExitCode } from '../../types/exit-codes.js';
import { getCleoDir } from '../../core/paths.js';
import { readJson, computeChecksum } from '../../store/json.js';
import { getAccessor } from '../../store/data-accessor.js';
import type { Task, TaskStatus } from '../../types/task.js';

/** TodoWrite item as exported by Claude. */
interface TodoWriteItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

/** TodoWrite state file format. */
interface TodoWriteState {
  todos: TodoWriteItem[];
}

/** Sync session state. */
interface SyncSessionState {
  injected_tasks: string[];
  injectedPhase?: string;
  task_metadata?: Record<string, { phase?: string }>;
}

/** Detected changes from TodoWrite state. */
interface ChangeSet {
  completed: string[];
  progressed: string[];
  newTasks: string[];
  removed: string[];
}

/**
 * Parse task ID from content prefix: "[T001] ..." -> "T001".
 * @task T4551
 */
function parseTaskId(content: string): string | null {
  const match = content.match(/^\[T(\d+)\]/);
  return match ? `T${match[1]}` : null;
}

/**
 * Strip ID and status prefixes from content.
 * @task T4551
 */
function stripPrefixes(content: string): string {
  return content
    .replace(/^\[T\d+\]\s*/, '')
    .replace(/^\[!\]\s*/, '')
    .replace(/^\[BLOCKED\]\s*/, '');
}

/**
 * Analyze TodoWrite state and detect changes.
 * @task T4551
 */
function analyzeChanges(
  todowriteState: TodoWriteState,
  injectedIds: string[],
): ChangeSet {
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

/**
 * Register the extract command.
 * @task T4551
 */
export function registerExtractCommand(program: Command): void {
  program
    .command('extract <file>')
    .description('Merge TodoWrite state back to CLEO (session end)')
    .option('--dry-run', 'Show changes without modifying files')
    .option('--default-phase <phase>', 'Override default phase for new tasks')
    .action(async (file: string, opts: Record<string, unknown>) => {
      try {
        const dryRun = opts['dryRun'] as boolean ?? false;
        const defaultPhase = opts['defaultPhase'] as string | undefined;

        // Validate input file
        try {
          await stat(file);
        } catch {
          throw new CleoError(ExitCode.NOT_FOUND, `File not found: ${file}`);
        }

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

        // Load todo data
        const accessor = await getAccessor();
        const todoData = await accessor.loadTodoFile();

        // Load sync session state
        const cleoDir = getCleoDir();
        const stateFile = join(cleoDir, 'sync', 'todowrite-session.json');
        let sessionState: SyncSessionState | null = null;
        try {
          sessionState = await readJson<SyncSessionState>(stateFile);
        } catch {
          // No session state
        }

        const injectedIds = sessionState?.injected_tasks ?? [];

        // Analyze changes
        const changes = analyzeChanges(todowriteState, injectedIds);

        const totalChanges = changes.completed.length + changes.progressed.length + changes.newTasks.length;

        if (totalChanges === 0) {
          console.log(formatSuccess({
            changes: {
              completed: 0,
              progressed: 0,
              new: 0,
              removed: changes.removed.length,
              applied: 0,
            },
          }, 'No changes to apply'));
          return;
        }

        let appliedCount = 0;

        if (!dryRun) {
          // Apply completed tasks
          for (const taskId of changes.completed) {
            const task = todoData.tasks.find((t) => t.id === taskId);
            if (!task) continue;
            if (task.status === 'done') continue;

            task.status = 'done';
            task.completedAt = new Date().toISOString();
            task.updatedAt = new Date().toISOString();
            task.notes = task.notes ?? [];
            task.notes.push('Completed via TodoWrite session sync');
            appliedCount++;
          }

          // Apply progressed tasks
          for (const taskId of changes.progressed) {
            const task = todoData.tasks.find((t) => t.id === taskId);
            if (!task) continue;
            if (task.status !== 'pending' && task.status !== 'blocked') continue;

            task.status = 'active' as TaskStatus;
            task.updatedAt = new Date().toISOString();
            task.notes = task.notes ?? [];
            task.notes.push('Progressed during TodoWrite session');
            appliedCount++;
          }

          // Create new tasks
          for (const title of changes.newTasks) {
            const maxNum = todoData.tasks.reduce((max, t) => {
              const num = parseInt(t.id.replace('T', ''), 10);
              return isNaN(num) ? max : Math.max(max, num);
            }, 0);

            const newTask: Task = {
              id: `T${String(maxNum + 1).padStart(4, '0')}`,
              title,
              description: 'Created during TodoWrite session',
              status: 'pending' as TaskStatus,
              priority: 'medium',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              labels: ['session-created'],
              ...(defaultPhase ? { phase: defaultPhase } : {}),
            };

            todoData.tasks.push(newTask);
            appliedCount++;
          }

          // Save changes
          todoData._meta.checksum = computeChecksum(todoData.tasks);
          todoData.lastUpdated = new Date().toISOString();
          await accessor.saveTodoFile(todoData);

          // Clean up session state
          try {
            await rm(stateFile);
          } catch {
            // ignore
          }
        }

        console.log(formatSuccess({
          dryRun,
          changes: {
            completed: changes.completed.length,
            progressed: changes.progressed.length,
            new: changes.newTasks.length,
            removed: changes.removed.length,
            applied: dryRun ? 0 : appliedCount,
          },
          sessionCleared: !dryRun,
        }, dryRun ? 'Dry run complete' : `Applied ${appliedCount} changes`));
      } catch (err) {
        if (err instanceof CleoError) {
          console.error(formatError(err));
          process.exit(err.code);
        }
        throw err;
      }
    });
}
