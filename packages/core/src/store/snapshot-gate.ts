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
 *      on `<backupDir>/.snapshot-gate`. It is acquired with zero retries, so a
 *      caller that finds a snapshot in flight skips instead of queueing behind it.
 *   2. **Debounce** — the last start time of each snapshot prefix is persisted
 *      in the project `cleo.db` (`schema_meta`, key {@link SNAPSHOT_GATE_META_KEY}).
 *      It is re-read under the lock, so the window applies across processes.
 *      There is no `force` option.
 *   3. **Retention** — {@link selectSnapshotsToKeep} keeps time-spread slots
 *      (latest, hourly, daily) instead of the newest N, so a burst can occupy
 *      at most the "latest" slots and one hourly and one daily bucket.
 *
 * @task T12508
 */

import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { acquireLock, type ReleaseFn } from './lock.js';

/** Minimum interval between two snapshot starts of the same prefix, per project. */
export const SNAPSHOT_DEBOUNCE_MS = 5 * 60_000;

/**
 * Age after which a held gate lock is considered abandoned. `VACUUM INTO` is
 * synchronous and blocks the event loop, so the lock's mtime cannot be
 * refreshed while it runs; this value must exceed the longest snapshot.
 */
export const SNAPSHOT_LOCK_STALE_MS = 10 * 60_000;

/** `schema_meta` key holding the persisted snapshot gate state. */
export const SNAPSHOT_GATE_META_KEY = 'sqlite_snapshot_gate';

/** Basename of the lock target inside the backup directory. */
const GATE_LOCK_BASENAME = '.snapshot-gate';

/** Persisted state for one snapshot prefix. */
interface SnapshotPrefixState {
  /** Epoch ms when the most recent snapshot of this prefix started. */
  startedAt: number;
  /** Epoch ms when that snapshot finished, or `null` if it did not finish. */
  completedAt: number | null;
}

/** Persisted gate state, keyed by snapshot prefix. */
type SnapshotGateState = Record<string, SnapshotPrefixState>;

/** Why a gated snapshot request did not snapshot anything. */
export type SnapshotGateSkipReason = 'debounced' | 'in-flight' | 'state-unavailable';

/** Outcome of {@link runGatedSnapshot}. */
export interface SnapshotGateResult {
  /** Prefixes whose snapshot function ran and resolved. */
  readonly snapshotted: readonly string[];
  /** Set when no snapshot ran; `null` when at least one prefix was admitted. */
  readonly skipped: SnapshotGateSkipReason | null;
}

