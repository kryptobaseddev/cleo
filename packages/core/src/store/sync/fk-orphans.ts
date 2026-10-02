/**
 * The bounded `fk_orphans` repair (journal spec §3.5 Rule 4 (a)(3), §2.3a
 * rule 2; C3 T12821, D3 T12826; T12986, S3c).
 *
 * An orphan is a sync-set row whose foreign key names a parent row this store
 * does not have. The repair never deletes user data (C3), and it first asks
 * whether the orphan is only LOCAL damage, by looking the missing parent up
 * in the merged stream state (D3):
 *
 * - **live elsewhere**: the parent is restored locally (checkpoint bundle or
 *   its latest ops), with capture suspended, so nothing is emitted: every
 *   other replica already agrees. No conflict.
 * - **tombstoned**: a `delete-with-live-children` conflict naming the
 *   children; nothing changes.
 * - **unknown** (never seen): re-parent to the deterministic sentinel where
 *   the column defines one, else NULL where the column is nullable, else
 *   report. A conflict record is written in every case. The writes are an
 *   ordinary `repair` frame: captured, sealed, sent, so every replica
 *   converges.
 *
 * Before `row_identity_synced` exists there is no merged state: the repair is
 * report-only and writes nothing (D3(d)).
 *
 * The merged-state lookup, the restore and the conflict store belong to S4/S5
 * and T12344, so they are injected ({@link FkOrphanRepairSeams}).
 *
 * The sentinel (D3(a)(b)): the parent-type matrix has no single task type
 * that may parent every other (saga→epic, epic→task|subtask, task→subtask),
 * so the sentinel is a root-level `epic` and parents orphaned tasks and
 * subtasks; an orphaned epic, saga or other type becomes a root (NULL), which
 * the matrix allows. Its uid is the natural uid over
 * `(project, tasks_tasks, 'fk-orphan-sentinel')`, its display id and every
 * column are constants, so replicas that create it independently write the
 * same row.
 *
 * @module store/sync/fk-orphans
 * @task T12986
 * @epic T12323
 */

import type { DatabaseSync } from 'node:sqlite';
import type { TableScope } from '@cleocode/contracts';
import {
  naturalRowUid,
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_SYNCED_KEY,
} from '../row-identity.js';
import { finishCaptureFrame, openCaptureFrame, syncSetTables } from './capture.js';
import { withImmediateTransaction } from './clock-store.js';
import { hasTable } from './schema.js';
import { withTriggersSuspended } from './trigger-classes.js';

const q = (id: string): string => `"${id.replaceAll('"', '""')}"`;

/** A local key value (SQLite TEXT or INTEGER). */
export type KeyValue = string | number;

/** One orphaned row: a foreign key naming a parent this store lacks. */
export interface FkOrphan {
  /** The child table. */
  readonly table: string;
  readonly rowid: number | null;
  /** The child's uid, when its table has one. */
  readonly uid: string | null;
  /** The child's foreign-key column. */
  readonly column: string;
  readonly parentTable: string;
  readonly parentColumn: string;
  /** The missing parent's local key. */
  readonly parentKey: KeyValue;
}

/**
 * Every single-column foreign-key violation in the store, read-only: the
 * doctor's `fk_orphans` finding. Composite keys and WITHOUT ROWID children
 * are listed with `rowid: null` where SQLite gives none.
 */
