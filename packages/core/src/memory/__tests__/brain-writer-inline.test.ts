/**
 * T13126 — brain writes run inline unless a long-lived host opts in.
 *
 * A one-shot `cleo memory observe` spawned a worker isolate and opened the
 * store a second time for one write (~300 MB). The serialization primitive is
 * now the cross-process `brain` writer lease plus the in-process async mutex;
 * only a host that calls `useBrainWriterThread()` gets the worker.
 *
 * ## What these tests observe
 *
 * - Overlap: the write handler is replaced by one that records how many writes
 *   are inside it at once and yields mid-write. Two (and twenty) overlapping
 *   `enqueueBrainWrite` calls must never be inside it together. Remove the
 *   `runInline` mutex from the default path and the maximum rises above 1.
 * - Opt-in: `getManager()` registers process `exit`/`SIGTERM`/`SIGINT`
 *   listeners when it builds the worker manager, before any worker file is
 *   resolved (see t12239-no-worker-resurrection.test.ts for why that, and not
 *   "was a Worker constructed", is the observable). The default path must add
 *   none; an opted-in process must add them.
 *
 * The T10301 reproduction against the real handlers (concurrent setImmediate
 * writers, then `PRAGMA integrity_check`) lives in brain-writer-thread.test.ts
 * and now exercises this inline default.
 *
 * @task T13126
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ inside: 0, maxInside: 0, order: [] as string[] }));

vi.mock('../brain-writer-handlers.js', () => ({
  handleWriteOp: async (op: { kind: string; params?: { title?: string } }) => {
    probe.inside += 1;
    probe.maxInside = Math.max(probe.maxInside, probe.inside);
    probe.order.push(`start:${op.params?.title ?? op.kind}`);
    // Yield across several macrotasks so an unserialized second write would enter.
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await new Promise<void>((resolve) => setImmediate(resolve));
    probe.order.push(`end:${op.params?.title ?? op.kind}`);
    probe.inside -= 1;
    return { kind: 'observe', result: { id: `O-${op.params?.title ?? 'x'}` } };
  },
}));

let tempDir: string;

beforeEach(async () => {
  probe.inside = 0;
  probe.maxInside = 0;
  probe.order = [];
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-inline-'));
  await mkdir(join(tempDir, '.cleo'), { recursive: true });
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { getDb } = await import('../../store/sqlite.js');
  await getDb(tempDir);
});

afterEach(async () => {
  const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
    '../brain-writer-thread.js'
  );
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['CLEO_BRAIN_WRITER_THREAD'];
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

function observe(title: string) {
  return {
    kind: 'observe' as const,
    projectRoot: tempDir,
    params: { text: `inline ${title}`, title, sourceType: 'manual' as const },
  };
}

function writerListeners(): number {
  return (
    process.listenerCount('exit') +
    process.listenerCount('SIGTERM') +
    process.listenerCount('SIGINT')
  );
}

describe('inline brain writer (default, T13126)', () => {
  it('serializes two overlapping in-process writes', async () => {
    const { enqueueBrainWrite } = await import('../brain-writer-thread.js');
    const [a, b] = await Promise.all([
      enqueueBrainWrite(observe('a')),
      enqueueBrainWrite(observe('b')),
    ]);
    expect(a.kind).toBe('observe');
    expect(b.kind).toBe('observe');
    expect(probe.maxInside).toBe(1);
    expect(probe.order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('serializes writers started from setImmediate callbacks', async () => {
    const { enqueueBrainWrite } = await import('../brain-writer-thread.js');
    const writes = await new Promise<Promise<unknown>[]>((resolve) => {
      const started: Promise<unknown>[] = [];
      for (let i = 0; i < 20; i++) {
        setImmediate(() => {
          started.push(enqueueBrainWrite(observe(`w${i}`)));
          if (started.length === 20) resolve(started);
        });
      }
    });
    await Promise.all(writes);
    expect(probe.maxInside).toBe(1);
    expect(probe.order.filter((e) => e.startsWith('end:'))).toHaveLength(20);
  });

  it('builds no worker manager unless the host opts in', async () => {
    const { enqueueBrainWrite, brainWriterThreadEnabled } = await import(
      '../brain-writer-thread.js'
    );
    expect(brainWriterThreadEnabled()).toBe(false);
    const before = writerListeners();
    await enqueueBrainWrite(observe('default'));
    expect(writerListeners() - before).toBe(0);
  });

  it('uses the worker manager after useBrainWriterThread()', async () => {
    const { enqueueBrainWrite, useBrainWriterThread, brainWriterThreadEnabled } = await import(
      '../brain-writer-thread.js'
    );
    useBrainWriterThread();
    expect(brainWriterThreadEnabled()).toBe(true);
    const before = writerListeners();
    // No worker file exists beside the source under vitest, so the manager falls
    // back inline after it is built; the write still completes.
    const result = await enqueueBrainWrite(observe('opted-in'));
    expect(result.kind).toBe('observe');
    expect(writerListeners() - before).toBe(3);
  });

  it('honours CLEO_BRAIN_WRITER_THREAD=1 as the host flag', async () => {
    process.env['CLEO_BRAIN_WRITER_THREAD'] = '1';
    const { brainWriterThreadEnabled } = await import('../brain-writer-thread.js');
    expect(brainWriterThreadEnabled()).toBe(true);
  });
});
