/**
 * The genesis cut: where a stream's pushed history begins (journal spec
 * §2.11 §10, §3.5 Rule 2; T12343 S4-1a).
 *
 * Before genesis nothing leaves the device: every effect is carried by the
 * stream's genesis checkpoint instead of by segments. {@link cutGenesis}
 * checks the store is fit to push (the step-0 preconditions, T13032 AC2),
 * seals what is pending, then in ONE `BEGIN IMMEDIATE` with no frame open:
 * - records `genesis_cut:<stream>` and `genesis_source_seq:<stream>` (the
 *   highest capture seq whose effect the checkpoint carries; equal by
 *   construction, since every capture at or below it is sealed first);
 * - folds every sealed, unsegmented transaction (`state = 'folded'`): it is
 *   in the checkpoint and is never sent;
 * - initialises row meta for every row that has none (§1.2 genesis HLC);
 * - sets `undo_enabled`, raises `min_writer_version` and turns `sync.push`
 *   on, so every pushed transaction has undo (C1);
 * - leaves `genesis_pending:<stream>`, which the push keeps until the
 *   genesis checkpoint is stored (S4-1b), so no segment ever precedes it.
 *
 * Draining first is what makes "every capture at or below the cut is
 * folded" hold without folding unsealed captures, whose rows would keep
 * stale meta and ledger counts: the cut transaction refuses (and retries
 * the drain) if a capture is still live.
 *
 * @task T12343
 * @module store/sync/genesis
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { writeRestoreMarker } from '../restore-marker.js';
import {
  BIRTH_FP_COLUMN,
  ROW_IDENTITY,
  rowIdentityRecipeCurrent,
  UID_COLUMN,
} from '../row-identity.js';
import { captureTriggerDrift, syncSetTables } from './capture.js';
import { isSyncFlagOn, setSyncFlag } from './flags.js';
import { baselineRowMeta } from './repair.js';
import { activeReplica, persistStoreSeq } from './replica.js';
import { hasTable } from './schema.js';
import { sealPending, sealPreconditions } from './sealer.js';
import { capturePosition } from './sequencing.js';
import { hasTriggerSuspendTable, verifyOwnedTriggers } from './trigger-classes.js';
import { raiseMinWriterVersion } from './writer-version.js';

/** `_sync_meta` key prefix of a stream's genesis cut (read by `streamStarted`, T13217). */
export const GENESIS_CUT_KEY_PREFIX = 'genesis_cut:';

/** `_sync_meta` key prefix of a stream's genesis source seq (equal to the cut). */
export const GENESIS_SOURCE_SEQ_KEY_PREFIX = 'genesis_source_seq:';

/** `_sync_meta` key prefix set at the cut and cleared once the genesis checkpoint is stored. */
export const GENESIS_PENDING_KEY_PREFIX = 'genesis_pending:';

/** `_sync_meta` key prefix: the highest `local_seq` a stream's cut folded (so a raced cut can be undone). */
export const GENESIS_FOLDED_UPTO_KEY_PREFIX = 'genesis_folded_upto:';

/** `_sync_meta` key prefix: the lowest `local_seq` a stream's cut folded (its range, never another cut's). */
export const GENESIS_FOLDED_FROM_KEY_PREFIX = 'genesis_folded_from:';

/** `_sync_meta` key the capture triggers' undo `WHEN` checks (§3.5 Rule 2). */
export const UNDO_ENABLED_KEY = 'undo_enabled';

/** How many times the cut re-drains when writes arrive between the drain and the cut. */
const CUT_ATTEMPTS = 3;

/** Options for {@link cutGenesis}. */
export interface GenesisCutOptions {
  readonly scope: TableScope;
  /** The stream whose pushed history starts here (`project:<id>` or `home:<userId>`). */
  readonly stream: string;
  /** Wall clock in ms (the genesis HLC of baselined rows). @defaultValue Date.now */
  readonly now?: () => number;
  /** Environment for the sync kill switches. @defaultValue process.env */
  readonly env?: NodeJS.ProcessEnv;
  /** Enable the unreleased `sync.seal` / `sync.push` (tests only). Never set from user input. */
  readonly allowUnreleased?: boolean;
}

