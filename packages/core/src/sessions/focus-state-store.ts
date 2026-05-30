/**
 * Per-session focus_state keying (T11345 · Epic T11284 · SG-COGNITIVE-SUBSTRATE).
 *
 * `focus_state` is the per-agent work-state blob (currentTask, sessionNotes,
 * nextAction, …). Historically it lived under ONE global meta key
 * (`focus_state`) shared by every agent — so two concurrent agents writing
 * their current task clobbered each other. This module keys it per resolved
 * session id (`focus_state:<sessionId>`), with a backward-compatible read
 * fallback to the legacy global key so no data is lost on upgrade.
 *
 * Single source of truth: every read/write callsite across engine-ops,
 * briefing, drift-watchdog, session-drift, session-switch, and orchestrate/pivot
 * routes through {@link readFocusState} / {@link writeFocusState} so the keying
 * + fallback precedence is never duplicated.
 *
 * @task T11345
 * @epic T11284
 */

import type { TaskWorkState } from '@cleocode/contracts';

/**
 * The legacy global focus_state meta key, shared by all agents before T11345.
 *
 * Retained as the read-fallback target so sessions that wrote focus_state
 * before this change (and the global-scope/no-session case) keep resolving.
 *
 * @task T11345
 */
export const LEGACY_FOCUS_STATE_KEY = 'focus_state' as const;

/**
 * Minimal structural view of the metadata accessor used by the focus-state
 * helpers. Declared locally (not importing the full `DataAccessor`) so this
 * module stays decoupled from the store implementation — any object exposing
 * the two meta methods satisfies it.
 *
 * @task T11345
 */
export interface FocusStateMetaAccessor {
  getMetaValue<T>(key: string): Promise<T | null>;
  setMetaValue(key: string, value: unknown): Promise<void>;
}

/**
 * Compute the focus_state meta key for a resolved session id.
 *
 * - A non-empty session id → the per-session key `focus_state:<sessionId>`.
 * - `null` / `undefined` (no resolvable session, e.g. global-scope CLI call) →
 *   the legacy global key so behaviour is unchanged when there is no session.
 *
 * @param sessionId - Resolved session id, or `null` when none.
 * @returns The meta key to read/write.
 * @task T11345
 */
export function focusStateKey(sessionId: string | null | undefined): string {
  return sessionId ? `${LEGACY_FOCUS_STATE_KEY}:${sessionId}` : LEGACY_FOCUS_STATE_KEY;
}

/**
 * Read the focus_state blob for a resolved session id (per-session, env-aware).
 *
 * Resolution:
 * 1. Read the per-session key `focus_state:<sessionId>`.
 * 2. If absent AND a session id was provided, fall back to the legacy global
 *    `focus_state` key (backward-compat — sessions written before T11345).
 *
 * @param accessor  - Metadata accessor.
 * @param sessionId - Resolved session id (or `null` for the global key).
 * @returns The focus_state blob, or `null` when neither key has a value.
 * @task T11345
 */
export async function readFocusState(
  accessor: FocusStateMetaAccessor,
  sessionId: string | null | undefined,
): Promise<TaskWorkState | null> {
  const key = focusStateKey(sessionId);
  const scoped = await accessor.getMetaValue<TaskWorkState>(key);
  if (scoped) return scoped;

  // Backward-compat: a session existed before T11345 keyed under the global
  // key. Only fall back when we actually scoped to a session (else the scoped
  // key IS the legacy key and we'd read it twice).
  if (sessionId) {
    return accessor.getMetaValue<TaskWorkState>(LEGACY_FOCUS_STATE_KEY);
  }
  return null;
}

/**
 * Write the focus_state blob for a resolved session id (per-session).
 *
 * Always writes the per-session key so concurrent agents never clobber each
 * other. The legacy global key is left untouched (read-only fallback) to avoid
 * resurrecting the shared-write contention this module exists to eliminate.
 *
 * @param accessor  - Metadata accessor.
 * @param sessionId - Resolved session id (or `null` for the global key).
 * @param value     - The focus_state blob to persist.
 * @task T11345
 */
export async function writeFocusState(
  accessor: FocusStateMetaAccessor,
  sessionId: string | null | undefined,
  value: TaskWorkState,
): Promise<void> {
  await accessor.setMetaValue(focusStateKey(sessionId), value);
}
