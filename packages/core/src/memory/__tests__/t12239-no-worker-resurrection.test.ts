/**
 * T12239 AC3 — the brain writer must not resurrect after teardown.
 *
 * ## The defect
 *
 * `shutdownBrainWriter()` sets `_manager = null`, discarding that manager's
 * `shuttingDown` flag with it. A write arriving afterwards hits
 * `if (!_manager) _manager = new BrainWriterManager()` and gets a manager whose
 * `shuttingDown` is `false`, so `ensureWorker()`'s guard passes and a worker
 * realm is spawned AFTER teardown. Its MessagePort holds the event loop open
 * until the 3-second backstop fires — the "event loop still alive 3000ms after
 * teardown" that every mutating command pays (gh#1448, gh#1454, gh#1457,
 * gh#1466).
 *
 * ## Why these tests assert on PROCESS LISTENERS and not on "was a Worker constructed"
 *
 * `resolveWorkerPath()` looks for `brain-writer-worker.js` beside this source
 * file. Under vitest that file does not exist (it is emitted to `dist/`), so
 * the worker path is never reached and EVERYTHING falls inline. A test
 * asserting "no Worker was constructed" would therefore pass against the
 * broken code — it would not be a regression test at all, just a restatement
 * of the harness.
 *
 * The listener count is immune to that. `getManager()` registers
 * `process.on('exit')` plus two `process.once` handlers inside the same
 * `if (!_manager)` block that constructs the manager — BEFORE any worker is
 * resolved. So the delta measures the resurrection itself, with no mocking, and
 * it is a different KIND of observation from the thing under test.
 *
 * It also pins a second defect that was never on the ticket: each
 * teardown -> late-write cycle leaked three process-lifetime listeners.
 *
 * ## Predicted result against the unfixed implementation
 *
 * The three listener-delta assertions in the first block go RED (each observed
 * as 1, expected 0). The two guard assertions after them stay GREEN in both
 * versions — they exist to prove the write is not silently dropped, which is
 * the failure mode a careless fix would introduce.
 *
 * @task T12239
 * @epic T12114
 */

import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t12239-'));
  cleoDir = join(tempDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;

  const { getDb } = await import('../../store/sqlite.js');
  const { sessions } = await import('../../store/tasks-schema.js');
  const db = await getDb(tempDir);
  await db
    .insert(sessions)
    .values({ id: 'S-t12239', name: 't12239', status: 'active' })
    .onConflictDoNothing()
    .run();
});

afterEach(async () => {
  try {
    const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
      '../brain-writer-thread.js'
    );
    await shutdownBrainWriter();
    _resetBrainWriterForTests();
  } catch {
    /* may not be loaded */
  }
});

describe('T12239 AC3 — a write after teardown must not rebuild the writer', () => {
  it('registers no new process-lifetime listeners for a late write', async () => {
    const { enqueueBrainWrite, shutdownBrainWriter } = await import('../brain-writer-thread.js');

    // Prime: one normal write, so the manager (and its listeners) exist.
    await enqueueBrainWrite({
      kind: 'observe',
      projectRoot: tempDir,
      params: { text: 'before teardown', title: 'before' },
    } as never);

    await shutdownBrainWriter();

    const before = {
      exit: process.listenerCount('exit'),
      sigterm: process.listenerCount('SIGTERM'),
      sigint: process.listenerCount('SIGINT'),
    };

    // The late write. On the unfixed implementation this reaches
    // `new BrainWriterManager()` and re-registers all three handlers.
    await enqueueBrainWrite({
      kind: 'observe',
      projectRoot: tempDir,
      params: { text: 'after teardown', title: 'after' },
    } as never);

    expect(process.listenerCount('exit') - before.exit, 'exit listener leaked').toBe(0);
    expect(process.listenerCount('SIGTERM') - before.sigterm, 'SIGTERM listener leaked').toBe(0);
    expect(process.listenerCount('SIGINT') - before.sigint, 'SIGINT listener leaked').toBe(0);
  });

  it('still completes the late write rather than dropping it', async () => {
    // GREEN IN BOTH VERSIONS, on purpose. The obvious wrong fix is to refuse
    // the write outright; `enqueueBrainWrite` must keep resolving, via the
    // inline executor, or the guard trades a slow exit for silent data loss.
    const { enqueueBrainWrite, shutdownBrainWriter } = await import('../brain-writer-thread.js');

    await shutdownBrainWriter();

    await expect(
      enqueueBrainWrite({
        kind: 'observe',
        projectRoot: tempDir,
        params: { text: 'late but not lost', title: 'late' },
      } as never),
    ).resolves.toBeDefined();
  });

  it('a second late write does not compound the leak', async () => {
    const { enqueueBrainWrite, shutdownBrainWriter } = await import('../brain-writer-thread.js');
    await shutdownBrainWriter();

    const base = process.listenerCount('exit');
    for (let i = 0; i < 3; i++) {
      await enqueueBrainWrite({
        kind: 'observe',
        projectRoot: tempDir,
        params: { text: `late ${i}`, title: `late-${i}` },
      } as never);
    }
    // Unfixed: +3. The per-cycle leak is what makes a long-lived process
    // accumulate handlers rather than merely exiting slowly once.
    expect(process.listenerCount('exit') - base).toBe(0);
  });
});

describe('T12239 AC3 — the latch itself', () => {
  it('reports shutdown state at module scope, surviving _manager = null', async () => {
    const { isBrainWriterShuttingDown, shutdownBrainWriter, _resetBrainWriterForTests } =
      await import('../brain-writer-thread.js');

    expect(isBrainWriterShuttingDown()).toBe(false);
    await shutdownBrainWriter();
    // The whole point: `_manager` is now null and its `shuttingDown` flag is
    // gone, but the latch remains.
    expect(isBrainWriterShuttingDown()).toBe(true);

    _resetBrainWriterForTests();
    // MANDATORY clear — without it every subsequent test in a file runs against
    // a permanently shut-down writer.
    expect(isBrainWriterShuttingDown()).toBe(false);
  });

  it('BrainWriterShutDownError carries a stable code name', async () => {
    const { BrainWriterShutDownError } = await import('../brain-writer-thread.js');
    const err = new BrainWriterShutDownError('observe');
    expect(err.codeName).toBe('E_BRAIN_WRITER_SHUTDOWN');
    expect(err).toBeInstanceOf(Error);
    // Caught one frame up and routed to runInline — it must never surface as a
    // CleoError in a LAFS envelope.
    expect(err.name).toBe('BrainWriterShutDownError');
  });
});
