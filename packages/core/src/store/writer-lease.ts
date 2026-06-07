/**
 * **DbWriterLease** — single in-process writer-lease arbitration over a persisted
 * SQLite row (T11627 ST-2 · local-mode engine).
 *
 * Heals the T5158 multi-writer corruption (`E_NOT_INITIALIZED` / `E_INTERNAL` on
 * the consolidated `cleo.db`) **while the supervisor daemon stays DISABLED in
 * production** by serializing writers through a `BEGIN IMMEDIATE` claim transaction
 * against a persisted `_writer_leases` row, fenced by an epoch-CAS. The supervisor
 * (ST-5, daemon-on) and Node (this module, daemon-off) share the SAME arbitration
 * primitive and row format — IPC is a coordination optimization over the persisted
 * source-of-truth, never a second source.
 *
 * ## Modes ({@link resolveLeaseMode})
 *
 * `CLEO_WRITER_LEASE_MODE` ∈ `{ supervisor | local | off | require }`, default
 * `local`:
 *
 * - `local` — Node arbitrates the row directly. No IPC. **Heals T5158 with the
 *   daemon off** (the shipping config). DEFAULT.
 * - `supervisor` — would prefer IPC to the supervisor; in ST-2 (no IPC client
 *   wired) it transparently behaves as `local`, logging the demotion once.
 * - `off` — pure pass-through: {@link withWriterLease} just runs `fn` under the
 *   existing `busy_timeout=30000`. Byte-identical to pre-lease behaviour. Rollback
 *   escape hatch.
 * - `require` — strict: an acquire that cannot take the row throws
 *   `E_LEASE_UNAVAILABLE`. No fallback.
 *
 * `busy_timeout=30000` (SSoT in `specs/sqlite-pragmas.json`) backstops every
 * `BEGIN IMMEDIATE`, so a contended claim degrades to today's bounded wait rather
 * than a hang in any mode.
 *
 * ## Re-entrancy
 *
 * A process-local grant memo (`Map<\`${scope}::${lane}\`, { handle, refcount }>`)
 * memoizes the active grant so a nested same-lane write in the SAME process shares
 * one lease (`refcount++` + the row's `reentrancy_depth++`) instead of re-running
 * the claim txn — no second `BEGIN IMMEDIATE`, no IPC. `release()` decrements; the
 * row is freed (`active = 0`) at depth 0.
 *
 * ## DB Open Guard (Gate 3)
 *
 * This module lives under `packages/core/src/store/**`, which is inside the Gate-3
 * raw-open allowlist (the DB chokepoint). It obtains the native handle via
 * {@link openDualScopeDb} (no new raw `new DatabaseSync(`) and runs raw
 * `BEGIN IMMEDIATE` claim/reclaim/release transactions on it.
 *
 * ## Cold-open seam (T11627 ST-3 · Seam 0 — the T5158 heal)
 *
 * {@link withColdOpenLease} leases the `dual-scope-db.ts` cold-open critical
 * section (`reconcileJournal` + `migrateWithRetry` + the exodus-on-open hook)
 * against the SAME native handle the open just created — it does NOT route through
 * the default resolver (which would re-enter `openDualScopeDb` and recurse). It
 * idempotently bootstraps the lease tables on that handle FIRST (the full
 * migration that creates them runs INSIDE the leased section), so exactly one
 * process per scope runs the migrate/reconcile write-txn while peers
 * `BEGIN IMMEDIATE`-queue and then observe a ready DB. This is the heal that ships
 * with the supervisor daemon disabled.
 *
 * @module
 * @task T11627
 * @epic T11625
 * @see ./writer-lease-schema.ts — the drizzle table decls + bootstrap index assertion
 * @see ./dual-scope-db.ts — the open chokepoint this engine routes through (Seams 0 & 1)
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { LeaseLane, LeaseScope } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { openDualScopeDb, openDualScopeDbAtPath, resolveDualScopeDbPath } from './dual-scope-db.js';
import {
  assertWriterLeaseActiveIndexPresent,
  WRITER_LEASES_ACTIVE_INDEX,
  WRITER_LEASES_TABLE,
  WRITER_QUEUE_TABLE,
} from './writer-lease-schema.js';

// Re-export the canonical scope/lane types so consumers can import them from the
// engine surface without reaching into @cleocode/contracts directly.
export type { LeaseLane, LeaseScope } from '@cleocode/contracts';

/**
 * The writer-lease arbitration mode. Resolved once at process start from
 * `CLEO_WRITER_LEASE_MODE`; default `'local'`.
 */
export type LeaseMode = 'supervisor' | 'local' | 'off' | 'require';

/**
 * A held writer-lease grant. Returned by {@link acquireWriterLease}; passed to the
 * callback of {@link withWriterLease}.
 */
export interface LeaseHandle {
  /** The cleo.db scope this lease arbitrates within. */
  readonly scope: LeaseScope;
  /** The write lane this lease arbitrates within the scope. */
  readonly lane: LeaseLane;
  /**
   * The epoch fence assigned to this grant. A write whose epoch no longer matches
   * the row (the lease was reclaimed) must fail rather than corrupt
   * (`E_WRITER_LEASE_STALE`).
   */
  readonly epoch: number;
  /**
   * Release the lease. Decrements the process-local refcount and the row's
   * `reentrancy_depth`; frees the row (`active = 0`) and stops the heartbeat at
   * depth 0. Idempotent — a second call is a no-op.
   */
  release(): Promise<void>;
  /**
   * Advance the lease heartbeat (`heartbeat_at = now`) under the epoch guard. A
   * reclaimed holder's heartbeat no-ops. Called automatically by the internal
   * timer; exposed for callers that want to assert liveness mid-batch.
   */
  heartbeat(): void;
}

/** Options accepted by {@link withWriterLease} / {@link acquireWriterLease}. */
export interface LeaseAcquireOptions {
  /** Advisory priority — lower acquires sooner. `0` = highest. Default `100`. */
  priority?: number;
  /** Lease time-to-live in milliseconds. Default {@link DEFAULT_TTL_MS}. */
  ttlMs?: number;
  /**
   * When true (default), a nested same-(scope,dbPath,lane) acquire in this process
   * re-enters the existing grant (refcount++) instead of contending. When false,
   * a nested acquire is forced to take a fresh row (used only by tests exercising
   * cross-holder contention within one process).
   */
  reentrant?: boolean;
  /**
   * Pin the lease to a SPECIFIC cleo.db file (its resolved on-disk path) instead
   * of the cwd-default canonical path the scope→path resolver returns. The
   * chokepoint write primitives pass the dbPath recorded at cold-open
   * ({@link activeScopeDbPath}) so the lease row lands in the SAME file the write
   * targets — correct when more than one project's cleo.db is open in one process
   * (Finding 1). When omitted, the canonical scope→path resolution is used.
   */
  dbPath?: string;
}