export function findFkOrphans(db: DatabaseSync): FkOrphan[] {
  const rows = db.prepare('PRAGMA main.foreign_key_check').all() as Array<{
    table: string;
    rowid: number | null;
    parent: string;
    fkid: number;
  }>;
  const out: FkOrphan[] = [];
  const fks = new Map<
    string,
    Array<{ id: number; table: string; from: string; to: string | null }>
  >();
  for (const r of rows) {
    let list = fks.get(r.table);
    if (!list) {
      list = db.prepare(`PRAGMA main.foreign_key_list(${q(r.table)})`).all() as Array<{
        id: number;
        table: string;
        from: string;
        to: string | null;
      }>;
      fks.set(r.table, list);
    }
    const cols = list.filter((f) => f.id === r.fkid);
    if (cols.length !== 1 || r.rowid === null) continue; // composite or no rowid: report via doctor only
    const fk = cols[0] as { table: string; from: string; to: string | null };
    const parentColumn = fk.to ?? primaryKey(db, fk.table);
    if (parentColumn === null) continue;
    const child = db
      .prepare(
        `SELECT ${q(fk.from)} AS k${hasColumn(db, r.table, 'uid') ? ', uid' : ''} FROM ${q(r.table)} WHERE rowid = ?`,
      )
      .get(r.rowid) as { k: KeyValue | null; uid?: string | null } | undefined;
    if (!child || child.k === null) continue;
    out.push({
      table: r.table,
      rowid: r.rowid,
      uid: child.uid ?? null,
      column: fk.from,
      parentTable: fk.table,
      parentColumn,
      parentKey: child.k,
    });
  }
  return out;
}

function primaryKey(db: DatabaseSync, table: string): string | null {
  const pk = (
    db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{ name: string; pk: number }>
  ).filter((c) => c.pk > 0);
  return pk.length === 1 ? (pk[0] as { name: string }).name : null;
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{ name: string }>).some(
    (c) => c.name === column,
  );
}

function nullable(db: DatabaseSync, table: string, column: string): boolean {
  const c = (
    db.prepare(`PRAGMA main.table_info(${q(table)})`).all() as Array<{
      name: string;
      notnull: number;
    }>
  ).find((x) => x.name === column);
  return c !== undefined && c.notnull === 0;
}

// ---------------------------------------------------------------------------
// The sentinel
// ---------------------------------------------------------------------------

/** Where the sentinel lives, and which orphaned children it may parent. */
interface SentinelPolicy {
  readonly table: string;
  /** Child (table.column) → may this child row be re-parented to the sentinel? */
  readonly children: Readonly<Record<string, (db: DatabaseSync, rowid: number) => boolean>>;
}

/** Display id of the tasks sentinel (matches `T\d{3,}`; allocation never reaches 0). */
export const FK_ORPHAN_SENTINEL_ID = 'T000';

/** The tasks sentinel's uid: the natural uid over (project, tasks_tasks, 'fk-orphan-sentinel'). */
export const FK_ORPHAN_SENTINEL_UID = naturalRowUid('project', 'tasks_tasks', [
  'fk-orphan-sentinel',
]);

const SENTINEL: Readonly<Record<TableScope, SentinelPolicy | null>> = {
  project: {
    table: 'tasks_tasks',
    children: {
      // The matrix lets an epic parent tasks and subtasks only.
      'tasks_tasks.parent_id': (db, rowid) => {
        const row = db.prepare('SELECT type FROM tasks_tasks WHERE rowid = ?').get(rowid) as
          | { type: string | null }
          | undefined;
        return row?.type === 'task' || row?.type === 'subtask';
      },
    },
  },
  global: null,
};

/** Constant column values of the sentinel row: every replica writes the same row. */
const SENTINEL_ROW: Readonly<Record<string, KeyValue>> = {
  id: FK_ORPHAN_SENTINEL_ID,
  title: 'Orphaned work (fk_orphans repair)',
  description:
    'Created by the fk_orphans repair: tasks and subtasks whose parent was never seen on any replica were moved here. Re-parent them and delete this epic when it is empty.',
  type: 'epic',
  status: 'pending',
  priority: 'low',
  uid: FK_ORPHAN_SENTINEL_UID,
  birth_fp: FK_ORPHAN_SENTINEL_UID,
  created_at: '1970-01-01T00:00:00.000Z',
  updated_at: '1970-01-01T00:00:00.000Z',
};

/**
 * Create the sentinel when absent, inside the caller's transaction and
 * capture frame (an ordinary op). Returns false when a different row holds
 * its display id, so the caller falls back to NULL or report.
 */
