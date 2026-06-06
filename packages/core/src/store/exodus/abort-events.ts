/**
 * Typed, process-local event channel for exodus-on-open ABORTS (T11828 · DHQ-059).
 *
 * ## Why this exists
 *
 * The exodus-on-open data-continuity gate ({@link maybeRunExodusOnOpen}) can
 * ABORT a first-open auto-migration when the parity verify fails or the copy
 * errors mid-flight. On abort the consolidated `cleo.db` is rolled back to EMPTY
 * and the legacy fleet is kept as the source of truth — so the handle the
 * chokepoint hands back is live and success-shaped, but the data the caller
 * expected is NOT in it.
 *
 * Before T11828 that abort surfaced ONLY as a `log.warn(...)` inside the open
 * chokepoint. A MUTATING caller (e.g. `tasks.add`) therefore had no programmatic
 * signal that its write was about to land in a consolidated DB that does not
 * contain the user's real data — i.e. the write may not be durable against the
 * source of truth. This module is the out-of-band surface: every abort is
 * broadcast here so daemon/session/diagnostic subscribers can react, AND the
 * abort detail is stamped onto the returned {@link DualScopeDbHandle} so a
 * mutation path can detect it synchronously via {@link assertWriteDurable}.
 *
 * Read-only callers ignore the marker entirely — they get a valid handle and the
 * empty-but-consistent consolidated DB, exactly as before.
 *
 * @module
 * @task T11828 (DHQ-059 — surface exodus-on-open abort to mutating callers)
 * @epic T11833
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @see packages/core/src/store/exodus/on-open.ts — where the abort originates
 * @see packages/core/src/store/dual-scope-db.ts — where the marker is stamped + assertWriteDurable
 */

import { EventEmitter } from 'node:events';
import type { DualScope } from '../dual-scope-db.js';

/**
 * Structured detail of an exodus-on-open abort, stamped onto the returned
 * {@link DualScopeDbHandle} and broadcast on the {@link exodusAbortEvents}
 * channel.
 *
 * @task T11828
 * @public
 */
export interface ExodusAbortDetail {
  /** The scope whose first-open auto-migration aborted. */
  readonly scope: DualScope;
  /** Absolute path to the consolidated `cleo.db` for that scope. */
  readonly dbPath: string;
  /** Human-readable abort reason (parity deficit, mid-copy failure, …). */
  readonly reason: string;
  /** Epoch-ms timestamp the abort was observed. */
  readonly at: number;
}

/**
 * Map of event name → listener argument tuple for the exodus-abort channel.
 *
 * @task T11828
 */
interface ExodusAbortEventMap {
  /** Emitted once per exodus-on-open abort, after rollback completes. */
  abort: [detail: ExodusAbortDetail];
}

/**
 * Process-local emitter broadcasting every exodus-on-open ABORT.
 *
 * Subscribers (daemon liveness, session lifecycle, `cleo doctor exodus-health`)
 * MAY listen for `'abort'` to react to a degraded first-open without coupling to
 * the store chokepoint. Emission is best-effort and never throws into the open
 * path — listener errors are swallowed by {@link emitExodusAbort}.
 *
 * @task T11828
 * @public
 */
export const exodusAbortEvents = new EventEmitter<ExodusAbortEventMap>();

// An aborted first-open install can legitimately have many domain opens fire in
// one process (tasks, brain, conduit, …); each would re-broadcast. Raise the cap
// modestly above the default 10 so a busy session does not emit a spurious
// MaxListenersExceededWarning, while still flagging a genuine listener leak.
exodusAbortEvents.setMaxListeners(50);

/**
/**
 * Process-local registry of the most recent abort detail per scope.
 *
 * Recorded on every {@link emitExodusAbort} so the write-side guard
 * (`assertWriteDurable` via {@link insertIdempotent} / {@link upsertIdempotent})
 * can detect a degraded first-open even when the caller no longer holds the
 * original {@link DualScopeDbHandle} (e.g. domain modules that extract the native
 * handle and discard the wrapper). Cleared by {@link clearExodusAborts} once the
 * underlying migration is resolved (successful `cleo exodus migrate` / recovery)
 * or in test teardown.
 */
const _abortedScopes = new Map<DualScope, ExodusAbortDetail>();

/**
 * Broadcast an exodus-on-open abort on the {@link exodusAbortEvents} channel and
 * record it in the process-local per-scope registry.
 *
 * Best-effort: a throwing/synchronous listener must NOT propagate into the DB
 * open path, so emission is wrapped. Returns `true` if at least one listener was
 * notified (matching `EventEmitter.emit` semantics) — informational only.
 *
 * @param detail - The structured abort detail to broadcast.
 * @returns `true` when the event had listeners; `false` otherwise.
 *
 * @task T11828
 * @public
 */
export function emitExodusAbort(detail: ExodusAbortDetail): boolean {
  _abortedScopes.set(detail.scope, detail);
  try {
    return exodusAbortEvents.emit('abort', detail);
  } catch {
    // A misbehaving listener must never break the open path.
    return false;
  }
}

/**
 * Return the recorded abort detail for `scope`, or — when `scope` is omitted —
 * the most-recent abort across any scope. `undefined` when no abort is recorded.
 *
 * Used by the write-side guard to reject a mutation that would land in a
 * consolidated DB the exodus-on-open gate left empty.
 *
 * @param scope - Optional scope filter; when omitted, returns any recorded abort.
 * @returns The {@link ExodusAbortDetail}, or `undefined`.
 *
 * @task T11828
 * @public
 */
export function getRecordedExodusAbort(scope?: DualScope): ExodusAbortDetail | undefined {
  if (scope !== undefined) return _abortedScopes.get(scope);
  // Most-recent across scopes (Map preserves insertion order; emit overwrites).
  let latest: ExodusAbortDetail | undefined;
  for (const detail of _abortedScopes.values()) {
    if (!latest || detail.at >= latest.at) latest = detail;
  }
  return latest;
}

/**
 * Clear recorded aborts — all scopes, or a single `scope`.
 *
 * Call after the aborted migration is resolved (a subsequent successful
 * `cleo exodus migrate` / `cleo doctor repair`) so writes are no longer rejected,
 * and in test teardown to isolate cases.
 *
 * @param scope - Optional scope to clear; when omitted, clears every scope.
 *
 * @task T11828
 * @public
 */
export function clearExodusAborts(scope?: DualScope): void {
  if (scope !== undefined) {
    _abortedScopes.delete(scope);
    return;
  }
  _abortedScopes.clear();
}
