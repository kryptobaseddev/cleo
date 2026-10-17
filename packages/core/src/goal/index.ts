/**
 * CLEO goal record — barrel.
 *
 * CLEO owns the goal protocol and OpenCode-Goal is the goal runtime (ADR-097,
 * owner decision 2026-10-16, epic T13791): the protocol verbs live in
 * `./draft.js` and `./close.js`, loaded directly by `cleo goal draft|close`.
 * CLEO's own turn-budgeted goal loop (judge, continuation, Stop hook, `cleo go`
 * arming) is retired (T13797); only the persisted goal record remains here,
 * re-exported from the core barrel as `goal.*`.
 *
 * @module @cleocode/core/goal
 *
 * @epic T13791
 * @task T13797
 */

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