/** Default lease TTL — aligned to `busy_timeout=30000` (specs/sqlite-pragmas.json). */
export const DEFAULT_TTL_MS = 30_000;

/** Default advisory priority (lower acquires sooner). */
const DEFAULT_PRIORITY = 100;

/** The cold-open schema-bootstrap priority (highest). */
export const SCHEMA_BOOTSTRAP_PRIORITY = 0;

/** Max wall-clock a single acquire will spin before giving up (ms). */
const ACQUIRE_DEADLINE_MS = 30_000;

/** Backoff between contended claim retries (ms). */
const CLAIM_RETRY_DELAY_MS = 25;

/**
 * Lazily-memoized module logger.
 *
 * Constructed on first use rather than at import time. A top-level
 * `getLogger(...)` call executes the `'../logger.js'` factory during module
 * initialization, which — when this module is pulled into a test's mocked
 * import graph via `dual-scope-db.ts` → `writer-lease.ts` — reaches a
 * `vi.mock('../../logger.js')` factory before its module-scoped spy `const` has
 * been initialized, throwing a TDZ `ReferenceError`. Deferring the call to the
 * first log site keeps import-time side-effect-free and matches the
 * call-inside-function pattern used by `dual-scope-db.ts` and
 * `brain-writer-thread.ts`.
 *
 * @task T11627
 */
let _log: ReturnType<typeof getLogger> | null = null;
function log(): ReturnType<typeof getLogger> {
  if (_log === null) _log = getLogger('writer-lease');
  return _log;
}

// ── Mode resolution ───────────────────────────────────────────────────────────

let _cachedMode: LeaseMode | null = null;
let _supervisorDemotionLogged = false;

/**
 * Resolve the writer-lease mode from `CLEO_WRITER_LEASE_MODE`, once per process.
 *
 * Unknown / unset values resolve to `'local'` — the production-safe default while
 * the supervisor daemon is disabled.
 *
 * @returns The resolved {@link LeaseMode}.
 *
 * @task T11627
 */
export function resolveLeaseMode(): LeaseMode {
  if (_cachedMode !== null) return _cachedMode;
  const raw = process.env.CLEO_WRITER_LEASE_MODE;
  switch (raw) {
    case 'supervisor':
    case 'local':
    case 'off':
    case 'require':
      _cachedMode = raw;
      break;
    default:
      _cachedMode = 'local';
      break;
  }
  return _cachedMode;
}

/**
 * The mode actually used for arbitration. `supervisor` demotes to `local` in ST-2
 * because the IPC client is not wired yet — a dead/absent arbiter must never
 * deadlock a write. Logged once.
 */
function effectiveMode(): Exclude<LeaseMode, 'supervisor'> {
  const mode = resolveLeaseMode();
  if (mode === 'supervisor') {
    if (!_supervisorDemotionLogged) {
      _supervisorDemotionLogged = true;
      log().info(
        'CLEO_WRITER_LEASE_MODE=supervisor but no IPC client is wired (ST-2); ' +
          'demoting to local-mode arbitration for the process lifetime.',
      );
    }
    return 'local';
  }
  return mode;
}

/**
 * Reset cached process-global state (mode + demotion flag + grant memo). Tests
 * only — production resolves these once and never resets.
 *
 * @internal
 */
export function _resetWriterLeaseStateForTest(): void {
  _cachedMode = null;
  _supervisorDemotionLogged = false;
  _grantMemo.clear();
  _inflightAcquire.clear();
  _nativeDbResolver = defaultNativeDbResolver;
  _dbPathResolver = resolveDualScopeDbPath;
  _activeScope = null;
}

// ── Native handle resolution (test-injectable) ────────────────────────────────

/**
 * A resolved lease target: the native `cleo.db` handle for a scope PLUS the
 * absolute on-disk path that physically distinguishes it.
 *
 * The lease scope key is the EXISTING `cacheKey(scope, dbPath)` composite
 * (`${scope}::${dbPath}`), so two DIFFERENT project files opened in one process
 * are DISTINCT lease scopes (spec §6 Seam 0). Keying the grant memo + the
 * resolver on the abstract scope LABEL alone would mis-share an in-process grant
 * across two projects and route the second project's lease writes to the
 * cwd-default file. `dbPath` closes that latent cross-project gap.
 */
export interface LeaseTarget {
  /** The native `DatabaseSync` handle for the scope's `cleo.db`. */
  readonly native: DatabaseSync;
  /** The absolute on-disk path of that `cleo.db` (the lease-scope discriminator). */
  readonly dbPath: string;
}

/**
 * Resolver that yields the native handle + path for a scope's `cleo.db`. When
 * `dbPath` is supplied the resolver MUST open THAT file (an explicit-path lease,
 * e.g. a second project's cleo.db); otherwise it resolves the cwd-default
 * canonical path for the scope.
 */
export type NativeDbResolver = (scope: LeaseScope, dbPath?: string) => Promise<LeaseTarget>;

/**
 * Default resolver: route through the dual-scope chokepoint so the lease
 * migration is applied (tables + raw partial-unique index), then extract the
 * native handle drizzle holds on `$client` together with the handle's resolved
 * `dbPath` (the lease-scope discriminator). When an explicit `dbPath` is supplied
 * the cached path-aware opener is used so the lease row lands in THAT file (the
 * multi-project-in-one-process case — Finding 1).
 */
const defaultNativeDbResolver: NativeDbResolver = async (scope, dbPath) => {
  let handle: { db: unknown; dbPath: string };
  if (dbPath !== undefined && dbPath !== resolveDualScopeDbPath(scope)) {
    // Explicit non-canonical path → open (cached) at that exact file.
    handle =
      scope === 'project'
        ? await openDualScopeDbAtPath('project', dbPath)
        : await openDualScopeDbAtPath('global', dbPath);
  } else {
    handle =
      scope === 'project' ? await openDualScopeDb('project') : await openDualScopeDb('global');
  }
  const native = (handle.db as unknown as { $client: DatabaseSync }).$client;
  // `handle.dbPath` is the path this open resolved; fall back to the scope→path
  // resolver defensively (the handle always carries it in practice).
  const resolvedPath = handle.dbPath ?? dbPath ?? resolveDualScopeDbPath(scope);
  return { native, dbPath: resolvedPath };
};

let _nativeDbResolver: NativeDbResolver = defaultNativeDbResolver;

