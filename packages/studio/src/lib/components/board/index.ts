/**
 * Generic Kanban Board component shelf (T11927).
 *
 * `Board.svelte` is the reusable, lane-agnostic column board generalised from
 * `pipeline/StageSwimLane.svelte`. The agent-lifecycle dispatcher view
 * (`/tasks/kanban`, T11925) is its first consumer.
 *
 * @task T11927
 * @epic T11559
 */

export { default as Board } from './Board.svelte';
export {
  type BoardCard,
  type BoardLane,
  type BoardLaneColumn,
  bucketBoardCards,
} from './board-types.js';
