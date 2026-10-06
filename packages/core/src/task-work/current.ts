/**
 * The current task work state: the session's live focus pointer.
 *
 * A leaf module. `./index.js` registers the hook handlers at load
 * (`import '../hooks/handlers/index.js'`) and imports task creation, claims and
 * nexus coverage for starting and stopping work; reading the focus needs none
 * of them, and `cleo current` runs often. `./index.js` re-exports
 * {@link currentTask} and {@link TaskCurrentResult}.
 *
 * @task T4462
 * @task T4750
 * @task T13126 - split out of task-work/index.ts
 */

import {
  readLiveFocus,
  resolveFocusSessionId,
  type StaleFocusPointer,
} from '../sessions/focus-state-store.js';
import type { DataAccessor } from '../store/data-accessor.js';
import { getTaskAccessor } from '../store/data-accessor.js';

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
  } = await readLiveFocus(acc, await resolveFocusSessionId(cwd));

  return {
    currentTask: live,
    ...(staleFocus ? { staleFocus } : {}),
    currentPhase: focus?.currentPhase ?? null,
    sessionNote: focus?.sessionNote ?? null,
    nextAction: focus?.nextAction ?? null,
  };
}
