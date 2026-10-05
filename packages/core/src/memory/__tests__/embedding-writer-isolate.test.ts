/**
 * T13246 — only the brain writer isolate writes an observe-time embedding
 * directly. `!isMainThread` meant ANY worker thread, and
 * `CLEO_BRAIN_WRITER_THREAD=1` carries into every worker's environment, so a
 * worker that observes (not the writer) would have written `brain_embeddings`
 * on its own handle. Here every isolate reports itself a worker thread:
 *
 * - not the writer isolate: the embed goes out as an `embed` op through
 *   `enqueueBrainWrite` (the lease and the mutex);
 * - the writer isolate (`markBrainWriterIsolate`): it writes directly, no op.
 *
 * @task T13246
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  setEmbeddingProvider,
} from '../brain-embedding.js';

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual, isMainThread: false };
});

const recorder = vi.hoisted(() => ({ ops: [] as string[] }));

vi.mock('../brain-writer-thread.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brain-writer-thread.js')>();
  return {
    ...actual,
    enqueueBrainWrite: async (
      op: Parameters<typeof actual.enqueueBrainWrite>[0],
      execution?: Parameters<typeof actual.enqueueBrainWrite>[1],
    ) => {
      recorder.ops.push(op.kind);
      return actual.enqueueBrainWrite(op, execution);
    },
  };
});

function vecAvailable(): boolean {
  try {
    createRequire(import.meta.url)('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

let tempDir: string;

beforeEach(async () => {
  recorder.ops = [];
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-embed-isolate-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { getDb } = await import('../../store/sqlite.js');
  await getDb(tempDir);
  setEmbeddingProvider({
    dimensions: EMBEDDING_DIMENSIONS,
    isAvailable: () => true,
    embed: async () => new Float32Array(EMBEDDING_DIMENSIONS).fill(0.25),
  });
});

afterEach(async () => {
  clearEmbeddingProvider();
  const { _resetLongLivedBrainHostForTests } = await import('../brain-host.js');
  _resetLongLivedBrainHostForTests();
  const { shutdownBrainWriter, _resetBrainWriterForTests } = await import(
    '../brain-writer-thread.js'
  );
  await shutdownBrainWriter();
  _resetBrainWriterForTests();
  const { closeBrainDb } = await import('../../store/memory-sqlite.js');
  closeBrainDb();
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
});

async function embeddingCount(): Promise<number> {
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const db = getBrainNativeDb(tempDir);
  if (!db) throw new Error('no brain handle');
  return (db.prepare('SELECT COUNT(*) AS n FROM brain_embeddings').get() as { n: number }).n;
}

async function observeAndWait(): Promise<void> {
  const { observeBrain } = await import('../retrieval/observe.js');
  await observeBrain(tempDir, {
    text: `worker isolate observe ${'w'.repeat(48)}`,
    title: 'isolate',
    sourceType: 'manual',
  });
  const deadline = Date.now() + 10_000;
  while ((await embeddingCount()) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe.skipIf(!vecAvailable())('observe-time embed in a worker thread (T13246)', () => {
  it('a worker thread that is not the writer isolate sends the embed through the chokepoint', async () => {
    const { markLongLivedBrainHost } = await import('../brain-host.js');
    markLongLivedBrainHost();
    await observeAndWait();
    expect(recorder.ops).toContain('embed');
    expect(await embeddingCount()).toBe(1);
  });

  it('the writer isolate writes it directly', async () => {
    const { markBrainWriterIsolate, markLongLivedBrainHost } = await import('../brain-host.js');
    markLongLivedBrainHost();
    markBrainWriterIsolate();
    await observeAndWait();
    expect(recorder.ops).not.toContain('embed');
    expect(await embeddingCount()).toBe(1);
  });
});