/**
 * Override how the engine obtains a scope's native `cleo.db` handle + path. Tests
 * inject a temp-dir handle here so arbitration runs against an isolated fixture
 * with no supervisor and no canonical-path side effects.
 *
 * For backward-compatibility a resolver that returns a bare `DatabaseSync` is
 * accepted and adapted to a {@link LeaseTarget} whose `dbPath` is a stable
 * synthetic per-scope token (`test://<scope>`) — sufficient for single-file test
 * fixtures, which key one file per scope.
 *
 * @param resolver - The resolver to use, or `undefined` to restore the default.
 * @internal
 */
export function _setNativeDbResolverForTest(
  resolver:
    | ((scope: LeaseScope, dbPath?: string) => Promise<DatabaseSync | LeaseTarget>)
    | undefined,
): void {
  if (resolver === undefined) {
    _nativeDbResolver = defaultNativeDbResolver;
    return;
  }
  _nativeDbResolver = async (scope, dbPath) => {
    const out = await resolver(scope, dbPath);
    // Adapt a bare native handle to a LeaseTarget with a stable synthetic path.
    return 'native' in out ? out : { native: out, dbPath: dbPath ?? scopePathToken(scope) };
  };
  // Keep the (I/O-free) path resolver consistent with the injected native one so
  // the memo key derived before the resolver await matches the resolved target.
  _dbPathResolver = (scope) => scopePathToken(scope);
}

/** Stable synthetic dbPath token for a scope under a test resolver injection. */
function scopePathToken(scope: LeaseScope): string {
  return `test://${scope}`;
}

/**
 * Resolve the absolute dbPath for a scope WITHOUT opening the handle. Used to
 * build the memo key on the re-entrant fast path (before the native resolver
 * await). Defaults to the canonical scope→path resolver (deterministic, no I/O);
 * a test native-resolver injection swaps in the matching synthetic token so the
 * key built here equals the {@link LeaseTarget.dbPath} the resolver returns.
 */
let _dbPathResolver: (scope: LeaseScope) => string = resolveDualScopeDbPath;

// ── Process-local grant memo (C1 graft · refcounted re-entrancy) ───────────────

interface GrantEntry {
  handle: InternalLeaseHandle;
  refcount: number;
}

/**
 * `Map<\`${scope}::${dbPath}::${lane}\`, GrantEntry>` — the active grant per
 * (scope, dbPath, lane). Keyed on the EXISTING `cacheKey(scope, dbPath)` composite
 * (spec §6 Seam 0) so two DIFFERENT project files in one process are distinct
 * lease scopes — the in-process grant is NEVER mis-shared across projects.
 */
const _grantMemo = new Map<string, GrantEntry>();

/**
 * In-flight FIRST-acquisition promises per memo key (Finding 2 — single-flight).
 *
 * The re-entrant fast path memoizes the active grant, but the FIRST acquisition
 * resolves the native handle (`await _nativeDbResolver`) BEFORE writing the memo
 * entry. Two callers racing the first acquire would both observe an empty memo
 * across that await and both run the full claim path — the loser then spins the
 * whole acquire window and degrades to a lease-less write. This map makes the
 * first acquisition single-flight: concurrent callers await the SAME in-flight
 * acquire and share the resulting grant (refcount++), exactly like a nested
 * same-frame re-entry.
 */
const _inflightAcquire = new Map<string, Promise<LeaseHandle>>();

/**
 * Build the lease-scope memo key. Keyed on `${scope}::${dbPath}::${lane}` — the
 * `${scope}::${dbPath}` prefix is byte-equal to `cacheKey(scope, dbPath)` in
 * `dual-scope-db.ts` so the lease scope and the handle cache agree on identity.
 */
function memoKey(scope: LeaseScope, dbPath: string, lane: LeaseLane): string {
  return `${scope}::${dbPath}::${lane}`;
}

// ── Active-scope registry (ST-3 · Seam 1 — process-local, no signature change) ──

/**
 * The scope + resolved dbPath of the most-recent canonical cold-open in this
 * process.
 *
 * The chokepoint write primitives ({@link insertIdempotent} /
 * {@link upsertIdempotent} in `dual-scope-db.ts`) receive only a drizzle handle —
 * NOT the scope or a {@link LeaseHandle}. To gate them through the writer lease
 * (Seam 1) WITHOUT a signature change, the cold-open path records its scope AND
 * dbPath here (mirroring the `getRecordedExodusAbort` registry pattern already
 * used by those primitives) and the primitive reads them back via
 * {@link activeScope} / {@link activeScopeDbPath}.
 *
 * Recording the dbPath (not just the abstract scope LABEL) means the chokepoint
 * leases against the lease ROW in the SAME file the open targeted — so two
 * different projects opened in one process lease in their OWN cleo.db, never the
 * cwd-default file (Finding 1).
 *
 * `null` until the first canonical cold-open records a scope.
 */
let _activeScope: LeaseScope | null = null;
let _activeScopeDbPath: string | null = null;

/**
 * Record the scope (and optionally the resolved dbPath) of the cold-open
 * currently in progress / most recently opened. Called by `dual-scope-db.ts` at
 * the head of its cold-open critical section (Seam 0). Idempotent — last writer
 * wins; a project open after a global open makes `'project'` the active scope,
 * which is correct because the chokepoint write primitives only ever write the
 * project-tier `tasks_*` tables.
 *
 * @param scope - The scope of the in-progress cold-open.
 * @param dbPath - The resolved on-disk path of that scope's cleo.db. When
 *   omitted, the active dbPath is cleared so {@link activeScopeDbPath} falls back
 *   to the canonical scope→path resolver.
 * @internal
 * @task T11627
 */
export function setActiveScope(scope: LeaseScope, dbPath?: string): void {
  _activeScope = scope;
  _activeScopeDbPath = dbPath ?? null;
}

/**
 * The scope the chokepoint write primitives should lease against. Defaults to
 * `'project'` (the tasks chokepoint is project-tier) when no cold-open has
 * recorded a scope yet — a write before any open is degenerate, but `'project'`
 * is the only correct lease scope for `tasks_*` mutations.
 *
 * @returns The active {@link LeaseScope}.
 * @internal
 * @task T11627
 */
export function activeScope(): LeaseScope {
  return _activeScope ?? 'project';
}

/**
 * The dbPath the chokepoint write primitives should lease their row in. Returns
 * the path recorded by the most-recent cold-open, or — defensively — the
 * canonical scope→path resolution for {@link activeScope} when none was recorded.
 *
 * @returns The active cleo.db on-disk path.
 * @internal
 * @task T11627
 */
export function activeScopeDbPath(): string {
  return _activeScopeDbPath ?? _dbPathResolver(activeScope());
}

/**
 * Clear the recorded active scope + dbPath. Tests only — production records once
 * per cold-open and never clears (the scope of the last canonical open remains
 * the lease target for subsequent writes).
 *
 * @internal
 */
