/**
 * `session.status`: the caller's session and its live focus.
 *
 * A leaf module. `./engine-ops.js` imports the sessions barrel and task-work,
 * which register the hook handlers when they load; reporting status reads the
 * session store and the focus pointer and needs neither. `./engine-ops.js`
 * re-exports {@link sessionStatus}.
 *
 * @task T1573
 * @task T13126 - split out of session/engine-ops.ts
 */

import type { Session, TaskWorkState } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { exodusRefusalToEngineResult } from '../errors-to-engine.js';
import { focusSessionIdFromRead, readLiveFocus } from '../sessions/focus-state-store.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { resolveSessionForRead } from '../store/session-store.js';

/**
 * Get current session status.
 *
 * Returns whether there is an active session, along with the session record,
 * current task work state, and the running CLEO_OWNER_OVERRIDE count for
 * the active session (T1501 / P0-5).
 *
 * @param projectRoot - Absolute path to the project root
 * @returns EngineResult with active session flag, session record, task work
 *   state, and `overrideCount` for the active session.
 *
 * @task T1573
 */
export async function sessionStatus(projectRoot: string): Promise<
  EngineResult<{
    hasActiveSession: boolean;
    session?: Session | null;
    taskWork?: TaskWorkState | null;
    /** Running CLEO_OWNER_OVERRIDE count for the active session. */
    overrideCount: number;
    /**
     * `true` when this caller is NOT bound to a session and `session` is only
     * the newest active row — possibly another agent's (T12500). Omitted when
     * the session is the caller's own.
     */
    unbound?: true;
  }>
> {
  try {
    const accessor = await getTaskAccessor(projectRoot);
    // T11344 — env-first identity resolution. The CALLER's session
    // (`CLEO_SESSION_ID`) wins over the DB's most-recent active row so a
    // spawned agent's `cleo session status` reports ITS own session.
    // T12500 — read-only: an unbound caller may still SEE the newest active
    // row, but the envelope labels it `unbound: true`.
    const read = await resolveSessionForRead(projectRoot);
    const { session: active, unbound } = read;
    // T11345 — read the per-session focus_state key for the resolved session.
    // T12684: the live focus — a finished task is reported as staleFocus.
    // T12501: keyed by THE focus-key rule, the one `cleo start` writes — never
    // the newest active row's key for an unbound caller. Derived from the one
    // resolution above (same bound tiers), not resolved twice.
    const liveFocus = await readLiveFocus(accessor, focusSessionIdFromRead(read));
    const focusState = liveFocus.state
      ? { ...liveFocus.state, currentTask: liveFocus.currentTask }
      : null;

    // Surface persisted override count for the active session (T1501).
    let overrideCount = 0;
    if (active) {
      const { readSessionOverrideCount } = await import('../security/override-cap.js');
      overrideCount = readSessionOverrideCount(projectRoot, active.id);
    }

    return engineSuccess({
      hasActiveSession: !!active && active.status === 'active',
      session: active ?? null,
      taskWork: focusState,
      ...(liveFocus.staleFocus ? { staleFocus: liveFocus.staleFocus } : {}),
      overrideCount,
      ...(unbound ? { unbound: true as const } : {}),
    });
  } catch (err) {
    // T13167: a write the store refused (legacy migration deferred or aborted)
    // keeps its typed code and remedy.
    return (
      exodusRefusalToEngineResult(err) ??
      engineError('E_NOT_INITIALIZED', 'Task database not initialized')
    );
  }
}
