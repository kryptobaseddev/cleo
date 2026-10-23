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
 * @param cwd - Project root, for the ranking context's focus phase (T12501).
 * @returns The wave number `cleo orchestrate waves` prints for it, or null.
 * @task T12682
 */
export async function waveNumberOfTask(
  epicId: string,
  taskId: string,
  accessor: DataAccessor,
  cwd?: string,
): Promise<number | null> {
  const { waves } = await planEpicWaves(epicId, accessor, [epicId], undefined, cwd);
  return waves.find((w) => w.tasks.includes(taskId))?.waveNumber ?? null;
}
