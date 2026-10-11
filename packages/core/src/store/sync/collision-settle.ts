/**
 * The origin settles a uid collision it lost (T13397; T12341 §6.4 "Re-key",
 * §9.2 origin rule).
 *
 * Apply holds an incoming row whose uid a local row holds with another birth
 * fingerprint (T13394) and records a `uid-collision` conflict naming the
 * loser, the greater fingerprint. When the local row is the loser and this
 * replica authored it, this replica is the authority that re-keys it: the row
 * gets a fresh uid in a local `rekey` frame, so the capture triggers journal
 * the K (and the cascade's K ops) and the next push publishes it. The held
 * winner then places under the freed uid on the next pass, and every receiver
 * holding the loser follows the K through its alias (store/sync/uid-alias).
 *
 * A loser this replica only received (its origin is elsewhere) is never
 * re-keyed here: it waits for its origin's K, which moves it like any re-key.
 *
 * @module store/sync/collision-settle
 * @task T13397
 * @task T13405
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import type { LedgerOp } from '@cleocode/contracts/ledger';
import { recordDisplayIdAlias, rekeyRowUid, taskReferenceColumns } from '../display-id-alias.js';
import { mintRowUid } from '../row-identity.js';
import { BIRTH_FP_COLUMN, rowIdentitySpec, UID_COLUMN } from '../row-identity-registry.js';
import {
  advanceTaskIdSequence,
  renameBrainDisplayKeyNative,
  renameTaskDisplayIdNative,
  repointDecisionReferencesNative,
  rewriteTaskIdReferencesNative,
  setRowUidNative,
} from '../sqlite-data-accessor.js';
import {
  type CaptureTableDef,
  captureRekeyAnnouncement,
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
} from './capture.js';
import { type StagedTxn, stagedTxns } from './inbox.js';
import { hasTable } from './schema.js';
import { markAliasAnnounced, owedAnnouncements } from './uid-alias.js';

/** What {@link settleLostUidCollisions} needs. */
export interface SettleOptions {
  readonly scope: TableScope;
  readonly stream: string;
  /** This replica's id. */
  readonly replica: string;
}

/** One re-key this replica made as the loser's origin. */
export interface SettledCollision {
  readonly table: string;
  readonly oldUid: string;
  readonly newUid: string;
  /** The loser's birth fingerprint (it keeps it). */
  readonly birthFp: string;
}

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** The incoming (winner) fingerprint of each open lost collision, by row. */
function lostCollisions(
  db: DatabaseSync,
  stream: string,
): Map<string, { table: string; uid: string; incomingFp: string }> {
  const open = db
    .prepare(
      `SELECT seq, txn_idx AS txnIdx, op_idx AS opIdx, tbl, uid FROM _sync_conflict
        WHERE stream = ? AND kind = 'uid-collision' AND rule = 'loser:local' AND resolved_at IS NULL`,
    )
    .all(stream) as Array<{ seq: number; txnIdx: number; opIdx: number; tbl: string; uid: string }>;
  const out = new Map<string, { table: string; uid: string; incomingFp: string }>();
  if (open.length === 0) return out;
  const staged = stagedTxns(db, stream);
  for (const c of open) {
    const st = staged.find((s) => s.key.seq === c.seq && s.key.txnIdx === c.txnIdx);
    const op = st?.txn.ops[c.opIdx];
    if (op?.bfp)
      out.set(`${c.tbl}\u0000${c.uid}`, { table: c.tbl, uid: c.uid, incomingFp: op.bfp });
  }
  return out;
}

/**
 * Whether this replica sealed the insert of the row (table, uid,
 * fingerprint). `_sync_authored` keeps it after the transaction's ops are
 * folded or collected (T13399); a store without it falls back to the ops.
 */
function authoredHere(
  db: DatabaseSync,
  table: string,
  uid: string,
  fp: string,
  replica: string,
): boolean {
  if (
    hasTable(db, '_sync_authored') &&
    db
      .prepare('SELECT 1 FROM _sync_authored WHERE tbl = ? AND uid = ? AND bfp = ? AND replica = ?')
      .get(table, uid, fp, replica) !== undefined
  ) {
    return true;
  }
  return (
    hasTable(db, '_sync_op') &&
    db
      .prepare(
        `SELECT 1 FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
          WHERE o.tbl = ? AND o.uid = ? AND o.o = 'I' AND t.replica = ?
            AND json_extract(o.body, '$.bfp') = ? LIMIT 1`,
      )
      .get(table, uid, replica, fp) !== undefined
  );
}

