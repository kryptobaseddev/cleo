/**
 * Project-wide admission gate and retention policy for SQLite snapshots.
 *
 * `cleo session end` snapshots the project databases. When many agents end
 * their sessions together, each process used to run its own snapshot, because
 * the debounce lived in process memory and the session-end hook bypassed it
 * with `force: true`. On 2026-09-27 that produced four 1.3 GB snapshots in ten
 * seconds, and the newest-10 rotation then evicted the older recovery points.
 *
 * This module closes that path with three mechanisms:
 *
 *   1. **Lock** — a cross-process lock ({@link acquireLock}, proper-lockfile)
 *      on `<backupDir>/.snapshot-gate`. At most one snapshot runs per project.
 *   2. **Admission** — gate state lives in the project `cleo.db`
 *      (`schema_meta`, key {@link SNAPSHOT_GATE_META_KEY}) and is re-read
 *      under the lock. It holds a monotonic snapshot GENERATION counter,
 *      claimed under the lock when a snapshot starts, and per prefix the
 *      generation and start time of its last satisfied snapshot. Two modes
 *      ({@link SnapshotGateMode}) use it:
 *        - `routine` (per-write checkpoints): debounced for
 *          {@link SNAPSHOT_DEBOUNCE_MS}, and the lock is tried once — a caller
 *          that finds a snapshot in flight skips.
 *        - `required` (session end, pre-destructive checkpoints): not
 *          debounced. The caller records the generation it saw when it made
 *          the request, WAITS for the lock (bounded), and is satisfied only
 *          by a snapshot of a LATER generation — one that started after the
 *          request, so it contains every write made before it. Requests queued
 *          behind one snapshot are all covered by it, so a burst produces one
 *          snapshot. Works without a state store. No wall clock is involved,
 *          so a stepped clock cannot fake coverage.
 *      A prefix whose database does not exist in this project (e.g. no
 *      `llmtxt.db`) is `absent`: it satisfies admission like a written
 *      snapshot and is never reported as failed. There is no mode that
 *      bypasses the lock.
 *   3. **Retention** — {@link selectSnapshotsToKeep} keeps time-spread slots
 *      (latest, quarter-hourly, hourly, daily) instead of the newest N, so a
 *      burst cannot evict older recovery points. The file just written is
 *      always kept.
 *
 * @task T12508
 */

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { acquireLock, type ReleaseFn } from './lock.js';

/** Minimum interval between two `routine` snapshot starts of a prefix, per project. */
export const SNAPSHOT_DEBOUNCE_MS = 5 * 60_000;

/**
 * Age after which a held gate lock is considered abandoned. `VACUUM INTO` is
 * synchronous and blocks the event loop, so the lock's mtime cannot be
 * refreshed while it runs; this value must exceed the longest snapshot.
 */
export const SNAPSHOT_LOCK_STALE_MS = 10 * 60_000;

/**
 * Default lock retries for a `required` request (pre-destructive
 * checkpoints). proper-lockfile backs off from 100 ms to 1 s per attempt, so
 * 90 retries bound the wait to about 90 s.
 */
export const SNAPSHOT_LOCK_WAIT_RETRIES = 90;

/**
 * Lock retries for the session-end snapshot: about 6.5 s (100 + 200 + 400 +
 * 800 ms, then 1 s each). Session end runs inside host shutdown hooks that
 * may be killed, so it must not wait long; the session is already persisted
 * when it runs.
 */
export const SESSION_END_LOCK_WAIT_RETRIES = 9;

/** `schema_meta` key holding the persisted snapshot gate state. */
export const SNAPSHOT_GATE_META_KEY = 'sqlite_snapshot_gate';

/** Basename of the lock target inside the backup directory. */
const GATE_LOCK_BASENAME = '.snapshot-gate';

/** Persisted state for one prefix: its last satisfied (written or absent) snapshot. */
interface SnapshotPrefixState {
  /** Generation of the snapshot run that satisfied this prefix. */
  generation: number;
  /** Epoch ms when that run started (used only by the `routine` debounce). */
  startedAt: number;
  /** Epoch ms when that prefix finished. */
  completedAt: number;
}

/** Persisted gate state. */
interface SnapshotGateState {
  /** Highest generation claimed by any snapshot run (0 = none yet). */
  generation: number;
  /** Per-prefix record of the last satisfied snapshot. */
  prefixes: Record<string, SnapshotPrefixState>;
}

