/**
 * Re-key the legacy `T-RECONCILE-FOLLOWUP-*` task rows (T14324).
 *
 * Before T14271 the release reconcile minted follow-up tasks with ids such as
 * `T-RECONCILE-FOLLOWUP-v2026.5.63-6`, which `cleo show` rejects, so CLEO
 * filed tasks it could not read. Every store that ran a reconcile may hold
 * them. Each one takes the next `T####` through the journal re-mint path
 * (`remintDisplayKey`, the one sync runs, T13405) in a `remint` capture frame:
 * the rename and every local reference are journaled, the old id stays a
 * display-id alias, and another device follows the rename instead of keeping
 * a second row.
 *
 * `cleo doctor malformed-ids` drives it: without `--fix` it lists each row
 * with the id it would take; with `--fix` it takes a required-mode snapshot
 * first, re-keys row by row, and appends one receipt per row to
 * `.cleo/audit/followup-rekey.jsonl`.
 *
 * @module
 * @task T14324
 * @task T14271
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getCleoDir } from '../paths.js';
import { describeSnapshotMiss, type SnapshotGateResult } from '../store/snapshot-gate.js';
import { vacuumIntoBackup } from '../store/sqlite-backup.js';
import { finishCaptureFrame, openCaptureFrame } from '../store/sync/capture.js';
import { remintDisplayKey } from '../store/sync/collision-settle.js';
import { activeReplica } from '../store/sync/replica.js';

/** Ids the release reconcile minted before T14271. */
export const LEGACY_FOLLOWUP_ID = /^T-RECONCILE-FOLLOWUP-/;

/** Audit file the re-key appends one receipt per row to, under `.cleo/`. */
export const FOLLOWUP_REKEY_AUDIT_FILE = 'audit/followup-rekey.jsonl';

/** One legacy row and the id it takes (planned on a dry run, final after `--fix`). */
export interface FollowUpRekey {
  /** The legacy id. */
  readonly oldId: string;
  /** The `T####` it takes: planned (may move if tasks are added first) or final. */
  readonly newId: string;
  /** Rows rewritten per `table.column`, the row itself included (after `--fix`). */
  readonly rewritten?: Readonly<Record<string, number>>;
}

/** Outcome of {@link rekeyLegacyFollowUps}. */
export interface FollowUpRekeyReport {
  /** True when the rows were re-keyed; false on a dry run or a refusal. */
  readonly applied: boolean;
  /** Each legacy row with its planned or final id. */
  readonly rows: readonly FollowUpRekey[];
  /** Why `--fix` re-keyed nothing (the snapshot was not taken), or null. */
  readonly refused: string | null;
}

/** Legacy follow-up rows, with uid and birth fingerprint, in id order. */
function legacyRows(
  db: DatabaseSync,
): Array<{ id: string; uid: string | null; fp: string | null }> {
  return (
    db
      .prepare(
        `SELECT id, uid, birth_fp AS fp FROM tasks_tasks
          WHERE id LIKE 'T-RECONCILE-FOLLOWUP-%' ORDER BY id`,
      )
      .all() as Array<{ id: string; uid: string | null; fp: string | null }>
  ).filter((r) => LEGACY_FOLLOWUP_ID.test(r.id));
}

/** The next `count` task ids, read-only (the same floor the allocator starts from). */
function plannedIds(db: DatabaseSync, count: number): string[] {
  let floor = 0;
  for (const { id } of db.prepare('SELECT id FROM tasks_tasks').all() as Array<{ id: string }>) {
    const m = /^T([0-9]+)$/.exec(id);
    if (m) floor = Math.max(floor, Number(m[1]));
  }
  const counter = db
    .prepare(
      `SELECT json_extract(value, '$.counter') AS c FROM tasks_schema_meta WHERE key = 'task_id_sequence'`,
    )
    .get() as { c: number | null } | undefined;
  floor = Math.max(floor, counter?.c ?? 0);
  return Array.from({ length: count }, (_, i) => `T${String(floor + i + 1).padStart(3, '0')}`);
}

/**
 * List, or with `apply` re-key, the legacy follow-up rows of a project store.
 *
 * @param db - The project `cleo.db` (native handle; not inside a transaction).
 * @param cwd - The project root (for the snapshot and the audit file).
 * @param opts - `apply: true` re-keys; otherwise a dry run that writes nothing.
 * @returns Each row with its planned or final id, and why `apply` refused, if it did.
 */
export async function rekeyLegacyFollowUps(
  db: DatabaseSync,
  cwd: string,
  opts: {
    readonly apply?: boolean;
    /** Test seam: the pre-re-key snapshot. @defaultValue a required-mode `vacuumIntoBackup` */
    readonly snapshot?: () => Promise<SnapshotGateResult | null>;
  } = {},
): Promise<FollowUpRekeyReport> {
  const rows = legacyRows(db);
  if (rows.length === 0) return { applied: false, rows: [], refused: null };
  if (opts.apply !== true) {
    const ids = plannedIds(db, rows.length);
    return {
      applied: false,
      rows: rows.map((r, i) => ({ oldId: r.id, newId: ids[i] as string })),
      refused: null,
    };
  }
  // A re-key renames rows that sync: snapshot first, and stop if it was not taken.
  const snapshot = opts.snapshot ?? (() => vacuumIntoBackup({ cwd, mode: 'required' }));
  const miss = describeSnapshotMiss(await snapshot());
  if (miss !== null) {
    const ids = plannedIds(db, rows.length);
    return {
      applied: false,
      rows: rows.map((r, i) => ({ oldId: r.id, newId: ids[i] as string })),
      refused: `no snapshot before the re-key: ${miss}`,
    };
  }
  const origin = activeReplica(db, 'project')?.replicaId ?? null;
  const audit = join(getCleoDir(cwd), FOLLOWUP_REKEY_AUDIT_FILE);
  mkdirSync(dirname(audit), { recursive: true });
  const done: FollowUpRekey[] = [];
  for (const row of rows) {
    if (row.uid === null || row.fp === null) {
      throw new Error(`${row.id} has no row identity yet; open the store once so it is filled`);
    }
    db.exec('BEGIN IMMEDIATE');
    let remint: ReturnType<typeof remintDisplayKey>;
    try {
      const frame = openCaptureFrame(db, 'remint', null);
      remint = remintDisplayKey(db, 'project', 'tasks_tasks', row.uid, row.fp, {
        stream: null,
        origin,
        reason: 'manual',
      });
      finishCaptureFrame(db, frame);
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
    if (remint === null) continue;
    const receipt = { oldId: remint.fromKey, newId: remint.toKey, rewritten: remint.rewritten };
    appendFileSync(
      audit,
      `${JSON.stringify({ timestamp: new Date().toISOString(), uid: row.uid, ...receipt })}\n`,
    );
    done.push(receipt);
  }
  return { applied: true, rows: done, refused: null };
}
