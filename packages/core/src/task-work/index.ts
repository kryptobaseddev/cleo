/**
 * Task work management operations (start/stop/current).
 * @task T4462
 * @task T4750
 * @epic T4454
 */

// Auto-register hook handlers
import '../hooks/handlers/index.js';

import type { KnowledgeCoverage, TaskClaim, TaskWorkState } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { assessKnowledgeCoverage } from '../nexus/knowledge.js';
import { resolveOrCwd } from '../paths.js';
import {
  readFocusState,
  readLiveFocus,
  type StaleFocusPointer,
  writeFocusState,
} from '../sessions/focus-state-store.js';
import { resolveSessionIdFromEnv } from '../sessions/session-id.js';
import { trackBackgroundOp } from '../store/background-ops.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { logOperation } from '../tasks/add.js';
import { getUnresolvedDeps } from '../tasks/dependency-check.js';
import { isValidPipelineStage } from '../tasks/pipeline-stage.js';
import {
  type ClaimOverrideFlags,
  claimModeFor,
  releaseOwnClaim,
  resolveClaimant,
} from './claims.js';

export type {
  Claimant,
  ClaimOverrideFlags,
  SessionHeartbeatResult,
  SpawnClaimReceipt,
} from './claims.js';
export {
  claimModeFor,
  claimSpawnedTask,
  heartbeatProjectSession,
  releaseOwnClaim,
  releaseSpawnClaim,
  renewClaimsForSession,
  renewProjectSessionClaims,
  renewTaskClaim,
  resolveClaimant,
} from './claims.js';

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
  /**
   * The focus pointer when it names a done, cancelled, archived or missing
   * task. `currentTask` is then `null`: a finished task is never current (T12660).
   */
  staleFocus?: StaleFocusPointer;
}

/** Result of starting work on a task. */
export interface TaskStartResult {
  /** Coverage at task start; unavailable evidence never implies no impact. */
  knowledgeCoverage?: KnowledgeCoverage;
  taskId: string;
  taskTitle: string;
  previousTask: string | null;
  /**
   * The claim lease this start holds on the task, or `null` when the caller
   * is not bound to a session (no lease is taken). @task T12502
   */
  claim: TaskClaim | null;
}

/**
 * Options for {@link startTask}: explicit, audited overrides of another
 * session's claim (T12502).
 */
export type StartTaskOptions = ClaimOverrideFlags;

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
  // T12660/T12684: the one validating focus reader — a pointer left behind by
  // a completion (or the never-cleared legacy key) comes back stale.
  const {
    state: focus,
    currentTask: live,
    staleFocus,
  } = await readLiveFocus(acc, resolveFocusSessionId());

  return {
    currentTask: live,
    ...(staleFocus ? { staleFocus } : {}),
    currentPhase: focus?.currentPhase ?? null,
    sessionNote: focus?.sessionNote ?? null,
    nextAction: focus?.nextAction ?? null,
  };
}

/**
 * Refuse to start `taskId` while it has unresolved dependencies — the
 * readiness check {@link startTask} runs before it takes any claim or writes
 * focus. Exported so a composite verb (`pivot`) can run it BEFORE its own
 * side effects instead of discovering the refusal half-way (T12502).
 *
 * @param acc - Task accessor.
 * @param taskId - The task about to be started.
 * @throws CleoError `DEPENDENCY_ERROR` naming the unresolved blockers.
 * @example
 * ```ts
 * await assertTaskStartable(acc, 'T2');
 * ```
 * @task T12502
 */
export async function assertTaskStartable(acc: DataAccessor, taskId: string): Promise<void> {
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
}

/**
 * Start working on a specific task.
 *
 * T12502: the start takes the caller session's claim lease on the task with a
 * compare-and-set inside the same write transaction as the focus write. When
 * another session holds the task the start is refused with `E_TASK_CLAIMED`
 * naming the holder and lease expiry; `takeOver` takes an expired lease and
 * `forceClaim` a live one (both audited). The human `assignee` is not touched.
 * Starting a new task releases the lease this session held on its previous one.
 *
 * @param taskId - Task to start.
 * @param cwd - Project root.
 * @param accessor - Task accessor (tests inject one).
 * @param options - Claim overrides (`--take-over`, `--force-claim`).
 * @task T4462
 * @task T4750
 * @task T12502
 */
export async function startTask(
  taskId: string,
  cwd?: string,
  accessor?: DataAccessor,
  options: StartTaskOptions = {},
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
  await assertTaskStartable(acc, taskId);

  // Auto-advance pipelineStage: RCASD planning stages → implementation (T719)
  // Best-effort: if pipelineStage is in planning stages, advance to implementation.
  // This mirrors the lifecycle model: starting work means entering the IVTR phase.
  const currentStage = task.pipelineStage;
  const advanceStage =
    !!currentStage && isValidPipelineStage(currentStage) && PLANNING_STAGES.has(currentStage);

  // T12502 — the caller's claim identity: its BOUND session, never a guess.
  const claimant = await resolveClaimant(cwd);

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

  const projectRoot = resolveOrCwd(cwd);
  const claim = await acc.transaction(async () => {
    // T12502: claim first — a refusal rolls back before anything is written.
    const held = await acc.claimTask(taskId, { ...claimant, mode: claimModeFor(options) });
    if (advanceStage) {
      await acc.updateTaskFields(taskId, { pipelineStage: 'implementation' });
    }
    if (previousTask && previousTask !== taskId) {
      await releaseOwnClaim(acc, previousTask, claimant.sessionId);
    }
    await writeFocusState(acc, focusSessionId, focus);
    await logOperation(
      'task_start',
      taskId,
      { previousTask, title: task.title, claimedBy: held?.sessionId ?? null },
      acc,
    );
    trackBackgroundOp(async () => {
      const { hooks } = await import('../hooks/registry.js');
      await hooks.dispatch('PreToolUse', projectRoot, {
        timestamp: noteEntry.timestamp,
        taskId,
        taskTitle: task.title,
      });
    });
    return held;
  });

  return {
    knowledgeCoverage: await assessKnowledgeCoverage(resolveOrCwd(cwd)),
    taskId,
    taskTitle: task.title,
    previousTask,
    claim,
  };
}

/**
 * Stop working on the current task. T12502: releases the claim lease the
 * caller's session holds on it (a lease held by another session is left).
 * @task T4462
 * @task T4750
 * @task T12502
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
  const claimant = taskId ? await resolveClaimant(cwd) : null;

  const projectRoot = resolveOrCwd(cwd);
  await acc.transaction(async () => {
    if (taskId && claimant) await releaseOwnClaim(acc, taskId, claimant.sessionId);
    await writeFocusState(acc, focusSessionId, focus);
    await logOperation('task_stop', previousTask ?? 'none', { previousTask }, acc);
    if (taskId && task) {
      trackBackgroundOp(async () => {
        const { hooks } = await import('../hooks/registry.js');
        await hooks.dispatch('PostToolUse', projectRoot, {
          timestamp: now,
          taskId,
          taskTitle: task.title,
          status: 'done',
        });
      });
    }
  });

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
