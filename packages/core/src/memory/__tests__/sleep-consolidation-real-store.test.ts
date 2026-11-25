/**
 * Sleep consolidation's near-duplicate merge on a real migrated brain store.
 *
 * The sibling `sleep-consolidation.test.ts` fakes the native handle, which hid
 * that the merge selected a column `brain_observations` does not have and
 * swallowed the error (T14599). This test opens a real store (migrations +
 * sqlite-vec), stores vectors where the schema keeps them (`brain_embeddings`),
 * and asserts the duplicate is evicted. Only the LLM is mocked, so the merge
 * takes its structural fallback.
 *
 * @task T14599
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODEL = 'test-model-t14599';

/** A 384-dimension unit vector pointing along `axis`. */
function unitVector(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

vi.mock('../../llm/role-executor.js', () => ({
  executeForRole: vi.fn().mockResolvedValue(null),
}));

// Every registration path (the brain open's background init and the merge
// step's own ensureEmbeddingProvider) builds this provider, so stored vectors
// and the merge query agree on one model without loading the real one.
vi.mock('../embedding-local.js', () => ({
  LocalEmbeddingProvider: class {
    readonly model = MODEL;
    readonly dimensions = 384;
    isAvailable(): boolean {
      return true;
    }
    async embed(): Promise<Float32Array> {
      return unitVector(0);
    }
  },
}));

/** Whether the sqlite-vec native extension is installed here. */
function isSqliteVecAvailable(): boolean {
  try {
    createRequire(import.meta.url)('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

let tempDir: string;

describe.skipIf(!isSqliteVecAvailable())('sleep consolidation merge on a real store', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-sleep-merge-'));
    process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    const { clearEmbeddingProvider } = await import('../brain-embedding.js');
    closeBrainDb();
    clearEmbeddingProvider();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  it('evicts the lower-quality duplicate and keeps distinct entries', async () => {
    const { getBrainDb, getBrainNativeDb, isBrainVecLoaded } = await import(
      '../../store/memory-sqlite.js'
    );
    const { upsertEmbeddingRowsNative } = await import('../../store/memory-accessor.js');
    await getBrainDb(tempDir);
    expect(isBrainVecLoaded(tempDir)).toBe(true);
    const db = getBrainNativeDb(tempDir);
    if (!db) throw new Error('brain store did not open');

    const insert = db.prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, quality_score, memory_tier)
       VALUES (?, 'discovery', ?, ?, ?, 'short')`,
    );
    insert.run('O-keep', 'Duplicate A', 'Same content', 0.9);
    insert.run('O-dup', 'Duplicate B', 'Same content again', 0.4);
    insert.run('O-other', 'Distinct', 'Unrelated content', 0.7);
    upsertEmbeddingRowsNative(db, MODEL, [
      { id: 'O-keep', vector: unitVector(0) },
      { id: 'O-dup', vector: unitVector(0) },
      { id: 'O-other', vector: unitVector(1) },
    ]);

    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);

    expect(result.mergeDuplicates.error).toBeUndefined();
    expect(result.mergeDuplicates.merged).toBe(1);
    const invalid = db
      .prepare('SELECT id FROM brain_observations WHERE invalid_at IS NOT NULL ORDER BY id')
      .all()
      .map((r) => r.id);
    expect(invalid).toEqual(['O-dup']);
  });

  it('reports a query failure in the result instead of reading as nothing to merge', async () => {
    const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
    await getBrainDb(tempDir);
    const db = getBrainNativeDb(tempDir);
    if (!db) throw new Error('brain store did not open');
    db.exec('DROP TABLE brain_embeddings');

    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);

    expect(result.mergeDuplicates.merged).toBe(0);
    expect(result.mergeDuplicates.error).toMatch(/brain_embeddings/);
  });
});
