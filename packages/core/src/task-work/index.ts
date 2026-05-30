/**
 * Task work management operations (start/stop/current).
 * @task T4462
 * @task T4750
 * @epic T4454
 */

// Auto-register hook handlers
import '../hooks/handlers/index.js';

import type { TaskWorkState } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { resolveOrCwd } from '../paths.js';
import { readFocusState, writeFocusState } from '../sessions/focus-state-store.js';
import { resolveSessionIdFromEnv } from '../sessions/session-id.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { logOperation } from '../tasks/add.js';
import { getUnresolvedDeps } from '../tasks/dependency-check.js';
import { isValidPipelineStage } from '../tasks/pipeline-stage.js';

/**
 * Resolve the focus_state session key for the CALLER (T11345 · Epic T11284).
 *
 * Env-first: a spawned agent's `CLEO_SESSION_ID` keys its own focus_state
 * (`focus_state:<id>`); an orchestrator/CLI call with no session env resolves
 * to `null`, which {@link readFocusState}/{@link writeFocusState} map to the
 * legacy global `focus_state` key (backward-compatible — no behaviour change
 * outside spawned agents). This is what stops two concurrent agents from
 * clobbering each other's current task.
 *
 * @returns The resolved session id, or `null` for the legacy global key.
 * @task T11345
 */
function resolveFocusSessionId(): string | null {
  return resolveSessionIdFromEnv();
}

/**
 * RCASD planning stages — tasks in these stages auto-advance to 'implementation'
 * when work begins (cleo start TXXX).
 */
const PLANNING_STAGES = new Set([
  'research',
  'consensus',
  'architecture_decision',
  'specification',
  'decomposition',
]);

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
export async function currentTask(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskCurrentResult> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const focus = await readFocusState(acc, resolveFocusSessionId());

  return {
    currentTask: focus?.currentTask ?? null,
    currentPhase: focus?.currentPhase ?? null,
    sessionNote: focus?.sessionNote ?? null,
    nextAction: focus?.nextAction ?? null,
  };
}

/**
 * Start working on a specific task.
 * @task T4462
 * @task T4750
 */
export async function startTask(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskStartResult> {
  if (!taskId) {
    throw new CleoError(ExitCode.INVALID_INPUT, 'Task ID is required');
  }

  const acc = accessor ?? (await getTaskAccessor(cwd));

  // Verify task exists
  const task = await acc.loadSingleTask(taskId);
  if (!task) {
    throw new CleoError(ExitCode.NOT_FOUND, `Task not found: ${taskId}`, {
      fix: `Use 'cleo find "${taskId}"' to search`,
    });
  }

  // Block starting a task with unresolved dependencies
  const { tasks: allTasks } = await acc.queryTasks({});
  const unresolvedDeps = getUnresolvedDeps(taskId, allTasks);
  if (unresolvedDeps.length > 0) {
    throw new CleoError(
      ExitCode.DEPENDENCY_ERROR,
      `Task ${taskId} is blocked by unresolved dependencies: ${unresolvedDeps.join(', ')}`,
      {
        fix: `Complete blockers first: ${unresolvedDeps.map((d) => `cleo complete ${d}`).join(', ')}`,
      },
    );
  }

  // Auto-advance pipelineStage: RCASD planning stages → implementation (T719)
  // Best-effort: if pipelineStage is in planning stages, advance to implementation.
  // This mirrors the lifecycle model: starting work means entering the IVTR phase.
  const currentStage = task.pipelineStage;
  if (currentStage && isValidPipelineStage(currentStage) && PLANNING_STAGES.has(currentStage)) {
    await acc.updateTaskFields(taskId, { pipelineStage: 'implementation' });
  }

  // T11345 — read/write the CALLER's per-session focus_state key.
  const focusSessionId = resolveFocusSessionId();
  const focus = (await readFocusState(acc, focusSessionId)) ?? ({} as TaskWorkState);
  const previousTask = focus.currentTask ?? null;

  // Update focus
  focus.currentTask = taskId;
  focus.currentPhase = task.phase ?? null;

  // Add to session notes for work history tracking
  const noteEntry = {
    note: `Started work on ${taskId}: ${task.title}`,
    timestamp: new Date().toISOString(),
  };
  if (!focus.sessionNotes) {
    focus.sessionNotes = [];
  }
  focus.sessionNotes.push(noteEntry);

  await writeFocusState(acc, focusSessionId, focus);

  // Set assignee on the task (claim semantics)
  if (!task.assignee) {
    await acc.updateTaskFields(taskId, { assignee: process.env['CLEO_AGENT_ID'] ?? 'local' });
  }

  await logOperation(
    'task_start',
    taskId,
    {
      previousTask,
      title: task.title,
    },
    accessor,
  );

  // Dispatch PreToolUse hook (best-effort, don't await)
  const { hooks } = await import('../hooks/registry.js');
  hooks
    .dispatch('PreToolUse', resolveOrCwd(cwd), {
      timestamp: new Date().toISOString(),
      taskId,
      taskTitle: task.title,
    })
    .catch(() => {
      /* Hooks are best-effort */
    });

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
export async function stopTask(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<{ previousTask: string | null }> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  // T11345 — read/write the CALLER's per-session focus_state key.
  const focusSessionId = resolveFocusSessionId();
  const focus = await readFocusState(acc, focusSessionId);

  const previousTask = focus?.currentTask ?? null;

  if (!focus) {
    return { previousTask: null };
  }

  // Get task info before clearing focus for hook dispatch
  const taskId = focus.currentTask;
  const task = taskId ? await acc.loadSingleTask(taskId) : undefined;

  focus.currentTask = null;
  focus.nextAction = null;

  const now = new Date().toISOString();

  // Dispatch PostToolUse hook (best-effort, don't await)
  if (taskId && task) {
    const { hooks } = await import('../hooks/registry.js');
    hooks
      .dispatch('PostToolUse', resolveOrCwd(cwd), {
        timestamp: now,
        taskId,
        taskTitle: task.title,
        status: 'done',
      })
      .catch(() => {
        /* Hooks are best-effort */
      });
  }

  await writeFocusState(acc, focusSessionId, focus);

  await logOperation(
    'task_stop',
    previousTask ?? 'none',
    {
      previousTask,
    },
    accessor,
  );

  return { previousTask };
}

/**
 * Get task work history from session notes.
 * @task T4462
 * @task T4750
 */
export async function getWorkHistory(
  cwd?: string,
  accessor?: DataAccessor,
): Promise<TaskWorkHistoryEntry[]> {
  const acc = accessor ?? (await getTaskAccessor(cwd));
  const focus = await readFocusState(acc, resolveFocusSessionId());

  const notes = focus?.sessionNotes ?? [];
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

/**
 * Get task work history (canonical verb alias for dispatch layer).
 * @task T5323
 */
export const getTaskHistory = getWorkHistory;