export function _clearActiveScopeForTest(): void {
  _activeScope = null;
  _activeScopeDbPath = null;
}

// ── Small helpers ─────────────────────────────────────────────────────────────

/**
 * Asynchronously wait `ms` between contended claim retries. MUST be async (not
 * `Atomics.wait`): the claim transaction itself is synchronous, but the BETWEEN-
 * retry gap has to yield the event loop so a concurrent holder in THIS process can
 * run its `release()` (which frees the row this waiter is spinning for). A
 * synchronous spin would deadlock single-process re-entrant contention.
 */
function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.round(ms))));
}

/** No-throw pid-liveness probe (`process.kill(pid, 0)`), mirrors gc/daemon.ts. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH => no such process (dead). EPERM => process exists, not ours (alive).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** This process's stable holder identity for a lane. */
function makeHolderId(lane: LeaseLane): string {
  return `pid-${process.pid}:${lane}:${randomUUID().slice(0, 8)}`;
}

interface ActiveLeaseRow {
  id: number;
  holder_id: string;
  holder_pid: number;
  epoch: number;
  heartbeat_at: number;
  ttl_ms: number;
  reentrancy_depth: number;
}

// ── Internal handle ───────────────────────────────────────────────────────────

/**
 * Concrete {@link LeaseHandle} bound to a native handle + holder identity. Owns
 * the heartbeat timer and the epoch-guarded release/heartbeat SQL.
 */
class InternalLeaseHandle implements LeaseHandle {
  readonly scope: LeaseScope;
  readonly lane: LeaseLane;
  readonly epoch: number;
  readonly holderId: string;
  /** The resolved on-disk path of the cleo.db this lease's row lives in. */
  readonly dbPath: string;
  private readonly nativeDb: DatabaseSync;
  private readonly ttlMs: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private released = false;

  constructor(args: {
    scope: LeaseScope;
    lane: LeaseLane;
    epoch: number;
    holderId: string;
    dbPath: string;
    nativeDb: DatabaseSync;
    ttlMs: number;
  }) {
    this.scope = args.scope;
    this.lane = args.lane;
    this.epoch = args.epoch;
    this.holderId = args.holderId;
    this.dbPath = args.dbPath;
    this.nativeDb = args.nativeDb;
    this.ttlMs = args.ttlMs;
    this.startHeartbeat();
  }

  /** Start the heartbeat timer at `ttl/3` (unref'd so it never holds the event loop open). */
  private startHeartbeat(): void {
    const interval = Math.max(1, Math.floor(this.ttlMs / 3));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), interval);
    // Never keep the process alive solely for a heartbeat.
    this.heartbeatTimer.unref?.();
  }

  heartbeat(): void {
    if (this.released) return;
    // The heartbeat fires from an unref'd timer; if the underlying native handle
    // was closed out from under a still-held lease (cache eviction / shutdown /
    // test teardown), `prepare()` throws `database is not open` INSIDE the timer
    // callback — an UNCAUGHT exception that would crash Node. Tolerate a closed
    // handle the same way `tryClaimOnce` tolerates a rolled-back txn: stop the
    // timer, mark released, and no-op. A reclaimed holder (new epoch) updates 0
    // rows → no-op via the epoch guard.
    try {
      this.nativeDb
        .prepare(
          `UPDATE ${WRITER_LEASES_TABLE} SET heartbeat_at = ? ` +
            `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
        )
        .run(Date.now(), this.scope, this.lane, this.holderId, this.epoch);
    } catch (err) {
      // Closed handle (or any heartbeat-write failure): stop heartbeating rather
      // than throw on every subsequent tick. The row is freed by whoever closed
      // the DB (close drops the file lock) or reclaimed via TTL by a peer.
      this.released = true;
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      log().debug(
        { scope: this.scope, lane: this.lane, err: err instanceof Error ? err.message : err },
        'writer-lease heartbeat failed (native handle likely closed); stopping heartbeat',
      );
    }
  }

  /** Free the row (`active = 0`) under the epoch guard, stop the heartbeat. */
  releaseRow(): void {
    if (this.released) return;
    this.released = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Tolerate a closed native handle on release (same race as the heartbeat):
    // the lease row is freed implicitly when the DB closes / dies, so a failed
    // free-row UPDATE must not throw out of `release()`.
    try {
      this.nativeDb
        .prepare(
          `UPDATE ${WRITER_LEASES_TABLE} SET active = 0, reentrancy_depth = 0 ` +
            `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
        )
        .run(this.scope, this.lane, this.holderId, this.epoch);
    } catch (err) {
      log().debug(
        { scope: this.scope, lane: this.lane, err: err instanceof Error ? err.message : err },
        'writer-lease releaseRow failed (native handle likely closed); row freed by close/TTL',
      );
    }
  }

  async release(): Promise<void> {
    await releaseGrant(this.scope, this.dbPath, this.lane);
  }
}

// ── Error ─────────────────────────────────────────────────────────────────────

/**
 * Thrown when `require` mode cannot acquire the lease, or (future) when a
 * supervisor explicitly denies. Carries a stable `codeName` for envelope mapping.
 *
 * @public
 */
export class LeaseUnavailableError extends Error {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_LEASE_UNAVAILABLE' as const;
  constructor(scope: LeaseScope, lane: LeaseLane, reason: string) {
    super(
      `E_LEASE_UNAVAILABLE: could not acquire ${scope}/${lane} writer lease ` +
        `(mode=require): ${reason}`,
    );
    this.name = 'LeaseUnavailableError';
  }
}

/**
 * Thrown when a write primitive opens the WRITE handle without a held lease
 * (T11627 ST-4 · Seam 2 · AC4). The brain worker (and any other dedicated-handle
 * writer outside the chokepoint) MUST hold its lane's grant before it writes — a
 * lease-less write is exactly the multi-writer race the lease exists to kill.
 *
 * Enforced (not merely advised): the brain writer bootstrap calls
 * {@link assertWriterLeaseHeld} before draining, and a lease-less drain throws
 * this. `off` mode (the rollback escape hatch) is exempt — there is no lease to
 * hold and the underlying `busy_timeout` serializes writes as before.
 *
 * @public
 * @task T11627
 */
export class WriterLeaseRequiredError extends Error {
  /** Stable string error code for envelope `codeName` / log correlation. */
  readonly codeName = 'E_WRITER_LEASE_REQUIRED' as const;
  constructor(scope: LeaseScope, lane: LeaseLane) {
    super(
      `E_WRITER_LEASE_REQUIRED: cannot open the ${scope}/${lane} writer handle ` +
        'without a held writer lease (AC4) — wrap the write in withWriterLease/' +
        'acquireWriterLease, or set CLEO_WRITER_LEASE_MODE=off to bypass.',
    );
    this.name = 'WriterLeaseRequiredError';
  }
}

