/**
 * T13218 — the embedding backfill writes only through the brain chokepoint.
 *
 * `populateEmbeddings` used to `INSERT OR REPLACE INTO brain_embeddings` on its
 * own `getBrainNativeDb` handle. Run automatically (sentient tick, session-end
 * worker) beside an opted-in host's worker writer, that is two write handles
 * in one process: the T10301 corruption shape. Inference now stays outside the
 * chokepoint and every write is one `embed` op through `enqueueBrainWrite`.
 *
 * - The first test replaces `enqueueBrainWrite` with a recorder that writes
 *   nothing: afterwards `brain_embeddings` must still be empty, which proves
 *   the backfill itself opens no write path.
 * - The second runs a declared host's writes and a backfill concurrently
 *   through the real chokepoint and ends in `PRAGMA integrity_check`.
 *
 * @task T13218
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

const recorder = vi.hoisted(() => ({
  forward: true,
  ops: [] as Array<{ kind: string; rows: number }>,
}));

vi.mock('../brain-writer-thread.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../brain-writer-thread.js')>();
  return {
    ...actual,
    enqueueBrainWrite: async (
      op: Parameters<typeof actual.enqueueBrainWrite>[0],
      execution?: Parameters<typeof actual.enqueueBrainWrite>[1],
    ) => {
      recorder.ops.push({ kind: op.kind, rows: op.kind === 'embed' ? op.rows.length : 0 });
      if (recorder.forward) return actual.enqueueBrainWrite(op, execution);
      return op.kind === 'embed'
        ? { kind: 'embed' as const, written: op.rows.length }
        : actual.enqueueBrainWrite(op, execution);
    },
  };
});

vi.mock('../embedding-local.js', () => ({
  LocalEmbeddingProvider: class {
    readonly dimensions = 384;
    isAvailable() {
      return true;
    }
    async embed() {
      return new Float32Array(384).fill(0.1);
    }
  },
}));

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
  recorder.forward = true;
  recorder.ops = [];
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-embed-chokepoint-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  const { getDb } = await import('../../store/sqlite.js');
  await getDb(tempDir);
  setEmbeddingProvider({
    dimensions: EMBEDDING_DIMENSIONS,
    isAvailable: () => true,
    embed: async (text: string) => {
      const v = new Float32Array(EMBEDDING_DIMENSIONS).fill(0);
      v[0] = text.length / 1000;
      v[1] = 0.5;
      return v;
    },
  });
});

afterEach(async () => {
  clearEmbeddingProvider();
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

async function seedObservations(n: number): Promise<void> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  await getBrainDb(tempDir);
  const db = getBrainNativeDb(tempDir);
  if (!db) throw new Error('no brain handle');
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  for (let i = 0; i < n; i++) {
    db.prepare(
      `INSERT INTO brain_observations
         (id, type, title, narrative, content_hash, project, source_session_id, source_type, agent, quality_score, created_at)
       VALUES (?, 'context', ?, ?, ?, NULL, NULL, 'agent', NULL, 0.7, ?)`,
    ).run(`O-chk${i}-0`, `obs ${i}`, `narrative ${i} for the chokepoint test`, `hash-${i}`, now);
  }
}

async function embeddingCount(): Promise<number> {
  const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
  const db = getBrainNativeDb(tempDir);
  if (!db) throw new Error('no brain handle');
  return (db.prepare('SELECT COUNT(*) AS n FROM brain_embeddings').get() as { n: number }).n;
}

describe.skipIf(!vecAvailable())('embedding backfill through the chokepoint (T13218)', () => {
  it('writes nothing itself: every vector goes out as an embed op', async () => {
    await seedObservations(5);
    recorder.forward = false;
    const { populateEmbeddings } = await import('../retrieval/observe.js');
    const result = await populateEmbeddings(tempDir, { batchSize: 2 });
    expect(recorder.ops.filter((o) => o.kind === 'embed').map((o) => o.rows)).toEqual([2, 2, 1]);
    expect(result.processed).toBe(5);
    // The recorder dropped the ops: a direct write would show up here.
    expect(await embeddingCount()).toBe(0);
  });

  it('a declared host and a concurrent backfill leave brain.db intact', async () => {
    await seedObservations(12);
    const { enqueueBrainWrite, useBrainWriterThread } = await import('../brain-writer-thread.js');
    useBrainWriterThread();
    const { populateEmbeddings } = await import('../retrieval/observe.js');
    const writes = Array.from({ length: 10 }, (_v, i) =>
      enqueueBrainWrite({
        kind: 'observe',
        projectRoot: tempDir,
        params: {
          text: `host write ${i} ${'z'.repeat(48)}`,
          title: `host-${i}`,
          sourceType: 'manual',
        },
      }),
    );
    const [backfill] = await Promise.all([
      populateEmbeddings(tempDir, { batchSize: 3 }),
      ...writes,
    ]);
    expect(backfill.errors).toBe(0);
    expect(await embeddingCount()).toBeGreaterThanOrEqual(12);
    const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    const row = getBrainNativeDb(tempDir)?.prepare('PRAGMA integrity_check').get() as {
      integrity_check?: string;
    };
    expect(row.integrity_check).toBe('ok');
  });

  it('a host on the inline fallback sends its observe-time embed through the chokepoint (T13230)', async () => {
    // No worker file under vitest: an opted-in host runs observeBrain inline on
    // the main thread. Its deferred embed must then go back through
    // enqueueBrainWrite (lease + mutex), never write the main handle directly.
    const { enqueueBrainWrite, useBrainWriterThread } = await import('../brain-writer-thread.js');
    useBrainWriterThread();
    await enqueueBrainWrite({
      kind: 'observe',
      projectRoot: tempDir,
      params: {
        text: `inline host observe ${'q'.repeat(48)}`,
        title: 'inline-host',
        sourceType: 'manual',
      },
    });
    const deadline = Date.now() + 10_000;
    while (!recorder.ops.some((o) => o.kind === 'embed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(recorder.ops.filter((o) => o.kind === 'embed')).toEqual([{ kind: 'embed', rows: 1 }]);
    // The recorder logs the op before forwarding it; wait for the write to land.
    while ((await embeddingCount()) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(await embeddingCount()).toBe(1);
  });
});
