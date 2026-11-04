/**
 * T14202 — a read-only memory search never writes and never waits on another
 * writer. Each CLI call is a new process, and the first BRAIN search in a
 * process used to rebuild every FTS index (a write), so under any held write
 * lock `cleo memory find` waited out the 30 s busy timeout.
 *
 * Every test starts like a new process ({@link resetFts5Cache}) with no warm-up
 * search under the lock.
 *
 * @task T14202
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, StatementSync } from 'node:sqlite';
import type { SearchBrainCompactResult } from '@cleocode/contracts/memory/search.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settleBackgroundOps } from '../../store/background-ops.js';
import { closeBrainDb, getBrainDbPath, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { closeAllDatabases, closeDb, getDb } from '../../store/sqlite.js';
import { resetFts5Cache, searchBrain, staleFts5Tables } from '../brain-search.js';

/** A statement slower than this waited on the held lock (the read path's own timeout is 250 ms). */
const SLOW_STATEMENT_MS = 1_000;

describe('T14202 — read-only BRAIN search', () => {
  let projectRoot: string;
  let prevCleoDir: string | undefined;
  let prevCwd: string;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'cleo-brain-readonly-'));
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
    mkdirSync(join(projectRoot, '.git'), { recursive: true });
    prevCleoDir = process.env['CLEO_DIR'];
    process.env['CLEO_DIR'] = join(projectRoot, '.cleo');
    prevCwd = process.cwd();
    process.chdir(projectRoot);
    const { storeDecision } = await import('../decisions.js');
    await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Backup retention keeps ten snapshots',
      rationale: 'Enough history for a week.',
      confidence: 'high',
      confirmationState: 'accepted',
    });
    // The store as an earlier CLI process leaves it: every command binds the
    // tasks domain (`cleo init` first), so its lineage is migrated and seeded.
    // Then every binding is dropped, so the test's first tasks read cold-binds
    // like a new process (T14210 AC4).
    await getDb(projectRoot);
    await closeAllDatabases();
  });

  afterEach(() => {
    resetFts5Cache();
    closeBrainDb();
    closeDb();
    process.chdir(prevCwd);
    if (prevCleoDir === undefined) delete process.env['CLEO_DIR'];
    else process.env['CLEO_DIR'] = prevCleoDir;
    rmSync(projectRoot, { recursive: true, force: true });
  });

  /**
   * Hold the store's write lock from another connection while `fn` runs, and
   * fail naming every statement that waited on it (over {@link SLOW_STATEMENT_MS},
   * with its SQL and the stack that ran it), so a regression names its call site.
   */
  async function underWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const slow: string[] = [];
    const timed = <A extends unknown[], R>(
      label: (self: { sourceSQL?: string }, args: A) => string,
      original: (this: unknown, ...args: A) => R,
    ) =>
      function (this: { sourceSQL?: string }, ...args: A): R {
        const start = performance.now();
        try {
          return original.apply(this, args);
        } finally {
          const ms = performance.now() - start;
          if (ms > SLOW_STATEMENT_MS)
            slow.push(`${ms.toFixed(0)} ms: ${label(this, args)}\n${new Error().stack ?? ''}`);
        }
      };
    const execOriginal = DatabaseSync.prototype.exec;
    const stmt = StatementSync.prototype;
    const originals = { run: stmt.run, get: stmt.get, all: stmt.all };
    DatabaseSync.prototype.exec = timed((_self, [sql]: [string]) => sql, execOriginal);
    for (const name of ['run', 'get', 'all'] as const)
      Object.assign(stmt, { [name]: timed((self) => self.sourceSQL ?? '?', originals[name]) });
    const locker = new DatabaseSync(getBrainDbPath(projectRoot));
    locker.exec('BEGIN IMMEDIATE');
    try {
      const waited = () => `statements that waited on the held lock:\n${slow.join('\n\n')}`;
      let result: T;
      try {
        result = await fn();
      } catch (err) {
        if (slow.length > 0 && err instanceof Error) err.message = `${err.message}\n${waited()}`;
        throw err;
      }
      expect(slow, waited()).toEqual([]);
      return result;
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
      DatabaseSync.prototype.exec = execOriginal;
      Object.assign(stmt, originals);
    }
  }

  /** Retrieval-log rows for `query`, read on a separate connection (0 when the table is absent). */
  function retrievalLogRows(query: string): number {
    const reader = new DatabaseSync(getBrainDbPath(projectRoot));
    try {
      const table = reader
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('brain_retrieval_log');
      if (table === undefined) return 0;
      const row = reader
        .prepare('SELECT count(*) AS n FROM brain_retrieval_log WHERE query = ?')
        .get(query) as { n: number };
      return row.n;
    } finally {
      reader.close();
    }
  }

  async function nativeDb(): Promise<DatabaseSync> {
    const { getBrainDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(projectRoot);
    const db = getBrainNativeDb(projectRoot);
    if (!db) throw new Error('no brain store');
    return db;
  }

  it('AC1/AC3: with the index in step, a new process searches under a held write lock without writing or waiting', async () => {
    // A first search builds the index, as an earlier process would have.
    expect((await searchBrain(projectRoot, 'retention')).decisions).toHaveLength(1);
    expect(staleFts5Tables(await nativeDb())).toEqual([]);
    resetFts5Cache();

    const { memoryFind } = await import('../engine-compat.js');
    await underWriteLock(async () => {
      const start = performance.now();
      const found = await searchBrain(projectRoot, 'retention');
      expect(found.decisions.map((d) => d.decision)).toEqual([
        'Backup retention keeps ten snapshots',
      ]);
      const compact = await memoryFind(
        {
          query: 'backup retention',
          tables: ['decisions', 'patterns', 'learnings', 'observations'],
        },
        projectRoot,
      );
      expect(compact.success, JSON.stringify(compact.error)).toBe(true);
      expect((compact.data as SearchBrainCompactResult).results.map((h) => h.type)).toContain(
        'decision',
      );
      // The retrieval-log row is a background write the CLI settles before it
      // exits: under the lock it is dropped, so the whole call, settle
      // included, stays well under the CLI's 5 s settle budget.
      expect(await settleBackgroundOps(5_000)).toBe(0);
      expect(performance.now() - start).toBeLessThan(2_000);
    });
    expect(retrievalLogRows('backup retention')).toBe(0);

    // With the store free the row is written as before.
    await memoryFind(
      { query: 'backup retention', tables: ['decisions', 'patterns', 'learnings', 'observations'] },
      projectRoot,
    );
    expect(await settleBackgroundOps(5_000)).toBe(0);
    expect(retrievalLogRows('backup retention')).toBeGreaterThan(0);
  });

  it('AC2: a stale index is rebuilt when the store is free, and searched as it stands when not', async () => {
    expect((await searchBrain(projectRoot, 'retention')).decisions).toHaveLength(1);
    const db = await nativeDb();
    // A row written past the content-sync triggers leaves the index behind.
    db.exec('DROP TRIGGER brain_decisions_ai');
    const { storeDecision } = await import('../decisions.js');
    await storeDecision(projectRoot, {
      type: 'technical',
      decision: 'Snapshots are pruned weekly',
      rationale: 'Disk.',
      confidence: 'medium',
      confirmationState: 'accepted',
    });
    expect(staleFts5Tables(db)).toEqual(['brain_decisions']);
    resetFts5Cache();

    await underWriteLock(async () => {
      const start = performance.now();
      const found = await searchBrain(projectRoot, 'snapshots');
      // The stale index is still searched; the unindexed row waits for the rebuild.
      expect(found.decisions.map((d) => d.decision)).toEqual([
        'Backup retention keeps ten snapshots',
      ]);
      expect(performance.now() - start).toBeLessThan(5_000);
    });
    expect(staleFts5Tables(db)).toEqual(['brain_decisions']);

    const repaired = await searchBrain(projectRoot, 'snapshots');
    expect(repaired.decisions).toHaveLength(2);
    expect(staleFts5Tables(db)).toEqual([]);
  });

  it('AC2/AC3: a missing index under a held write lock falls back to a plain search', async () => {
    // The indexes exist and are in step, as an earlier process left them.
    expect((await searchBrain(projectRoot, 'retention')).decisions).toHaveLength(1);
    const db = await nativeDb();
    expect(staleFts5Tables(db)).toEqual([]);
    db.exec('DROP TABLE IF EXISTS brain_decisions_fts');
    resetFts5Cache();

    await underWriteLock(async () => {
      const start = performance.now();
      const found = await searchBrain(projectRoot, 'retention');
      expect(found.decisions).toHaveLength(1);
      expect(performance.now() - start).toBeLessThan(5_000);
    });
    expect(staleFts5Tables(db)).toEqual(['brain_decisions']);
    await searchBrain(projectRoot, 'retention');
    expect(staleFts5Tables(db)).toEqual([]);
  });
});
