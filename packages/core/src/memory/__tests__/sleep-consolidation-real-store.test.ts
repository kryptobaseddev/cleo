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
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MODEL = 'test-model-t14599';

/** A 384-dimension unit vector pointing along `axis`. */
function unitVector(axis: number): Float32Array {
  const v = new Float32Array(384);
  v[axis] = 1;
  return v;
}

/** A unit vector in the plane of axes 2 and 3 whose cosine with axis 2 is `cos`. */
function vectorAtCosine(cos: number): Float32Array {
  const v = new Float32Array(384);
  v[2] = cos;
  v[3] = Math.sqrt(1 - cos * cos);
  return v;
}

/** Real store with one duplicate pair, one distinct entry and one below-threshold pair. */
async function seedStore(): Promise<DatabaseSync> {
  const { getBrainDb, getBrainNativeDb, isBrainVecLoaded } = await import(
    '../../store/memory-sqlite.js'
  );
  const { upsertEmbeddingRowsNative } = await import('../../store/memory-accessor.js');
  await getBrainDb(tempDir);
  expect(isBrainVecLoaded(tempDir)).toBe(true);
  const db = getBrainNativeDb(tempDir);
  if (!db) throw new Error('brain store did not open');

  const insert = db.prepare(
    `INSERT INTO brain_observations (id, type, title, narrative, quality_score, memory_tier, citation_count)
     VALUES (?, 'discovery', ?, ?, ?, 'short', ?)`,
  );
  insert.run('O-keep', 'Duplicate A', 'Same content', 0.9, 2);
  insert.run('O-dup', 'Duplicate B', 'Same content again', 0.4, 3);
  insert.run('O-other', 'Distinct', 'Unrelated content', 0.7, 0);
  insert.run('O-near-a', 'Near A', 'Similar content', 0.6, 0);
  insert.run('O-near-b', 'Near B', 'Similar content, different point', 0.5, 0);
  upsertEmbeddingRowsNative(db, MODEL, [
    { id: 'O-keep', vector: unitVector(0) },
    { id: 'O-dup', vector: unitVector(0) },
    { id: 'O-other', vector: unitVector(1) },
    // cosine 0.84: just below the 0.85 duplicate threshold
    { id: 'O-near-a', vector: vectorAtCosine(1) },
    { id: 'O-near-b', vector: vectorAtCosine(0.84) },
  ]);
  return db;
}

/** Observation state the merge may change, keyed by id. */
function snapshot(db: DatabaseSync): Record<string, string> {
  const rows = db
    .prepare('SELECT id, invalid_at, citation_count FROM brain_observations ORDER BY id')
    .all();
  return Object.fromEntries(rows.map((r) => [String(r.id), `${r.invalid_at}|${r.citation_count}`]));
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

  it('merges only the above-threshold pair and links the evicted node to the kept one', async () => {
    const db = await seedStore();

    const { runSleepConsolidation, SLEEP_MERGE_PROVENANCE_SOURCE } = await import(
      '../sleep-consolidation.js'
    );
    const result = await runSleepConsolidation(tempDir);

    expect(result.mergeDuplicates).toMatchObject({ merged: 1, failed: 0 });
    expect(result.mergeDuplicates.error).toBeUndefined();
    const state = snapshot(db);
    expect(state['O-dup']).not.toMatch(/^null\|/);
    // The below-threshold pair and the distinct entry stay active.
    for (const id of ['O-keep', 'O-other', 'O-near-a', 'O-near-b']) {
      expect(state[id]).toMatch(/^null\|/);
    }
    // The kept row gained the evicted row's citations.
    expect(state['O-keep']).toBe('null|5');

    const edge = db
      .prepare(
        `SELECT provenance FROM brain_page_edges
         WHERE from_id = 'observation:O-keep' AND to_id = 'observation:O-dup' AND edge_type = 'supersedes'`,
      )
      .get();
    expect(edge).toBeDefined();
    const provenance = JSON.parse(String(edge?.provenance));
    expect(provenance).toMatchObject({
      source: SLEEP_MERGE_PROVENANCE_SOURCE,
      citationsAdded: 3,
      invalidAt: state['O-dup']?.split('|')[0],
    });
  });

  it('rolls a failed pair back, leaving both nodes unchanged, and reports it', async () => {
    const db = await seedStore();
    db.exec(`CREATE TRIGGER t14639_inject BEFORE INSERT ON brain_page_edges
             WHEN NEW.edge_type = 'supersedes'
             BEGIN SELECT RAISE(ABORT, 'injected edge failure'); END`);
    const before = snapshot(db);

    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);

    expect(result.mergeDuplicates).toMatchObject({ merged: 0, failed: 1 });
    expect(result.mergeDuplicates.error).toMatch(/injected edge failure/);
    expect(snapshot(db)).toEqual(before);
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
