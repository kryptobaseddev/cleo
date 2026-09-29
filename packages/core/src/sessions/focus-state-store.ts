/**
 * Per-session focus_state keying (T11345 · Epic T11284 · SG-COGNITIVE-SUBSTRATE).
 *
 * `focus_state` is the per-agent work-state blob (currentTask, sessionNotes,
 * nextAction, …). Historically it lived under ONE global meta key
 * (`focus_state`) shared by every agent — so two concurrent agents writing
 * their current task clobbered each other. This module keys it per resolved
 * session id (`focus_state:<sessionId>`). The legacy global key remains the
 * focus of an UNBOUND caller only (T12501).
 *
 * Single source of truth: every read/write callsite across engine-ops,
 * briefing, drift-watchdog, session-drift, session-switch, and orchestrate/pivot
 * routes through {@link readFocusState} / {@link writeFocusState}, and every
 * caller picks its session through {@link resolveFocusSessionId}, so the
 * keying is never duplicated (T12501).
 *
 * @task T11345
 * @epic T11284
 */

import type { TaskWorkState } from '@cleocode/contracts';
import { TERMINAL_TASK_STATUSES } from '@cleocode/contracts';

/**
 * The legacy global focus_state meta key, shared by all agents before T11345.
 *
 * UNBOUND CALLERS ONLY (T12501): it is the focus of a caller that is bound to
 * no session — {@link resolveFocusSessionId} returned `null`. A caller bound
 * to a session never reads or writes it: its focus lives only under
 * `focus_state:<sessionId>`. The one exception is
 * {@link clearFocusForFinishedTask}, which clears a pointer to a finished task
 * wherever it is.
 *
 * @task T11345
 * @task T12501
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
  /**
   * Run a read-modify-write atomically (the store's write transaction). When
   * present, {@link clearFocusForFinishedTask} compares and clears each key
   * inside it, so a concurrent focus write is never overwritten (T12689).
   */
  transaction?<T>(
    fn: (tx: { setMetaValue(key: string, value: unknown): Promise<void> }) => Promise<T>,
  ): Promise<T>;
}

/**
 * THE focus-key rule (T12501): the session whose focus key the CALLER reads
 * and writes. Every focus reader and writer — start, stop, pivot, complete's
 * clear, `cleo current`, session status, briefing, inject, bootstrap, stats,
 * validation, attention and orchestrator startup — resolves through this one
 * function, so a write and the read that follows it can never land on
 * different keys.
 *
 * It is the mutation resolver (`resolveBoundSessionId` in `store/session-store.ts`): the daemon
 * connection handle, then an env-named session whose row exists, then the
 * session this terminal started or resumed. It never guesses the newest
 * active row — from an unbound terminal that is another agent's session, and
 * its focus is not this caller's.
 *
 * `null` means the caller is bound to no session (or the session store
 * cannot be opened); {@link focusStateKey} then maps it to the legacy global
 * key (unbound callers only).
 *
 * @param cwd - Project root for session resolution.
 * @returns The bound session id, or `null` when the caller is unbound.
 * @example
 * ```ts
 * const focus = await readLiveFocus(acc, await resolveFocusSessionId(projectRoot));
 * ```
 * @task T12501
 */
export async function resolveFocusSessionId(cwd?: string): Promise<string | null> {
  // Dynamic: the store module is heavy and this module is imported widely.
  const { resolveBoundSessionId } = await import('../store/session-store.js');
  try {
    return await resolveBoundSessionId(cwd);
  } catch {
    // No readable session store means no session can be bound: the caller is
    // unbound, exactly as before any session existed.
    return null;
  }
}

/**
 * Compute the focus_state meta key for a session id from
 * {@link resolveFocusSessionId} (or an explicitly named session).
 *
 * - A non-empty session id → the per-session key `focus_state:<sessionId>`.
 * - `null` / `undefined` (the caller is bound to no session) → the legacy
 *   global key, {@link LEGACY_FOCUS_STATE_KEY}. Only an unbound caller lands
 *   here (T12501).
 *
 * @param sessionId - Resolved session id, or `null` when none.
 * @returns The meta key to read/write.
 * @task T11345
 */
export function focusStateKey(sessionId: string | null | undefined): string {
  return sessionId ? `${LEGACY_FOCUS_STATE_KEY}:${sessionId}` : LEGACY_FOCUS_STATE_KEY;
}

/**
 * Read the RAW focus_state blob for a session id — for read-modify-write
 * only. Anything that reports or acts on the current task reads
 * {@link readLiveFocus}, which never returns a finished task (T12684).
 *
 * Reads exactly one key, {@link focusStateKey}. A bound session with no focus
 * yet has none: it does NOT fall back to the legacy global key, which holds
 * an unbound caller's focus, not this session's (T12501).
 *
 * @param accessor  - Metadata accessor.
 * @param sessionId - Session id from {@link resolveFocusSessionId}, or `null`
 *   for an unbound caller (the legacy key).
 * @returns The focus_state blob, or `null` when the key has no value.
 * @task T11345
 * @task T12501
 */
export async function readFocusState(
  accessor: FocusStateMetaAccessor,
  sessionId: string | null | undefined,
): Promise<TaskWorkState | null> {
  return accessor.getMetaValue<TaskWorkState>(focusStateKey(sessionId));
}

