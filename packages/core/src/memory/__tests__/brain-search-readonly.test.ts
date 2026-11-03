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
import { DatabaseSync } from 'node:sqlite';
import type { SearchBrainCompactResult } from '@cleocode/contracts/memory/search.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeBrainDb, getBrainDbPath, getBrainNativeDb } from '../../store/memory-sqlite.js';
import { closeDb } from '../../store/sqlite.js';
import { resetFts5Cache, searchBrain, staleFts5Tables } from '../brain-search.js';

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

  /** Hold the store's write lock from another connection while `fn` runs. */
  async function underWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const locker = new DatabaseSync(getBrainDbPath(projectRoot));
    locker.exec('BEGIN IMMEDIATE');
    try {
      return await fn();
    } finally {
      locker.exec('ROLLBACK');
      locker.close();
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
      expect(performance.now() - start).toBeLessThan(5_000);
    });
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
    const db = await nativeDb();
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