/**
 * Whether THIS process currently holds an active grant for `(scope, lane)` in the
 * process-local grant memo. Used by dedicated-handle writers (the brain worker) to
 * assert AC4 without re-running the claim txn.
 *
 * @param scope - The cleo.db scope.
 * @param lane - The write lane.
 * @returns `true` iff a memoized grant with `refcount > 0` exists for the key.
 *
 * @task T11627
 */
export function hasActiveGrant(scope: LeaseScope, lane: LeaseLane): boolean {
  const entry = _grantMemo.get(memoKey(scope, _dbPathResolver(scope), lane));
  return entry !== undefined && entry.refcount > 0;
}

/**
 * AC4 guard. Assert this process holds the `(scope, lane)` writer lease before it
 * opens a dedicated WRITE handle. In `off` mode the assertion is a no-op (there is
 * no lease; `busy_timeout` serializes). In every other mode a missing grant throws
 * {@link WriterLeaseRequiredError}.
 *
 * @param scope - The cleo.db scope the handle writes to.
 * @param lane - The write lane that must be held.
 * @throws {WriterLeaseRequiredError} when no grant is held and mode is not `off`.
 *
 * @task T11627
 */
export function assertWriterLeaseHeld(scope: LeaseScope, lane: LeaseLane): void {
  if (effectiveMode() === 'off') return;
  if (!hasActiveGrant(scope, lane)) {
    throw new WriterLeaseRequiredError(scope, lane);
  }
}

// ── Claim transaction (shared primitive — local mode) ─────────────────────────

/**
 * Attempt ONE `BEGIN IMMEDIATE` claim against the active row. Returns the granted
 * epoch on success, or `null` if a live holder owns the row (caller backs off and
 * retries; the queue row was enqueued on the first miss).
 */
function tryClaimOnce(
  nativeDb: DatabaseSync,
  scope: LeaseScope,
  lane: LeaseLane,
  holderId: string,
  ttlMs: number,
): number | null {
  const now = Date.now();
  nativeDb.exec('BEGIN IMMEDIATE TRANSACTION');
  try {
    const active = nativeDb
      .prepare(
        `SELECT id, holder_id, holder_pid, epoch, heartbeat_at, ttl_ms, reentrancy_depth ` +
          `FROM ${WRITER_LEASES_TABLE} WHERE scope = ? AND lane = ? AND active = 1`,
      )
      .get(scope, lane) as ActiveLeaseRow | undefined;

    if (active === undefined) {
      // No active holder — take a fresh row with the next epoch.
      const nextEpoch =
        (
          nativeDb
            .prepare(
              `SELECT COALESCE(MAX(epoch), 0) + 1 AS e FROM ${WRITER_LEASES_TABLE} WHERE scope = ? AND lane = ?`,
            )
            .get(scope, lane) as { e: number } | undefined
        )?.e ?? 1;
      nativeDb
        .prepare(
          `INSERT INTO ${WRITER_LEASES_TABLE} ` +
            `(scope, lane, holder_id, holder_pid, epoch, acquired_at, heartbeat_at, ttl_ms, reentrancy_depth, active) ` +
            `VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 1)`,
        )
        .run(scope, lane, holderId, process.pid, nextEpoch, now, now, ttlMs);
      nativeDb.exec('COMMIT');
      return nextEpoch;
    }

    if (active.holder_id === holderId) {
      // Same holder (defensive — same-process re-entrancy is handled by the memo
      // before reaching here). Bump the durable depth and re-assert the epoch.
      nativeDb
        .prepare(
          `UPDATE ${WRITER_LEASES_TABLE} SET reentrancy_depth = reentrancy_depth + 1, heartbeat_at = ? ` +
            `WHERE id = ?`,
        )
        .run(now, active.id);
      nativeDb.exec('COMMIT');
      return active.epoch;
    }

    // A different holder owns the row. Reclaim IFF it is stale (TTL expired AND
    // its pid is dead) — SQLite serializes this inside BEGIN IMMEDIATE so two
    // reclaimers cannot both win; the loser sees the new epoch and re-queues.
    const stale = now - active.heartbeat_at > active.ttl_ms && !isPidAlive(active.holder_pid);
    if (stale) {
      const reclaimedEpoch = active.epoch + 1;
      nativeDb
        .prepare(
          `UPDATE ${WRITER_LEASES_TABLE} ` +
            `SET holder_id = ?, holder_pid = ?, epoch = ?, acquired_at = ?, heartbeat_at = ?, ttl_ms = ?, reentrancy_depth = 1 ` +
            `WHERE id = ? AND epoch = ?`,
        )
        .run(holderId, process.pid, reclaimedEpoch, now, now, ttlMs, active.id, active.epoch);
      nativeDb.exec('COMMIT');
      return reclaimedEpoch;
    }

    // Live holder — give up this attempt.
    nativeDb.exec('ROLLBACK');
    return null;
  } catch (err) {
    try {
      nativeDb.exec('ROLLBACK');
    } catch {
      // already rolled back / no active txn — ignore
    }
    throw err;
  }
}

