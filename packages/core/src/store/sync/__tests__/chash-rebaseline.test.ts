/**
 * A migration's backfill is never emitted, and the row-meta `chash` follows
 * it (journal spec §2.3a rule 3; B, T12775).
 *
 * Every store is a temp project `cleo.db` opened through the chokepoint, and
 * the migration runs through the real bracketed runner with the hooks the
 * canonical open passes.
 *
 * @task T12775
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetDualScopeDbCache, openDualScopeDbAtPath } from '../../dual-scope-db.js';
import { runBracketedMigrations } from '../../migration-runner.js';
import {
  captureTableDef,
  finishCaptureFrame,
  openCaptureFrame,
  setCaptureEnabled,
} from '../capture.js';
import { setSyncFlag } from '../flags.js';
import { syncMigrationHooks } from '../migration-hooks.js';
import {
  CHASH_BASELINE_KEY,
  rebaselineChash,
  rowChash,
  sealPending,
  syncSetVersion,
} from '../sealer.js';

const SYNC_SCHEMA = resolve(import.meta.dirname, '../../../../migrations/sync-journal');
const REPLICA = '01929a3e-7f00-7000-8000-000000000001';
const T0 = 1_790_000_000_000;

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-chash-rebaseline-'));
  mkdirSync(join(dir, 'project', '.cleo'), { recursive: true });
  mkdirSync(join(dir, 'cleo'), { recursive: true });
  vi.stubEnv('CLEO_HOME', join(dir, 'cleo'));
  vi.stubEnv('CLEO_ROOT', undefined);
  vi.stubEnv('CLEO_DIR', undefined);
  dbPath = join(dir, 'project', '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

async function store(): Promise<DatabaseSync> {
  const handle = await openDualScopeDbAtPath('project', dbPath);
  const db = handle.db.$client as DatabaseSync;
  setCaptureEnabled(db, 'project', true, { schemaRoot: SYNC_SCHEMA });
  setSyncFlag(db, 'sync.seal', true, { schemaRoot: SYNC_SCHEMA, allowUnreleased: true });
  return db;
}

let clock = T0;
const seal = (db: DatabaseSync) =>
  sealPending(db, {
    scope: 'project',
    replica: REPLICA,
    now: () => ++clock,
    env: {},
    allowUnreleased: true,
  });

function addTask(db: DatabaseSync, id: string): void {
  db.exec('BEGIN IMMEDIATE');
  const frame = openCaptureFrame(db, 'write', 'test');
  db.prepare(
    `INSERT INTO tasks_tasks (id, title, type, status, priority, uid, birth_fp)
     VALUES (?, ?, 'task', 'pending', 'medium', ?, ?)`,
  ).run(id, `title ${id}`, `uid-${id}`, `fp-${id}`);
  finishCaptureFrame(db, frame);
  db.exec('COMMIT');
}

const metaChash = (db: DatabaseSync, uid: string) =>
  (
    db.prepare("SELECT chash FROM _sync_row_meta WHERE tbl = 'tasks_tasks' AND uid = ?").get(uid) as
      | { chash: string | null }
      | undefined
  )?.chash;

const liveChash = (db: DatabaseSync, uid: string) => {
  const def = captureTableDef(db, 'project', 'tasks_tasks');
  if (!def) throw new Error('fixture: tasks_tasks is not in the sync set');
  return rowChash(db, 'project', def, uid);
};

const n = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as { n: number }).n;

function migrate(db: DatabaseSync, name: string, sql: string): void {
  const lineage = join(dir, 'extra');
  mkdirSync(join(lineage, name), { recursive: true });
  writeFileSync(join(lineage, name, 'migration.sql'), sql);
  runBracketedMigrations(
    db,
    drizzle({ client: db }),
    [{ folder: lineage }],
    syncMigrationHooks(db, 'project'),
  );
}

describe('migration backfills re-baseline chash and emit nothing (T12775)', () => {
  it('a data backfill in a migration is not captured, and row meta takes the new hash', async () => {
    const db = await store();
    addTask(db, 'T1');
    addTask(db, 'T2');
    seal(db);
    const before = metaChash(db, 'uid-T1');
    expect(before).toBe(liveChash(db, 'uid-T1'));
    const txns = n(db, 'SELECT count(*) AS n FROM _sync_txn');

    migrate(db, '20991231000000_backfill', 'UPDATE `tasks_tasks` SET `title` = upper(`title`)');

    expect(n(db, "SELECT count(*) AS n FROM _sync_capture WHERE state = 'live'")).toBe(0);
    expect(seal(db).txns).toBe(0);
    expect(n(db, 'SELECT count(*) AS n FROM _sync_txn')).toBe(txns);
    const after = metaChash(db, 'uid-T1');
    expect(after).not.toBe(before);
    expect(after).toBe(liveChash(db, 'uid-T1'));
    expect(metaChash(db, 'uid-T2')).toBe(liveChash(db, 'uid-T2'));
    const version = db
      .prepare('SELECT value FROM _sync_meta WHERE key = ?')
      .get(CHASH_BASELINE_KEY) as {
      value: string;
    };
    expect(version.value).toBe(syncSetVersion(db, 'project'));
  });

  it('a migration that adds a captured column moves the sync-set version', async () => {
    const db = await store();
    addTask(db, 'T1');
    seal(db);
    const v1 = syncSetVersion(db, 'project');
    migrate(db, '20991231000001_col', 'ALTER TABLE `tasks_tasks` ADD COLUMN `t12775_note` TEXT');
    expect(syncSetVersion(db, 'project')).not.toBe(v1);
  });

  it('a tombstone keeps the hash it was deleted with, and a second re-baseline changes nothing', async () => {
    const db = await store();
    addTask(db, 'T1');
    addTask(db, 'T2');
    seal(db);
    db.exec('BEGIN IMMEDIATE');
    const frame = openCaptureFrame(db, 'write', 'test');
    db.exec("DELETE FROM tasks_tasks WHERE id = 'T2'");
    finishCaptureFrame(db, frame);
    db.exec('COMMIT');
    seal(db);
    const tomb = metaChash(db, 'uid-T2');
    db.exec("INSERT INTO cleo_trigger_suspend (scope) VALUES ('capture')");
    db.exec("UPDATE tasks_tasks SET title = 'changed' WHERE id = 'T1'");
    db.exec('DELETE FROM cleo_trigger_suspend');
    expect(rebaselineChash(db, 'project').rows).toBe(1);
    expect(metaChash(db, 'uid-T2')).toBe(tomb);
    expect(rebaselineChash(db, 'project').rows).toBe(0);
  });

  it('a store that never sealed gets only the capture hooks', async () => {
    const handle = await openDualScopeDbAtPath('project', dbPath);
    const db = handle.db.$client as DatabaseSync;
    expect(syncMigrationHooks(db, 'project').afterMigration).toBeUndefined();
  });
});