function ensureSentinel(db: DatabaseSync, policy: SentinelPolicy): boolean {
  const t = policy.table;
  const held = db.prepare(`SELECT uid FROM ${q(t)} WHERE id = ?`).get(FK_ORPHAN_SENTINEL_ID) as
    | { uid: string | null }
    | undefined;
  if (held) return held.uid === FK_ORPHAN_SENTINEL_UID;
  const cols = Object.keys(SENTINEL_ROW).filter((c) => hasColumn(db, t, c));
  db.prepare(
    `INSERT INTO ${q(t)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
  ).run(...cols.map((c) => SENTINEL_ROW[c] as KeyValue));
  return true;
}

// ---------------------------------------------------------------------------
// The repair
// ---------------------------------------------------------------------------

/** The missing parent in the merged stream state. */
export type ParentState =
  | { readonly state: 'live'; readonly uid: string }
  | { readonly state: 'tombstoned'; readonly uid: string }
  | { readonly state: 'unknown' };

/** A conflict record for the owner (T12344's store backs it). */
export interface FkOrphanConflict {
  readonly kind: 'fk-orphan' | 'delete-with-live-children';
  readonly parent: {
    readonly table: string;
    readonly column: string;
    readonly key: KeyValue;
    readonly uid: string | null;
  };
  readonly children: ReadonlyArray<{
    readonly table: string;
    readonly column: string;
    readonly uid: string | null;
  }>;
  /** What the repair did: re-parented to the sentinel, NULLed, reported, or nothing. */
  readonly resolution: 'sentinel' | 'null' | 'report' | 'none';
}

/** The stream-side services the repair needs (S4/S5, T12344). */
export interface FkOrphanRepairSeams {
  /** The parent in the merged state: row meta, tombstones, folds, latest verified checkpoint. */
  readonly parentState: (table: string, column: string, key: KeyValue) => ParentState;
  /**
   * Restore a parent that is live elsewhere, from the checkpoint bundle or a
   * pull of its latest ops. Called inside a transaction with capture
   * suspended, so the restore emits nothing.
   */
  readonly restoreParent: (db: DatabaseSync, table: string, uid: string) => void;
  /**
   * Persist a conflict record. For a repair that writes (sentinel, NULL),
   * it is called inside the repair's transaction, before the commit: a throw
   * rolls the repair back, so no repair lands without its record (D3,
   * T13044). It must not open its own transaction.
   */
  readonly recordConflict: (conflict: FkOrphanConflict) => void;
}

/** What happened to one orphan. */
export type FkOrphanOutcome = 'restored' | 'conflict' | 'sentinel' | 'nulled' | 'reported';

/** What {@link repairFkOrphans} did. */
export interface FkOrphanRepairReport {
  /** `report-only` before `row_identity_synced` exists (nothing written). */
  readonly mode: 'report-only' | 'repair';
  readonly orphans: ReadonlyArray<FkOrphan & { readonly outcome: FkOrphanOutcome }>;
  readonly sentinelCreated: boolean;
}

function synced(db: DatabaseSync): boolean {
  if (!hasTable(db, ROW_IDENTITY_META_TABLE)) return false;
  return (
    db
      .prepare(`SELECT 1 FROM ${q(ROW_IDENTITY_META_TABLE)} WHERE key = ?`)
      .get(ROW_IDENTITY_SYNCED_KEY) !== undefined
  );
}

function parentExists(db: DatabaseSync, o: FkOrphan): boolean {
  return (
    db
      .prepare(`SELECT 1 FROM ${q(o.parentTable)} WHERE ${q(o.parentColumn)} = ?`)
      .get(o.parentKey) !== undefined
  );
}

/**
 * Repair up to `budget` sync-set orphans (C3, D3). Never deletes a row.
 *
 * Orphans of tables outside the sync set, or whose parent is outside it, are
 * reported only: no stream state describes them.
 */
export function repairFkOrphans(
  db: DatabaseSync,
  scope: TableScope,
  seams: FkOrphanRepairSeams,
  opts: { readonly budget?: number } = {},
): FkOrphanRepairReport {
  const budget = Math.max(1, opts.budget ?? 100);
  const all = findFkOrphans(db).slice(0, budget);
  if (!synced(db)) {
    return {
      mode: 'report-only',
      orphans: all.map((o) => ({ ...o, outcome: 'reported' as const })),
      sentinelCreated: false,
    };
  }
  const syncSet = new Set(syncSetTables(scope));
  const policy = SENTINEL[scope];
  const out: Array<FkOrphan & { outcome: FkOrphanOutcome }> = [];
  let sentinelCreated = false;

  // One lookup per missing parent.
  const groups = new Map<string, FkOrphan[]>();
  for (const o of all) {
    if (!syncSet.has(o.table) || !syncSet.has(o.parentTable)) {
      out.push({ ...o, outcome: 'reported' });
      continue;
    }
    const k = JSON.stringify([o.parentTable, o.parentColumn, o.parentKey]);
    const g = groups.get(k);
    if (g) g.push(o);
    else groups.set(k, [o]);
  }

  for (const children of groups.values()) {
    const first = children[0] as FkOrphan;
    const parent = seams.parentState(first.parentTable, first.parentColumn, first.parentKey);
    const conflictOf = (
      kind: FkOrphanConflict['kind'],
      resolution: FkOrphanConflict['resolution'],
      kids: readonly FkOrphan[],
    ): FkOrphanConflict => ({
      kind,
      parent: {
        table: first.parentTable,
        column: first.parentColumn,
        key: first.parentKey,
        uid: parent.state === 'unknown' ? null : parent.uid,
      },
      children: kids.map((c) => ({ table: c.table, column: c.column, uid: c.uid })),
      resolution,
    });

    if (parent.state === 'live') {
      // Local damage: every other replica has the parent. Restore, emit nothing.
      withImmediateTransaction(db, () =>
        withTriggersSuspended(db, ['capture'], 'forward', () =>
          seams.restoreParent(db, first.parentTable, parent.uid),
        ),
      );
      if (parentExists(db, first)) {
        for (const c of children) out.push({ ...c, outcome: 'restored' });
      } else {
        seams.recordConflict(conflictOf('fk-orphan', 'report', children));
        for (const c of children) out.push({ ...c, outcome: 'reported' });
      }
      continue;
    }
    if (parent.state === 'tombstoned') {
      seams.recordConflict(conflictOf('delete-with-live-children', 'none', children));
      for (const c of children) out.push({ ...c, outcome: 'conflict' });
      continue;
    }

    // Never seen anywhere: sentinel, else NULL, else report; always a conflict.
    const done: Array<FkOrphan & { outcome: FkOrphanOutcome }> = [];
    withImmediateTransaction(db, () => {
      const frame = openCaptureFrame(db, 'repair', 'fk_orphans');
      for (const c of children) {
        const may = policy?.children[`${c.table}.${c.column}`];
        if (
          policy &&
          c.parentTable === policy.table &&
          c.rowid !== null &&
          may?.(db, c.rowid) === true
        ) {
          const existed =
            db
              .prepare(`SELECT 1 FROM ${q(policy.table)} WHERE id = ?`)
              .get(FK_ORPHAN_SENTINEL_ID) !== undefined;
          if (ensureSentinel(db, policy)) {
            if (!existed) sentinelCreated = true;
            db.prepare(`UPDATE ${q(c.table)} SET ${q(c.column)} = ? WHERE rowid = ?`).run(
              FK_ORPHAN_SENTINEL_ID,
              c.rowid,
            );
            done.push({ ...c, outcome: 'sentinel' });
            continue;
          }
        }
        if (c.rowid !== null && nullable(db, c.table, c.column)) {
          db.prepare(`UPDATE ${q(c.table)} SET ${q(c.column)} = NULL WHERE rowid = ?`).run(c.rowid);
          done.push({ ...c, outcome: 'nulled' });
          continue;
        }
        done.push({ ...c, outcome: 'reported' });
      }
      // D3: every case writes its conflict record, in the same transaction as
      // the repair, so a failed record (or a crash) never leaves a repair
      // without one (T13044).
      for (const resolution of ['sentinel', 'null', 'report'] as const) {
        const outcome =
          resolution === 'null' ? 'nulled' : resolution === 'report' ? 'reported' : 'sentinel';
        const kids = done.filter((d) => d.outcome === outcome);
        if (kids.length > 0) seams.recordConflict(conflictOf('fk-orphan', resolution, kids));
      }
      finishCaptureFrame(db, frame);
    });
    out.push(...done);
  }
  return { mode: 'repair', orphans: out, sentinelCreated };
}
