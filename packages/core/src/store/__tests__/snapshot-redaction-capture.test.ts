/**
 * Snapshot redaction on a store with sync capture on (T13042). A snapshot of
 * such a store keeps its capture triggers, so clearing columns in it must not
 * journal the cleared values into the snapshot's own `_sync_capture`, and the
 * vault empties the local-only change journal from the snapshot.
 *
 * Every store is a temp project under a `mkdtemp` directory.
 *
 * @task T13042
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../dual-scope-db.js';
import { clearSnapshotColumns, clearSnapshotTables } from '../portable-bundle-scan.js';
import { setCaptureEnabled } from '../sync/capture.js';

const _require = createRequire(import.meta.url);
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof DatabaseSyncType>) => DatabaseSyncType;
};

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../migrations/sync-journal');
const SECRET = 'STRIPPED-VALUE-7f3a';

let root: string;
let liveDb: string;

const count = (db: DatabaseSyncType, sql: string) =>
  Number(Object.values(db.prepare(sql).get() as Record<string, unknown>)[0]);

/** A capture-on project store with one task whose description holds {@link SECRET}. */
async function captureStoreWithTask(): Promise<void> {
  const h = await openDualScopeDbAtPath('project', liveDb, undefined, { dedicated: true });
  const db = h.db.$client as DatabaseSyncType;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  db.prepare(
    "INSERT INTO tasks_tasks (id, title, type, status, description) VALUES ('T1', 't', 'task', 'pending', ?)",
  ).run(SECRET);
  h.close();
}

/** A VACUUM copy of the live store, as the bundle export stages it. */
function snapshot(): string {
  const snap = join(root, 'snapshot.db');
  const live = new DatabaseSync(liveDb, { readOnly: true });
  live.exec(`VACUUM INTO '${snap.replaceAll("'", "''")}'`);
  live.close();
  return snap;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cleo-snapshot-redaction-'));
  const cleoDir = join(root, 'project', '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  mkdirSync(join(root, 'cleo-home'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(root, 'cleo-home'));
  vi.stubEnv('CLEO_DIR', cleoDir);
  vi.stubEnv('CLEO_ROOT', undefined);
  liveDb = join(cleoDir, 'cleo.db');
});

afterEach(async () => {
  const { closeDb } = await import('../sqlite.js');
  closeDb();
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('snapshot redaction with capture on (T13042)', () => {
  it("clearing a column never writes into the snapshot's own capture tables", async () => {
    await captureStoreWithTask();
    const snap = snapshot();
    const before = new DatabaseSync(snap, { readOnly: true });
    const captures = count(before, 'SELECT count(*) FROM _sync_capture');
    const undo = count(before, 'SELECT count(*) FROM _sync_undo');
    // The capture triggers came along in the snapshot.
    expect(
      count(
        before,
        "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, 10) = '_sync_cap_'",
      ),
    ).toBeGreaterThan(0);
    before.close();

    const cleared = clearSnapshotColumns(snap, { tasks_tasks: ['description'] });
    expect(cleared).toMatchObject([{ table: 'tasks_tasks', columns: ['description'], rows: 1 }]);

    const after = new DatabaseSync(snap, { readOnly: true });
    expect(count(after, 'SELECT count(*) FROM _sync_capture')).toBe(captures);
    expect(count(after, 'SELECT count(*) FROM _sync_undo')).toBe(undo);
    expect(
      count(
        after,
        "SELECT count(*) FROM tasks_tasks WHERE description IS NOT NULL AND description <> ''",
      ),
    ).toBe(0);
    // The suspension was lifted inside the snapshot's transaction.
    expect(count(after, 'SELECT count(*) FROM cleo_trigger_suspend')).toBe(0);
    after.close();
  });

  it('the local-only change journal is emptied and its images leave no bytes behind', async () => {
    await captureStoreWithTask();
    const snap = snapshot();
    const before = new DatabaseSync(snap, { readOnly: true });
    expect(count(before, 'SELECT count(*) FROM _sync_capture')).toBeGreaterThan(0);
    const tasks = count(before, 'SELECT count(*) FROM tasks_tasks');
    before.close();

    clearSnapshotColumns(snap, { tasks_tasks: ['description'] });
    const emptied = clearSnapshotTables(snap, [
      '_sync_capture',
      '_sync_undo',
      '_sync_frame',
      'absent_table',
    ]);
    expect(emptied.map((e) => e.table)).toContain('_sync_capture');
    expect(emptied.every((e) => e.rows > 0)).toBe(true);

    const after = new DatabaseSync(snap, { readOnly: true });
    for (const t of ['_sync_capture', '_sync_undo', '_sync_frame']) {
      expect({ t, n: count(after, `SELECT count(*) FROM ${t}`) }).toEqual({ t, n: 0 });
    }
    expect(count(after, 'SELECT count(*) FROM tasks_tasks')).toBe(tasks);
    after.close();
    // secure_delete + VACUUM: the captured description is gone from the file.
    expect(readFileSync(snap).includes(Buffer.from(SECRET))).toBe(false);
  });

  it('a snapshot without the suspension table (a plain store) is still cleared', () => {
    const snap = join(root, 'plain.db');
    const db = new DatabaseSync(snap);
    db.exec("CREATE TABLE t (id TEXT PRIMARY KEY, secret TEXT); INSERT INTO t VALUES ('a', 'x');");
    db.exec(
      'CREATE TABLE _sync_capture (seq INTEGER PRIMARY KEY, v TEXT); INSERT INTO _sync_capture (v) VALUES (1);',
    );
    db.close();
    expect(clearSnapshotColumns(snap, { t: ['secret'] })).toMatchObject([{ table: 't', rows: 1 }]);
    expect(clearSnapshotTables(snap, ['_sync_capture'])).toEqual([
      { table: '_sync_capture', rows: 1 },
    ]);
    const after = new DatabaseSync(snap, { readOnly: true });
    expect(count(after, 'SELECT count(*) FROM t WHERE secret IS NOT NULL')).toBe(0);
    expect(count(after, 'SELECT count(*) FROM _sync_capture')).toBe(0);
    after.close();
  });
});
