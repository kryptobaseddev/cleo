/**
 * Goal-loop arming — create + register the per-saga goal that `cleo go`
 * uses to drive the Stop-hook self-renudge cycle (AC3 of T11496).
 *
 * `armGoalLoop` is called by `cleoGo()` after it has selected the active saga.
 * It creates (or reuses via idempotency key) a `fuzzy` goal whose intent
 * describes the saga work. The Stop-hook then advances this goal each turn,
 * re-injecting the continuation nudge until `judgeGoal` signals
 * `satisfied` or `impossible`.
 *
 * ## Idempotency
 *
 * The idempotency key is `cleo-go:${sagaId}:${epochDay}`, ensuring one goal
 * per saga per calendar day. Re-runs of `cleo go` on the same day reuse the
 * existing goal (via `onConflictDoNothing` in the store) rather than
 * accumulating rows.
 *
 * ## Why fuzzy?
 *
 * Saga completion is orchestration-level progress — not a single task with
 * ADR-051 evidence gates. A `fuzzy` goal lets the loop keep nudging Claude
 * until the saga rollup shows the desired state; the injected nudge text
 * (from `buildContinuation`) reminds Claude of the intent each turn.
 *
 * @module @cleocode/core/goal/arm
 *
 * @task T11496 E4-GOAL-LOOP
 * @epic T11492 SG-AUTOPILOT
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type { GoalRecord } from '@cleocode/contracts';
import { createGoal } from './store.js';

/** Default turn budget for a saga-level goal (a full autopilot session). */
const SAGA_GOAL_TURN_BUDGET = 20;

/**
 * Parameters for {@link armGoalLoop}.
 *
 * @task T11496
 */
export interface ArmGoalLoopParams {
  /** The saga being worked on (e.g. `'T11492'`). */
  readonly sagaId: string;
  /** Human-readable saga title for the goal intent. */
  readonly sagaTitle?: string;
  /** Override project root (useful in tests). */
  readonly cwd?: string;
  /**
   * Turn budget for the goal (default: {@link SAGA_GOAL_TURN_BUDGET}).
   */
  readonly turnBudget?: number;
}

/**
 * Create (or reuse) the per-saga goal that arms the Stop-hook self-renudge
 * loop for `cleo go`.
 *
 * Idempotent on `(sagaId, calendarDay)` — safe to call every `cleo go` turn.
 *
 * @param params - Arming parameters.
 * @returns The created (or pre-existing) {@link GoalRecord}.
 *
 * @task T11496
 */
export async function armGoalLoop(params: ArmGoalLoopParams): Promise<GoalRecord> {
  const { sagaId, sagaTitle, cwd, turnBudget = SAGA_GOAL_TURN_BUDGET } = params;

  // Idempotency key: one goal per saga per calendar day.
  const epochDay = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const idempotencyKey = `cleo-go:${sagaId}:${epochDay}`;

  const intent =
    sagaTitle != null
      ? `Drive saga ${sagaId} (${sagaTitle}) forward — pick the next ready task and advance it until done.`
      : `Drive saga ${sagaId} forward — pick the next ready task and advance it until done.`;

  const criteria: readonly string[] = [
    `All tasks in saga ${sagaId} reach 'done' status with ADR-051 evidence gates satisfied.`,
    'Each turn: run `cleo go` to pick the next ready task and start IVTR.',
  ];

  return createGoal(
    {
      goalKind: { kind: 'fuzzy' },
      intent,
      turnBudget,
      criteria,
      idempotencyKey,
    },
    cwd,
  );
}
