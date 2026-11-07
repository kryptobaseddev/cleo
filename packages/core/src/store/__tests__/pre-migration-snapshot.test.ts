/**
 * The pre-migration snapshot of a project store and the stored-`active`
 * retire migration (T14268, owner decision D11230).
 *
 * - The runner hands `beforePendingMigrations` the pending files before any
 *   other hook or bracket, and not at all for a lineage at head.
 * - A pending set with data DML is refused when its snapshot cannot be
 *   written; a schema-only set proceeds with a warning.
 * - Opening a real project store with the retire migration pending writes one
 *   `cleo.db.migration-<stamp>` snapshot (the family #2693's byte cap rotates),
 *   then one audit row per retired task.
 *
 * @task T14268
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MigrationSnapshotRequiredError,
  pendingHasDataDml,
  runBracketedMigrations,
} from '../migration-runner.js';
import { snapshotBeforePendingMigrations } from '../pre-repair-snapshot.js';
import { getNativeTasksDb, resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

/** #2693's grouping of a typed system backup: `<db>.<type>-<stamp>`. */
const TYPED_BACKUP = /^(.+)\.(snapshot|migration)-(\d{8}-\d{6})$/;

const meta = (name: string, sql: string[]): MigrationMeta =>
  ({ name, sql, hash: name, folderMillis: 0, bps: true }) as MigrationMeta;

describe('pendingHasDataDml (T14268)', () => {
  it('counts INSERT/UPDATE/DELETE/REPLACE, including a rebuild copy; DDL alone is schema-only', () => {
    expect(pendingHasDataDml([meta('a', ['ALTER TABLE t ADD COLUMN c TEXT;'])])).toBe(false);
    expect(pendingHasDataDml([meta('a', ['CREATE INDEX i ON t (c);'])])).toBe(false);
    expect(pendingHasDataDml([meta('a', ["UPDATE t SET s = 'p' WHERE s = 'a';"])])).toBe(true);
    expect(
      pendingHasDataDml([
        meta('a', ['CREATE TABLE `__new_t` (id TEXT);', 'INSERT INTO `__new_t` SELECT id FROM t;']),
      ]),
    ).toBe(true);
  });
});

describe('runner: beforePendingMigrations (T14268)', () => {
  let dir: string;
  let db: DatabaseSync;
  let folder: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-premigrate-'));
    folder = join(dir, 'lineage');
    for (const [name, sql] of [
      ['20260101000001_m1', 'CREATE TABLE q (id TEXT PRIMARY KEY);'],
      ['20260101000002_m2', "INSERT INTO q VALUES ('Q1');"],
    ] as const) {
      mkdirSync(join(folder, name), { recursive: true });
      writeFileSync(join(folder, name, 'migration.sql'), sql);
    }
    db = new DatabaseSync(join(dir, 'store.db'));
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs first, with every pending file, and not again once the lineage is at head', () => {
    const log: string[] = [];
    const hooks = {
      beforePendingMigrations: (_d: DatabaseSync, pending: readonly MigrationMeta[]) =>
        log.push(`pending(${pending.map((m) => m.name).join(',')})`),
      beforeMigrations: () => log.push('before'),
      suspendCapture: () => log.push('suspend'),
    };
    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }], hooks);
    expect(log[0]).toBe('pending(20260101000001_m1,20260101000002_m2)');
    expect(log[1]).toBe('before');
    log.length = 0;
    runBracketedMigrations(db, drizzle({ client: db }), [{ folder }], hooks);
    expect(log).toEqual([]);
  });

  it('a throwing hook refuses the migration: nothing is applied', () => {
    expect(() =>
      runBracketedMigrations(db, drizzle({ client: db }), [{ folder }], {
        beforePendingMigrations: () => {
          throw new MigrationSnapshotRequiredError(['m2'], 'disk full');
        },
      }),
    ).toThrow(MigrationSnapshotRequiredError);
    const q = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'q'").get() as {
      n: number;
    };
    expect(q.n).toBe(0);
  });
});

