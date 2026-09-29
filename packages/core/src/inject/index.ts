/**
 * Task injection core module.
 *
 * Selects and formats tasks for injection into external systems.
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

import type { Task } from '@cleocode/contracts';
import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts';
import { readLiveFocus } from '../sessions/focus-state-store.js';
import { resolveSessionIdFromEnv } from '../sessions/session-id.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';

/**
 * Select tasks eligible for injection based on filters.
 * This is CLEO-specific task selection logic (stays in CLEO).
 * @task T4539
 */
function selectTasksForInjection(
  allTasks: Task[],
  opts: {
    maxTasks?: number;
    focusedOnly?: boolean;
    phase?: string;
    focusedTaskId?: string | null;
    currentPhase?: string | null;
  },
): Task[] {
  const maxTasks = opts.maxTasks ?? 8;
  // T12684: no finished task (done, cancelled or archived) enters agent context.
  let tasks = allTasks.filter(
    (t) => !(TERMINAL_TASK_STATUSES as ReadonlySet<string>).has(t.status),
  );

  // Filter by focused task
  if (opts.focusedOnly && opts.focusedTaskId) {
    tasks = tasks.filter((t) => t.id === opts.focusedTaskId);
  }

  // Filter by phase
  const phase = opts.phase ?? opts.currentPhase ?? undefined;
  if (phase) {
    const phaseTasks = tasks.filter((t) => t.phase === phase);
    if (phaseTasks.length > 0) tasks = phaseTasks;
  }

  // Sort: active first, then by priority
  const priorityOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1;
    if (b.status === 'active' && a.status !== 'active') return 1;
    return (
      (priorityOrder[a.priority ?? 'medium'] ?? 2) - (priorityOrder[b.priority ?? 'medium'] ?? 2)
    );
  });

  return tasks.slice(0, maxTasks);
}

/**
 * Format tasks for injection.
 * Format: [T###] [!]? [BLOCKED]? <title>
 * @task T4539
 */
function formatForInjection(tasks: Task[]): Array<{ id: string; text: string; status: string }> {
  return tasks.map((t) => {
    let prefix = `[${t.id}]`;
    if (t.priority === 'critical' || t.priority === 'high') prefix += ' [!]';
    if (t.status === 'blocked') prefix += ' [BLOCKED]';
    return { id: t.id, text: `${prefix} ${t.title}`, status: t.status };
  });
}

/** Inject tasks for external consumption. */
export async function injectTasks(
  opts: {
    maxTasks?: number;
    focusedOnly?: boolean;
    phase?: string;
    output?: string;
    saveState?: boolean;
    dryRun?: boolean;
    cwd?: string;
  },
  accessor?: DataAccessor,
): Promise<Record<string, unknown>> {
  const acc = accessor ?? (await getTaskAccessor(opts.cwd));
  const { tasks: allTasks } = await acc.queryTasks({});
  const projectMeta = await acc.getMetaValue<{ currentPhase?: string }>('project');
  // T12684: never inject a finished task as the focused one.
  const focus = await readLiveFocus(acc, resolveSessionIdFromEnv());

  const selectedTasks = selectTasksForInjection(allTasks, {
    ...opts,
    focusedTaskId: focus.currentTask,
    currentPhase: projectMeta?.currentPhase ?? null,
  });
  const formatted = formatForInjection(selectedTasks);

  const phase = opts.phase ?? projectMeta?.currentPhase ?? null;

  return {
    tasks: formatted,
    count: formatted.length,
    phase,
    focusedOnly: opts.focusedOnly ?? false,
    dryRun: opts.dryRun ?? false,
  };
}
