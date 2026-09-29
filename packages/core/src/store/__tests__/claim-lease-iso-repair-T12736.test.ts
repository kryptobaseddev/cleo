/**
 * T12736 repair migration — a store where t12502 (task claim leases) was only
 * half applied gets its ISO-8601 guard and the `idx_tasks_sessions_spawned_by`
 * index back through the REAL project open path, and a fully migrated store is
 * unaffected.
 *
 * The half-applied state is the one observed on a live store: the t12502
 * journal row is present, its four columns, index on `claimed_by_session`,
 * `spawned_by_session_id` column and three release triggers exist, but the two
 * column CHECKs and `idx_tasks_sessions_spawned_by` are missing. SQLite cannot
 * drop a CHECK from a column, so the test rewrites the table's stored DDL.
 *
 * @task T12736
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetDualScopeDbCache,
  getDualScopeNativeDb,
  openDualScopeDbAtPath,
} from '../dual-scope-db.js';

const T12502 = '20260929120000_t12502-task-claim-leases';
const T12736 = '20260929130000_t12736-claim-lease-iso-repair';
const REPAIR_TRIGGERS = ['tasks_tasks_lease_iso_insert', 'tasks_tasks_lease_iso_update'];
const SPAWNED_BY_INDEX = 'idx_tasks_sessions_spawned_by';
const ISO = '2026-09-29T10:00:00.000Z';

let testDir: string;
let dbPath: string;

beforeEach(() => {
  testDir = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-claim-lease-repair-T12736-')));
  dbPath = join(testDir, '.cleo', 'cleo.db');
});

afterEach(() => {
  _resetDualScopeDbCache();
  rmSync(testDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

async function openProject(): Promise<DatabaseSync> {
  return getDualScopeNativeDb(await openDualScopeDbAtPath('project', dbPath));
}

function objectExists(db: DatabaseSync, type: 'index' | 'trigger', name: string): boolean {
  const row = db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name);
  return row !== undefined;
}

function tableSql(db: DatabaseSync): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'tasks_tasks'")
    .get() as { sql: string } | undefined;
  return row?.sql ?? '';
}

/**
 * Turn a fully migrated store into the half-applied one: drop the repair's
 * objects and journal row, drop the index, and strip both CHECKs from the
 * stored `tasks_tasks` DDL.
 */
function simulateHalfApplied(): void {
  const raw = new DatabaseSync(dbPath, { defensive: false });
  try {
    for (const name of REPAIR_TRIGGERS) raw.exec(`DROP TRIGGER IF EXISTS ${name}`);
    raw.exec(`DROP INDEX IF EXISTS ${SPAWNED_BY_INDEX}`);
    raw.prepare('DELETE FROM __drizzle_migrations WHERE name = ?').run(T12736);
    const before = tableSql(raw);
    const stripped = before.replace(
      /\s+CHECK\s*\(\s*"(claimed_at|lease_expires_at)" IS NULL OR "\1" GLOB '[^']*'\s*\)/g,
      '',
    );
    expect(stripped, 'both claim CHECKs are present before stripping').not.toBe(before);
    expect(stripped).not.toMatch(/"(claimed_at|lease_expires_at)" GLOB/);
    const version = raw.prepare('PRAGMA schema_version').get() as { schema_version: number };
    raw.exec('PRAGMA writable_schema = ON');
    raw
      .prepare("UPDATE sqlite_master SET sql = ? WHERE type = 'table' AND name = 'tasks_tasks'")
      .run(stripped);
    raw.exec(`PRAGMA schema_version = ${version.schema_version + 1}`);
    raw.exec('PRAGMA writable_schema = OFF');
  } finally {
    raw.close();
  }
  const check = new DatabaseSync(dbPath);
  try {
    expect(
      (check.prepare('PRAGMA integrity_check').get() as { integrity_check: string })
        .integrity_check,
    ).toBe('ok');
    expect(tableSql(check)).not.toMatch(/claimed_at" GLOB/);
    expect(objectExists(check, 'index', SPAWNED_BY_INDEX)).toBe(false);
    // The half-applied store really accepts a non-ISO lease (the defect).
    check
      .prepare("INSERT INTO tasks_tasks (id, title, claimed_at) VALUES ('T9999', 'x', 'yesterday')")
      .run();
    check.prepare("DELETE FROM tasks_tasks WHERE id = 'T9999'").run();
    expect(
      check.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(T12502),
    ).toBeDefined();
    expect(
      check.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(T12736),
    ).toBeUndefined();
  } finally {
    check.close();
  }
}

/** Assert the repaired guard: non-ISO writes abort, ISO writes succeed, the index exists. */
function assertGuarded(db: DatabaseSync): void {
  expect(objectExists(db, 'index', SPAWNED_BY_INDEX)).toBe(true);
  for (const name of REPAIR_TRIGGERS) expect(objectExists(db, 'trigger', name)).toBe(true);
  expect(db.prepare('SELECT 1 FROM __drizzle_migrations WHERE name = ?').get(T12736)).toBeDefined();

  const insert = (id: string, claimedAt: string | null, leaseExpiresAt: string | null) =>
    db
      .prepare(
        'INSERT INTO tasks_tasks (id, title, claimed_at, lease_expires_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, id, claimedAt, leaseExpiresAt);
  expect(() => insert('T9001', 'yesterday', null)).toThrow();
  expect(() => insert('T9002', null, 'soon')).toThrow();
  insert('T9003', ISO, ISO);
  insert('T9004', null, null);

  const update = (column: 'claimed_at' | 'lease_expires_at', value: string | null) =>
    db.prepare(`UPDATE tasks_tasks SET ${column} = ? WHERE id = 'T9004'`).run(value);
  expect(() => update('claimed_at', 'not-a-date')).toThrow();
  expect(() => update('lease_expires_at', '12345')).toThrow();
  update('claimed_at', ISO);
  update('lease_expires_at', ISO);
  update('lease_expires_at', null);

  expect(db.prepare("SELECT id FROM tasks_tasks WHERE id LIKE 'T900%' ORDER BY id").all()).toEqual([
    { id: 'T9003' },
    { id: 'T9004' },
  ]);
}

describe('T12736 claim-lease ISO repair migration', () => {
  it('guards a fully migrated store (CHECKs present) without changing behaviour', async () => {
    const db = await openProject();
    expect(tableSql(db)).toMatch(/"claimed_at" GLOB/);
    assertGuarded(db);
  });

  it('repairs a half-applied t12502 store: runs (not stamps) the repair on the next open', async () => {
    await openProject();
    _resetDualScopeDbCache();
    simulateHalfApplied();

    const db = await openProject();
    // The CHECKs are still gone (no table rebuild); the triggers now enforce them.
    expect(tableSql(db)).not.toMatch(/"claimed_at" GLOB/);
    assertGuarded(db);
  });

  it('is a no-op on a reopen', async () => {
    await openProject();
    _resetDualScopeDbCache();
    simulateHalfApplied();
    await openProject();
    _resetDualScopeDbCache();
    const db = await openProject();
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM __drizzle_migrations WHERE name = ?')
      .get(T12736) as { n: number };
    expect(rows.n).toBe(1);
    assertGuarded(db);
  });
});
