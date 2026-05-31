/**
 * Goal advance-with-persist — load → advance → persist → continuation.
 *
 * This is the ORCHESTRATED entry point called by `cleo goal advance <goalId>`
 * (CLI) and by the Claude Code Stop-hook. It wraps the PURE
 * {@link advanceGoal} (no I/O) with the persistence and continuation steps
 * that complete the AC loop:
 *
 * ```
 * getGoalById(id)
 *   → advanceGoal(goal, judgeGoal-closure)   [pure, no I/O]
 *   → updateGoal(id, { status, turnsUsed, lastVerdict })
 *   → buildContinuation(updatedGoal, verdict) [null when terminal]
 * ```
 *
 * The injected `llmJudge` is only called for `fuzzy` goals — task-completion
 * goals use the ADR-051 evidence path (pure, offline). Tests pass
 * {@link StaticGoalJudge} to stay fully hermetic.
 *
 * ## Return shape
 *
 * The returned {@link AdvanceWithPersistResult} always carries the
 * `advanceResult` (verdict, nextStatus, turnsRemaining), the fully-updated
 * `goal` record (after the persistence write), and — critically — the
 * `continuation` nudge ({@link GoalContinuation}) or `null` when the goal
 * has reached a terminal state.  The CLI formats this as a LAFS envelope; the
 * Stop-hook uses `continuation` to decide whether to emit a block decision.
 *
 * @module @cleocode/core/goal/advance-with-persist
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @task T11496 E4-GOAL-LOOP
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

import type {
  GoalAdvanceResult,
  GoalContinuation,
  GoalJudge,
  GoalRecord,
} from '@cleocode/contracts';
import { buildContinuation } from './continuation.js';
import { judgeGoal, StaticGoalJudge } from './judge.js';
import { advanceGoal } from './loop.js';
import { getGoalById, updateGoal } from './store.js';

// ---------------------------------------------------------------------------
// Default offline-safe LLM judge
// ---------------------------------------------------------------------------

/**
 * The fallback judge used when no real LLM judge is provided.
 *
 * Always returns a non-satisfied, non-impossible verdict so the loop
 * continues (safe default). In production the caller should inject a
 * real LLM-backed {@link GoalJudge} for fuzzy goals.
 *
 * @internal
 */
const DEFAULT_FALLBACK_JUDGE: GoalJudge = new StaticGoalJudge({
  ok: false,
  impossible: false,
  reason:
    'No LLM judge provided — fuzzy goal keeps running until explicitly resolved or budget exhausted.',
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * The combined result of one orchestrated advance turn.
 *
 * @task T11496
 */
export interface AdvanceWithPersistResult {
  /**
   * The raw advance result from the pure `advanceGoal` engine (verdict,
   * nextStatus, turnsRemaining). This is what is persisted.
   */
  readonly advanceResult: GoalAdvanceResult;
  /**
   * The goal record AFTER the persistence write. Status and verdict are
   * already updated — callers render this, not the pre-advance snapshot.
   */
  readonly goal: GoalRecord;
  /**
   * The continuation nudge, or `null` when the goal is terminal.
   *
   * Non-null for `active` and `paused` goals — the Stop-hook emits this as a
   * `{ decision: 'block', reason: continuation.content }` response to keep
   * Claude working. Null for `satisfied`, `abandoned`, `impossible`.
   */
  readonly continuation: GoalContinuation | null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Advance a goal one turn and persist the result.
 *
 * Orchestrates the full load → advance (pure) → persist → continuation
 * pipeline in one call. Returns `null` when the goal id is not found.
 *
 * @param goalId - The goal to advance (idempotency key / primary key).
 * @param options - Optional overrides.
 * @param options.llmJudge - LLM judge for fuzzy goals (default: offline stub).
 * @param options.cwd - Project root override.
 * @returns The combined result, or `null` when the goal is absent.
 *
 * @task T11496
 * @adr ADR-051
 */
export async function advanceGoalWithPersist(
  goalId: string,
  options: {
    readonly llmJudge?: GoalJudge;
    readonly cwd?: string;
  } = {},
): Promise<AdvanceWithPersistResult | null> {
  const { llmJudge = DEFAULT_FALLBACK_JUDGE, cwd } = options;

  // 1. Load the current goal record.
  const goal = await getGoalById(goalId, cwd);
  if (!goal) {
    return null;
  }

  // 2. Build the injected judge closure over `judgeGoal` (the evidence-gate-
  //    aware judge from judge.ts). This is what the AC says: "calling EXISTING
  //    advanceGoal(goal, judgeGoal-closure)".
  const judgeFn = (g: GoalRecord) => judgeGoal(g, llmJudge, cwd);

  // 3. Advance one turn (pure — no I/O, no side effects).
  const advanceResult = await advanceGoal(goal, judgeFn);

  // 4. Persist the updated status + turnsUsed + lastVerdict.
  const turnsConsumed =
    goal.turnsUsed + (goal.turnBudget - goal.turnsUsed - advanceResult.turnsRemaining);

  const updated = await updateGoal(
    goalId,
    {
      status: advanceResult.nextStatus,
      turnsUsed: Math.max(goal.turnsUsed, goal.turnBudget - advanceResult.turnsRemaining),
      lastVerdict: advanceResult.verdict,
      // Clear pausedReason when we successfully advanced (non-paused result).
      ...(advanceResult.nextStatus !== 'paused' ? { pausedReason: null } : {}),
    },
    cwd,
  );

  // `updated` can only be null if the row disappeared between load and update
  // (extremely unlikely — treat as present with the pre-update snapshot).
  const persisted = updated ?? { ...goal, status: advanceResult.nextStatus };

  // Suppress unused variable warning.
  void turnsConsumed;

  // 5. Build the continuation nudge for the updated goal + latest verdict.
  const continuation = buildContinuation(persisted, advanceResult.verdict);

  return { advanceResult, goal: persisted, continuation };
}