/**
 * Whether this replica sealed the insert of a `table` row born with `fp`,
 * under any uid (T13431): a re-keyed loser keeps its birth fingerprint, not
 * its uid.
 */
function authoredFpHere(db: DatabaseSync, table: string, fp: string, replica: string): boolean {
  if (
    hasTable(db, '_sync_authored') &&
    db
      .prepare('SELECT 1 FROM _sync_authored WHERE tbl = ? AND bfp = ? AND replica = ?')
      .get(table, fp, replica) !== undefined
  ) {
    return true;
  }
  return (
    hasTable(db, '_sync_op') &&
    db
      .prepare(
        `SELECT 1 FROM _sync_op o JOIN _sync_txn t ON t.txn = o.txn
          WHERE o.tbl = ? AND o.o = 'I' AND t.replica = ?
            AND json_extract(o.body, '$.bfp') = ? LIMIT 1`,
      )
      .get(table, replica, fp) !== undefined
  );
}

/**
 * Re-key every row this replica lost a uid collision with and authored
 * (module doc). Each re-key is its own local transaction in a `rekey` frame;
 * the caller seals and applies again.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @returns The re-keys made.
 */
export function settleLostUidCollisions(db: DatabaseSync, opts: SettleOptions): SettledCollision[] {
  if (!hasTable(db, '_sync_conflict')) return [];
  const settled: SettledCollision[] = [];
  for (const c of lostCollisions(db, opts.stream).values()) {
    const row = db
      .prepare(
        `SELECT ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(c.table)} WHERE ${q(UID_COLUMN)} = ?`,
      )
      .get(c.uid) as { fp: string | null } | undefined;
    const fp = row?.fp ?? null;
    // Only the loser (the greater fingerprint) is re-keyed, and only by its origin.
    if (fp === null || !(c.incomingFp < fp)) continue;
    if (!authoredHere(db, c.table, c.uid, fp, opts.replica)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const frame = openCaptureFrame(db, 'rekey', null);
      let newUid: string;
      if (opts.scope === 'project' && rowIdentitySpec('project', c.table)?.kind === 'minted') {
        // The project re-key cascades owned children and natural rows, and
        // writes the portable uid alias (T12341 §6.4).
        newUid = rekeyRowUid(
          db,
          c.table,
          c.uid,
          { loserBirthFp: fp, winnerBirthFp: c.incomingFp },
          { origin: opts.replica },
        ).newUid;
      } else {
        // The global store's minted tables (brain) own no children by uid.
        newUid = mintRowUid();
        setRowUidNative(db, c.table, c.uid, fp, newUid);
      }
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
      settled.push({ table: c.table, oldUid: c.uid, newUid, birthFp: fp });
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return settled;
}

/**
 * Re-mint the counter key of every local row that lost a key collision and
 * that this replica authored (T13405, T13431). Apply holds an incoming insert
 * whose counter key (`T####`, `D###`, `SN-###`) a live row of another uid holds
 * here (`key-collision`); the greater birth fingerprint loses, as for uids.
 * Its origin gives it the next free key in a local `remint` frame, so the
 * held insert places on the next pass and every receiver folds the rename
 * into the insert it holds ({@link foldDisplayRemints}).
 *
 * Driven by the open conflicts, not by the uid re-key: a re-mint that fails
 * (a kill, `SQLITE_BUSY`) leaves the conflict open, and the next apply re-mints
 * it. A uid collision's K commits first, so receivers record its alias before
 * they meet the rename.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @returns The re-mints made.
 */
export function remintLostKeyCollisions(db: DatabaseSync, opts: SettleOptions): DisplayRemint[] {
  if (!hasTable(db, '_sync_conflict')) return [];
  const open = db
    .prepare(
      `SELECT seq, txn_idx AS txnIdx, op_idx AS opIdx, tbl FROM _sync_conflict
        WHERE stream = ? AND kind = 'key-collision' AND resolved_at IS NULL`,
    )
    .all(opts.stream) as Array<{ seq: number; txnIdx: number; opIdx: number; tbl: string }>;
  const out: DisplayRemint[] = [];
  const staged = open.length > 0 ? stagedTxns(db, opts.stream) : [];
  for (const c of open) {
    const col = displayKeyColumn(c.tbl);
    if (!col) continue;
    const op = staged.find((s) => s.key.seq === c.seq && s.key.txnIdx === c.txnIdx)?.txn.ops[
      c.opIdx
    ];
    const key = op?.a?.[col];
    if (!op?.bfp || typeof key !== 'string') continue;
    const holder = db
      .prepare(
        `SELECT ${q(UID_COLUMN)} AS uid, ${q(BIRTH_FP_COLUMN)} AS fp FROM main.${q(c.tbl)} WHERE ${q(col)} = ?`,
      )
      .get(key) as { uid: string | null; fp: string | null } | undefined;
    // Only the loser (the greater fingerprint) moves, and only by its origin.
    if (!holder?.uid || !holder.fp || holder.uid === op.u || !(op.bfp < holder.fp)) continue;
    if (!authoredFpHere(db, c.tbl, holder.fp, opts.replica)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const frame = openCaptureFrame(db, 'remint', null);
      const remint = remintDisplayKey(db, opts.scope, c.tbl, holder.uid, holder.fp, {
        stream: opts.stream,
        origin: opts.replica,
      });
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
      if (remint) out.push(remint);
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return out;
}

/** A decision re-mint this replica applied to a row it had placed (T13433). */
export interface DecisionKeyMove {
  readonly uid: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Re-point this replica's own text references to decisions another origin
 * re-minted after this replica had placed them (T13433): evidence atoms and
 * page edges it wrote with `decision:<old>` meant the loser, while the old key
 * now names the winner everywhere. A local `remint` frame, so the rewrite
 * propagates; a move the apply rolled back (the row no longer has the new key)
 * is skipped. The caller seals.
 *
 * shortcut: the moves are collected in memory during one apply call, so a crash
 * between that apply's commit and this frame drops them; persist them if that
 * window matters.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @param moves - Decision key moves applied in this call.
 * @returns Rows rewritten.
 */
export function repointOwnDecisionText(
  db: DatabaseSync,
  opts: SettleOptions,
  moves: readonly DecisionKeyMove[],
): number {
  let n = 0;
  for (const m of moves) {
    const live = db
      .prepare(`SELECT id FROM main.brain_decisions WHERE ${q(UID_COLUMN)} = ?`)
      .get(m.uid) as { id: string } | undefined;
    if (live?.id !== m.to) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      const frame = openCaptureFrame(db, 'remint', null);
      for (const k of Object.values(
        repointDecisionReferencesNative(db, m.from, m.to, opts.replica),
      )) {
        n += k;
      }
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }
  return n;
}

/**
 * Announce every re-key this replica applied to a loser it had placed
 * (T13399). The loser's origin draws the boundary for its own references with
 * its K; a replica the origin's insert reached before the winner's may also
 * have written references to the old uid that meant the loser. Receivers only
 * read a writer's references through an alias that writer drew, so this
 * replica re-states the re-key under its own name: an alias-only K in a local
 * `rekey` frame (it moves nothing here). The caller seals.
 *
 * @param db - The store; must not be inside a transaction.
 * @param opts - Scope, stream and this replica.
 * @param nowIso - The time.
 * @returns The announcements captured.
 */
export function announcePlacedRekeys(
  db: DatabaseSync,
  opts: SettleOptions,
  nowIso: string,
): number {
  const owed = owedAnnouncements(db);
  if (owed.length === 0) return 0;
  let n = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    const frame = openCaptureFrame(db, 'rekey', null);
    // Capture off: nothing can be announced, and the debt stays.
    if (frame !== null) {
      for (const a of owed) {
        const def = captureTableDef(db, opts.scope, a.table);
        if (def) n += captureRekeyAnnouncement(db, def, a.oldUid, a.newUid, a.oldBfp);
        markAliasAnnounced(db, a, nowIso);
      }
      finishCaptureFrame(db, frame);
    }
    db.exec('COMMIT');
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
  return n;
}

// ---- Counter-key re-mint (T13405) ----------------------------------------

/*
 * Display-key re-mint for a settled uid collision (T13405; T12341 §6.4 step 7,
 * §9.2 origin rule).
 *
 * Counter keys (`T####`, `D####`, `SN-###`) are allocated locally, so two
 * offline stores can mint the same one. A uid collision on a minted table
 * whose uid hashes that key always shares it too: once the origin re-keys its
 * losing row (above), the held winner still collides on the key
 * (`key-collision`); two rows of different uids can share a key without any
 * uid collision as well. The origin of the losing row (the greater birth
 * fingerprint) re-mints its key in a local `remint` frame
 * ({@link remintLostKeyCollisions}, driven by the open conflict, so a failed
 * re-mint is retried): the next counter value above every key it holds
 * or has staged, written through the chokepoint with its local references
 * (child rows, supersession links, `decision:<id>` page nodes, edges and
 * evidence atoms). The capture triggers journal the rename as ordinary U ops.
 *
 * Receivers never allocate. A receiver holding the loser's insert behind the
 * key collision folds the origin's later rename U into that insert
 * ({@link foldDisplayRemints}), so it places under the new key and the U then
 * changes nothing; a receiver that had placed the loser applies the U like
 * any write, and the applier points its local references at the new key. Its
 * own text references to a re-minted decision (evidence atoms, page edges)
 * mean the loser too, so it re-points those in a local frame that propagates
 * ({@link repointOwnDecisionText}).
 *
 * `display-id-alias.ts` keeps the older authority-driven protocol
 * (`remintAuthority`, `remintTaskDisplayId`): it has no production caller, and
 * this origin re-mint is the one the journal runs.
 *
 * Authority: the origin, until a server path exists (T13404). The spec names
 * the server once a project syncs to the cloud.
 *
 * @task T13405
 */

/** A value an op carries in `a`. */
type OpValue = NonNullable<LedgerOp['a']>[string];

/** A table whose local key is a counter display id. */
interface DisplayKeyTable {
  /** The key column. */
  readonly column: string;
  /** Prefix of the counter (`T`, `D`, `SN-`). */
  readonly prefix: string;
  /** Minimum digits (zero-padded). */
  readonly width: number;
}

/** Tables whose key the origin re-mints (T13405). */
const DISPLAY_KEYS: Readonly<Record<string, DisplayKeyTable>> = {
  tasks_tasks: { column: 'id', prefix: 'T', width: 3 },
  brain_decisions: { column: 'id', prefix: 'D', width: 3 },
  brain_sticky_notes: { column: 'id', prefix: 'SN-', width: 3 },
};

/**
 * The counter display-key column of `table`, or null when its key is not a
 * counter (T13405).
 *
 * @param table - A sync-set table.
 * @returns The key column, or null.
 */
export function displayKeyColumn(table: string): string | null {
  return DISPLAY_KEYS[table]?.column ?? null;
}

/**
 * The local key column a held insert of `table` may take from its origin's
 * later rename (T13432): the counter keys, plus a decision's `decision:<id>`
 * page node, which the decision re-mint renames with it.
 */
function foldKeyColumn(table: string): string | null {
  return table === 'brain_page_nodes' ? 'id' : displayKeyColumn(table);
}

/** The counter value of `key` under `spec`, or 0 when it is not one. */
function counterOf(spec: DisplayKeyTable, key: OpValue | string | null | undefined): number {
  if (typeof key !== 'string' || !key.startsWith(spec.prefix)) return 0;
  const digits = key.slice(spec.prefix.length);
  return /^[0-9]+$/.test(digits) ? Number(digits) : 0;
}

/**
 * The next counter key of `table` above every key it holds and every key a
 * staged transaction would write, so the re-mint never lands on a row that is
 * still held in the inbox.
 */
function allocateDisplayKey(db: DatabaseSync, table: string, stream: string): string {
  const spec = DISPLAY_KEYS[table];
  // @sync-invariant none:input-shape callers pass only tables from DISPLAY_KEYS
  if (!spec) throw new Error(`display key: ${table} has no counter key`);
  const col = `"${spec.column}"`;
  let floor = 0;
  for (const r of db
    .prepare(`SELECT ${col} AS k FROM main."${table}" WHERE substr(${col}, 1, ?) = ?`)
    .all(spec.prefix.length, spec.prefix) as Array<{ k: string | null }>) {
    floor = Math.max(floor, counterOf(spec, r.k));
  }
  for (const st of stagedTxns(db, stream)) {
    for (const op of st.txn.ops) {
      if (op.t === table && op.a) floor = Math.max(floor, counterOf(spec, op.a[spec.column]));
    }
  }
  const next =
    table === 'tasks_tasks' ? (advanceTaskIdSequence(db, floor) ?? floor + 1) : floor + 1;
  return `${spec.prefix}${String(next).padStart(spec.width, '0')}`;
}

/**
 * Every column holding a task display id that a re-mint must rewrite: the
 * declared references, plus `brain_task_observations.task_id`, which holds a
 * task id without a declaration on stores where that table is not synced
 * (T13433; #2034 declares it, and the Map key keeps one entry).
 */
function taskKeyColumns(db: DatabaseSync): ReturnType<typeof taskReferenceColumns> {
  const cols = taskReferenceColumns(db);
  const has =
    hasTable(db, 'brain_task_observations') &&
    !cols.some((c) => c.table === 'brain_task_observations' && c.column === 'task_id');
  return has
    ? [...cols, { table: 'brain_task_observations', column: 'task_id', jsonArray: false }]
    : cols;
}

/** A re-mint the origin made. */
export interface DisplayRemint {
  readonly table: string;
  readonly uid: string;
  readonly fromKey: string;
  readonly toKey: string;
  /** Rows rewritten per `table.column`, the row itself included. */
  readonly rewritten: Readonly<Record<string, number>>;
}

/**
 * ORIGIN ONLY: give the row (`table`, `uid`) a fresh counter key and point its
 * local references at it. Call inside the caller's transaction and capture
 * frame; it defers foreign keys for that transaction.
 *
 * @param db - The store.
 * @param scope - Its scope.
 * @param table - A table with a counter key ({@link displayKeyColumn}).
 * @param uid - The losing row's (new) uid.
 * @param birthFp - Its birth fingerprint.
 * @param opts - The stream (for staged keys) and this replica (the alias origin).
 * @returns The re-mint, or null when the row is gone.
 */
export function remintDisplayKey(
  db: DatabaseSync,
  scope: TableScope,
  table: string,
  uid: string,
  birthFp: string,
  opts: { readonly stream: string; readonly origin: string },
): DisplayRemint | null {
  const spec = DISPLAY_KEYS[table];
  if (!spec) return null;
  const row = db
    .prepare(`SELECT "${spec.column}" AS k FROM main."${table}" WHERE "${UID_COLUMN}" = ?`)
    .get(uid) as { k: string | null } | undefined;
  if (!row?.k) return null;
  const fromKey = row.k;
  const toKey = allocateDisplayKey(db, table, opts.stream);
  db.exec('PRAGMA defer_foreign_keys = ON');
  let rewritten: Record<string, number>;
  if (table === 'tasks_tasks') {
    rewritten = {
      'tasks_tasks.id': 1,
      ...renameTaskDisplayIdNative(db, uid, toKey, taskKeyColumns(db)).rewritten,
    };
  } else {
    rewritten = renameBrainDisplayKeyNative(
      db,
      table as 'brain_decisions' | 'brain_sticky_notes',
      uid,
      fromKey,
      toKey,
    );
    if (table === 'brain_decisions') {
      for (const [k, n] of Object.entries(
        repointDecisionReferencesNative(db, fromKey, toKey, opts.origin, true),
      )) {
        rewritten[k] = (rewritten[k] ?? 0) + n;
      }
    }
  }
  // The portable display alias lets `T0001` still resolve (project store only).
  if (scope === 'project' && hasTable(db, 'tasks_display_id_aliases')) {
    recordDisplayIdAlias(db, {
      table,
      displayId: fromKey,
      entityUid: uid,
      entityBirthFp: birthFp,
      reason: 'collision-remint',
      origin: opts.origin,
    });
  }
  return { table, uid, fromKey, toKey, rewritten };
}

/**
 * RECEIVER: fold an origin's re-mint into the insert it held (module doc).
 * An insert of a counter-keyed row whose key a live row of another uid holds
 * here takes the key of the LATEST later staged U by the same origin on the
 * same row (uid and birth fingerprint) that sets it. Nothing else changes; the
 * U still applies (and changes nothing). Pure over `staged`; reads the store.
 *
 * @param db - The store.
 * @param staged - Staged transactions in stream order (aliases followed).
 * @param defs - Capture definitions by table.
 * @returns `staged`, with folded inserts replaced.
 */
export function foldDisplayRemints(
  db: DatabaseSync,
  staged: readonly StagedTxn[],
  defs: (table: string) => CaptureTableDef | null,
): StagedTxn[] {
  const out = [...staged];
  for (const [i, st] of staged.entries()) {
    let ops: LedgerOp[] | null = null;
    for (const [j, op] of st.txn.ops.entries()) {
      const col = op.o === 'I' ? foldKeyColumn(op.t) : null;
      const key = col ? op.a?.[col] : undefined;
      if (!col || typeof key !== 'string' || !defs(op.t)) continue;
      const holder = db
        .prepare(`SELECT "${UID_COLUMN}" AS uid FROM main."${op.t}" WHERE "${col}" = ?`)
        .get(key) as { uid: string | null } | undefined;
      if (!holder || holder.uid === op.u) continue;
      let renamed: string | null = null;
      for (const later of staged.slice(i + 1)) {
        if (later.replicaId !== st.replicaId) continue;
        for (const u of later.txn.ops) {
          const v = u.o === 'U' && u.t === op.t && u.u === op.u ? u.a?.[col] : undefined;
          if (typeof v === 'string' && (!u.bfp || !op.bfp || u.bfp === op.bfp)) renamed = v;
        }
      }
      if (renamed === null || renamed === key) continue;
      ops ??= [...st.txn.ops];
      ops[j] = { ...op, a: { ...op.a, [col]: renamed } };
    }
    if (ops) out[i] = { ...st, txn: { ...st.txn, ops } };
  }
  return out;
}

/**
 * Local columns that reference `table` by `keyColumn` (T13405): every
 * sync-set table's declared reference to it, with that table's uid.
 *
 * @param db - The store.
 * @param defs - Capture definitions by table.
 * @param table - The re-keyed table.
 * @param keyColumn - Its key column.
 * @returns The referencing (table, column) pairs.
 */
export function displayKeyReferrers(
  db: DatabaseSync,
  defs: (table: string) => CaptureTableDef | null,
  table: string,
  keyColumn: string,
): Array<{ readonly table: string; readonly column: string }> {
  const out: Array<{ table: string; column: string }> = [];
  const tables = db
    .prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const def = defs(name);
    if (!def) continue;
    for (const [column, target] of def.refs) {
      if (target.table === table && target.key === keyColumn) out.push({ table: name, column });
    }
  }
  return out;
}

/**
 * Point the columns of tables OUTSIDE the sync set that hold a moved task id
 * at its new id (T13405). They carry no capture and no uid (derived or
 * local-only tables such as the acceptance projections), so the write API
 * cannot reach them, and their foreign keys would otherwise fail at commit.
 *
 * @param db - The project store.
 * @param defs - Capture definitions by table (null outside the sync set).
 * @param fromId - The task's old display id.
 * @param toId - Its new display id.
 * @returns Rows rewritten per `table.column`.
 */
export function followLocalTaskRefs(
  db: DatabaseSync,
  defs: (table: string) => CaptureTableDef | null,
  fromId: string,
  toId: string,
): Record<string, number> {
  const local = taskKeyColumns(db).filter((r) => defs(r.table) === null);
  return local.length > 0 ? rewriteTaskIdReferencesNative(db, local, fromId, toId) : {};
}
