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
import { statSync } from 'node:fs';
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
  /**
   * `aborted` (default): the migration ran and its parity gate rolled it back.
   * `deferred`: the governor could not admit the migration this open (memory
   * pressure, or `db-heavy` at capacity), so it never ran (T13158). Either way
   * the consolidated store is empty while legacy rows wait, and writes refuse.
   */
  readonly kind?: 'aborted' | 'deferred';
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

/** Remedy for a write refused because exodus-on-open was deferred (T13158). */
export const EXODUS_DEFERRED_FIX =
  'Retry when the machine is less busy (the next open migrates automatically), or run ' +
  '`cleo exodus migrate` now. Nothing was written.';

/** Remedy for a write refused because exodus-on-open aborted (T11828). */
export const EXODUS_ABORTED_FIX =
  'Resolve the aborted migration (`cleo doctor exodus-health` → `cleo exodus migrate`) ' +
  'so the consolidated cleo.db carries your data before mutating it.';

/**
 * Why a write was refused on a store that still owes its legacy migration.
 *
 * @param scope - The scope.
 * @param reason - The deferral or abort detail.
 * @param kind - `deferred` (the migration has not run yet) or `aborted`.
 * @returns The refusal message, remedy included.
 */
export function exodusRefusalMessage(
  scope: DualScope,
  reason: string,
  kind: 'aborted' | 'deferred' = 'deferred',
): string {
  if (kind === 'aborted') {
    return (
      `Refusing to write to consolidated ${scope} cleo.db — exodus-on-open ABORTED ` +
      `(${reason}). The DB is empty; legacy data is the source of truth. ` +
      `Run \`cleo doctor exodus-health\` then \`cleo exodus migrate\` (or restore via ` +
      `\`cleo doctor repair --role ${scope === 'project' ? 'tasks' : 'nexus'}\`) before writing.`
    );
  }
  return (
    `Refusing to write to the ${scope} cleo.db: its migration from the legacy stores has not ` +
    `run yet (${reason}), so the store is empty and a write now would strand the legacy ` +
    `data. ${EXODUS_DEFERRED_FIX}`
  );
}

/**
 * Thrown by {@link assertWriteDurable} when a MUTATING caller is about to write
 * through a {@link DualScopeDbHandle} whose first-open exodus auto-migration
 * ABORTED (T11828 · DHQ-059).
 *
 * The consolidated `cleo.db` is internally consistent but EMPTY: the user's real
 * data is still in the legacy fleet (kept as the source of truth). Writing here
 * would land in a DB that does not reflect that data, so the write is NOT durable
 * against the source of truth. Read paths never raise this — they intentionally
 * skip {@link assertWriteDurable} and operate on the empty-but-consistent DB.
 *
 * Self-contained (mirrors `BackupRecoverError`) rather than a `CleoError` subclass
 * so the store layer does not need a new numeric `ExitCode` in `@cleocode/contracts`
 * for a condition that is surfaced structurally on the handle.
 *
 * @task T11828
 * @epic T11833
 * @saga T11242
 * @public
 */
export class ExodusAbortWriteUnsafeError extends Error {
  /**
   * Stable string error code for envelope `codeName` / log correlation:
   * `E_EXODUS_DEFERRED_WRITE_UNSAFE` when the migration was deferred (T13158),
   * else `E_EXODUS_ABORT_WRITE_UNSAFE`.
   */
  readonly codeName: 'E_EXODUS_ABORT_WRITE_UNSAFE' | 'E_EXODUS_DEFERRED_WRITE_UNSAFE';
  /** The structured abort detail carried by the handle. */
  readonly detail: ExodusAbortDetail;
  /** Remediation hint surfaced to the operator. */
  readonly fix: string;

  /**
   * @param detail - The {@link ExodusAbortDetail} stamped on the handle.
   */
  constructor(detail: ExodusAbortDetail) {
    const kind = detail.kind === 'deferred' ? 'deferred' : 'aborted';
    super(exodusRefusalMessage(detail.scope, detail.reason, kind));
    this.name = 'ExodusAbortWriteUnsafeError';
    this.codeName =
      kind === 'deferred' ? 'E_EXODUS_DEFERRED_WRITE_UNSAFE' : 'E_EXODUS_ABORT_WRITE_UNSAFE';
    this.detail = detail;
    this.fix = kind === 'deferred' ? EXODUS_DEFERRED_FIX : EXODUS_ABORTED_FIX;
  }
}

