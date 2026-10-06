/**
 * The repair diff (journal spec §4.4, §4.3 item 3; S3d, T12987).
 *
 * A table is `suspect:` when something may have written it uncaptured: a
 * bracketed rewriter (exodus, the lineage carry-forward, the identity fill),
 * a quarantined capture, or a migration pass over rows that were already out
 * of baseline. Later migrations skip every row of a suspect table when they
 * re-baseline `chash` (T13202), so this pass is the only place those rows are
 * checked again, and it re-checks EVERY row of the table, never only the
 * captured ones.
 *
 * For each suspect table it compares the live rows with `_sync_row_meta`:
 * - a live row whose meta `chash` differs: U, carrying the full after-image
 *   (the before-image is unknown; only its hash was kept);
 * - a live row with no meta, or with a tombstone: I;
 * - a live meta row with no live row (an orphan): D.
 *
 * Rows held by a rebase (`held = 1`, §3.5 Rule 5) are skipped, so a held
 * insert never produces a spurious D. The ops are written as captures of one
 * `repair` frame per table and sealed by the sealer (`via: 'repair'`), so row
 * meta, the ledger and `chash` have one writer.
 *
 * A table whose row meta was never baselined (no `baseline:<table>` key)
 * cannot tell a pre-sync row from an uncaptured insert: both lack meta. Such
 * rows are baselined instead (meta with the §1.2 genesis HLC, no op) and the
 * ledger is set to the verified count; nothing is pushed before the genesis
 * checkpoint, which carries them. From then on a row without meta is an
 * uncaptured insert. Once the stream has started ({@link streamStarted}) a
 * row without meta is journaled as an I in every table, baselined or not,
 * and the table is then marked baselined (T13217): never absorbed silently.
 *
 * The suspect key is cleared only after verification: no live capture of the
 * table remains, a rescan finds nothing to repair, and the ledger equals
 * `count(*) + held`. A key re-marked while the repair ran is kept.
 *
 * @task T12987
 * @module store/sync/repair
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import { rowIdentitySpec, UID_COLUMN } from '../row-identity-registry.js';
import { AT_MS_SQL, type CaptureTableDef, captureTableDef, repairImageSql } from './capture.js';
import { withImmediateTransaction } from './clock-store.js';
import { encodeHlc, MAX_PHYS } from './hlc.js';
import { activeReplica } from './replica.js';
import { upsertRowMeta } from './row-meta.js';
import { hasTable } from './schema.js';
import { type SealerRowView, sealerRowView, sealPending, sealPreconditions } from './sealer.js';
import { decodeEnc, type WireValue } from './sealer-values.js';
import { suspectTables } from './structural.js';
import { canonicalStoreTimestamp, timestampColumns } from './timestamps.js';
import { CAPTURE_TRIGGER_PREFIX } from './trigger-classes.js';

/** `_sync_meta` key prefix of a table whose row meta covers every live row. */
export const BASELINE_KEY_PREFIX = 'baseline:';

/** How many uids a report lists per kind (the counts are always complete). */
export const REPAIR_SAMPLE_SIZE = 20;

/** A live row: its uid and its local key `rk` (as the capture triggers write it). */
export interface RepairRow {
  readonly uid: string;
  readonly rk: string;
}

/** The repair diff of one suspect table. */
export interface RepairPlan {
  readonly table: string;
  /** Row meta covers every live row, so a row without meta is an uncaptured insert. */
  readonly baselined: boolean;
  /** Live rows to emit as I. */
  readonly inserts: readonly RepairRow[];
  /** Live rows whose `chash` differs: U. */
  readonly updates: readonly RepairRow[];
  /** Live meta rows without a live row: D. */
  readonly deletes: readonly string[];
  /** Live rows without meta in a table never baselined: baselined, no op. */
  readonly unbaselined: readonly RepairRow[];
  /** Rows a rebase holds (skipped). */
  readonly held: number;
  /** Live rows with no uid: the identity fill must run first. */
  readonly unidentified: number;
  /** Why the table was not diffed, or null. */
  readonly skipped: string | null;
}

