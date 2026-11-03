/**
 * T14210 — binding a project domain on a store already at head takes no write
 * lock. The cold-open writer lease serialises establish's schema WRITES; its
 * claim is a BEGIN IMMEDIATE, so every first bind in a process waited behind
 * any other writer (T14202's CI found it: two 30 s claims). A store each
 * domain reads as at head is now bound without the lease; anything else takes
 * the leased path unchanged.
 *
 * @task T14210
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { brainSchemaAtHead, getBrainDb, getBrainNativeDb } from '../memory-sqlite.js';
import { readMigrationFilesCached } from '../migration-files.js';
import { requiredColumnsPresent } from '../migration-manager.js';
import {
  closeAllDatabases,
  getDb,
  getDbPath,
  getNativeDb,
  resolveMigrationsFolder,
  tasksSchemaAtHead,
} from '../sqlite.js';

/** A statement slower than this waited on the held lock. */
const SLOW_STATEMENT_MS = 1_000;

describe('T14210 — cold open of a store at head', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-cold-open-at-head-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    // An earlier process created, migrated and seeded the store.
    await getDb(projectRoot);
    await getBrainDb(projectRoot);
    await closeAllDatabases();
  });

  afterEach(async () => {
    await closeAllDatabases();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /** Statements that took the write lock or waited on it while `fn` ran. */
  async function lockActivity(fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const record = (sql: string, ms: number, error: unknown): void => {
      const locked = error instanceof Error && /database is locked/.test(error.message);
      if (/^\s*BEGIN\s+IMMEDIATE/i.test(sql) || locked || ms > SLOW_STATEMENT_MS)
        seen.push(`${ms.toFixed(0)} ms${locked ? ' (locked)' : ''}: ${sql}\n${new Error().stack}`);
    };
    const wrap = <A extends unknown[], R>(
      sqlOf: (self: { sourceSQL?: string }, args: A) => string,
      original: (...args: A) => R,
    ) =>
      function (this: { sourceSQL?: string }, ...args: A): R {
        const start = performance.now();
        let error: unknown;
        try {
          return original.apply(this, args);
        } catch (err) {
          error = err;
          throw err;
        } finally {
          record(sqlOf(this, args), performance.now() - start, error);
        }
      };
    const exec = DatabaseSync.prototype.exec;
    const stmt = StatementSync.prototype;
    const originals = { run: stmt.run, get: stmt.get, all: stmt.all };
    DatabaseSync.prototype.exec = wrap((_self, [sql]: [string]) => sql, exec);
    for (const name of ['run', 'get', 'all'] as const)
      Object.assign(stmt, { [name]: wrap((self) => self.sourceSQL ?? '?', originals[name]) });
    try {
      await fn();
    } finally {
      DatabaseSync.prototype.exec = exec;
      Object.assign(stmt, originals);
    }
    return seen;
  }

  /** Hold the write lock from another connection while `fn` runs. */
  async function underWriteLock(fn: () => Promise<void>): Promise<void> {
    const locker = new DatabaseSync(getDbPath(projectRoot));
    locker.exec('BEGIN IMMEDIATE');
    try {
      await fn();
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
    }
  }

  /** The newest cold-open lease epoch the store has granted (0 for none). */
  function leaseEpoch(): number {
    const reader = new DatabaseSync(getDbPath(projectRoot));
    try {
      const row = reader
        .prepare(
          "SELECT COALESCE(MAX(epoch), 0) AS epoch FROM _writer_leases WHERE scope = 'project' AND lane = 'tasks'",
        )
        .get() as { epoch: number };
      return row.epoch;
    } finally {
      reader.close();
    }
  }

  it('AC1/AC3: a fresh process binds the tasks and brain domains under a held write lock and reads, with no BEGIN IMMEDIATE', async () => {
    const epoch = leaseEpoch();
    let elapsed = 0;
    let activity: string[] = [];
    await underWriteLock(async () => {
      activity = await lockActivity(async () => {
        const start = performance.now();
        await getDb(projectRoot);
        await getBrainDb(projectRoot);
        const meta = getNativeDb(projectRoot)
          ?.prepare('SELECT count(*) AS n FROM tasks_schema_meta')
          .get() as { n: number } | undefined;
        const brain = getBrainNativeDb(projectRoot)
          ?.prepare('SELECT count(*) AS n FROM brain_decisions')
          .get() as { n: number } | undefined;
        expect(meta?.n).toBeGreaterThan(0);
        expect(brain?.n).toBe(0);
        elapsed = performance.now() - start;
      });
    });
    // Every statement the bind ran, establish included, took no write lock.
    expect(activity, activity.join('\n\n')).toEqual([]);
    expect(elapsed).toBeLessThan(2_000);
    expect(leaseEpoch()).toBe(epoch);
  }, 120_000);

  it('the at-head probes read a freshly migrated store as current', async () => {
    await getDb(projectRoot);
    await getBrainDb(projectRoot);
    const native = getNativeDb(projectRoot);
    if (!native) throw new Error('no store');
    expect(tasksSchemaAtHead(native)).toBe(true);
    expect(brainSchemaAtHead(native)).toBe(true);
  });

  it('AC2: a pending migration, a missing seed or a missing column is not at head, and the bind takes the lease', async () => {
    await getDb(projectRoot);
    await getBrainDb(projectRoot);
    const native = getNativeDb(projectRoot);
    if (!native) throw new Error('no store');

    // A drizzle-tasks migration whose journal row is gone is pending.
    const newest = readMigrationFilesCached(resolveMigrationsFolder()).at(-1);
    if (!newest) throw new Error('no drizzle-tasks migrations');
    const journal = native
      .prepare('SELECT id, hash, created_at, name FROM "__drizzle_migrations" WHERE hash = ?')
      .get(newest.hash) as { id: number; hash: string; created_at: number; name: string };
    native.prepare('DELETE FROM "__drizzle_migrations" WHERE id = ?').run(journal.id);
    const pending = tasksSchemaAtHead(native);
    native
      .prepare(
        'INSERT INTO "__drizzle_migrations" (id, hash, created_at, name) VALUES (?, ?, ?, ?)',
      )
      .run(journal.id, journal.hash, journal.created_at, journal.name);
    expect(pending).toBe(false);
    expect(tasksSchemaAtHead(native)).toBe(true);

    // A missing seed.
    native.exec("DELETE FROM brain_schema_meta WHERE key = 'schemaVersion'");
    expect(brainSchemaAtHead(native)).toBe(false);
    native.exec("DELETE FROM tasks_schema_meta WHERE key = 'task_id_sequence'");
    expect(tasksSchemaAtHead(native)).toBe(false);

    // A missing column (the same list ensureColumns repairs).
    expect(requiredColumnsPresent(native, 'tasks', [{ name: 'no_such_column', ddl: 'text' }])).toBe(
      false,
    );
    expect(requiredColumnsPresent(native, 'no_such_table', [{ name: 'x', ddl: 'text' }])).toBe(
      true,
    );

    // A fresh process binding that store takes the lease (its epoch moves) and repairs it.
    await closeAllDatabases();
    const epoch = leaseEpoch();
    await getDb(projectRoot);
    await getBrainDb(projectRoot);
    expect(leaseEpoch()).toBeGreaterThan(epoch);
    const repaired = getNativeDb(projectRoot);
    if (!repaired) throw new Error('no store');
    expect(tasksSchemaAtHead(repaired)).toBe(true);
    expect(brainSchemaAtHead(repaired)).toBe(true);
  });
});
