/**
 * Journal parity of the bracketed migration runner with drizzle's
 * `migrateSync` (journal spec §2.3a rule 2; R5-3, T12796).
 *
 * On each store shape, the old path (`reconcileJournal` + `migrateWithRetry`,
 * or `migrateSanitized` per folder) runs on one copy and the runner on an
 * identical copy. The journals must match row for row (`applied_at` compared
 * only for NULL-ness) and so must the schema. The next reconcile on the
 * runner's copy must pass the #1719 drift check and find nothing pending.
 *
 * Shapes: fresh; a v0 journal (claude-todo); a stamped store (journal entries
 * missing for applied migrations, Scenario 3); a store ahead of this install
 * (journal ahead of files); a drifted store (same name, different hash); and a
 * two-folder store sharing one journal.
 *
 * Every store is a file under a `mkdtemp` directory.
 *
 * @task T12796
 */

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { getMigrationsToRun } from 'drizzle-orm/migrator.utils';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateSanitized, migrateWithRetry, reconcileJournal } from '../migration-manager.js';
import {
  migrateBracketed,
  PINNED_DRIZZLE_VERSION,
  runBracketedMigrations,
} from '../migration-runner.js';

const MIGRATIONS = resolve(import.meta.dirname, '../../../migrations');
const PROJECT = join(MIGRATIONS, 'drizzle-cleo-project');
const TASKS = join(MIGRATIONS, 'drizzle-tasks');
const SIBLINGS = [
  'drizzle-tasks',
  'drizzle-nexus',
  'drizzle-brain',
  'drizzle-conduit',
  'drizzle-cleo-global',
  'drizzle-agent-registry',
  'drizzle-skills',
  'drizzle-telemetry',
].map((n) => join(MIGRATIONS, n));
const EXISTENCE = 'tasks_tasks';
const LOG = 'parity-test';

let dir: string;
const handles: DatabaseSync[] = [];

function open(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  handles.push(db);
  return db;
}

function wrap(db: DatabaseSync) {
  return drizzle({ client: db });
}

