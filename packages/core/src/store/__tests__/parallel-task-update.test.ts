/**
 * Integration test for {@link withWriteRetry} against a real SQLite database.
 *
 * **Bug**: 19 parallel `cleo update <id> --add-labels …` invocations from a
 * single shell used to lose ~50% of writes to `SQLITE_BUSY: database is
 * locked` despite the engine-level `busy_timeout=5000ms` pragma. A serial
 * loop succeeded 19/19. This test pins the fix in place.
 *
 * **Test surface**: two complementary scenarios, both anchored on
 * {@link createSqliteDataAccessor} so they validate the production code
 * path used by the CLI, not a hand-rolled stub.
 *
 *  1. **In-process parallel `updateTaskFields`** — drives 10 concurrent
 *     `accessor.updateTaskFields(...)` calls against 10 distinct rows,
 *     each adding a unique label. Asserts all 10 promises resolve AND
 *     the persisted labels match expectations. node:sqlite serializes
 *     writes from one connection, but this still exercises the retry
 *     boundary because the BEGIN IMMEDIATE inside `saveArchive` /
 *     `updateTaskFields` could otherwise race the implicit transaction
 *     queue (verified empirically in gh#391 reproductions).
 *
 *  2. **Cross-connection contention** — opens an independent raw
 *     `node:sqlite` handle on the same database file, holds a RESERVED
 *     lock via `BEGIN IMMEDIATE`, then schedules an accessor
 *     `updateTaskFields()` call. Releases the lock after a brief delay.
 *     Asserts the accessor write SUCCEEDS thanks to the retry primitive
 *     instead of failing with `SQLITE_BUSY`. This is the precise shape
 *     of the parallel-shell repro.
 *
 * **Determinism**: both scenarios use short fixed delays (no
 * `setTimeout(.., random)`) and the retry primitive itself uses bounded
 * exponential backoff with jitter. The cross-connection lock release
 * happens via `await setTimeout(50)` — well inside the 5s
 * `busy_timeout` window, so the accessor's first attempt will either
 * succeed (lock released in time) or its first retry will (BUSY raised,
 * 100ms ± 50ms backoff, lock by then long gone). The test asserts only
 * eventual success, not which path got there.
 *
 * @bug gh-391
 * @task T9839
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetDbState } from '../sqlite.js';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';

describe('Parallel task updates (gh#391 SQLITE_BUSY retry)', () => {
  let testDir: string;
  let accessor: Awaited<ReturnType<typeof createSqliteDataAccessor>>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'cleo-gh391-'));
    // Pre-create `.cleo/` so resolveCleoDir resolves the temp dir (T11262).
    mkdirSync(join(testDir, '.cleo'), { recursive: true });
    resetDbState();
    accessor = await createSqliteDataAccessor(testDir);
  });

  afterEach(async () => {
    await accessor.close();
    resetDbState();
    rmSync(testDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('10 concurrent updateTaskFields() calls all succeed with no lost writes', async () => {
    // Seed 10 distinct task rows, each with an empty labels array.
    const N = 10;
    const seedTasks: Task[] = Array.from({ length: N }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      description: `Seed task #${i + 1} for gh#391 reproduction.`,
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      labels: [],
    }));
    for (const task of seedTasks) {
      await accessor.upsertSingleTask(task);
    }

    // Fire N parallel updateTaskFields calls. Each adds one unique label
    // to a different row. With retry, all should land; without retry,
    // some would be lost to SQLITE_BUSY mid-burst.
    const updates = seedTasks.map((task, i) =>
      accessor.updateTaskFields(task.id, {
        labelsJson: JSON.stringify([`label-${i + 1}`]),
        updatedAt: new Date().toISOString(),
      }),
    );
    const settled = await Promise.allSettled(updates);

    const fulfilled = settled.filter((r) => r.status === 'fulfilled').length;
    const rejected = settled
      .filter((r) => r.status === 'rejected')
      .map((r) => (r as PromiseRejectedResult).reason);

    // CONTRACT: all 10 updates land. Any rejection is a regression.
    expect(rejected).toEqual([]);
    expect(fulfilled).toBe(N);

    // Verify persisted state: each row has exactly its assigned label.
    for (let i = 0; i < N; i++) {
      const id = `T${String(i + 1).padStart(3, '0')}`;
      const task = await accessor.loadSingleTask(id);
      expect(task, `task ${id} should exist`).not.toBeNull();
      expect(task?.labels).toEqual([`label-${i + 1}`]);
    }
  });

  it('cross-connection RESERVED lock contention is absorbed by retry', async () => {
    // Seed a single target row.
    const targetId = 'TLOCK';
    await accessor.upsertSingleTask({
      id: targetId,
      title: 'Lock contention target',
      description: 'gh#391 cross-connection BUSY repro.',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
      labels: [],
    });

    // Locate the underlying tasks.db file. createSqliteDataAccessor writes
    // it to <testDir>/.cleo/tasks.db.
    const dbPath = join(testDir, '.cleo', 'tasks.db');

    // Open an independent raw connection and acquire a RESERVED lock via
    // BEGIN IMMEDIATE. Any concurrent writer will see SQLITE_BUSY until
    // we COMMIT or ROLLBACK below.
    const locker = new DatabaseSync(dbPath);
    locker.exec('PRAGMA busy_timeout = 100');
    locker.prepare('BEGIN IMMEDIATE').run();

    let locked = true;
    // Schedule release after 50ms — well inside busy_timeout (5s) so the
    // accessor's first attempt usually succeeds without ever surfacing
    // BUSY to JS. If the engine-level wait expires, the app-level
    // retry primitive recovers transparently.
    void (async () => {
      await sleep(50);
      if (locked) {
        locker.prepare('COMMIT').run();
        locked = false;
      }
    })();

    // Fire the contended write through the accessor. Without retry +
    // engine-level busy_timeout, this would throw SQLITE_BUSY after the
    // engine-level wait expires; with our fix it resolves successfully.
    await expect(
      accessor.updateTaskFields(targetId, {
        labelsJson: JSON.stringify(['post-lock']),
        updatedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    // Ensure lock is released even if we got here before the timer ran.
    if (locked) {
      try {
        locker.prepare('COMMIT').run();
      } catch {
        // already committed elsewhere
      }
      locked = false;
    }
    locker.close();

    // Persisted state matches the contended update.
    const task = await accessor.loadSingleTask(targetId);
    expect(task?.labels).toEqual(['post-lock']);
  });
});
