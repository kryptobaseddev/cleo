/**
 * The one wave topic (T12682).
 *
 * A Lead listens on `epic-<epicId>.wave-<n>`, where `n` is the wave number
 * `cleo orchestrate waves <epic>` prints (from 1). A spawned worker must
 * publish on exactly that topic. Workers used to be told
 * `epic-<epicId>.wave-<last 4 digits of their task id>`, so a Lead never heard
 * them. Both sides now derive the topic here, from the same wave plan
 * ({@link planEpicWaves}).
 *
 * @task T12682
 */

import type { DataAccessor } from '../store/data-accessor.js';
import type { ConduitSubscriptionConfig } from './spawn-prompt.js';
import { planEpicWaves } from './waves.js';

/**
 * The wave topic a Lead listens on and its workers publish to.
 *
 * @param epicId - Parent epic.
 * @param waveNumber - Wave number as `cleo orchestrate waves` prints it (from 1).
 * @returns `epic-<epicId>.wave-<waveNumber>`.
 * @task T12682
 */
export function waveTopic(epicId: string, waveNumber: number): string {
  return `epic-${epicId}.wave-${waveNumber}`;
}

/**
 * The epic's coordination topic (orchestrator broadcasts).
 *
 * @param epicId - Parent epic.
 * @returns `epic-<epicId>.coordination`.
 * @task T12682
 */
export function coordinationTopic(epicId: string): string {
  return `epic-${epicId}.coordination`;
}

/**
 * The wave a task belongs to in its epic's plan, or null when the task is not
 * scheduled (done, cancelled, or not a child of the epic).
 *
 * @param epicId - Parent epic.
 * @param taskId - Task to locate.
 * @param accessor - Task accessor.
 * @returns The wave number `cleo orchestrate waves` prints for it, or null.
 * @task T12682
 */
export async function waveNumberOfTask(
  epicId: string,
  taskId: string,
  accessor: DataAccessor,
): Promise<number | null> {
  const { waves } = await planEpicWaves(epicId, accessor);
  return waves.find((w) => w.tasks.includes(taskId))?.waveNumber ?? null;
}

/**
 * The CONDUIT subscription a spawned worker is given: its parent epic and the
 * wave it belongs to in that epic's plan. Undefined for a top-level task, or
 * one the plan does not schedule — never a topic no Lead listens on.
 *
 * @param taskId - Task being spawned.
 * @param accessor - Task accessor.
 * @returns The subscription, or undefined.
 * @task T12682
 */
export async function deriveConduitSubscription(
  taskId: string,
  accessor: DataAccessor,
): Promise<ConduitSubscriptionConfig | undefined> {
  const task = await accessor.loadSingleTask(taskId);
  if (!task?.parentId) return undefined;
  const waveId = await waveNumberOfTask(task.parentId, taskId, accessor);
  if (waveId === null) return undefined;
  return { epicId: task.parentId, waveId, peerId: `cleo-agent-${taskId.toLowerCase()}` };
}
