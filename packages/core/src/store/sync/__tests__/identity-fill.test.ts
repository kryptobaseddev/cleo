/**
 * The open-time row-identity fill with capture on (the S2 interactions of
 * T12806's snapshot-overwrite import and T12801's refill): the fill is a
 * derived rewrite, uncaptured with its tables marked suspect, except that an
 * identity a CAPTURED write cleared gets a re-mint K.
 *
 * Every store is a temp project under a `mkdtemp` directory.
 *
 * @task T12343
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import {
  preReleaseBirthFp,
  ROW_IDENTITY_META_TABLE,
  ROW_IDENTITY_RECIPE_KEY,
} from '../../row-identity.js';
import {
  clearCaptureFrame,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { suspectTables } from '../structural.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');

let dir: string;
let dbPath: string;

async function open(): Promise<DatabaseSync> {
  _resetDualScopeDbCache();
  const h = await openDualScopeDbAtPath('project', dbPath);
  return h.db.$client as DatabaseSync;
}

const maxSeq = (db: DatabaseSync) =>
  (db.prepare('SELECT coalesce(max(seq), 0) AS n FROM _sync_capture').get() as { n: number }).n;

/** A framed write, as the accessor makes one. */
function framed(db: DatabaseSync, sql: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write');
  try {
    db.exec(sql);
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    clearCaptureFrame(db, frame);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-identity-fill-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  vi.stubEnv('CLEO_ROW_UID_FILL', '1');
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function captureStoreWithTask(): Promise<DatabaseSync> {
  const db = await open();
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  framed(
    db,
    "INSERT INTO tasks_tasks (id, title, type, status) VALUES ('T1', 'x', 'task', 'pending')",
  );
  return db;
}

describe('the open-time identity fill with capture on', () => {
  it('a refill of pre-release fingerprints writes no capture and marks its tables suspect (T12801)', async () => {
    const db = await captureStoreWithTask();
    const row = db.prepare("SELECT * FROM tasks_tasks WHERE id = 'T1'").get() as Record<
      string,
      string | null
    >;
    const fresh = row.birth_fp;
    expect(fresh).toBeTruthy();
    const stale = preReleaseBirthFp(db, 'tasks_tasks', row) ?? '';
    expect(stale).not.toBe(fresh);
    // The pre-release state, written outside capture (as the old build did).
    db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')");
    db.prepare("UPDATE tasks_tasks SET birth_fp = ? WHERE id = 'T1'").run(stale);
    db.exec(`DELETE FROM ${ROW_IDENTITY_META_TABLE} WHERE key = '${ROW_IDENTITY_RECIPE_KEY}'`);
    db.exec('DELETE FROM cleo_trigger_suspend');
    const before = maxSeq(db);

    const again = await open();
    expect(
      (
        again.prepare("SELECT birth_fp FROM tasks_tasks WHERE id = 'T1'").get() as {
          birth_fp: string;
        }
      ).birth_fp,
    ).toBe(fresh);
    expect(maxSeq(again)).toBe(before);
    expect(suspectTables(again)).toContain('tasks_tasks');
    // The capture triggers are back after the bracket.
    expect(
      again
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = '_sync_cap_tasks_tasks_k'",
        )
        .get(),
    ).toBeDefined();
  });

  it('an identity a captured write cleared is re-minted with a K that journals the new uid (T12806)', async () => {
    const db = await captureStoreWithTask();
    const old = (db.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T1'").get() as { uid: string })
      .uid;
    // A snapshot-overwrite import clears the identity under capture: K old -> NULL.
    framed(db, "UPDATE tasks_tasks SET uid = NULL, birth_fp = NULL WHERE id = 'T1'");
    const cleared = db
      .prepare(
        "SELECT json_extract(img, '$.uid') AS u FROM _sync_capture WHERE tbl = 'tasks_tasks' AND op = 'K' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { u: string };
    expect(JSON.parse(cleared.u)).toEqual([`'${old}'`, 'NULL']);
    const before = maxSeq(db);

    const again = await open();
    const now = (
      again.prepare("SELECT uid FROM tasks_tasks WHERE id = 'T1'").get() as { uid: string }
    ).uid;
    expect(now).toBeTruthy();
    const after = again
      .prepare(
        `SELECT c.op, json_extract(c.img, '$.uid') AS u, f.kind FROM _sync_capture c
           LEFT JOIN _sync_frame f ON f.frame = c.frame WHERE c.seq > ? ORDER BY c.seq`,
      )
      .all(before) as Array<{ op: string; u: string; kind: string | null }>;
    // Exactly one capture: the re-mint K, NULL -> the new uid, in a remint frame.
    expect(after).toHaveLength(1);
    expect(after[0]?.op).toBe('K');
    expect(JSON.parse(after[0]?.u as string)).toEqual(['NULL', `'${now}'`]);
    expect(after[0]?.kind).toBe('remint');

    // A second open finds nothing left to re-mint.
    const seen = maxSeq(again);
    const third = await open();
    expect(maxSeq(third)).toBe(seen);
  });
});