/** Enqueue a waiter row (idempotent per holder) for FIFO+priority ordering / aging. */
function enqueueWaiter(
  nativeDb: DatabaseSync,
  scope: LeaseScope,
  lane: LeaseLane,
  holderId: string,
  priority: number,
  ttlMs: number,
): void {
  const now = Date.now();
  const existing = nativeDb
    .prepare(
      `SELECT ticket FROM ${WRITER_QUEUE_TABLE} WHERE scope = ? AND lane = ? AND holder_id = ?`,
    )
    .get(scope, lane, holderId) as { ticket: number } | undefined;
  if (existing) return;
  nativeDb
    .prepare(
      `INSERT INTO ${WRITER_QUEUE_TABLE} (scope, lane, holder_id, priority, enqueued_at, deadline_at) ` +
        `VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(scope, lane, holderId, priority, now, now + ttlMs);
}

/** Remove this holder's waiter row once granted (or on give-up). */
function dequeueWaiter(
  nativeDb: DatabaseSync,
  scope: LeaseScope,
  lane: LeaseLane,
  holderId: string,
): void {
  nativeDb
    .prepare(`DELETE FROM ${WRITER_QUEUE_TABLE} WHERE scope = ? AND lane = ? AND holder_id = ?`)
    .run(scope, lane, holderId);
}

// ── Acquire / release surface ─────────────────────────────────────────────────

/**
 * Acquire (or re-enter) the writer lease for `(scope, lane)`. Caller MUST call
 * `release()` on the returned handle (use {@link withWriterLease} to do so
 * automatically).
 *
 * - `off` mode → returns a no-op handle (pass-through; no row written).
 * - `local`/`supervisor` mode → arbitrates over the persisted row via
 *   `BEGIN IMMEDIATE` (+ epoch-CAS). A nested same-(scope,lane) acquire in this
 *   process re-enters the memoized grant (refcount++).
 * - `require` mode → throws {@link LeaseUnavailableError} if the row cannot be
 *   taken within the acquire window (`min(ACQUIRE_DEADLINE_MS, ttlMs)`).
 *
 * @param scope - The cleo.db scope.
 * @param lane - The write lane within the scope.
 * @param opts - Priority / TTL / re-entrancy options.
 * @returns A held {@link LeaseHandle}.
 *
 * @task T11627
 */
export async function acquireWriterLease(
  scope: LeaseScope,
  lane: LeaseLane,
  opts?: LeaseAcquireOptions,
): Promise<LeaseHandle> {
  const mode = effectiveMode();
  const reentrant = opts?.reentrant ?? true;

  // `off` mode — pure pass-through. No row written, no memo entry; busy_timeout on
  // the underlying connection serializes writes exactly as before the lease.
  if (mode === 'off') {
    return makeNoopHandle(scope, lane);
  }

  // Build the lease-scope key up front from the explicit pinned dbPath (when the
  // chokepoint pins a non-cwd-default file) or the I/O-free path resolver, so the
  // re-entrant fast path AND the single-flight guard are decided SYNCHRONOUSLY,
  // before any `await` yields the event loop. Keying on `${scope}::${dbPath}::
  // ${lane}` means two different project files in one process are distinct lease
  // scopes (Finding 1) and that the same (scope,dbPath,lane) never double-claims.
  const dbPath = opts?.dbPath ?? _dbPathResolver(scope);
  const key = memoKey(scope, dbPath, lane);

  // Re-entrant fast path: an existing same-(scope,dbPath,lane) grant is shared
  // (refcount++ + durable depth++) without a second claim txn.
  if (reentrant) {
    const existing = _grantMemo.get(key);
    if (existing) {
      existing.refcount += 1;
      // Reflect the re-entry in the durable row depth (best-effort under epoch guard).
      const { native } = await _nativeDbResolver(scope, dbPath);
      native
        .prepare(
          `UPDATE ${WRITER_LEASES_TABLE} SET reentrancy_depth = reentrancy_depth + 1 ` +
            `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
        )
        .run(scope, lane, existing.handle.holderId, existing.handle.epoch);
      return existing.handle;
    }

    // Single-flight FIRST acquisition (Finding 2): if another caller is already
    // mid-acquire for this key, await its in-flight promise and share the grant
    // (refcount++) instead of racing a second full claim that would spin the whole
    // acquire window and degrade to a lease-less write. Decided synchronously here
    // — no `await` has run since the memo check above, so the two checks are atomic.
    const inflight = _inflightAcquire.get(key);
    if (inflight) {
      const shared = await inflight;
      // Re-check the memo: the in-flight acquire may have already released (e.g.
      // immediate withWriterLease) or degraded to a no-op (not memoized).
      const entry = _grantMemo.get(key);
      if (entry && entry.handle === shared) {
        entry.refcount += 1;
        // `entry.handle` is the concrete InternalLeaseHandle (holderId/epoch).
        const { native } = await _nativeDbResolver(scope, dbPath);
        native
          .prepare(
            `UPDATE ${WRITER_LEASES_TABLE} SET reentrancy_depth = reentrancy_depth + 1 ` +
              `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
          )
          .run(scope, lane, entry.handle.holderId, entry.handle.epoch);
        return entry.handle;
      }
      // The shared acquire is no longer active — fall through to a fresh acquire.
    }
  }

  // First acquisition for this key. Register the in-flight promise BEFORE the
  // first `await` so a concurrent reentrant caller (above) can single-flight onto
  // it. Only the reentrant path participates; reentrant:false callers (test cross-
  // holder contention) deliberately bypass the memo + single-flight.
  const acquirePromise = performFirstAcquire(scope, dbPath, lane, mode, key, opts);
  if (reentrant) {
    _inflightAcquire.set(key, acquirePromise);
  }
  try {
    return await acquirePromise;
  } finally {
    // Always clear our in-flight entry. A degraded acquire resolves to a no-op
    // handle (never memoized) and `require` mode rejects — in both cases the
    // single-flight followers re-check the memo, find nothing, and acquire freshly,
    // so a stale in-flight entry must never linger.
    if (reentrant && _inflightAcquire.get(key) === acquirePromise) {
      _inflightAcquire.delete(key);
    }
  }
}

/**
 * Run ONE full first-acquisition for `(scope, dbPath, lane)` against the persisted
 * row: resolve the native handle, claim/queue/backoff under the bounded acquire
 * window, and on success memoize the grant. Returns a degraded no-op handle on
 * deadline (local) or throws {@link LeaseUnavailableError} (`require`).
 *
 * Factored out of {@link acquireWriterLease} so the single-flight guard can wrap a
 * single in-flight promise per key — the resolved handle (a memoized
 * {@link InternalLeaseHandle}, or a no-op handle on degrade) is what concurrent
 * reentrant followers re-check the memo against before sharing.
 */
async function performFirstAcquire(
  scope: LeaseScope,
  dbPath: string,
  lane: LeaseLane,
  mode: Exclude<LeaseMode, 'supervisor' | 'off'>,
  key: string,
  opts?: LeaseAcquireOptions,
): Promise<LeaseHandle> {
  const { native } = await _nativeDbResolver(scope, dbPath);
  // Defensive bootstrap assert: the partial-unique active index MUST exist or AC1
  // is unenforced. Cheap single-row sqlite_master lookup, runs on first acquire.
  assertWriterLeaseActiveIndexPresent(native);

  const holderId = makeHolderId(lane);
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const priority = opts?.priority ?? DEFAULT_PRIORITY;

  // Wait at most the lease TTL (but never longer than the hard cap): a caller must
  // not block for a grant longer than the lease itself would live. busy_timeout on
  // the IMMEDIATE lock still backstops every individual claim attempt.
  const acquireWindowMs = Math.min(ACQUIRE_DEADLINE_MS, Math.max(1, ttlMs));
  const deadline = Date.now() + acquireWindowMs;
  let enqueued = false;
  for (;;) {
    const epoch = tryClaimOnce(native, scope, lane, holderId, ttlMs);
    if (epoch !== null) {
      if (enqueued) dequeueWaiter(native, scope, lane, holderId);
      const handle = new InternalLeaseHandle({
        scope,
        lane,
        epoch,
        holderId,
        dbPath,
        nativeDb: native,
        ttlMs,
      });
      _grantMemo.set(key, { handle, refcount: 1 });
      return handle;
    }

    // Contended by a live holder. Enqueue once for ordering/aging, then back off.
    if (!enqueued) {
      enqueueWaiter(native, scope, lane, holderId, priority, ttlMs);
      enqueued = true;
    }

    if (Date.now() >= deadline) {
      if (enqueued) dequeueWaiter(native, scope, lane, holderId);
      if (mode === 'require') {
        throw new LeaseUnavailableError(scope, lane, 'live holder did not release within deadline');
      }
      // local: degrade to today's behaviour — proceed without a lease. busy_timeout
      // on the connection still serializes the actual write. A no-op handle writes
      // no row, starts no heartbeat, and is never memoized — so single-flight
      // followers find no memo entry and acquire freshly.
      log().warn(
        { scope, lane },
        'writer-lease acquire deadline exceeded; proceeding under busy_timeout fallback (degraded)',
      );
      return makeNoopHandle(scope, lane);
    }
    await sleepAsync(CLAIM_RETRY_DELAY_MS);
  }
}

