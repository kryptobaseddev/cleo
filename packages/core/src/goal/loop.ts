/**
 * Turn-budgeted goal loop (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * The loop is the Hermes-style post-turn driver, hardened: it consumes one turn
 * per advance, enforces a hard {@link GoalRecord.turnBudget}, surfaces
 * `impossible` verdicts as a terminal state (no further turns), and — the Hermes
 * pattern that prevents silent crashes — AUTO-PAUSES on a judge/parse failure
 * rather than aborting.
 *
 * `advanceGoal` is PURE and DETERMINISTIC over `(goal, judgeFn)`: it performs no
 * I/O itself (the judge is injected; persistence is the caller's job via the
 * store's `updateGoal`). This makes every transition trivially unit-testable
 * offline and keeps the budget/impossible/pause logic in one auditable place.
 *
 * Transition table (the four AC-mandated outcomes):
 * - `verdict.ok`         → `satisfied` (terminal).
 * - `verdict.impossible` → `impossible` (terminal; consumes NO turn).
 * - judge/parse failure  → `paused` (auto-pause, `pausedReason` set).
 * - turn budget reached  → `abandoned` (terminal).
 * - otherwise            → `active` (one turn consumed; keep going).
 *
 * @module @cleocode/core/goal/loop
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11379
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type {
  GoalAdvanceResult,
  GoalJudgeVerdict,
  GoalRecord,
  GoalStatus,
} from '@cleocode/contracts';

/**
 * A judge function the loop invokes once per advance. Injected so the loop is
 * pure over `(goal, judgeFn)` — production passes a closure over `judgeGoal`,
 * tests pass a deterministic stub.
 *
 * @param goal - The goal being advanced.
 * @returns The verdict for this turn.
 * @task T11379
 */
export type GoalJudgeFn = (goal: GoalRecord) => Promise<GoalJudgeVerdict>;

/**
 * A minimal, well-formed {@link GoalJudgeVerdict}-shaped object check.
 *
 * A judge that returns a malformed value (missing `ok`/`impossible`, wrong
 * types) is treated as a PARSE FAILURE — the goal auto-pauses rather than
 * trusting a garbage verdict. This is the structural half of the Hermes
 * parse-failure pattern (the thrown-error half is handled by the try/catch in
 * {@link advanceGoal}).
 *
 * @param value - The judge's return value.
 * @returns `true` when `value` is a structurally-valid verdict.
 * @task T11379
 */
export function isWellFormedVerdict(value: unknown): value is GoalJudgeVerdict {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ok === 'boolean' && typeof v.impossible === 'boolean' && typeof v.reason === 'string'
  );
}

/**
 * The malformed-verdict sentinel used as the verdict in an auto-pause result
 * when the judge returned an unparseable value (vs. threw). Carries
 * `impossible: false` so a resumed goal is not mistaken for terminal.
 *
 * @internal
 */
function pauseVerdict(reason: string): GoalJudgeVerdict {
  return { ok: false, impossible: false, reason };
}

/**
 * Advance a goal one turn through the budgeted loop.
 *
 * Pure and deterministic over `(goal, judgeFn)` — NO persistence here; the
 * caller persists the returned `nextStatus` / `turnsRemaining` via the goal
 * store's `updateGoal`. Already-terminal goals are returned unchanged (no turn
 * is consumed, no judge is called) so the loop is idempotent at its boundaries.
 *
 * Ordering rationale:
 * - The judge runs FIRST so a goal that became satisfiable/impossible since the
 *   last turn is detected before a turn is "spent".
 * - `impossible` consumes NO turn (the verdict is final regardless of budget).
 * - `ok` consumes NO turn (work is done).
 * - Only the "keep going" path consumes a turn, and the budget check fires AFTER
 *   incrementing so `turnsRemaining` never goes negative.
 *
 * @param goal - The current goal record.
 * @param judgeFn - The injected judge (see {@link GoalJudgeFn}).
 * @returns The verdict, the next status, and the remaining turns.
 * @task T11379
 */
export async function advanceGoal(
  goal: GoalRecord,
  judgeFn: GoalJudgeFn,
): Promise<GoalAdvanceResult> {
  const remainingBefore = Math.max(0, goal.turnBudget - goal.turnsUsed);

  // Already-terminal goals are inert — return them unchanged.
  if (goal.status === 'satisfied' || goal.status === 'abandoned' || goal.status === 'impossible') {
    return {
      verdict: goal.lastVerdict ?? pauseVerdict(`Goal already ${goal.status}; no further turns.`),
      nextStatus: goal.status,
      turnsRemaining: remainingBefore,
    };
  }

  // Hermes auto-pause: a judge that THROWS (network blip, parse crash) must
  // never abort the loop — pause the goal with the cause and let it resume.
  let verdict: GoalJudgeVerdict;
  try {
    const raw = await judgeFn(goal);
    if (!isWellFormedVerdict(raw)) {
      return {
        verdict: pauseVerdict('Judge returned a malformed verdict (auto-paused).'),
        nextStatus: 'paused',
        turnsRemaining: remainingBefore,
      };
    }
    verdict = raw;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: pauseVerdict(`Judge failed: ${message} (auto-paused).`),
      nextStatus: 'paused',
      turnsRemaining: remainingBefore,
    };
  }

  // Satisfied — terminal, no turn consumed.
  if (verdict.ok) {
    return { verdict, nextStatus: 'satisfied', turnsRemaining: remainingBefore };
  }

  // Impossible — terminal, no turn consumed (the verdict is final).
  if (verdict.impossible) {
    return { verdict, nextStatus: 'impossible', turnsRemaining: remainingBefore };
  }

  // Keep going: consume one turn. Budget is checked AFTER the increment so the
  // turn that exhausts the budget is the one that triggers abandonment, and
  // turnsRemaining floors at 0.
  const turnsRemaining = Math.max(0, remainingBefore - 1);
  const nextStatus: GoalStatus = turnsRemaining === 0 ? 'abandoned' : 'active';
  const finalVerdict: GoalJudgeVerdict =
    nextStatus === 'abandoned'
      ? {
          ok: false,
          impossible: false,
          reason: `Turn budget exhausted (${goal.turnBudget} turns) before satisfaction. Last judge reason: ${verdict.reason}`,
        }
      : verdict;

  return { verdict: finalVerdict, nextStatus, turnsRemaining };
}
