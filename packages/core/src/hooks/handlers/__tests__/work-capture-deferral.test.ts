/**
 * T14553 — awaited work-capture handlers stay inside a budget under a held
 * `brain` writer lease, report the deferral, and never drop the observation.
 *
 * A live foreign holder of the `project`/`brain` lease is seeded BEFORE the
 * dispatch, exactly what a second process mid brain write looks like. Without
 * the budget the capture waited the 30 s acquire window and then wrote
 * lease-less; with it, the dispatch returns within the budget, names the
 * deferred handler, and the spooled observation lands in `brain_observations`
 * on the next capture once the lease is free.
 *
 * @task T14553
 */

import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, aroundEach, describe, expect, it, vi } from 'vitest';
import { worktreeScope } from '../../../paths.js';
import { awaitBackgroundOps } from '../../../store/background-ops.js';
import { WRITER_LEASES_TABLE } from '../../../store/writer-lease-schema.js';
import { hooks, RESPONSE_HOOK_BUDGET_MS } from '../../registry.js';
import { WORK_CAPTURE_WRITE_BUDGET_MS } from '../work-capture-hooks.js';

let tempDir: string;

/** Rows written by the work-capture handlers, by title. */
async function capturedTitles(): Promise<string[]> {
  const { getBrainNativeDb } = await import('../../../store/memory-sqlite.js');
  const native = getBrainNativeDb(tempDir);
  if (!native) throw new Error('brain store not open');
  return (
    native
      .prepare("SELECT title FROM brain_observations WHERE title LIKE 'Work %' ORDER BY title")
      .all() as Array<{ title: string }>
  ).map((row) => row.title);
}

/** Spooled observations still waiting to be written. */
async function spooled(): Promise<string[]> {
  const names = await readdir(join(tempDir, '.cleo', 'brain-capture-spool')).catch(() => []);
  return names.filter((name) => !name.startsWith('.'));
}

describe('T14553 — work capture under a held brain lease', () => {
  aroundEach(async (runTest) => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-t14553-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await worktreeScope.run({ worktreeRoot: tempDir, projectHash: 't14553-capture' }, runTest);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await awaitBackgroundOps();
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '../../../memory/brain-writer-thread.js'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
    const { closeBrainDb } = await import('../../../store/memory-sqlite.js');
    closeBrainDb();
    const { closeDb } = await import('../../../store/sqlite.js');
    closeDb();
    const { _resetWriterLeaseStateForTest } = await import('../../../store/writer-lease.js');
    _resetWriterLeaseStateForTest();
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  });

  it('defers within the budget while the lease is held, then the row lands', async () => {
    vi.stubEnv('CLEO_BRAIN_CAPTURE_WORK', 'true');
    vi.stubEnv('CLEO_WRITER_LEASE_MODE', 'local');
    const { getBrainDb, getBrainNativeDb } = await import('../../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const native = getBrainNativeDb(tempDir);
    if (!native) throw new Error('brain store not open');

    // A live holder in another process (the parent runner is alive and is not
    // this process, so the lease is neither re-entered nor reclaimed).
    const now = Date.now();
    native
      .prepare(
        `INSERT INTO ${WRITER_LEASES_TABLE} (scope,lane,holder_id,holder_pid,epoch,acquired_at,heartbeat_at,ttl_ms,reentrancy_depth,active) VALUES ('project','brain','foreign-holder',?,7,?,?,30000,1,1)`,
      )
      .run(process.ppid, now, now);

    const backstopped: Promise<void>[] = [];
    const started = Date.now();
    const held = await hooks.dispatch(
      'ResponseComplete',
      tempDir,
      {
        timestamp: new Date().toISOString(),
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        success: true,
        durationMs: 5,
      },
      (work) => backstopped.push(work),
      RESPONSE_HOOK_BUDGET_MS,
    );
    const elapsed = Date.now() - started;

    // Bounded: the handler gave up at its own budget, well inside the
    // response budget, and the registry backstop never had to step in.
    expect(held.deferred).toEqual(['work-capture-response-complete']);
    expect(elapsed).toBeGreaterThanOrEqual(WORK_CAPTURE_WRITE_BUDGET_MS - 50);
    expect(elapsed).toBeLessThan(RESPONSE_HOOK_BUDGET_MS);
    expect(backstopped).toHaveLength(0);
    // Not written, not dropped: it waits in the spool.
    expect(await capturedTitles()).toEqual([]);
    expect(await spooled()).toHaveLength(1);

    // The other process releases its lease; the next capture writes its own
    // observation and drains the deferred one.
    native
      .prepare(
        `UPDATE ${WRITER_LEASES_TABLE} SET active = 0 WHERE scope = 'project' AND lane = 'brain' AND holder_id = 'foreign-holder'`,
      )
      .run();
    const free = await hooks.dispatch(
      'PromptSubmit',
      tempDir,
      {
        timestamp: new Date().toISOString(),
        gateway: 'mutate',
        domain: 'tasks',
        operation: 'add',
        source: 'cli',
      },
      (work) => backstopped.push(work),
      RESPONSE_HOOK_BUDGET_MS,
    );

    expect(free.deferred).toEqual([]);
    expect(await capturedTitles()).toEqual(['Work done: tasks.add', 'Work intent: tasks.add']);
    expect(await spooled()).toEqual([]);
  }, 30_000);
});