/** What the repair did to one table. */
export interface RepairTableResult {
  readonly table: string;
  readonly baselined: boolean;
  readonly counts: {
    readonly inserts: number;
    readonly updates: number;
    readonly deletes: number;
    readonly baselinedRows: number;
    readonly held: number;
    readonly unidentified: number;
  };
  /** Up to {@link REPAIR_SAMPLE_SIZE} uids per kind. */
  readonly sample: {
    readonly inserts: readonly string[];
    readonly updates: readonly string[];
    readonly deletes: readonly string[];
  };
  /** The repair frame written, or null (dry run, nothing to emit, skipped). */
  readonly frame: string | null;
  /** The suspect key was cleared. */
  readonly cleared: boolean;
  /** Why the table stays suspect, or null. */
  readonly reason: string | null;
}

/** What {@link repairSuspectTables} did. */
export interface RepairReport {
  /** Why nothing ran, or null. */
  readonly refused: string | null;
  readonly dryRun: boolean;
  readonly tables: readonly RepairTableResult[];
  /** Transactions and ops the sealer wrote while sealing pending and repair captures. */
  readonly sealed: { readonly txns: number; readonly ops: number };
}

/** Options of {@link repairSuspectTables}. */
export interface RepairOptions {
  readonly scope: TableScope;
  /** Plan only: write nothing, seal nothing, clear nothing. */
  readonly dryRun?: boolean;
  /** Restrict to these suspect tables (default: every suspect table). */
  readonly tables?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** The replica to seal as (default: the store's bound replica). */
  readonly replica?: string;
  /** Seal while `sync.seal` is unreleased (tests and Gate B only). */
  readonly allowUnreleased?: boolean;
  readonly now?: () => number;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

const empty = (refused: string | null, dryRun: boolean): RepairReport => ({
  refused,
  dryRun,
  tables: [],
  sealed: { txns: 0, ops: 0 },
});

/** The live captures of `table` still waiting to seal. */
function waiting(db: DatabaseSync, table: string): number {
  return (
    db
      .prepare("SELECT count(*) AS n FROM _sync_capture WHERE state = 'live' AND tbl = ?")
      .get(table) as { n: number }
  ).n;
}

function metaValue(db: DatabaseSync, key: string): string | undefined {
  return (
    db.prepare('SELECT value FROM _sync_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
  )?.value;
}

function captureTriggersPresent(db: DatabaseSync, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(`${CAPTURE_TRIGGER_PREFIX}${table}_i`) !== undefined
  );
}

/**
 * Whether this store's stream has started (T13217): a genesis cut was
 * recorded (`genesis_cut*` in `_sync_meta`, §2.11 §10), a sealed transaction
 * was carried by a segment (`state = 'segmented'`), or undo is on (it turns
 * on with the genesis cut, C1). After that, a checkpoint may already have
 * left the device, so a row without meta can no longer be assumed to be in
 * it.
 */
export function streamStarted(db: DatabaseSync): boolean {
  const meta = db
    .prepare(
      "SELECT 1 FROM _sync_meta WHERE key LIKE 'genesis_cut%' OR key = 'undo_enabled' LIMIT 1",
    )
    .get();
  if (meta !== undefined) return true;
  return (
    hasTable(db, '_sync_txn') &&
    db.prepare("SELECT 1 FROM _sync_txn WHERE state = 'segmented' LIMIT 1").get() !== undefined
  );
}

/**
 * Diff one table against its row meta, every row. Read-only.
 *
 * @param db - The store.
 * @param scope - Its scope.
 * @param table - A sync-set table.
 * @param view - From {@link sealerRowView}, shared across tables.
 */
export function planRepair(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
  view: SealerRowView = sealerRowView(db, scope),
): RepairPlan {
  const plan = (skipped: string | null, baselined = false): RepairPlan => ({
    table,
    baselined,
    inserts: [],
    updates: [],
    deletes: [],
    unbaselined: [],
    held: 0,
    unidentified: 0,
    skipped,
  });
  if (!hasTable(db, table)) return plan('table does not exist');
  const def = captureTableDef(db, scope, table);
  if (!def) return plan('not in the sync set');
  if (!def.identity.includes(UID_COLUMN)) return plan('table has no uid column');
  if (!captureTriggersPresent(db, table)) {
    return plan('capture triggers missing: run cleo doctor sync-triggers --repair first');
  }
  if (waiting(db, table) > 0) return plan('captures still waiting to seal');
  const baselined = metaValue(db, `${BASELINE_KEY_PREFIX}${table}`) !== undefined;
  // Once the stream has started, no row may be absorbed silently: a row
  // without meta is journaled as an I even in a table never baselined
  // (T13217). Only before genesis is it baselined without an op.
  const journalMissing = baselined || streamStarted(db);

  const meta = new Map<string, { chash: string | null; deleted: number; held: number }>();
  for (const m of db
    .prepare('SELECT uid, chash, deleted, held FROM _sync_row_meta WHERE tbl = ?')
    .all(table) as Array<{ uid: string; chash: string | null; deleted: number; held: number }>) {
    meta.set(m.uid, { chash: m.chash, deleted: m.deleted, held: m.held });
  }
  const inserts: RepairRow[] = [];
  const updates: RepairRow[] = [];
  const unbaselined: RepairRow[] = [];
  let held = 0;
  let unidentified = 0;
  const live = new Set<string>();
  const rows = db
    .prepare(
      `SELECT x.${q(UID_COLUMN)} AS uid, ${repairImageSql(def, 'x').rk} AS rk FROM ${q(table)} x`,
    )
    .iterate() as Iterable<{ uid: string | null; rk: string }>;
  for (const r of rows) {
    // A natural row's uid is a function of its key, as the sealer reads it.
    const uid = r.uid ?? view.naturalUid(def, r.rk);
    if (uid === null) {
      unidentified += 1;
      continue;
    }
    live.add(uid);
    const row = { uid, rk: r.rk };
    const m = meta.get(uid);
    if (!m) (journalMissing ? inserts : unbaselined).push(row);
    else if (m.held === 1) held += 1;
    else if (m.deleted === 1) inserts.push(row);
    else if (view.chash(def, uid) !== m.chash) updates.push(row);
  }
  const deletes: string[] = [];
  for (const [uid, m] of meta) {
    if (live.has(uid) || m.deleted === 1) continue;
    if (m.held === 1) held += 1;
    else deletes.push(uid);
  }
  return {
    table,
    baselined,
    inserts,
    updates,
    deletes,
    unbaselined,
    held,
    unidentified,
    skipped: null,
  };
}

/** `x`'s local key matches the bound key values ({@link keyValues}). */
function keyWhere(def: CaptureTableDef): string {
  return def.key.map((k) => `x.${q(k)} IS ?`).join(' AND ');
}

/** A bindable SQLite value for a decoded key part. */
function bindable(v: WireValue): string | number | bigint | Uint8Array | null {
  if (v === null || typeof v === 'string' || typeof v === 'number') return v;
  if ('$i' in v) return BigInt(v.$i);
  if ('$r' in v) return Number(v.$r);
  return Buffer.from(v.$b, 'base64');
}

/** The key values a row's `rk` encodes, in key-column order. */
function keyValues(rk: string): Array<string | number | bigint | Uint8Array | null> {
  return (JSON.parse(rk) as string[]).map((p) => bindable(decodeEnc(p)));
}

/**
 * Write a plan's ops as the captures of one `repair` frame. Runs in the
 * caller's transaction.
 *
 * @returns The frame, or null when the plan emits nothing.
 */
function writeRepairFrame(db: DatabaseSync, def: CaptureTableDef, plan: RepairPlan): string | null {
  if (plan.inserts.length + plan.updates.length + plan.deletes.length === 0) return null;
  const frame = randomUUID();
  const first = (
    db.prepare('SELECT coalesce(max(seq), 0) + 1 AS n FROM main._sync_capture').get() as {
      n: number;
    }
  ).n;
  db.prepare('INSERT INTO _sync_frame (frame, kind, actor, first_seq) VALUES (?, ?, ?, ?)').run(
    frame,
    'repair',
    null,
    first,
  );
  const img = repairImageSql(def, 'x');
  const fromLive = (op: 'I' | 'U', image: string) =>
    db.prepare(
      `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms, frame, kind) ` +
        `SELECT ?, '${op}', ?, ?, ${image}, ${AT_MS_SQL}, ?, 'repair' ` +
        `FROM ${q(def.table)} x WHERE ${keyWhere(def)}`,
    );
  const ins = fromLive('I', img.insert);
  const upd = fromLive('U', img.update);
  // An orphan has no live row, so no local key: its rk only has to be unique
  // per row, and its image is empty (the sealer reads a natural key from meta).
  const del = db.prepare(
    `INSERT INTO _sync_capture (tbl, op, rk, uid, img, at_ms, frame, kind) ` +
      `VALUES (?, 'D', ?, ?, '{}', ${AT_MS_SQL}, ?, 'repair')`,
  );
  // Undo only for a capture actually inserted: `last_insert_rowid` names it.
  const undo = repairUndo(db, def, frame);
  for (const r of plan.updates) {
    if (upd.run(def.table, r.rk, r.uid, frame, ...keyValues(r.rk)).changes === 1) undo('U');
  }
  for (const r of plan.inserts) {
    if (ins.run(def.table, r.rk, r.uid, frame, ...keyValues(r.rk)).changes === 1) undo('I');
  }
  for (const uid of plan.deletes) {
    del.run(def.table, JSON.stringify(['<orphan>', uid]), uid, frame);
    undo('D');
  }
  return frame;
}

/**
 * The `_sync_undo` writer for a repair frame's captures, a no-op while undo
 * is off (T13212; §3.5 Rule 2, D1: a repair keeps its undo until its echo).
 * Repair captures are inserted directly, not by the triggers, so they write
 * their undo themselves, for the capture just inserted (`last_insert_rowid`),
 * stamped with the frame so the transaction has a position (the own-echo
 * fast path and the foreign-touch pruning read it).
 *
 * What the repair knows of each row:
 * - I: the row now (`after_full` = its capture image);
 * - U: only the row now. The value before the uncaptured write is lost, so
 *   `before_full` is NULL: the flag a trigger-written U never carries;
 * - D: no live row, only what row meta knows (`before_full` = its key).
 * An append-only table keeps neither image, as its triggers do.
 *
 * A rewind restores merge state from `_sync_row_undo`, which the sealer
 * snapshots for every sealed op while undo is on, so the images here are
 * informational and count toward the undo budget.
 */
function repairUndo(
  db: DatabaseSync,
  def: CaptureTableDef,
  frame: string,
): (op: 'I' | 'U' | 'D') => void {
  if (metaValue(db, 'undo_enabled') === undefined) return () => {};
  const images = (op: 'I' | 'U' | 'D'): string => {
    if (def.appendOnly) return 'NULL, NULL';
    if (op === 'D') {
      return '(SELECT m.key_json FROM _sync_row_meta m WHERE m.tbl = c.tbl AND m.uid = c.uid), NULL';
    }
    return 'NULL, c.img';
  };
  const stmts = new Map(
    (['I', 'U', 'D'] as const).map((op) => [
      op,
      db.prepare(
        `INSERT INTO _sync_undo (seq, txn_local, kind, tbl, rk, uid, op, before_full, after_full) ` +
          `SELECT c.seq, ?, 'repair', c.tbl, c.rk, c.uid, c.op, ${images(op)} ` +
          `FROM _sync_capture c WHERE c.seq = last_insert_rowid()`,
      ),
    ]),
  );
  return (op) => {
    stmts.get(op)?.run(frame);
  };
}

/** The column a pre-sync row's genesis HLC is read from (§1.2), or null. */
function genesisColumn(scope: TableScope, table: string): string | null {
  const stamps = timestampColumns(scope, table);
  for (const c of ['updated_at', 'created_at', 'recorded_at', 'started_at']) {
    if (stamps.has(c)) return c;
  }
  return null;
}

/**
 * Baseline live rows that have no meta (§1.2 "genesis of an existing row"):
 * the row's modification column, else its birth column, clamped to
 * `[0, now]`, counter 0, this replica. No op is emitted.
 */
function baselineRows(
  db: DatabaseSync,
  scope: TableScope,
  def: CaptureTableDef,
  rows: readonly RepairRow[],
  replica: string,
  view: SealerRowView,
  now: number,
): void {
  const col = genesisColumn(scope, def.table);
  const natural = rowIdentitySpec(scope, def.table)?.kind !== 'minted';
  const read = db.prepare(
    `SELECT ${col ? `x.${q(col)}` : 'NULL'} AS at FROM ${q(def.table)} x WHERE ${keyWhere(def)}`,
  );
  for (const r of rows) {
    const row = read.get(...keyValues(r.rk)) as { at: string | number | null } | undefined;
    if (!row) continue;
    const canon = typeof row.at === 'string' ? canonicalStoreTimestamp(row.at) : null;
    const phys = canon ? Math.min(Math.max(Date.parse(canon), 0), now, MAX_PHYS) : 0;
    const uid = r.uid;
    upsertRowMeta(db, {
      tbl: def.table,
      uid,
      hlc: encodeHlc({ phys, ctr: 0, replica }),
      fhlc: null,
      origin: replica,
      actor: null,
      version: 0,
      deleted: false,
      keyJson: natural ? view.naturalKeyJson(def, r.rk) : null,
      chash: view.chash(def, uid),
      bfp: natural ? null : (view.liveBirthFp(def.table, uid) ?? null),
    });
  }
}

/** Set `table`'s sealed-row count in the ledger. */
function setLedger(db: DatabaseSync, table: string, live: number): void {
  db.prepare(
    'INSERT INTO _sync_ledger (tbl, live) VALUES (?, ?) ON CONFLICT (tbl) DO UPDATE SET live = excluded.live',
  ).run(table, live);
}

/**
 * Baseline `rows` and record it, in the caller's transaction: their meta,
 * the ledger set to `count(*) + held`, and `baseline:<table>` commit (or roll
 * back, or die with the process) together, so a crash mid-baseline leaves
 * nothing half-written and the next run starts over.
 */
function baselineTable(
  db: DatabaseSync,
  scope: TableScope,
  def: CaptureTableDef,
  rows: readonly RepairRow[],
  replica: string,
  view: SealerRowView,
  now: number,
): void {
  baselineRows(db, scope, def, rows, replica, view, now);
  const count = (db.prepare(`SELECT count(*) AS n FROM ${q(def.table)}`).get() as { n: number }).n;
  const held =
    (
      db.prepare('SELECT held FROM _sync_ledger WHERE tbl = ?').get(def.table) as
        | { held: number }
        | undefined
    )?.held ?? 0;
  setLedger(db, def.table, count + held);
  const at = new Date(now).toISOString();
  db.prepare(
    'INSERT INTO _sync_meta (key, value, updated_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  ).run(`${BASELINE_KEY_PREFIX}${def.table}`, at, at);
}

/**
 * Baseline one table's row meta (§1.2 "genesis of an existing row"; §1.6
 * "one live meta row per live sync-set row"): every live row with a uid and
 * no meta gets meta with its genesis HLC and no op, the ledger is set to
 * `count(*) + held`, and `baseline:<table>` is recorded, atomically. The
 * repair diff calls it for a table never baselined; T12342's first-enable
 * init is meant to call it for every sync-set table, so row meta keeps one
 * initializer.
 *
 * Runs in the caller's transaction when there is one, else in its own
 * `BEGIN IMMEDIATE`.
 *
 * @param db - The store.
 * @param scope - Its scope.
 * @param table - A sync-set table with a uid column.
 * @param replica - The replica the baseline meta names as origin.
 * @param now - Wall milliseconds (the genesis HLC is clamped to it).
 * @returns The rows baselined, or null when the table is not in the sync set.
 */
export function baselineRowMeta(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
  replica: string,
  now: number = Date.now(),
): number | null {
  const def = captureTableDef(db, scope, table);
  if (!def) return null;
  if (!def.identity.includes(UID_COLUMN)) return null;
  const run = <T>(fn: () => T): T => (db.isTransaction ? fn() : withImmediateTransaction(db, fn));
  return run(() => {
    const view = sealerRowView(db, scope);
    const known = new Set(
      (
        db.prepare('SELECT uid FROM _sync_row_meta WHERE tbl = ?').all(table) as Array<{
          uid: string;
        }>
      ).map((r) => r.uid),
    );
    const rows: RepairRow[] = [];
    for (const r of db
      .prepare(
        `SELECT x.${q(UID_COLUMN)} AS uid, ${repairImageSql(def, 'x').rk} AS rk FROM ${q(table)} x`,
      )
      .iterate() as Iterable<{ uid: string | null; rk: string }>) {
      const uid = r.uid ?? view.naturalUid(def, r.rk);
      if (uid !== null && !known.has(uid)) rows.push({ uid, rk: r.rk });
    }
    baselineTable(db, scope, def, rows, replica, view, now);
    return rows.length;
  });
}

function resultOf(
  plan: RepairPlan,
  frame: string | null,
  cleared: boolean,
  reason: string | null,
): RepairTableResult {
  return {
    table: plan.table,
    baselined: plan.baselined,
    counts: {
      inserts: plan.inserts.length,
      updates: plan.updates.length,
      deletes: plan.deletes.length,
      baselinedRows: plan.unbaselined.length,
      held: plan.held,
      unidentified: plan.unidentified,
    },
    sample: {
      inserts: plan.inserts.slice(0, REPAIR_SAMPLE_SIZE).map((r) => r.uid),
      updates: plan.updates.slice(0, REPAIR_SAMPLE_SIZE).map((r) => r.uid),
      deletes: plan.deletes.slice(0, REPAIR_SAMPLE_SIZE),
    },
    frame,
    cleared,
    reason,
  };
}

/**
 * Verify a repaired table and clear its suspect key (§4.4 verification). Runs
 * in its own `BEGIN IMMEDIATE`.
 *
 * @returns Why the table stays suspect, or null when the key was cleared.
 */
function verifyAndClear(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
  mark: string,
  replica: string,
  now: number,
): string | null {
  return withImmediateTransaction(db, () => {
    const def = captureTableDef(db, scope, table);
    if (!def) return 'left the sync set during the repair';
    if (waiting(db, table) > 0) return 'writes arrived during the repair: run it again';
    const view = sealerRowView(db, scope);
    const plan = planRepair(db, scope, table, view);
    if (plan.skipped) return plan.skipped;
    if (plan.unidentified > 0) {
      return `${plan.unidentified} row(s) without uid: run the identity fill first`;
    }
    const left = plan.inserts.length + plan.updates.length + plan.deletes.length;
    if (left > 0) return `the rescan still finds ${left} row(s) to repair`;
    const count = (db.prepare(`SELECT count(*) AS n FROM ${q(table)}`).get() as { n: number }).n;
    const ledger = db.prepare('SELECT live, held FROM _sync_ledger WHERE tbl = ?').get(table) as
      | { live: number; held: number }
      | undefined;
    if (!plan.baselined) {
      baselineTable(db, scope, def, plan.unbaselined, replica, view, now);
    } else if (!ledger) {
      setLedger(db, table, count);
    } else if (ledger.live !== count + ledger.held) {
      return `ledger ${ledger.live} differs from count ${count} + held ${ledger.held}`;
    }
    // A key re-marked while the repair ran carries a newer value: keep it.
    const gone = db
      .prepare('DELETE FROM _sync_meta WHERE key = ? AND value = ?')
      .run(`suspect:${table}`, mark);
    return gone.changes === 1 ? null : 'marked suspect again during the repair: run it again';
  });
}

/**
 * Run the repair diff over every suspect table (§4.4; S3d, T12987): seal what
 * is pending, emit each table's repair ops in a `repair` frame, seal them,
 * then verify and clear the suspect key. A dry run only plans.
 *
 * Prerequisites (§4.4): the sealer's preconditions hold, a replica is bound,
 * the table's capture triggers are present, and no capture of the table is
 * left waiting after the pending seal. While undo is on, repair captures
 * write their own undo ({@link repairUndo}, T13212).
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - {@link RepairOptions}.
 */
export function repairSuspectTables(db: DatabaseSync, opts: RepairOptions): RepairReport {
  const dryRun = opts.dryRun === true;
  const env = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  if (!hasTable(db, '_sync_row_meta') || !hasTable(db, '_sync_meta')) {
    return empty('sync schema not installed', dryRun);
  }
  const wanted = opts.tables ? new Set(opts.tables) : null;
  const suspect = suspectTables(db).filter((t) => wanted === null || wanted.has(t));
  if (suspect.length === 0) return empty(null, dryRun);
  if (dryRun) {
    const view = sealerRowView(db, opts.scope);
    return {
      refused: null,
      dryRun,
      tables: suspect.map((t) => {
        const plan = planRepair(db, opts.scope, t, view);
        return resultOf(plan, null, false, plan.skipped ?? 'dry run');
      }),
      sealed: { txns: 0, ops: 0 },
    };
  }
  const refused = sealPreconditions(db, env, opts.allowUnreleased === true);
  if (refused) return empty(refused, dryRun);
  const replica = opts.replica ?? activeReplica(db, opts.scope)?.replicaId;
  if (!replica) return empty('no bound replica', dryRun);

  const sealed = { txns: 0, ops: 0 };
  const sealAll = (): void => {
    for (;;) {
      const r = sealPending(db, {
        scope: opts.scope,
        replica,
        env,
        allowUnreleased: opts.allowUnreleased === true,
        now,
      });
      sealed.txns += r.txns;
      sealed.ops += r.ops;
      if (r.refused !== null || r.captures === 0 || r.pending.length > 0) return;
    }
  };
  // §4.4 prerequisite: sealing idle. Captured writes seal first (NEW-8).
  sealAll();

  const results: RepairTableResult[] = [];
  const written: Array<{ plan: RepairPlan; frame: string | null; mark: string }> = [];
  for (const table of suspect) {
    const out = withImmediateTransaction(db, () => {
      const mark = metaValue(db, `suspect:${table}`);
      const plan = planRepair(db, opts.scope, table);
      if (mark === undefined || plan.skipped !== null) return { plan, frame: null, mark };
      const def = captureTableDef(db, opts.scope, table);
      return { plan, frame: def ? writeRepairFrame(db, def, plan) : null, mark };
    });
    if (out.mark === undefined) continue; // cleared by someone else meanwhile
    if (out.plan.skipped !== null) {
      results.push(resultOf(out.plan, null, false, out.plan.skipped));
      continue;
    }
    written.push({ plan: out.plan, frame: out.frame, mark: out.mark });
  }
  sealAll();
  for (const w of written) {
    const reason = verifyAndClear(db, opts.scope, w.plan.table, w.mark, replica, now());
    results.push(resultOf(w.plan, w.frame, reason === null, reason));
  }
  return { refused: null, dryRun, tables: results, sealed };
}