/**
 * How a snapshot request is admitted.
 *
 * - `routine` — debounced; skips when a snapshot is in flight; needs the state
 *   store (without it nothing is admitted, so a broken store cannot storm).
 * - `required` — not debounced; waits for the lock; skipped only when a
 *   snapshot of a later generation than the one seen at request time
 *   satisfied the prefix.
 */
export type SnapshotGateMode = 'routine' | 'required';

/**
 * What a snapshot function did for one prefix: wrote a file, hard-linked the
 * file already written in this run for the same physical database, or found
 * no database to snapshot.
 */
export type SnapshotOutcome = 'written' | 'linked' | 'absent';

/** Why a gated snapshot request did not snapshot anything. */
export type SnapshotGateSkipReason =
  | 'debounced'
  | 'in-flight'
  | 'covered'
  | 'state-unavailable'
  | 'lock-timeout';

/** Outcome of {@link runGatedSnapshot}. */
export interface SnapshotGateResult {
  /** Prefixes that have a snapshot file from this call (written or hard-linked). */
  readonly snapshotted: readonly string[];
  /**
   * Subset of `snapshotted` that shares its file with an earlier prefix of the
   * same run (same physical database — one VACUUM, hard-linked).
   */
  readonly linked: readonly string[];
  /** Prefixes whose database does not exist in this project (nothing to snapshot). */
  readonly absent: readonly string[];
  /** Prefixes whose snapshot was attempted and threw. */
  readonly failed: readonly string[];
  /** Set when no snapshot was attempted; `null` when at least one prefix was admitted. */
  readonly skipped: SnapshotGateSkipReason | null;
  /** Human-readable cause when `skipped` is `lock-timeout`. */
  readonly error?: string;
}

