/**
 * Re-key task rows whose id is outside the task grammar but which are real
 * tasks (T14324).
 *
 * Two kinds exist in the wild. Before T14271 the release reconcile minted
 * follow-up tasks as `T-RECONCILE-FOLLOWUP-v2026.5.63-6`; and older writers
 * left ids such as `T932EP`. `cleo show` rejects both, yet they carry task
 * content. A row is a task when its id is identifier-shaped (a letter, no
 * whitespace or path separators) and is a legacy follow-up id, or it has a
 * real title (not the synthetic `Task <id>`), a description, acceptance
 * criteria or a relation. Such a row is never deleted: it takes the next
 * `T####` through the journal re-mint path (`remintDisplayKey`, the one sync
 * runs, T13405) in a `remint` capture frame. The rename and every local
 * reference are journaled, the old id stays a display-id alias, and another
 * device follows the rename instead of keeping a second row. A row with none
 * of that (the T12128 path row) is left to the malformed-row delete.
 *
 * `cleo doctor malformed-ids` drives it: without `--fix` (or with `--dry-run`)
 * it lists each row with the id it would take; with `--fix` it takes a
 * required-mode snapshot first, re-keys row by row, and appends one receipt
 * per row to `.cleo/audit/malformed-id-rekey.jsonl`.
 *
 * @module
 * @task T14324
 * @task T14271
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { isTaskId } from '@cleocode/contracts/task-id.js';
import { getCleoDir } from '../paths.js';
import { describeSnapshotMiss, type SnapshotGateResult } from '../store/snapshot-gate.js';
import { vacuumIntoBackup } from '../store/sqlite-backup.js';
import { finishCaptureFrame, openCaptureFrame } from '../store/sync/capture.js';
import { remintDisplayKey } from '../store/sync/collision-settle.js';
import { activeReplica } from '../store/sync/replica.js';

/** Ids the release reconcile minted before T14271. */
export const LEGACY_FOLLOWUP_ID = /^T-RECONCILE-FOLLOWUP-/;

/** Audit file the re-key appends one receipt per row to, under `.cleo/`. */
export const MALFORMED_ID_REKEY_AUDIT_FILE = 'audit/malformed-id-rekey.jsonl';

/** One task row and the id it takes (planned on a dry run, final after `--fix`). */
export interface TaskIdRekey {
  /** The id outside the task grammar. */
  readonly oldId: string;
  /** The `T####` it takes: planned (may move if tasks are added first) or final. */
  readonly newId: string;
  /** Rows rewritten per `table.column`, the row itself included (after `--fix`). */
  readonly rewritten?: Readonly<Record<string, number>>;
}

/** Outcome of {@link rekeyMalformedTaskRows}. */
export interface TaskIdRekeyReport {
  /** True when the rows were re-keyed; false on a dry run or a refusal. */
  readonly applied: boolean;
  /** Each task row with its planned or final id. */
  readonly rows: readonly TaskIdRekey[];
  /** Why `--fix` re-keyed nothing (the snapshot was not taken), or null. */
  readonly refused: string | null;
}

/**
 * An identifier: a letter, then up to 63 characters with no whitespace, path
 * separator or control character. A value outside it (a path, prose) was
 * never a task id, whatever the row holds, and is left to the delete.
 */
const IDENTIFIER_SHAPE = /^[A-Za-z][^\s/\\\x00-\x1f\x7f]{0,63}$/;

/** A table's existence, for the optional content tables. */
function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/**
 * Task rows whose id is outside the task grammar and which are tasks: a legacy
 * follow-up id, or task content (see the module doc). In id order.
 */
function rekeyCandidates(
  db: DatabaseSync,
): Array<{ id: string; uid: string | null; fp: string | null }> {
  const rows = (
    db
      .prepare(
        `SELECT id, uid, birth_fp AS fp, title, description, acceptance_json AS acceptance
           FROM tasks_tasks ORDER BY id`,
      )
      .all() as Array<{
      id: string;
      uid: string | null;
      fp: string | null;
      title: string | null;
      description: string | null;
      acceptance: string | null;
    }>
  ).filter((r) => !isTaskId(r.id) && IDENTIFIER_SHAPE.test(r.id));
  const acs = hasTable(db, 'tasks_task_acceptance_criteria')
    ? db.prepare('SELECT 1 FROM tasks_task_acceptance_criteria WHERE task_id = ? LIMIT 1')
    : null;
  const rels = db.prepare(
    'SELECT 1 FROM tasks_task_relations WHERE task_id = ? OR related_to = ? LIMIT 1',
  );
  const filled = (v: string | null) => v !== null && v.trim() !== '';
  return rows
    .filter(
      (r) =>
        LEGACY_FOLLOWUP_ID.test(r.id) ||
        (filled(r.title) && r.title !== `Task ${r.id}`) ||
        filled(r.description) ||
        (filled(r.acceptance) && r.acceptance !== '[]') ||
        acs?.get(r.id) !== undefined ||
        rels.get(r.id, r.id) !== undefined,
    )
    .map(({ id, uid, fp }) => ({ id, uid, fp }));
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
 * List, or with `apply` re-key, the task rows of a project store whose id is
 * outside the task grammar (see the module doc for which rows are tasks).
 *
 * @param db - The project `cleo.db` (native handle; not inside a transaction).
 * @param cwd - The project root (for the snapshot and the audit file).
 * @param opts - `apply: true` re-keys; otherwise a dry run that writes nothing.
 * @returns Each row with its planned or final id, and why `apply` refused, if it did.
 */
export async function rekeyMalformedTaskRows(
  db: DatabaseSync,
  cwd: string,
  opts: {
    readonly apply?: boolean;
    /** Test seam: the pre-re-key snapshot. @defaultValue a required-mode `vacuumIntoBackup` */
    readonly snapshot?: () => Promise<SnapshotGateResult | null>;
  } = {},
): Promise<TaskIdRekeyReport> {
  const rows = rekeyCandidates(db);
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
  const audit = join(getCleoDir(cwd), MALFORMED_ID_REKEY_AUDIT_FILE);
  mkdirSync(dirname(audit), { recursive: true });
  const done: TaskIdRekey[] = [];
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