describe('snapshotBeforePendingMigrations (T14268)', () => {
  let dir: string;
  let dbPath: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-premigrate-snap-'));
    dbPath = join(dir, 'cleo.db');
    db = new DatabaseSync(dbPath);
    db.exec(
      'CREATE TABLE "__drizzle_migrations" (id INTEGER PRIMARY KEY, hash TEXT, created_at INTEGER, name TEXT, applied_at TEXT)',
    );
    db.exec("INSERT INTO \"__drizzle_migrations\" (hash, name) VALUES ('h', 'm0')");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const dml = [meta('m1', ["UPDATE t SET s = 'p';"])];
  const ddl = [meta('m1', ['ALTER TABLE t ADD COLUMN c TEXT;'])];

  it('writes a cleo.db.migration-<stamp> snapshot and its sidecar', () => {
    const outcome = snapshotBeforePendingMigrations(db, dbPath, dml);
    expect(outcome.kind).toBe('snapshot');
    const files = readdirSync(join(dir, 'backups', 'sqlite'));
    const snap = files.find((f) => f.startsWith('cleo.db.migration-'));
    expect(snap).toMatch(TYPED_BACKUP);
    expect(files).toContain(`${snap?.slice('cleo.db.'.length)}.meta.json`);
  });

  it('refuses data DML when the snapshot fails; schema-only proceeds', () => {
    writeFileSync(join(dir, 'backups'), 'not a directory');
    expect(() => snapshotBeforePendingMigrations(db, dbPath, dml)).toThrow(
      MigrationSnapshotRequiredError,
    );
    expect(snapshotBeforePendingMigrations(db, dbPath, ddl).kind).toBe('skipped');
  });

  it('skips a new store no migration has run on', () => {
    db.exec('DELETE FROM "__drizzle_migrations"');
    expect(snapshotBeforePendingMigrations(db, dbPath, dml)).toMatchObject({ kind: 'skipped' });
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });
});

describe('retire migration on a real project store (T14268 AC4)', () => {
  let env: TestDbEnv;

  beforeEach(async () => {
    env = await createTestDb();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('snapshots first, then writes one audit row per retired task and stores pending', async () => {
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Was active', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'Pending', status: 'pending', priority: 'medium' },
    ]);
    const native = getNativeTasksDb(env.tempDir);
    if (!native) throw new Error('no native handle');
    // An older build's row: stored active, its lease long gone.
    native
      .prepare(
        "UPDATE tasks_tasks SET status = 'active', updated_at = '2026-10-01T00:00:00.000Z' WHERE id = 'T001'",
      )
      .run();
    native
      .prepare("DELETE FROM __drizzle_migrations WHERE name LIKE '%t14268-retire-active'")
      .run();
    await env.accessor.close();
    resetDbState();

    const reopened = await createSqliteDataAccessor(env.tempDir);
    try {
      const backups = readdirSync(join(env.cleoDir, 'backups', 'sqlite'));
      const snaps = backups.filter((f) => /^cleo\.db\.migration-/.test(f));
      expect(snaps).toHaveLength(1);
      // The snapshot was taken before the rewrite: it still holds the old row.
      const snapshot = new DatabaseSync(
        join(env.cleoDir, 'backups', 'sqlite', snaps[0] as string),
        {
          readOnly: true,
        },
      );
      try {
        expect(snapshot.prepare("SELECT status FROM tasks_tasks WHERE id = 'T001'").get()).toEqual({
          status: 'active',
        });
      } finally {
        snapshot.close();
      }

      const db = getNativeTasksDb(env.tempDir);
      const rows = db
        ?.prepare("SELECT id, status FROM tasks_tasks WHERE id IN ('T001', 'T002') ORDER BY id")
        .all();
      expect(rows).toEqual([
        { id: 'T001', status: 'pending' },
        { id: 'T002', status: 'pending' },
      ]);
      const audit = db
        ?.prepare(
          "SELECT id, task_id, timestamp, action FROM tasks_audit_log WHERE action = 'task_active_retired'",
        )
        .all();
      expect(audit).toEqual([
        {
          id: 't14268-retire-active-T001',
          task_id: 'T001',
          timestamp: '2026-10-01T00:00:00.000Z',
          action: 'task_active_retired',
        },
      ]);
    } finally {
      await reopened.close();
      resetDbState();
    }

    // A second open finds the lineage at head: no second snapshot.
    const again = await createSqliteDataAccessor(env.tempDir);
    await again.close();
    resetDbState();
    const backups = readdirSync(join(env.cleoDir, 'backups', 'sqlite'));
    expect(backups.filter((f) => /^cleo\.db\.migration-/.test(f))).toHaveLength(1);
  });
});
