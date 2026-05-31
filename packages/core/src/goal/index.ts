/**
 * CLEO-native goal system — barrel (Layer 4 of SG-COGNITIVE-SUBSTRATE).
 *
 * Surfaces the DB-persisted per-agent goal store, the evidence-gate-aware judge
 * (+ injectable LLM fallback), the turn-budgeted loop, and the prompt-cache-safe
 * continuation builder. Re-exported from the core barrel as `goal.*` so the CLI
 * layer dispatches into these ops without reaching past the package boundary.
 *
 * @module @cleocode/core/goal
 *
 * @epic T11290 EP-CLEO-GOAL-SYSTEM
 * @saga T11283 SG-COGNITIVE-SUBSTRATE
 */

export {
  type AdvanceWithPersistResult,
  advanceGoalWithPersist,
} from './advance-with-persist.js';
export { type ArmGoalLoopParams, armGoalLoop } from './arm.js';
export { buildContinuation, CONTINUATION_MAX_BYTES } from './continuation.js';
export {
  CRITICAL_GATE_COUNT,
  CRITICAL_GATES,
  judgeGoal,
  judgeTaskCompletion,
  StaticGoalJudge,
} from './judge.js';
export {
  advanceGoal,
  type GoalJudgeFn,
  isWellFormedVerdict,
} from './loop.js';
export {
  appendCriteria,
  type CreateGoalParams,
  createGoal,
  type GoalOwner,
  getActiveGoal,
  getGoalById,
  listGoals,
  resolveGoalOwner,
  type UpdateGoalFields,
  updateGoal,
} from './store.js';
