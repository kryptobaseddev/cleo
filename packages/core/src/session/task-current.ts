/**
 * `tasks.current`: the task the session is working on.
 *
 * A leaf module. `./engine-ops.js` imports the sessions barrel and task-work,
 * which register the hook handlers when they load; reading the focus pointer
 * needs neither, and agents run `cleo current` often. `./engine-ops.js`
 * re-exports {@link taskCurrentGet}.
 *
 * @task T1573
 * @task T13126 - split out of session/engine-ops.ts
 */

import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { pushWarning } from '../output.js';
import { type StaleFocusPointer, staleFocusWarning } from '../sessions/focus-state-store.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { currentTask } from '../task-work/current.js';

/**
 * Get current task being worked on.
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with currentTask and currentPhase
 *
 * @task T1573
 */
export async function taskCurrentGet(projectRoot: string): Promise<
  EngineResult<{
    currentTask: string | null;
    currentPhase: string | null;
    staleFocus?: StaleFocusPointer;
    nextSuggested?: { id: string; title: string } | null;
  }>
> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    const result = await currentTask(projectRoot, accessor);
    if (!result.staleFocus)
      return engineSuccess({
        currentTask: result.currentTask,
        currentPhase: result.currentPhase,
      });
    // T12660: a done/cancelled/missing pointer is reported as stale, with the
    // next ready task in its place — never as the current task.
    const { coreTaskNext } = await import('../tasks/task-next.js');
    // T12689: a one-line hint — no brain pattern scoring for `cleo current`.
    const top = (await coreTaskNext(projectRoot, { count: 1, brain: false })).suggestions[0];
    const nextSuggested = top ? { id: top.id, title: top.title } : null;
    pushWarning({
      code: 'W_STALE_FOCUS',
      message: staleFocusWarning(result.staleFocus, nextSuggested),
    });
    return engineSuccess({
      currentTask: null,
      currentPhase: result.currentPhase,
      staleFocus: result.staleFocus,
      nextSuggested,
    });
  } catch {
    return engineError('E_NOT_INITIALIZED', 'Task database not initialized');
  }
}