/** Options for {@link runGatedSnapshot}. */
export interface SnapshotGateOptions {
  /** Absolute snapshot directory; the lock lives here. Must exist. */
  readonly backupDir: string;
  /**
   * Handle on the project `cleo.db` that stores the gate state, or `null` when
   * it cannot be opened. `routine` requests admit nothing without it;
   * `required` requests snapshot anyway.
   */
  readonly stateDb: DatabaseSync | null;
  /** Snapshot prefixes requested by the caller, in snapshot order. */
  readonly prefixes: readonly string[];
  /** Admission mode. Defaults to `routine`. */
  readonly mode?: SnapshotGateMode;
  /**
   * `required` mode: the gate generation observed when the request was made
   * (after the caller's last write). Only a later generation covers it.
   * Defaults to the generation read at the start of this call.
   */
  readonly seenGeneration?: number;
  /** Lock retries for `required` mode. Defaults to {@link SNAPSHOT_LOCK_WAIT_RETRIES}. */
  readonly lockWaitRetries?: number;
  /**
   * Called under the lock BEFORE the state is re-read and the generation is
   * claimed. The session-end worker uses it to drop its "worker pending"
   * marker: a request that saw the marker was made before this point, so the
   * generation claimed next covers it. Errors are ignored.
   */
  readonly onLockAcquired?: () => void;
  /** Clock override for tests (debounce and timestamps only). Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Read the persisted gate state. Throws when the store cannot be read, so the
 * caller can distinguish "no state yet" (empty state) from "no state store".
 */
function readGateState(db: DatabaseSync): SnapshotGateState {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get(SNAPSHOT_GATE_META_KEY) as { value: string } | undefined;
  const state: SnapshotGateState = { generation: 0, prefixes: {} };
  if (!row) return state;
  try {
    const parsed: {
      generation?: number;
      prefixes?: Record<string, Partial<SnapshotPrefixState> | null>;
    } | null = JSON.parse(row.value);
    if (parsed === null || typeof parsed !== 'object') return state;
    if (typeof parsed.generation === 'number' && Number.isSafeInteger(parsed.generation)) {
      state.generation = parsed.generation;
    }
    for (const [prefix, e] of Object.entries(parsed.prefixes ?? {})) {
      if (
        e &&
        typeof e.generation === 'number' &&
        typeof e.startedAt === 'number' &&
        typeof e.completedAt === 'number'
      ) {
        state.prefixes[prefix] = {
          generation: e.generation,
          startedAt: e.startedAt,
          completedAt: e.completedAt,
        };
      }
    }
  } catch {
    // A corrupt value (or the pre-generation layout) is treated as "no
    // history"; the next write replaces it.
  }
  return state;
}

/** Persist the gate state (upsert). */
function writeGateState(db: DatabaseSync, state: SnapshotGateState): void {
  db.prepare(
    'INSERT INTO schema_meta (key, value) VALUES (?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SNAPSHOT_GATE_META_KEY, JSON.stringify(state));
}

/** Read the state, or `null` when there is no usable state store. */
function tryReadGateState(db: DatabaseSync | null): SnapshotGateState | null {
  if (!db) return null;
  try {
    return readGateState(db);
  } catch {
    return null;
  }
}

/**
 * Read the current snapshot generation — what a `required` request should
 * pass as `seenGeneration` when it is made. Returns `null` without a usable
 * state store (the request is then never considered covered).
 *
 * @param db - Handle on the project `cleo.db`, or `null`.
 * @returns The highest claimed generation, or `null`.
 * @task T12508
 */
export function readSnapshotGeneration(db: DatabaseSync | null): number | null {
  return tryReadGateState(db)?.generation ?? null;
}

/**
 * Whether a prefix needs a snapshot.
 *
 * `routine`: the last satisfied start is outside the debounce window. A start
 * in the future (the clock moved backwards) does not block.
 * `required`: no snapshot of a generation later than `seenGeneration`
 * satisfied it (`seenGeneration === null` means never covered).
 */
function needsSnapshot(
  entry: SnapshotPrefixState | undefined,
  mode: SnapshotGateMode,
  nowMs: number,
  seenGeneration: number | null,
): boolean {
  if (!entry) return true;
  if (mode === 'required') return seenGeneration === null || entry.generation <= seenGeneration;
  const elapsed = nowMs - entry.startedAt;
  return elapsed < 0 || elapsed >= SNAPSHOT_DEBOUNCE_MS;
}

/**
 * Run `snapshot` for every requested prefix that needs one, while holding the
 * project-wide snapshot lock. See the module comment for the two modes.
 *
 * `snapshot` resolves `'written'` when it wrote a snapshot file and
 * `'absent'` when the database does not exist; a rejection counts as a
 * failure. Written and absent prefixes are recorded (they satisfy admission);
 * a failed one is not, so a failed attempt never uses up the debounce window
 * or covers a later request.
 *
 * Never throws; every failure is reported in the result.
 *
 * @param opts - Backup directory, state store, prefixes, and mode.
 * @param snapshot - Performs one prefix's snapshot. Runs under the lock.
 * @returns Which prefixes were written, absent or failed, or why none ran.
 * @task T12508
 */
export async function runGatedSnapshot(
  opts: SnapshotGateOptions,
  snapshot: (prefix: string) => Promise<SnapshotOutcome>,
): Promise<SnapshotGateResult> {
  const now = opts.now ?? Date.now;
  const mode = opts.mode ?? 'routine';
  const db = opts.stateDb;
  const none = (skipped: SnapshotGateSkipReason, error?: string): SnapshotGateResult => ({
    snapshotted: [],
    linked: [],
    absent: [],
    failed: [],
    skipped,
    ...(error !== undefined && { error }),
  });

  // Read once without the lock: the routine fast path, and the generation a
  // `required` request was made at (when the caller did not record it).
  const entryState = tryReadGateState(db);
  const seenGeneration =
    mode === 'required' ? (opts.seenGeneration ?? entryState?.generation ?? null) : null;
  if (mode === 'routine') {
    if (!entryState) return none('state-unavailable');
    const nowMs = now();
    if (!opts.prefixes.some((p) => needsSnapshot(entryState.prefixes[p], mode, nowMs, null))) {
      return none('debounced');
    }
  }

  const lockPath = join(opts.backupDir, GATE_LOCK_BASENAME);
  let release: ReleaseFn;
  try {
    release = await acquireLock(lockPath, {
      retries: mode === 'required' ? (opts.lockWaitRetries ?? SNAPSHOT_LOCK_WAIT_RETRIES) : 0,
      stale: SNAPSHOT_LOCK_STALE_MS,
      // A compromised lock (e.g. the backup dir was removed) must not throw
      // from a timer and crash the host process.
      onCompromised: () => {},
    });
  } catch {
    if (mode === 'routine') return none('in-flight');
    return none(
      'lock-timeout',
      `Snapshot lock ${lockPath}.lock is still held after waiting. Another snapshot is ` +
        `running, or a crashed process left the lock (it expires after ` +
        `${SNAPSHOT_LOCK_STALE_MS / 60_000} minutes). Remove it if no snapshot is running.`,
    );
  }

  try {
    try {
      opts.onLockAcquired?.();
    } catch {
      // A failing hook must not cost the snapshot.
    }
    // Re-read under the lock: another process may have snapshotted meanwhile.
    const state = tryReadGateState(db);
    if (!state && mode === 'routine') return none('state-unavailable');
    const startMs = now();
    const admitted = opts.prefixes.filter((p) =>
      needsSnapshot(state?.prefixes[p], mode, startMs, seenGeneration),
    );
    if (admitted.length === 0) return none(mode === 'routine' ? 'debounced' : 'covered');

    // Claim the next generation BEFORE snapshotting, so a request made while
    // this run is in flight sees it and is not covered by it.
    // If the claim cannot be persisted, this run records nothing: recording
    // under an unclaimed generation could cover a request made while the run
    // was in flight (it would have seen the old generation).
    const generation = (state?.generation ?? 0) + 1;
    let claimed = false;
    if (db && state) {
      try {
        writeGateState(db, { ...state, generation });
        claimed = true;
      } catch {
        // Unclaimed: later requests are simply not covered by this run.
      }
    }

    const snapshotted: string[] = [];
    const linked: string[] = [];
    const absent: string[] = [];
    const failed: string[] = [];
    for (const prefix of admitted) {
      try {
        const outcome = await snapshot(prefix);
        if (outcome === 'absent') absent.push(prefix);
        else {
          snapshotted.push(prefix);
          if (outcome === 'linked') linked.push(prefix);
        }
      } catch {
        failed.push(prefix);
      }
    }

    const satisfied = [...snapshotted, ...absent];
    if (db && claimed && satisfied.length > 0) {
      try {
        const latest = readGateState(db);
        const completedAt = now();
        latest.generation = Math.max(latest.generation, generation);
        for (const p of satisfied) {
          latest.prefixes[p] = { generation, startedAt: startMs, completedAt };
        }
        writeGateState(db, latest);
      } catch {
        // The snapshot exists; losing its record only makes the next request run.
      }
    }
    return { snapshotted, linked, absent, failed, skipped: null };
  } finally {
    await release().catch(() => {});
  }
}

/**
 * Explain why a `required` snapshot request left no fresh snapshot behind, or
 * return `null` when it succeeded (written, covered by a later snapshot, or
 * every prefix absent). Used by callers that must tell the user.
 *
 * @param result - Gate outcome; `null` means nothing could be attempted.
 * @returns A one-line reason, or `null` on success.
 * @task T12508
 */
export function describeSnapshotMiss(result: SnapshotGateResult | null): string | null {
  if (!result) return 'the backup directory could not be resolved';
  if (result.skipped === 'lock-timeout') return result.error ?? 'the snapshot lock stayed held';
  if (result.skipped !== null && result.skipped !== 'covered') {
    return `the snapshot was skipped (${result.skipped})`;
  }
  if (result.failed.length > 0) return `the snapshot failed for: ${result.failed.join(', ')}`;
  return null;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Time-spread retention policy. Each slot kind keeps the NEWEST snapshot in
 * each of its most recent non-empty buckets; the kept set is the union. Slots
 * overlap (the latest snapshot is usually also the newest of its quarter hour,
 * hour and day), so the slotted file count is at most the sum of the counts.
 */
export interface SnapshotRetentionPolicy {
  /** Number of most recent snapshots kept unconditionally. */
  readonly latest: number;
  /** Number of most recent distinct 15-minute buckets that keep one snapshot each. */
  readonly quarterHourly: number;
  /** Number of most recent distinct clock hours that keep one snapshot each. */
  readonly hourly: number;
  /** Number of most recent distinct calendar days that keep one snapshot each. */
  readonly daily: number;
}

/**
 * Default policy: at most 10 slotted files per prefix, the same ceiling as the
 * former newest-10 rotation, spread across quarter hours, hours and days. The
 * quarter-hour slots keep an active session's history from collapsing into
 * the one hourly bucket it is in.
 */
export const DEFAULT_SNAPSHOT_RETENTION: SnapshotRetentionPolicy = {
  latest: 1,
  quarterHourly: 3,
  hourly: 3,
  daily: 3,
};

/** Inputs to {@link selectSnapshotsToKeep} besides the filenames. */
export interface SnapshotRetentionContext {
  /** Slot counts; defaults to {@link DEFAULT_SNAPSHOT_RETENTION}. */
  readonly policy?: SnapshotRetentionPolicy;
  /** The snapshot just written; always kept, whatever its stamp. */
  readonly pinned?: string;
  /**
   * The current local time as a `YYYYMMDD-HHmmss` stamp. Files stamped later
   * than this are unslotted (kept, but they win no slot). Omit to skip the check.
   */
  readonly nowStamp?: string;
}

/** `YYYYMMDD-HHmmss` stamp embedded in a snapshot filename. */
const STAMP_PATTERN = /-(\d{8})-(\d{6})\.db$/;

/** Whether `YYYYMMDD` + `HHmmss` name a real calendar date and time. */
function isValidStamp(ymd: string, hms: string): boolean {
  const y = Number(ymd.slice(0, 4));
  const mo = Number(ymd.slice(4, 6));
  const d = Number(ymd.slice(6, 8));
  const h = Number(hms.slice(0, 2));
  const mi = Number(hms.slice(2, 4));
  const se = Number(hms.slice(4, 6));
  if (mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || se > 59) return false;
  // Day-of-month check via UTC so no time zone can shift the date.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === mo - 1 && probe.getUTCDate() === d;
}

/**
 * Choose which snapshot files survive retention.
 *
 * Buckets come from the `YYYYMMDD-HHmmss` stamp in each filename (the local
 * time the snapshot was taken), not from mtime, so copying or touching a file
 * cannot move it between buckets. Buckets are the most recent ones that HOLD
 * a snapshot, not the most recent hours on the clock: when no snapshots are
 * taken for a week, last week's history is kept rather than aged out.
 *
 * Never deleted: the pinned file (the one just written), files without a
 * stamp, files with an impossible stamp, and files stamped in the future.
 * The last two are also unslotted — a skewed or bogus stamp cannot win a slot
 * and push a real snapshot out.
 *
 * Local stamps repeat an hour at the DST fall-back (01:30 PDT, then 01:10
 * PST). During the repeated hour the earlier PDT file carries a stamp later
 * than the clock, so it is unslotted and kept; the PST file just written is
 * pinned. Once the hour passes, both share one hourly bucket.
 *
 * @param names - Snapshot filenames for a single prefix.
 * @param ctx - Policy, pinned file, and current stamp.
 * @returns The filenames to keep.
 * @task T12508
 */
export function selectSnapshotsToKeep(
  names: readonly string[],
  ctx: SnapshotRetentionContext = {},
): Set<string> {
  const policy = ctx.policy ?? DEFAULT_SNAPSHOT_RETENTION;
  const keep = new Set<string>();
  const stamped: Array<{ name: string; stamp: string }> = [];
  for (const name of names) {
    const m = STAMP_PATTERN.exec(name);
    const ymd = m?.[1];
    const hms = m?.[2];
    if (!ymd || !hms || !isValidStamp(ymd, hms)) {
      keep.add(name);
      continue;
    }
    const stamp = `${ymd}-${hms}`;
    if (ctx.nowStamp !== undefined && stamp > ctx.nowStamp) {
      keep.add(name);
      continue;
    }
    stamped.push({ name, stamp });
  }
  if (ctx.pinned !== undefined && names.includes(ctx.pinned)) keep.add(ctx.pinned);

  // Newest first; the stamp sorts lexicographically in time order.
  stamped.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  for (const s of stamped.slice(0, policy.latest)) keep.add(s.name);

  const keepNewestPerBucket = (bucketOf: (stamp: string) => string, slots: number): void => {
    const seen = new Set<string>();
    for (const s of stamped) {
      const bucket = bucketOf(s.stamp);
      if (seen.has(bucket)) continue;
      if (seen.size >= slots) break;
      seen.add(bucket);
      keep.add(s.name);
    }
  };
  // YYYYMMDD-HH + quarter index (minutes 00-14 → 0, 15-29 → 1, …)
  keepNewestPerBucket(
    (stamp) => `${stamp.slice(0, 11)}q${Math.floor(Number(stamp.slice(11, 13)) / 15)}`,
    policy.quarterHourly,
  );
  keepNewestPerBucket((stamp) => stamp.slice(0, 11), policy.hourly); // YYYYMMDD-HH
  keepNewestPerBucket((stamp) => stamp.slice(0, 8), policy.daily); // YYYYMMDD

  return keep;
}
