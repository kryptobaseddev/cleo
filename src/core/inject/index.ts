/**
 * TodoWrite injection core module.
 *
 * ARCHITECTURE NOTE: Instruction injection is a CAAMP domain responsibility.
 * Once @cleocode/caamp is available as a dependency, the injection formatting
 * and template resolution should delegate to CAAMP's injection provider.
 * CLEO's role here is task selection and filtering (what to inject),
 * while CAAMP handles the injection format (how to inject).
 *
 * @task T4539
 * @epic T4454
 */

import { readJson } from '../../store/json.js';
import { getTodoPath } from '../paths.js';
import type { TodoFile, Task } from '../../types/task.js';
import { CleoError } from '../errors.js';
import { ExitCode } from '../../types/exit-codes.js';

// TODO(T4539): Replace with @cleocode/caamp injection provider when available
// import { InstructionInjector } from '@cleocode/caamp';

/**
 * Select tasks eligible for injection based on filters.
 * This is CLEO-specific task selection logic (stays in CLEO).
 * @task T4539
 */
function selectTasksForInjection(
  data: TodoFile,
  opts: {
    maxTasks?: number;
    focusedOnly?: boolean;
    phase?: string;
  },
): Task[] {
  const maxTasks = opts.maxTasks ?? 8;
  let tasks = data.tasks.filter(t => t.status !== 'done');

  // Filter by focused task
  if (opts.focusedOnly && data.focus?.currentTask) {
    tasks = tasks.filter(t => t.id === data.focus!.currentTask);
  }

  // Filter by phase
  const phase = opts.phase ?? data.project?.currentPhase ?? undefined;
  if (phase) {
    const phaseTasks = tasks.filter(t => t.phase === phase);
    if (phaseTasks.length > 0) tasks = phaseTasks;
  }

  // Sort: active first, then by priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return (priorityOrder[a.priority ?? 'medium'] ?? 2) - (priorityOrder[b.priority ?? 'medium'] ?? 2);
  });

  return tasks.slice(0, maxTasks);
}

/**
 * Format tasks for TodoWrite injection.
 * TODO(T4539): Delegate to @cleocode/caamp InstructionInjector once available.
 * Format: [T###] [!]? [BLOCKED]? <title>
 * @task T4539
 */
function formatForTodoWrite(tasks: Task[]): Array<{ id: string; text: string; status: string }> {
  return tasks.map(t => {
    let prefix = `[${t.id}]`;
    if (t.priority === 'critical' || t.priority === 'high') prefix += ' [!]';
    if (t.status === 'blocked') prefix += ' [BLOCKED]';
    return { id: t.id, text: `${prefix} ${t.title}`, status: t.status };
  });
}

/** Inject tasks into TodoWrite format. */
export async function injectTasks(opts: {
  maxTasks?: number;
  focusedOnly?: boolean;
  phase?: string;
  output?: string;
  saveState?: boolean;
  dryRun?: boolean;
  cwd?: string;
}): Promise<Record<string, unknown>> {
  const data = await readJson<TodoFile>(getTodoPath(opts.cwd));
  if (!data) {
    throw new CleoError(ExitCode.CONFIG_ERROR, 'Not in a CLEO project');
  }

  const selectedTasks = selectTasksForInjection(data, opts);
  const formatted = formatForTodoWrite(selectedTasks);

  const phase = opts.phase ?? data.project?.currentPhase ?? null;

  return {
    tasks: formatted,
    count: formatted.length,
    phase,
    focusedOnly: opts.focusedOnly ?? false,
    dryRun: opts.dryRun ?? false,
  };
}