/** A lineage folder holding only the first `n` migrations of `from`. */
function partialFolder(from: string, n: number, name: string): string {
  const out = join(dir, name);
  mkdirSync(out, { recursive: true });
  const subdirs = readdirSync(from)
    .filter((d) => {
      try {
        return readFileSync(join(from, d, 'migration.sql')).length >= 0;
      } catch {
        return false;
      }
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, n);
  for (const d of subdirs) cpSync(join(from, d), join(out, d), { recursive: true });
  return out;
}

type Row = { id: number; hash: string; created_at: string; name: string | null; applied: number };

function journal(db: DatabaseSync): Row[] {
  const cols = (
    db.prepare('PRAGMA table_info("__drizzle_migrations")').all() as Array<{ name: string }>
  ).map((c) => c.name);
  const applied = cols.includes('applied_at') ? '(applied_at IS NOT NULL)' : '0';
  const name = cols.includes('name') ? 'name' : 'NULL';
  return db
    .prepare(
      `SELECT id, hash, CAST(created_at AS TEXT) AS created_at, ${name} AS name, ${applied} AS applied FROM "__drizzle_migrations" ORDER BY id`,
    )
    .all() as unknown as Row[];
}

function schema(db: DatabaseSync): Array<{ type: string; name: string; sql: string | null }> {
  return db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
}

/** Old path, as dual-scope-db ran it before the runner. */
function oldPath(db: DatabaseSync, folder = PROJECT): void {
  reconcileJournal(db, folder, EXISTENCE, LOG, SIBLINGS);
  migrateWithRetry(wrap(db), folder, db, EXISTENCE, LOG);
}

function newPath(db: DatabaseSync, folder = PROJECT): void {
  migrateBracketed(wrap(db), db, folder, EXISTENCE, LOG, SIBLINGS);
}

/** Copy a store file (and WAL, if any) after closing every handle on it. */
function copyStore(src: DatabaseSync, srcPath: string, dst: string): void {
  src.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  cpSync(srcPath, dst);
}

function expectParity(a: DatabaseSync, b: DatabaseSync): void {
  expect(journal(b)).toEqual(journal(a));
  expect(schema(b)).toEqual(schema(a));
}

function nextOpenIsClean(db: DatabaseSync, folder = PROJECT): void {
  expect(() => reconcileJournal(db, folder, EXISTENCE, LOG, SIBLINGS)).not.toThrow();
  const pending = getMigrationsToRun({
    localMigrations: readMigrationFiles({ migrationsFolder: folder }),
    dbMigrations: journal(db) as never,
  });
  expect(pending.map((m) => m.name)).toEqual([]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cleo-runner-parity-'));
});

afterEach(() => {
  for (const h of handles.splice(0)) {
    try {
      h.close();
    } catch {
      // already closed
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('drizzle pin', () => {
  it(`the installed drizzle-orm is ${PINNED_DRIZZLE_VERSION} (re-run this suite before upgrading)`, () => {
    const entry = readFileSync(
      resolve(import.meta.dirname, '../../../node_modules/drizzle-orm/package.json'),
      'utf8',
    );
    expect(JSON.parse(entry).version).toBe(PINNED_DRIZZLE_VERSION);
  });
});

describe('journal parity with migrateSync', () => {
  it('fresh store', () => {
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    oldPath(a);
    newPath(b);
    expect(journal(b).length).toBe(readMigrationFiles({ migrationsFolder: PROJECT }).length);
    expectParity(a, b);
    nextOpenIsClean(b);
  });

  it('store several releases behind (partial lineage, then the full one)', () => {
    const total = readMigrationFiles({ migrationsFolder: PROJECT }).length;
    const old = partialFolder(PROJECT, total - 4, 'partial');
    const seed = open(join(dir, 'seed.db'));
    oldPath(seed, old);
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'a.db'));
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'b.db'));
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    oldPath(a);
    newPath(b);
    expectParity(a, b);
    nextOpenIsClean(b);
  });

  it('v0 journal (claude-todo shape: no name / applied_at columns)', () => {
    const total = readMigrationFiles({ migrationsFolder: PROJECT }).length;
    const old = partialFolder(PROJECT, total - 3, 'partial');
    const seed = open(join(dir, 'seed.db'));
    oldPath(seed, old);
    seed.exec(`
      CREATE TABLE j0 (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric);
      INSERT INTO j0 (id, hash, created_at) SELECT id, hash, created_at FROM "__drizzle_migrations";
      DROP TABLE "__drizzle_migrations";
      ALTER TABLE j0 RENAME TO "__drizzle_migrations";
    `);
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'a.db'));
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'b.db'));
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    oldPath(a);
    newPath(b);
    expectParity(a, b);
    nextOpenIsClean(b);
  });

  it('stamped store: journal rows missing for applied migrations (Scenario 3)', () => {
    const seed = open(join(dir, 'seed.db'));
    oldPath(seed);
    // Forget the three newest journal rows; their DDL is present.
    seed.exec(
      'DELETE FROM "__drizzle_migrations" WHERE id IN (SELECT id FROM "__drizzle_migrations" ORDER BY id DESC LIMIT 3)',
    );
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'a.db'));
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'b.db'));
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    oldPath(a);
    newPath(b);
    expectParity(a, b);
    nextOpenIsClean(b);
  });

  it('store ahead of this install (journal ahead of the files)', () => {
    const seed = open(join(dir, 'seed.db'));
    oldPath(seed);
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'a.db'));
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'b.db'));
    const total = readMigrationFiles({ migrationsFolder: PROJECT }).length;
    const older = partialFolder(PROJECT, total - 2, 'older');
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    oldPath(a, older);
    newPath(b, older);
    expectParity(a, b);
    nextOpenIsClean(b, older);
  });

  it('drifted store: same name, different hash refuses identically and writes nothing', () => {
    const seed = open(join(dir, 'seed.db'));
    oldPath(seed);
    seed.exec(
      `UPDATE "__drizzle_migrations" SET hash = 'deadbeef' WHERE id = (SELECT max(id) FROM "__drizzle_migrations")`,
    );
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'a.db'));
    copyStore(seed, join(dir, 'seed.db'), join(dir, 'b.db'));
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    let errA: unknown;
    let errB: unknown;
    try {
      oldPath(a);
    } catch (e) {
      errA = e;
    }
    try {
      newPath(b);
    } catch (e) {
      errB = e;
    }
    expect(errA).toBeDefined();
    expect((errB as { code?: unknown }).code).toBe((errA as { code?: unknown }).code);
    expect(journal(b)).toEqual(journal(a));
    // The runner's refusal is atomic: the leading bracket rolls back, so the
    // store is exactly as it was. (The old path left reconcile's hash index.)
    expect(schema(b)).toEqual(schema(seed));
    expect(b.isTransaction).toBe(false);
  });

  it('two folders sharing one journal (migration-sqlite shape)', () => {
    const a = open(join(dir, 'a.db'));
    const b = open(join(dir, 'b.db'));
    migrateSanitized(wrap(a), { migrationsFolder: PROJECT });
    migrateSanitized(wrap(a), { migrationsFolder: TASKS });
    runBracketedMigrations(b, wrap(b), [{ folder: PROJECT }, { folder: TASKS }]);
    expectParity(a, b);
    for (const folder of [PROJECT, TASKS]) {
      const pending = getMigrationsToRun({
        localMigrations: readMigrationFiles({ migrationsFolder: folder }),
        dbMigrations: journal(b) as never,
      });
      expect(pending).toEqual([]);
    }
  });
});