/**
 * Write the focus_state blob for a session id.
 *
 * A bound session writes only its own key, so concurrent sessions never
 * clobber each other and never touch the legacy global key; only an unbound
 * caller (`sessionId` null) writes the legacy key (T12501).
 *
 * @param accessor  - Metadata accessor.
 * @param sessionId - Session id from {@link resolveFocusSessionId}, or `null`
 *   for an unbound caller (the legacy key).
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

/**
 * Clear the focus pointer to a task that just finished, in every scope that
 * holds it: each given session key and the legacy global key (T12660).
 *
 * Only a blob whose `currentTask` IS `taskId` is touched, and only that field
 * is cleared — notes and phase stay. Nothing else ever cleared the legacy key,
 * so `cleo current` kept reporting a task done weeks earlier.
 *
 * @param accessor   - Metadata accessor.
 * @param sessionIds - Session ids whose scoped key may hold the pointer
 *   (the caller's {@link resolveFocusSessionId}); duplicates and nulls are
 *   ignored.
 * @param taskId     - The completed task.
 * @returns The meta keys that were cleared (empty when none pointed at it).
 * @task T12660
 */
export async function clearFocusForFinishedTask(
  accessor: FocusStateMetaAccessor,
  sessionIds: ReadonlyArray<string | null | undefined>,
  taskId: string,
): Promise<string[]> {
  const keys = new Set<string>([LEGACY_FOCUS_STATE_KEY]);
  for (const id of sessionIds) if (id) keys.add(focusStateKey(id));
  const cleared: string[] = [];
  for (const key of keys) {
    // T12689: compare-and-clear in one transaction when the store offers one —
    // a pointer another session re-set between the read and the write stays.
    const clearOne = async (set: (k: string, v: unknown) => Promise<void>): Promise<boolean> => {
      const state = await accessor.getMetaValue<TaskWorkState>(key);
      if (state?.currentTask !== taskId) return false;
      await set(key, { ...state, currentTask: null });
      return true;
    };
    const done = accessor.transaction
      ? await accessor.transaction((tx) => clearOne((k, v) => tx.setMetaValue(k, v)))
      : await clearOne((k, v) => accessor.setMetaValue(k, v));
    if (done) cleared.push(key);
  }
  return cleared;
}

/** A focus pointer that names a task no longer workable (T12660). */
export interface StaleFocusPointer {
  /** Task the pointer names. */
  taskId: string;
  /** Its live status, or `missing` when the task no longer exists. */
  status: string;
}

/**
 * Whether a focus pointer is stale: its task is done, cancelled, archived or
 * missing. A stale pointer is never reported as the current task (T12660).
 *
 * @param taskId - Pointer value.
 * @param liveStatus - The task's live status, or `undefined` when it is missing.
 * @returns The stale pointer, or `null` when the task is still workable.
 * @task T12660
 */
export function staleFocusPointer(
  taskId: string,
  liveStatus: string | undefined,
): StaleFocusPointer | null {
  if (liveStatus === undefined) return { taskId, status: 'missing' };
  return (TERMINAL_TASK_STATUSES as ReadonlySet<string>).has(liveStatus)
    ? { taskId, status: liveStatus }
    : null;
}

/**
 * One-line warning for a stale focus pointer, naming the task, its status and
 * what to do next.
 *
 * @param stale - The stale pointer.
 * @param next - The next ready task, when one exists.
 * @returns The warning text.
 * @task T12660
 */
export function staleFocusWarning(
  stale: StaleFocusPointer,
  next: { id: string; title: string } | null,
): string {
  return (
    `Stale focus pointer: ${stale.taskId} is ${stale.status}, not current. ` +
    (next
      ? `Next ready task: ${next.id} (${next.title}) — cleo start ${next.id}`
      : 'No ready task — cleo next')
  );
}

/** The metadata accessor plus a live task lookup, for {@link readLiveFocus}. */
export interface LiveFocusAccessor extends FocusStateMetaAccessor {
  /** Load one task by id (any status, archived included); null when missing. */
  loadSingleTask(taskId: string): Promise<{ status: string } | null>;
}

/** A focus read validated against the pointed task's live status (T12684). */
export interface LiveFocus {
  /** The stored blob (notes, phase, …), or null when there is none. */
  state: TaskWorkState | null;
  /** The current task — only while it is still workable, else null. */
  currentTask: string | null;
  /** The pointer, when it names a done, cancelled, archived or missing task. */
  staleFocus: StaleFocusPointer | null;
}

/**
 * THE focus reader for anything that reports or acts on the current task
 * (T12684): `cleo current`, briefing, inject, bootstrap, orchestrator startup,
 * stats, validation, attention and the drift watchdog. A pointer to a done,
 * cancelled, archived or missing task comes back as `currentTask: null` plus
 * `staleFocus` — never as the current task. The stored key is not touched:
 * another session completing a task leaves this session's key alone, and this
 * read reports it stale.
 *
 * @param accessor - Metadata accessor with a live task lookup.
 * @param sessionId - Session id from {@link resolveFocusSessionId}, or `null`
 *   for an unbound caller (the legacy key).
 * @param known - Tasks the caller already loaded (e.g. the briefing's task
 *   map): a pointer found there skips the extra lookup (T12698). A pointer
 *   absent from it (archived tasks are not listed) is still looked up.
 * @returns The blob, the live current task, and the stale pointer if any.
 * @task T12684
 */
export async function readLiveFocus(
  accessor: LiveFocusAccessor,
  sessionId: string | null | undefined,
  known?: ReadonlyMap<string, { status: string }>,
): Promise<LiveFocus> {
  const state = await readFocusState(accessor, sessionId);
  const pointer = state?.currentTask ?? null;
  if (!pointer) return { state, currentTask: null, staleFocus: null };
  const staleFocus = staleFocusPointer(
    pointer,
    (known?.get(pointer) ?? (await accessor.loadSingleTask(pointer)))?.status,
  );
  return { state, currentTask: staleFocus ? null : pointer, staleFocus };
}