/** Options for {@link runGatedSnapshot}. */
export interface SnapshotGateOptions {
  /** Absolute snapshot directory; the lock lives here. Must exist. */
  readonly backupDir: string;
  /**
   * Handle on the project `cleo.db` that stores the debounce state, or `null`
   * when it cannot be opened. With no state store the gate admits nothing:
   * an unbounded snapshot is exactly the failure this gate exists to prevent.
   */
  readonly stateDb: DatabaseSync | null;
  /** Snapshot prefixes requested by the caller, in snapshot order. */
  readonly prefixes: readonly string[];
  /** Clock override for tests. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * Read the persisted gate state. Throws when the store cannot be read, so the
 * caller can distinguish "no state yet" (empty object) from "no state store".
 */
function readGateState(db: DatabaseSync): SnapshotGateState {
  const row = db
    .prepare('SELECT value FROM schema_meta WHERE key = ?')
    .get(SNAPSHOT_GATE_META_KEY) as { value: string } | undefined;
  if (!row) return {};
  const state: SnapshotGateState = {};
  try {
    const parsed: Record<string, Partial<SnapshotPrefixState> | null> = JSON.parse(row.value);
    if (parsed === null || typeof parsed !== 'object') return state;
    for (const [prefix, entry] of Object.entries(parsed)) {
      if (entry && typeof entry.startedAt === 'number') {
        state[prefix] = {
          startedAt: entry.startedAt,
          completedAt: typeof entry.completedAt === 'number' ? entry.completedAt : null,
        };
      }
    }
  } catch {
    // A corrupt value is treated as "no history"; the next write replaces it.
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

/**
 * Whether a prefix may start a new snapshot at `nowMs`. A start time in the
 * future (the clock moved backwards) does not block, or it would block until
 * the clock caught up.
 */
function isDue(entry: SnapshotPrefixState | undefined, nowMs: number): boolean {
  if (!entry) return true;
  const elapsed = nowMs - entry.startedAt;
  return elapsed < 0 || elapsed >= SNAPSHOT_DEBOUNCE_MS;
}

/**
 * Run `snapshot` for every requested prefix that is outside the debounce
 * window, while holding the project-wide snapshot lock.
 *
 * Sequence: a lock-free read of the persisted state returns early when every
 * prefix is debounced (the common case for per-write checkpoints). Otherwise
 * the lock is tried once; a held lock means a snapshot is in flight, and the
 * request is dropped because that snapshot already covers it. Under the lock
 * the state is re-read, the admitted prefixes' start times are persisted
 * BEFORE any snapshot runs (so a crash mid-snapshot still debounces), and the
 * completion time is recorded after each snapshot resolves.
 *
 * Never throws for gate failures; `snapshot` rejections are swallowed per
 * prefix, matching the non-fatal contract of the backup pipeline.
 *
 * @param opts - Backup directory, state store, and requested prefixes.
 * @param snapshot - Performs one prefix's snapshot.
 * @returns Which prefixes were snapshotted, or why none were.
 * @task T12508
 */
export async function runGatedSnapshot(
  opts: SnapshotGateOptions,
  snapshot: (prefix: string) => Promise<void>,
): Promise<SnapshotGateResult> {
  const now = opts.now ?? Date.now;
  const db = opts.stateDb;
  if (!db) return { snapshotted: [], skipped: 'state-unavailable' };

  try {
    const state = readGateState(db);
    const nowMs = now();
    if (!opts.prefixes.some((p) => isDue(state[p], nowMs))) {
      return { snapshotted: [], skipped: 'debounced' };
    }
  } catch {
    return { snapshotted: [], skipped: 'state-unavailable' };
  }

  let release: ReleaseFn;
  try {
    release = await acquireLock(join(opts.backupDir, GATE_LOCK_BASENAME), {
      retries: 0,
      stale: SNAPSHOT_LOCK_STALE_MS,
      // A compromised lock (e.g. the backup dir was removed) must not throw
      // from a timer and crash the host process; the snapshot is best-effort.
      onCompromised: () => {},
    });
  } catch {
    return { snapshotted: [], skipped: 'in-flight' };
  }

  const snapshotted: string[] = [];
  try {
    let state: SnapshotGateState;
    let admitted: string[];
    try {
      state = readGateState(db);
      const startMs = now();
      admitted = opts.prefixes.filter((p) => isDue(state[p], startMs));
      if (admitted.length === 0) return { snapshotted: [], skipped: 'debounced' };
      for (const p of admitted) state[p] = { startedAt: startMs, completedAt: null };
      writeGateState(db, state);
    } catch {
      return { snapshotted: [], skipped: 'state-unavailable' };
    }

    for (const prefix of admitted) {
      try {
        await snapshot(prefix);
        snapshotted.push(prefix);
        const entry = state[prefix];
        if (entry) entry.completedAt = now();
      } catch {
        // non-fatal — continue with remaining prefixes
      }
    }
    try {
      writeGateState(db, state);
    } catch {
      // Completion times are informational; the start times already debounce.
    }
    return { snapshotted, skipped: null };
  } finally {
    await release().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/**
 * Time-spread retention policy. Each slot kind keeps the NEWEST snapshot in
 * each of its most recent non-empty buckets; the kept set is the union. Slots
 * overlap (the latest snapshot is usually also the newest of its hour and
 * day), so the file count is at most `latest + hourly + daily`.
 */
export interface SnapshotRetentionPolicy {
  /** Number of most recent snapshots kept unconditionally. */
  readonly latest: number;
  /** Number of most recent distinct clock hours that keep one snapshot each. */
  readonly hourly: number;
  /** Number of most recent distinct calendar days that keep one snapshot each. */
  readonly daily: number;
}

/**
 * Default policy: at most 10 files per prefix, the same ceiling as the former
 * newest-10 rotation, but spread across hours and days.
 */
export const DEFAULT_SNAPSHOT_RETENTION: SnapshotRetentionPolicy = {
  latest: 2,
  hourly: 4,
  daily: 4,
};

/** `YYYYMMDD-HHmmss` stamp embedded in a snapshot filename. */
const STAMP_PATTERN = /-(\d{8})-(\d{6})\.db$/;

/**
 * Choose which snapshot files survive retention.
 *
 * Buckets come from the `YYYYMMDD-HHmmss` stamp in each filename (the local
 * time the snapshot was taken), not from mtime, so copying or touching a file
 * cannot move it between buckets. Buckets are the most recent ones that HOLD
 * a snapshot, not the most recent hours on the clock: when no snapshots are
 * taken for a week, last week's history is kept rather than aged out.
 *
 * Filenames without a stamp are always kept; retention never deletes a file
 * it cannot place.
 *
 * @param names - Snapshot filenames for a single prefix.
 * @param policy - Slot counts; defaults to {@link DEFAULT_SNAPSHOT_RETENTION}.
 * @returns The filenames to keep.
 * @task T12508
 */
export function selectSnapshotsToKeep(
  names: readonly string[],
  policy: SnapshotRetentionPolicy = DEFAULT_SNAPSHOT_RETENTION,
): Set<string> {
  const keep = new Set<string>();
  const stamped: Array<{ name: string; stamp: string }> = [];
  for (const name of names) {
    const m = STAMP_PATTERN.exec(name);
    if (m) stamped.push({ name, stamp: `${m[1]}-${m[2]}` });
    else keep.add(name);
  }
  // Newest first; the stamp sorts lexicographically in time order.
  stamped.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0));

  for (const s of stamped.slice(0, policy.latest)) keep.add(s.name);

  const keepNewestPerBucket = (bucketOf: (stamp: string) => string, slots: number): void => {
    const seen = new Set<string>();
    for (const s of stamped) {
      if (seen.size >= slots) break;
      const bucket = bucketOf(s.stamp);
      if (seen.has(bucket)) continue;
      seen.add(bucket);
      keep.add(s.name);
    }
  };
  keepNewestPerBucket((stamp) => stamp.slice(0, 11), policy.hourly); // YYYYMMDD-HH
  keepNewestPerBucket((stamp) => stamp.slice(0, 8), policy.daily); // YYYYMMDD

  return keep;
}