/** What {@link cutGenesis} did. */
export interface GenesisCutReport {
  readonly stream: string;
  /** Why nothing was cut, or null. */
  readonly refused: string | null;
  /** The stream was already cut: nothing changed. */
  readonly already: boolean;
  /** `genesis_cut` (= `genesis_source_seq`): the highest capture seq the checkpoint carries. */
  readonly cut: number | null;
  /** Transactions the pre-cut drain sealed. */
  readonly sealed: number;
  /** Sealed, unsegmented transactions folded into genesis. */
  readonly folded: number;
  /** Rows given genesis row meta, per table (tables with none are absent). */
  readonly baselined: Readonly<Record<string, number>>;
  /**
   * A cut committed by an earlier run that never finished its snapshot (it
   * crashed) was snapshotted now, at that same cut (T13301).
   */
  readonly resumed: boolean;
}

const report = (stream: string, fields: Partial<GenesisCutReport>): GenesisCutReport => ({
  stream,
  refused: null,
  already: false,
  resumed: false,
  cut: null,
  sealed: 0,
  folded: 0,
  baselined: {},
  ...fields,
});

const metaValue = (db: DatabaseSync, key: string): string | undefined =>
  (
    db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;

/**
 * A stream's genesis cut, or undefined before it. Read-only.
 *
 * @param db - The store.
 * @param stream - The stream.
 */
export function genesisCutOf(db: DatabaseSync, stream: string): number | undefined {
  if (!hasTable(db, '_sync_meta')) return undefined;
  const v = metaValue(db, `${GENESIS_CUT_KEY_PREFIX}${stream}`);
  return v === undefined ? undefined : Number(v);
}

/**
 * Whether a stream is cut but its genesis checkpoint is not yet stored: the
 * push sends no segment until it is. Read-only.
 *
 * @param db - The store.
 * @param stream - The stream.
 */
export function genesisPending(db: DatabaseSync, stream: string): boolean {
  return (
    hasTable(db, '_sync_meta') &&
    metaValue(db, `${GENESIS_PENDING_KEY_PREFIX}${stream}`) !== undefined
  );
}

/** Minted sync-set rows the sealer cannot seal yet: no uid, or no birth_fp. */
function unidentifiedRows(db: DatabaseSync, scope: TableScope): Record<string, number> {
  const out: Record<string, number> = {};
  const sync = new Set(syncSetTables(scope));
  for (const spec of ROW_IDENTITY[scope]) {
    if (spec.kind !== 'minted' || !sync.has(spec.table) || !hasTable(db, spec.table)) continue;
    const cols = new Set(
      (db.prepare(`PRAGMA table_info("${spec.table}")`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!cols.has(UID_COLUMN)) continue;
    const missing = [`"${UID_COLUMN}" IS NULL`];
    if (cols.has(BIRTH_FP_COLUMN)) missing.push(`"${BIRTH_FP_COLUMN}" IS NULL`);
    const n = (
      db
        .prepare(`SELECT count(*) AS n FROM "${spec.table}" WHERE ${missing.join(' OR ')}`)
        .get() as { n: number }
    ).n;
    if (n > 0) out[spec.table] = n;
  }
  return out;
}

/**
 * Why the store cannot reach genesis, or null when it can (the step-0
 * preconditions of `cleo sync enable push`, T13032 AC2). Read-only.
 *
 * - the sync schema is installed, capture is on and its triggers match the
 *   current schema, and the owned guard triggers are sound;
 * - the sealer may run (`sync.seal` on, released or explicitly allowed);
 * - a replica is bound;
 * - identity follows the current recipe, and every minted row has its uid
 *   and birth_fp (otherwise the sealer leaves its groups pending);
 * - no table is suspect and no capture is quarantined (the repair diff
 *   runs first: genesis must not freeze drift into the checkpoint).
 *
 * @param db - The store.
 * @param opts - Scope, environment, and whether unreleased flags are allowed.
 */
export function genesisPreconditions(
  db: DatabaseSync,
  opts: Pick<GenesisCutOptions, 'scope' | 'env' | 'allowUnreleased'>,
): string | null {
  const env = opts.env ?? process.env;
  if (!hasTable(db, '_sync_capture') || !hasTable(db, '_sync_segment')) {
    return 'sync schema not installed';
  }
  if (!isSyncFlagOn(db, 'sync.capture', env)) return 'sync.capture is off';
  const drift = captureTriggerDrift(db, opts.scope);
  const drifted = [...drift.missing, ...drift.differing, ...drift.extra];
  if (drifted.length > 0) {
    return `capture triggers differ from the schema (${drifted.slice(0, 3).join(', ')}): run \`cleo doctor sync-triggers --repair\``;
  }
  if (hasTriggerSuspendTable(db)) {
    const owned = verifyOwnedTriggers(db).map((f) => `${f.name} (${f.problem})`);
    if (owned.length > 0) return `owned triggers are unsound: ${owned.slice(0, 3).join(', ')}`;
  }
  const seal = sealPreconditions(db, env, opts.allowUnreleased === true);
  if (seal) return seal;
  if (!activeReplica(db, opts.scope)) return 'no bound replica';
  if (!rowIdentityRecipeCurrent(db, opts.scope)) {
    return 'row identity does not follow the current recipe: run the identity fill first';
  }
  const unidentified = Object.entries(unidentifiedRows(db, opts.scope));
  if (unidentified.length > 0) {
    return `rows without uid or birth_fp (${unidentified
      .slice(0, 3)
      .map(([t, n]) => `${t}: ${n}`)
      .join(', ')}): run the identity fill first`;
  }
  const suspect = db
    .prepare("SELECT substr(key, 9) AS t FROM _sync_meta WHERE key LIKE 'suspect:%' LIMIT 3")
    .all() as Array<{ t: string }>;
  if (suspect.length > 0) {
    return `suspect tables (${suspect.map((r) => r.t).join(', ')}): run \`cleo doctor sync-journal --repair\` first`;
  }
  if (
    hasTable(db, '_sync_quarantine') &&
    db.prepare('SELECT 1 FROM _sync_quarantine LIMIT 1').get() !== undefined
  ) {
    return 'quarantined captures: run `cleo doctor sync-journal --repair` first';
  }
  return null;
}

/** Seal until no capture is live; the reason it stopped early, or null. */
function drain(
  db: DatabaseSync,
  opts: GenesisCutOptions,
  replica: string,
): { sealed: number; refused: string | null } {
  let sealed = 0;
  for (;;) {
    const r = sealPending(db, {
      scope: opts.scope,
      replica,
      ...(opts.now ? { now: opts.now } : {}),
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.allowUnreleased ? { allowUnreleased: true } : {}),
    });
    if (r.refused) return { sealed, refused: r.refused };
    sealed += r.txns;
    if (r.pending.length > 0) {
      return {
        sealed,
        refused: `captures cannot seal yet (${r.pending[0]?.reason ?? 'pending'}): run the identity fill first`,
      };
    }
    if (r.quarantined.length > 0) {
      return {
        sealed,
        refused: 'captures were quarantined: run `cleo doctor sync-journal --repair` first',
      };
    }
    if (r.captures === 0) return { sealed, refused: null };
  }
}

/** Write one `_sync_meta` value. */
function setMeta(db: DatabaseSync, key: string, value: string, atIso: string): void {
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(key, value, atIso);
}

/** A cut held open: the write lock is taken, the cut position is fixed, nothing is written yet. */
interface OpenCut {
  readonly cut: number;
  readonly at: number;
  readonly replica: string;
  readonly sealed: number;
}

/**
 * The first half of a cut: preconditions, drain, `BEGIN IMMEDIATE`, and the
 * cut position. Returns the open cut with the transaction held, or a final
 * report (refused, or already cut) with no transaction open.
 */
function openCut(db: DatabaseSync, opts: GenesisCutOptions): OpenCut | GenesisCutReport {
  if (db.isTransaction) {
    // @sync-invariant none:local-only programming-error guard: the cut seals, then opens its own transaction
    throw new Error('cutGenesis must run outside a transaction (no frame open)');
  }
  const already = genesisCutOf(db, opts.stream);
  if (already !== undefined) return report(opts.stream, { already: true, cut: already });
  const refused = genesisPreconditions(db, opts);
  if (refused) return report(opts.stream, { refused });
  const replica = activeReplica(db, opts.scope)?.replicaId;
  if (!replica) return report(opts.stream, { refused: 'no bound replica' });
  const now = opts.now ?? Date.now;
  let sealed = 0;
  for (let attempt = 0; attempt < CUT_ATTEMPTS; attempt++) {
    const d = drain(db, opts, replica);
    sealed += d.sealed;
    if (d.refused) return report(opts.stream, { refused: d.refused, sealed });
    db.exec('BEGIN IMMEDIATE');
    try {
      // A write committed between the drain and this lock: drain it too.
      if (db.prepare("SELECT 1 FROM _sync_capture WHERE state = 'live' LIMIT 1").get()) {
        db.exec('ROLLBACK');
        continue;
      }
      const raced = genesisCutOf(db, opts.stream);
      if (raced !== undefined) {
        db.exec('ROLLBACK');
        return report(opts.stream, { already: true, cut: raced, sealed });
      }
      const cut = Number(
        (
          db.prepare("SELECT seq FROM sqlite_sequence WHERE name = '_sync_capture'").get() as
            | { seq: number }
            | undefined
        )?.seq ?? 0,
      );
      return { cut, at: now(), replica, sealed };
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return report(opts.stream, {
    refused: 'writes kept arriving during the genesis cut: run it again',
    sealed,
  });
}

/** The second half of a cut, in the transaction {@link openCut} holds: write it, then COMMIT. */
function closeCut(db: DatabaseSync, opts: GenesisCutOptions, o: OpenCut): GenesisCutReport {
  const atIso = new Date(o.at).toISOString();
  // Row meta for every row the sealer never journaled, before the stream
  // starts (after it, a meta-less row is journaled as an I, T13217).
  const baselined: Record<string, number> = {};
  for (const table of syncSetTables(opts.scope)) {
    const n = baselineRowMeta(db, opts.scope, table, o.replica, o.at);
    if (n) baselined[table] = n;
  }
  const range = db
    .prepare(
      "SELECT min(local_seq) AS lo, max(local_seq) AS hi FROM _sync_txn WHERE state = 'sealed'",
    )
    .get() as { lo: number | null; hi: number | null };
  // An empty fold records an empty range (from > upto).
  const upto = Number(range.hi ?? 0);
  const from = Number(range.lo ?? upto + 1);
  const folded = db
    .prepare("UPDATE _sync_txn SET state = 'folded' WHERE state = 'sealed'")
    .run().changes;
  setMeta(db, `${GENESIS_FOLDED_FROM_KEY_PREFIX}${opts.stream}`, String(from), atIso);
  setMeta(db, `${GENESIS_FOLDED_UPTO_KEY_PREFIX}${opts.stream}`, String(upto), atIso);
  setMeta(db, `${GENESIS_CUT_KEY_PREFIX}${opts.stream}`, String(o.cut), atIso);
  setMeta(db, `${GENESIS_SOURCE_SEQ_KEY_PREFIX}${opts.stream}`, String(o.cut), atIso);
  setMeta(db, `${GENESIS_PENDING_KEY_PREFIX}${opts.stream}`, String(o.cut), atIso);
  setMeta(db, UNDO_ENABLED_KEY, '1', atIso);
  raiseMinWriterVersion(db);
  setSyncFlag(db, 'sync.push', true, {
    now: new Date(o.at),
    ...(opts.allowUnreleased ? { allowUnreleased: true } : {}),
  });
  db.exec('COMMIT');
  return report(opts.stream, { cut: o.cut, sealed: o.sealed, folded: Number(folded), baselined });
}

/**
 * Record a stream's genesis cut and turn push on (§2.11 §10; module docs).
 * Must run outside a transaction (it seals, then opens its own
 * `BEGIN IMMEDIATE`). A refusal changes nothing beyond the drain's seals.
 *
 * @param db - The store.
 * @param opts - {@link GenesisCutOptions}.
 * @returns What was cut, or why not.
 */
export function cutGenesis(db: DatabaseSync, opts: GenesisCutOptions): GenesisCutReport {
  const open = openCut(db, opts);
  if (!('replica' in open)) return open;
  try {
    return closeCut(db, opts, open);
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** A write reached the store between the cut and the end of its snapshot; the cut was undone. */
export class GenesisRacedError extends Error {
  readonly code = 'E_SYNC_GENESIS_RACED';
}

/**
 * Undo a committed cut whose genesis checkpoint was never pushed (its
 * snapshot failed, or a write raced it), in one `BEGIN IMMEDIATE`: drop the
 * stream's genesis keys, turn push off, return the transactions it folded to
 * `sealed`, and, when no other stream is cut, turn undo off and drop the undo
 * written since. Row meta it baselined stays: before the stream starts that
 * is what the repair diff would write anyway (T13217).
 */
function uncutGenesis(db: DatabaseSync, opts: GenesisCutOptions): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    // Only this cut's fold: another stream's earlier cut keeps its own (LOW-1 on #1953).
    const upto = Number(metaValue(db, `${GENESIS_FOLDED_UPTO_KEY_PREFIX}${opts.stream}`) ?? 0);
    const from = Number(
      metaValue(db, `${GENESIS_FOLDED_FROM_KEY_PREFIX}${opts.stream}`) ?? upto + 1,
    );
    db.prepare(
      "UPDATE _sync_txn SET state = 'sealed' WHERE state = 'folded' AND local_seq BETWEEN ? AND ?",
    ).run(from, upto);
    const del = db.prepare('DELETE FROM _sync_meta WHERE key = ?');
    for (const prefix of [
      GENESIS_CUT_KEY_PREFIX,
      GENESIS_SOURCE_SEQ_KEY_PREFIX,
      GENESIS_PENDING_KEY_PREFIX,
      GENESIS_FOLDED_UPTO_KEY_PREFIX,
      GENESIS_FOLDED_FROM_KEY_PREFIX,
    ]) {
      del.run(`${prefix}${opts.stream}`);
    }
    if (!db.prepare(`SELECT 1 FROM _sync_meta WHERE key LIKE '${GENESIS_CUT_KEY_PREFIX}%'`).get()) {
      del.run(UNDO_ENABLED_KEY);
      db.exec('DELETE FROM _sync_undo');
      if (hasTable(db, '_sync_row_undo')) db.exec('DELETE FROM _sync_row_undo');
      setSyncFlag(db, 'sync.push', false);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * {@link cutGenesis}, then the genesis checkpoint's bundle snapshotted at
 * the committed cut (§2.11 §10; T13296). The cut commits FIRST, so the
 * bundle carries everything it wrote: genesis row meta, the genesis keys,
 * `undo_enabled`, `sync.push` and the folded transactions. A device restored
 * from it therefore has full row meta and never pushes a folded transaction.
 *
 * Nothing may write between the cut and the end of the snapshot. For the
 * whole run the store carries a `genesis` marker ({@link writeRestoreMarker}):
 * other processes wait at their store open, and every writer, in this
 * process too, waits at the write chokepoint (`assertExodusWriteSafe`: the
 * task accessor's write transactions, session creation, `insertIdempotent`,
 * `upsertIdempotent`) and refuses with `E_STORE_GENESIS` if the snapshot
 * outlasts its wait (T13297). The snapshot itself writes nothing. A writer
 * that bypasses the chokepoint is caught after the snapshot (the capture
 * position moved past the cut): the cut is undone and
 * {@link GenesisRacedError} is thrown, so no bundle holding a post-cut write
 * is ever pushed. A failing snapshot undoes the cut too. The marker is always
 * released.
 *
 * A cut that an earlier run committed but never snapshotted (a crash, kill
 * or sleep mid-export; `genesis_pending` still set) is resumed (T13301): with
 * no capture since, the snapshot runs at that cut (`resumed`); otherwise the
 * stale cut is undone and the store is cut again. A stored cut
 * (`genesis_pending` cleared) is `already`, and no snapshot runs.
 *
 * @param db - The store.
 * @param opts - {@link GenesisCutOptions}, plus the store file the marker guards.
 * @param snapshot - Export the store as the checkpoint bundle; receives the cut. Must not write.
 * @returns What was cut, or why not.
 * @throws {GenesisRacedError} When a write reached the store during the snapshot.
 */
export async function cutGenesisWithSnapshot(
  db: DatabaseSync,
  opts: GenesisCutOptions & { readonly dbPath: string },
  snapshot: (cut: number) => Promise<void>,
): Promise<GenesisCutReport> {
  const release = writeRestoreMarker(opts.dbPath, 'genesis');
  try {
    let r: GenesisCutReport;
    const crashed = genesisPending(db, opts.stream) ? genesisCutOf(db, opts.stream) : undefined;
    if (crashed !== undefined && capturePosition(db) === crashed) {
      // T13301: an earlier run committed this cut and died before its
      // snapshot finished; nothing was captured since, so the store is still
      // exactly the cut. Snapshot it now.
      r = report(opts.stream, { cut: crashed, resumed: true });
    } else {
      // Written to since that crash: the cut no longer describes the store.
      // Undo it and cut again.
      if (crashed !== undefined) uncutGenesis(db, opts);
      r = cutGenesis(db, opts);
      if (r.refused !== null || r.already || r.cut === null) return r;
    }
    const cut = r.cut;
    if (cut === null) return r;
    try {
      await snapshot(cut);
    } catch (err) {
      uncutGenesis(db, opts);
      throw err;
    }
    if (capturePosition(db) > cut) {
      uncutGenesis(db, opts);
      // @sync-invariant none:local-only a local write raced the genesis snapshot; the cut is undone and nothing is pushed
      throw new GenesisRacedError(
        'E_SYNC_GENESIS_RACED: a write reached the store during the genesis snapshot; the cut was undone, run it again',
      );
    }
    return r;
  } finally {
    release();
  }
}

/**
 * Finish a stream's genesis once its checkpoint is stored (S4-1b), in one
 * `BEGIN IMMEDIATE`: raise the persisted replicaSeq high-water mark to the
 * replica's last segment on the stream (the vault's delta segments spend this
 * replica's seqs, so the first journal segment follows them), then clear
 * `genesis_pending:<stream>`, which lets the push send segments.
 *
 * @param db - The store, outside a transaction.
 * @param o - Stream, replica, the replica's last replicaSeq on the stream (null: none yet) and the time.
 */
export function completeGenesis(
  db: DatabaseSync,
  o: {
    readonly stream: string;
    readonly replica: string;
    readonly replicaSeqFloor: number | null;
    readonly nowIso: string;
  },
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (o.replicaSeqFloor !== null) {
      persistStoreSeq(db, o.replica, o.stream, o.replicaSeqFloor, new Date(o.nowIso));
    }
    db.prepare('DELETE FROM _sync_meta WHERE key = ?').run(
      `${GENESIS_PENDING_KEY_PREFIX}${o.stream}`,
    );
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/**
 * A stream's genesis cut read from a store file with a read-only open, or
 * undefined (no cut, no store, or no journal): the vault reads it before a
 * push without binding or migrating anything.
 *
 * @param dbPath - The `cleo.db` file.
 * @param stream - The stream.
 */
export async function readGenesisCut(dbPath: string, stream: string): Promise<number | undefined> {
  if (!existsSync(dbPath)) return undefined;
  const { openNativeDatabase } = await import('../sqlite-native.js');
  const db = openNativeDatabase(dbPath, { readonly: true, enableWal: false });
  try {
    return genesisCutOf(db, stream);
  } finally {
    db.close();
  }
}