/** Decrement the memoized grant; free the row at depth 0. */
async function releaseGrant(scope: LeaseScope, dbPath: string, lane: LeaseLane): Promise<void> {
  const key = memoKey(scope, dbPath, lane);
  const entry = _grantMemo.get(key);
  if (!entry) return; // off-mode / no-op handle / already released
  entry.refcount -= 1;
  if (entry.refcount > 0) {
    // Still re-entered above this frame — decrement the durable depth only. Pin the
    // resolver at the grant's own dbPath so the depth-write lands in the SAME file
    // the lease row lives in (matches the memo key, not the cwd-default).
    const { native } = await _nativeDbResolver(scope, dbPath);
    native
      .prepare(
        `UPDATE ${WRITER_LEASES_TABLE} SET reentrancy_depth = reentrancy_depth - 1 ` +
          `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
      )
      .run(scope, lane, entry.handle.holderId, entry.handle.epoch);
    return;
  }
  // Depth 0 — free the row and evict the memo.
  _grantMemo.delete(key);
  entry.handle.releaseRow();
}

/**
 * A no-op handle for `off` mode and degraded-fallback returns: it holds no row,
 * starts no heartbeat, and `release()` is a no-op. `epoch` is `0` (sentinel).
 */
function makeNoopHandle(scope: LeaseScope, lane: LeaseLane): LeaseHandle {
  return {
    scope,
    lane,
    epoch: 0,
    async release(): Promise<void> {
      /* pass-through */
    },
    heartbeat(): void {
      /* pass-through */
    },
  };
}

/**
 * Primary surface: acquire → run `fn` → release (always, even on throw).
 *
 * Refcounted + re-entrant by `(scope, lane)`: a nested same-lane write in the same
 * process re-enters the memoized grant rather than re-running the claim txn.
 *
 * - `off` mode → pass-through (runs `fn` under today's busy_timeout, no row).
 * - `require` mode → an unacquirable lease throws {@link LeaseUnavailableError}
 *   before `fn` runs.
 *
 * @param scope - The cleo.db scope.
 * @param lane - The write lane.
 * @param fn - The work to run while holding the lease; receives the handle.
 * @param opts - Priority / TTL / re-entrancy options.
 * @returns The resolved value of `fn`.
 *
 * @task T11627
 */
export async function withWriterLease<T>(
  scope: LeaseScope,
  lane: LeaseLane,
  fn: (h: LeaseHandle) => Promise<T>,
  opts?: LeaseAcquireOptions,
): Promise<T> {
  const handle = await acquireWriterLease(scope, lane, opts);
  try {
    return await fn(handle);
  } finally {
    await handle.release();
  }
}

// ── Cold-open lease (ST-3 · Seam 0 — the T5158 heal) ──────────────────────────

/**
 * The lease-table bootstrap DDL, applied idempotently to a native handle BEFORE
 * the cold-open claim txn. It is byte-equivalent (modulo `IF NOT EXISTS`) to the
 * `_t11891-writer-leases` migration so the claim can run before the full migration
 * (which is what creates these tables) executes inside the leased section. The
 * partial-unique index is identical to the migration's — AC1 holds whether the
 * tables came from here or from the migration.
 */
const COLD_OPEN_LEASE_BOOTSTRAP_DDL: readonly string[] = [
  // Reserve rootpage 2 for drizzle's migration journal — the FIRST table drizzle
  // `migrate()` creates on a fresh DB — BEFORE the lease tables claim it.
  //
  // SQLite assigns b-tree rootpages sequentially: the first `CREATE TABLE` on an
  // empty file takes page 2. Bootstrapping the lease tables here (a prerequisite of
  // the cold-open claim txn, which runs BEFORE the data migrations inside `fn`)
  // would otherwise plant the EMPTY `_writer_leases` table at page 2. After the
  // cold-open lease releases (`active = 0`), that page is an empty leaf — so a DB
  // whose page-2 bytes are later scribbled is NOT flagged by `PRAGMA
  // integrity_check` (no cells to traverse), silently masking real corruption that
  // `cleo doctor` / project-health probes must detect. Pre-creating the journal
  // table (identical DDL to migration-manager's reconcile path) keeps page 2 owned
  // by the always-populated `__drizzle_migrations` table exactly as on a lease-free
  // open — the corruption-detection contract is preserved and the heal is unchanged.
  // `IF NOT EXISTS` → a no-op re-running over an already-migrated DB.
  //
  // @task T11627
  `CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
     id INTEGER PRIMARY KEY,
     hash text NOT NULL,
     created_at numeric,
     name text,
     applied_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS ${WRITER_LEASES_TABLE} (
     id INTEGER PRIMARY KEY,
     scope TEXT NOT NULL,
     lane TEXT NOT NULL,
     holder_id TEXT NOT NULL,
     holder_pid INTEGER NOT NULL,
     epoch INTEGER NOT NULL,
     acquired_at INTEGER NOT NULL,
     heartbeat_at INTEGER NOT NULL,
     ttl_ms INTEGER NOT NULL,
     reentrancy_depth INTEGER NOT NULL DEFAULT 1,
     active INTEGER NOT NULL DEFAULT 1
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ${WRITER_LEASES_ACTIVE_INDEX} ON ${WRITER_LEASES_TABLE} (scope, lane) WHERE active = 1`,
  `CREATE TABLE IF NOT EXISTS ${WRITER_QUEUE_TABLE} (
     ticket INTEGER PRIMARY KEY AUTOINCREMENT,
     scope TEXT NOT NULL,
     lane TEXT NOT NULL,
     holder_id TEXT NOT NULL,
     priority INTEGER NOT NULL DEFAULT 100,
     enqueued_at INTEGER NOT NULL,
     deadline_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS ix_writer_queue_order ON ${WRITER_QUEUE_TABLE} (scope, lane, priority ASC, ticket ASC)`,
];

/**
 * Idempotently create the lease tables + the raw partial-unique active index on
 * `nativeDb`. Safe to call before any migration has run (the migration that
 * normally creates these tables executes INSIDE the leased cold-open section, so
 * the claim txn needs the tables present first). Each statement is `IF NOT EXISTS`
 * so a re-open over an already-migrated DB is a no-op.
 */
function ensureColdOpenLeaseTables(nativeDb: DatabaseSync): void {
  for (const stmt of COLD_OPEN_LEASE_BOOTSTRAP_DDL) {
    nativeDb.exec(stmt);
  }
}

/**
 * Lease the dual-scope-db COLD-OPEN critical section (Seam 0 — the T5158 heal).
 *
 * This is the high-value gate: it serializes the cold-open `reconcileJournal` +
 * `migrateWithRetry` write-txn — the precise span that races in T5158 — so EXACTLY
 * ONE process per scope runs it while peers `BEGIN IMMEDIATE`-queue and then observe
 * a ready DB. It heals the T5158 `E_NOT_INITIALIZED` / `E_INTERNAL` corruption
 * **with the supervisor daemon disabled** (`local` mode default). The caller
 * (`dual-scope-db.ts`) runs the exodus-on-open hook AFTER this lease releases — the
 * exodus engine owns its own single-flight lock + dedicated connections and
 * closes/re-opens handles, so it must not run under this row lease.
 *
 * Unlike {@link withWriterLease} it operates DIRECTLY on the already-opened native
 * handle — it never routes through the default resolver (which would re-enter
 * `openDualScopeDb` and recurse) and it bootstraps the lease tables first (the full
 * migration that creates them runs inside `fn`). It also records the scope in the
 * Seam-1 active-scope registry ({@link setActiveScope}) so chokepoint write
 * primitives lease against the right scope.
 *
 * Mode semantics mirror {@link withWriterLease}:
 * - `off` → pass-through: runs `fn` under today's `busy_timeout=30000`, byte-
 *   identical to pre-lease cold-open behaviour.
 * - `local` / `supervisor` (demoted) → claim the row via `BEGIN IMMEDIATE`; on a
 *   contended live holder, spin under the busy-timeout-backstopped deadline, then
 *   degrade to running `fn` (busy_timeout still serializes the migrate write-txn).
 * - `require` → throw {@link LeaseUnavailableError} if the row cannot be taken.
 *
 * @param scope - The cleo.db scope being cold-opened.
 * @param nativeDb - The native handle the cold-open just created (pragmas applied).
 * @param fn - The cold-open body to run while holding the lease.
 * @param opts - Priority / TTL options + the resolved `dbPath` of this cold-open.
 *   `dbPath` is recorded in the Seam-1 active-scope registry so the chokepoint
 *   write primitives lease their row in the SAME file this open targeted (correct
 *   when more than one project is open in one process — Finding 1). Cold-open
 *   defaults to highest priority ({@link SCHEMA_BOOTSTRAP_PRIORITY}) and a 60s TTL
 *   (schema bootstrap can be slow).
 * @returns The resolved value of `fn`.
 *
 * @task T11627
 */
export async function withColdOpenLease<T>(
  scope: LeaseScope,
  nativeDb: DatabaseSync,
  fn: () => Promise<T>,
  opts?: { priority?: number; ttlMs?: number; dbPath?: string },
): Promise<T> {
  // Seam 1 wiring: record the scope + resolved dbPath of this cold-open so
  // chokepoint write primitives (insertIdempotent/upsertIdempotent) lease against
  // the right scope AND the right file.
  setActiveScope(scope, opts?.dbPath);

  const mode = effectiveMode();

  // `off` mode — pure pass-through. busy_timeout=30000 on the connection still
  // serializes the migrate/reconcile write-txn exactly as before the lease.
  if (mode === 'off') {
    return fn();
  }

  // The lease tables MUST exist before the claim txn — the migration that creates
  // them runs inside `fn`, so bootstrap them idempotently here first.
  ensureColdOpenLeaseTables(nativeDb);
  // Defensive: the partial-unique active index MUST be present or AC1 is unenforced.
  assertWriterLeaseActiveIndexPresent(nativeDb);

  const lane: LeaseLane = 'tasks';
  const holderId = makeHolderId(lane);
  const ttlMs = opts?.ttlMs ?? 60_000;
  const priority = opts?.priority ?? SCHEMA_BOOTSTRAP_PRIORITY;

  // Bounded acquire window — never wait longer than the lease TTL. busy_timeout on
  // the IMMEDIATE lock backstops every individual claim attempt.
  const acquireWindowMs = Math.min(ACQUIRE_DEADLINE_MS, Math.max(1, ttlMs));
  const deadline = Date.now() + acquireWindowMs;
  let enqueued = false;
  let epoch: number | null = null;
  for (;;) {
    epoch = tryClaimOnce(nativeDb, scope, lane, holderId, ttlMs);
    if (epoch !== null) {
      if (enqueued) dequeueWaiter(nativeDb, scope, lane, holderId);
      break;
    }
    if (!enqueued) {
      enqueueWaiter(nativeDb, scope, lane, holderId, priority, ttlMs);
      enqueued = true;
    }
    if (Date.now() >= deadline) {
      if (enqueued) dequeueWaiter(nativeDb, scope, lane, holderId);
      if (mode === 'require') {
        throw new LeaseUnavailableError(
          scope,
          lane,
          'cold-open: live holder did not release within deadline',
        );
      }
      // local/supervisor: degrade to today's behaviour — run the cold-open under
      // busy_timeout, which still serializes the migrate write-txn.
      log().warn(
        { scope },
        'cold-open writer-lease acquire deadline exceeded; proceeding under ' +
          'busy_timeout fallback (degraded)',
      );
      return fn();
    }
    await sleepAsync(CLAIM_RETRY_DELAY_MS);
  }

  // Held — run the cold-open body, then free the row (epoch-guarded) on the way out.
  try {
    return await fn();
  } finally {
    nativeDb
      .prepare(
        `UPDATE ${WRITER_LEASES_TABLE} SET active = 0, reentrancy_depth = 0 ` +
          `WHERE scope = ? AND lane = ? AND holder_id = ? AND epoch = ? AND active = 1`,
      )
      .run(scope, lane, holderId, epoch);
  }
}
