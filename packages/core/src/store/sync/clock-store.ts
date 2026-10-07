/**
 * The persisted HLC clock (journal spec §1.4).
 *
 * `_sync_clock(replica_id, phys, ctr)` is local-only. It is read and written
 * only inside the caller's `BEGIN IMMEDIATE` transaction (every seal and every
 * apply), so two processes serialize on the SQLite write lock and no clock
 * state lives in process memory across transactions.
 *
 * @task T12342
 * @module store/sync/clock-store
 */

import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  encodeHlc,
  genesisHlc,
  type Hlc,
  isWithinSkew,
  MAX_DRIFT_MS,
  maxHlc,
  parseHlc,
  receive,
  tick,
} from './hlc.js';
import { hasTable } from './schema.js';

/**
 * Journal tables whose `hlc` column can hold this replica's timestamps. The
 * clock heals to their maximum on open, which covers a store restored from a
 * copy taken between a seal and its clock write. They arrive with the sealer
 * (S3); a missing table is skipped.
 */
export const CLOCK_HEAL_SOURCES: ReadonlyArray<{ table: string; column: string }> = [
  { table: '_sync_op', column: 'hlc' },
  { table: '_sync_row_meta', column: 'hlc' },
];

/**
 * `_sync_meta` key: the server's clock as push last observed it (§1.3), JSON
 * `{offsetMs, atMs}` — `offsetMs` is the server's date minus this device's
 * clock, `atMs` this device's clock when it was observed.
 */
export const SERVER_CLOCK_KEY = 'sync.server_clock';

/** How long an observed server date bounds sealing (§1.3: "a server date from the last 24 h"). */
export const SERVER_CLOCK_TTL_MS = 24 * 60 * 60 * 1000;

const ServerClockJson = z.object({ offsetMs: z.number(), atMs: z.number() }).strict();

/**
 * The highest physical candidate a seal may use now (journal spec §1.3, local
 * clock ahead): the server's date, estimated from the last observed offset,
 * plus `MAX_DRIFT`. Null when no server date from the last 24 h is known (or
 * the record is unreadable): sealing is then unclamped. Read-only.
 *
 * @param db - The store.
 * @param nowMs - This device's clock.
 * @param maxDriftMs - The bound; defaults to {@link MAX_DRIFT_MS}.
 */
export function sealWallCeiling(
  db: DatabaseSync,
  nowMs: number,
  maxDriftMs: number = MAX_DRIFT_MS,
): number | null {
  if (!hasTable(db, '_sync_meta')) return null;
  const row = db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(SERVER_CLOCK_KEY) as
    | { value: string }
    | undefined;
  if (row === undefined) return null;
  let parsed: z.infer<typeof ServerClockJson>;
  try {
    const r = ServerClockJson.safeParse(JSON.parse(row.value));
    if (!r.success) return null;
    parsed = r.data;
  } catch {
    return null;
  }
  if (Math.abs(nowMs - parsed.atMs) > SERVER_CLOCK_TTL_MS) return null;
  return nowMs + parsed.offsetMs + maxDriftMs;
}

/** Offset of the replica id inside an encoded HLC (13 + 1 + 6 + 1). */
const REPLICA_OFFSET = 21;

function assertInTransaction(db: DatabaseSync, what: string): void {
  if (!db.isTransaction) {
    // @sync-invariant none:local-only a caller bug (clock bookkeeping outside its transaction); the clock is per-store state, not a synced row
    throw new Error(`${what} must run inside the caller's BEGIN IMMEDIATE transaction`);
  }
}

/**
 * The stored clock of a replica, or its genesis when none is stored.
 */
export function loadClock(db: DatabaseSync, replica: string): Hlc {
  const row = db.prepare('SELECT phys, ctr FROM _sync_clock WHERE replica_id = ?').get(replica) as
    | { phys: number; ctr: number }
    | undefined;
  return row ? { phys: row.phys, ctr: row.ctr, replica } : genesisHlc(replica);
}

/** Store a clock value. Caller holds the transaction. */
export function storeClock(db: DatabaseSync, h: Hlc): void {
  assertInTransaction(db, 'storeClock');
  db.prepare(
    'INSERT INTO _sync_clock (replica_id, phys, ctr) VALUES (?, ?, ?) ' +
      'ON CONFLICT(replica_id) DO UPDATE SET phys = excluded.phys, ctr = excluded.ctr',
  ).run(h.replica, h.phys, h.ctr);
}

/**
 * Issue the next local HLC and persist the clock. Caller holds the
 * transaction.
 *
 * @param wallMs - The physical candidate (§1.2).
 * @returns The issued timestamp, encoded.
 */
export function tickClock(db: DatabaseSync, replica: string, wallMs: number): string {
  assertInTransaction(db, 'tickClock');
  const next = tick(loadClock(db, replica), wallMs);
  storeClock(db, next);
  return encodeHlc(next);
}

/**
 * Merge a received HLC into the persisted clock, unless it is beyond the skew
 * bound: then nothing is written and the caller must hold the transaction
 * (see `SkewHold`). Caller holds the transaction.
 *
 * @returns `{ held: false, clock }` after a merge, `{ held: true }` otherwise.
 */
export function receiveClock(
  db: DatabaseSync,
  replica: string,
  remote: string,
  nowMs: number,
  maxDriftMs: number = MAX_DRIFT_MS,
): { held: false; clock: string } | { held: true } {
  assertInTransaction(db, 'receiveClock');
  const r = parseHlc(remote);
  if (!isWithinSkew(r, nowMs, maxDriftMs)) return { held: true };
  const next = receive(loadClock(db, replica), r, nowMs);
  storeClock(db, next);
  return { held: false, clock: encodeHlc(next) };
}

/**
 * Heal a replica's clock to the largest HLC it is known to have issued: the
 * stored clock, or the maximum of {@link CLOCK_HEAL_SOURCES}. Caller holds
 * the transaction.
 *
 * @returns The healed clock.
 */
export function healClock(
  db: DatabaseSync,
  replica: string,
  sources: ReadonlyArray<{ table: string; column: string }> = CLOCK_HEAL_SOURCES,
): Hlc {
  assertInTransaction(db, 'healClock');
  let best = loadClock(db, replica);
  for (const { table, column } of sources) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table) || !/^[a-z_][a-z0-9_]*$/.test(column)) {
      // @sync-invariant none:local-only a heal source is a compiled-in identifier, not row data; the clock is per-store state
      throw new Error(`invalid clock heal source ${table}.${column}`);
    }
    if (!hasTable(db, table)) continue;
    const row = db
      .prepare(`SELECT MAX(${column}) AS h FROM ${table} WHERE substr(${column}, ?) = ?`)
      .get(REPLICA_OFFSET + 1, replica) as { h: string | null } | undefined;
    if (row?.h) best = maxHlc(best, { ...parseHlc(row.h), replica });
  }
  const stored = loadClock(db, replica);
  if (best.phys !== stored.phys || best.ctr !== stored.ctr) storeClock(db, best);
  return best;
}

/**
 * Run `fn` inside `BEGIN IMMEDIATE`, committing on return and rolling back
 * on a throw. The clock primitives above require such a transaction.
 */
export function withImmediateTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