/** Remedy when a store that owes its migration could not be guarded (T13171). */
export const EXODUS_GUARD_FAILED_FIX =
  'Retry the command. If it keeps failing, check that the temp directory SQLite uses is ' +
  'writable and not full, then run `cleo exodus migrate`. Nothing was written.';

/**
 * Thrown by an open of a store that still owes its legacy migration when no
 * write guard could be installed at all (T13171): not even the anchor table's
 * trigger. Publishing the handle would let any write, raw SQL included, land
 * in the empty store and strand the legacy rows for good (the #1826 class), so
 * the open is refused instead. Retryable: a later open tries again.
 *
 * @task T13171
 */
export class ExodusGuardFailedError extends Error {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_EXODUS_GUARD_FAILED' as const;
  /** The scope whose store could not be guarded. */
  readonly scope: DualScope;
  /** Remediation hint surfaced to the operator. */
  readonly fix: string = EXODUS_GUARD_FAILED_FIX;

  /**
   * @param scope - The scope whose store could not be guarded.
   * @param cause - The trigger installation failure.
   */
  constructor(scope: DualScope, cause: unknown) {
    super(
      `Refusing to open the ${scope} cleo.db: its migration from the legacy stores has not ` +
        'completed and the store could not be protected against writes that would strand the ' +
        `legacy data (${cause instanceof Error ? cause.message : String(cause)}).`,
      { cause },
    );
    this.name = 'ExodusGuardFailedError';
    this.scope = scope;
  }
}

/**
 * The stale window of the exodus single-flight lock (`<cleo.db>.exodus-on-open
 * .lock`), shared by exodus-on-open and the reconcile (T12785). A holder
 * refreshes the lock every half window from a timer that cannot fire during a
 * stage (one synchronous transaction), so the window must exceed the longest
 * stage. Callers checking the lock must pass the same window.
 */
export const EXODUS_LOCK_STALE_MS = 600_000;

/** The exodus single-flight lock file of a consolidated store (T12785). */
export function exodusRunLockPath(dbPath: string): string {
  return `${dbPath}.exodus-on-open.lock`;
}

/** Lock files this process holds, so its own writes are never refused. */
const heldHere = new Set<string>();

/**
 * Record that this process holds (or released) an exodus run lock (T12785).
 * The holder's own writes, its revert included, must not be refused.
 */
export function markExodusRunHeld(lockPath: string, held: boolean): void {
  if (held) heldHere.add(lockPath);
  else heldHere.delete(lockPath);
}

/**
 * Whether ANOTHER process is running exodus or a reconcile on `dbPath`
 * (T12785): the single-flight lock's directory (proper-lockfile's
 * `<file>.lock`) exists and was refreshed within {@link EXODUS_LOCK_STALE_MS}.
 * One stat, synchronous, so the write chokepoints can call it on every write.
 */
export function exodusRunActiveElsewhere(dbPath: string): boolean {
  const lockPath = exodusRunLockPath(dbPath);
  if (heldHere.has(lockPath)) return false;
  try {
    return Date.now() - statSync(`${lockPath}.lock`).mtimeMs < EXODUS_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** Remedy while another process runs exodus or a reconcile on the store. */
export const EXODUS_RUN_FIX =
  'A legacy migration or `cleo doctor superseded-store --reconcile` is running on this store ' +
  'in another process. Retry when it finishes; nothing was written.';

/**
 * Thrown by a write chokepoint while another process holds the store's exodus
 * single-flight lock (T12785): exodus-on-open or the reconcile is copying
 * legacy rows, and verifies afterwards that live rows did not change. A write
 * landing mid-run would be refused by that check, and a write to a row the run
 * inserted would be lost when it reverts.
 *
 * @task T12785
 */
export class ExodusRunInProgressError extends Error {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_EXODUS_RUN_WRITE_UNSAFE' as const;
  /** Remediation hint surfaced to the operator. */
  readonly fix: string = EXODUS_RUN_FIX;

  /** @param dbPath - The store being migrated or reconciled. */
  constructor(dbPath: string) {
    super(`Refusing to write ${dbPath}: a legacy migration or reconcile is running on it.`);
    this.name = 'ExodusRunInProgressError';
  }
}

/**
 * Wrap a locked exodus run so this process is marked as the holder while it
 * runs ({@link markExodusRunHeld}), released on any exit (T12785).
 */
export function whileExodusRunHeld<T>(lockPath: string, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    markExodusRunHeld(lockPath, true);
    try {
      return await fn();
    } finally {
      markExodusRunHeld(lockPath, false);
    }
  };
}
