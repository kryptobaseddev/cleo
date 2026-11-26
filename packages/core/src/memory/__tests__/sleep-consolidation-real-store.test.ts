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
 * @task T14640
 * @task T14648
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

  it('never overwrites an existing supersedes edge for the pair and reports the skip', async () => {
    const db = await seedStore();
    db.prepare(
      `INSERT INTO brain_page_edges (from_id, to_id, edge_type, weight, provenance, created_at)
       VALUES ('observation:O-keep', 'observation:O-dup', 'supersedes', 0.5, '{"source":"earlier"}', '2026-01-01 00:00:00')`,
    ).run();
    const before = snapshot(db);

    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);

    expect(result.mergeDuplicates).toMatchObject({ merged: 0, failed: 0, skipped: 1 });
    expect(result.mergeDuplicates.error).toBeUndefined();
    expect(snapshot(db)).toEqual(before);
    const edge = db
      .prepare(
        `SELECT provenance, weight, created_at FROM brain_page_edges
         WHERE from_id = 'observation:O-keep' AND to_id = 'observation:O-dup' AND edge_type = 'supersedes'`,
      )
      .get();
    expect(edge).toMatchObject({
      provenance: '{"source":"earlier"}',
      weight: 0.5,
      created_at: '2026-01-01 00:00:00',
    });
  });

  it('reports committed merges and the failure when ROLLBACK TO itself throws', async () => {
    const db = await seedStore();
    const { upsertEmbeddingRowsNative } = await import('../../store/memory-accessor.js');
    db.prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, quality_score, memory_tier, citation_count)
       VALUES (?, 'discovery', ?, 'Second duplicate', ?, 'short', ?)`,
    ).run('O-keep2', 'Second A', 0.8, 0);
    db.prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, quality_score, memory_tier, citation_count)
       VALUES (?, 'discovery', ?, 'Second duplicate', ?, 'short', ?)`,
    ).run('O-dup2', 'Second B', 0.3, 4);
    upsertEmbeddingRowsNative(db, MODEL, [
      { id: 'O-keep2', vector: unitVector(4) },
      { id: 'O-dup2', vector: unitVector(4) },
    ]);
    // The second pair fails after its edge and eviction are written.
    db.exec(`CREATE TRIGGER t14640_inject BEFORE UPDATE OF citation_count ON brain_observations
             WHEN NEW.id = 'O-keep2'
             BEGIN SELECT RAISE(ABORT, 'injected citation failure'); END`);
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK TO sleep_merge_pair') throw new Error('injected rollback failure');
      return prepare(sql);
    });

    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);
    spy.mockRestore();

    expect(result.mergeDuplicates).toMatchObject({ merged: 1, failed: 1 });
    expect(result.mergeDuplicates.error).toMatch(/injected citation failure/);
    expect(result.mergeDuplicates.error).toMatch(/injected rollback failure/);
    expect(result.mergeDuplicates.error).toMatch(/stopped after 1 committed merge/);
    expect(db.isTransaction).toBe(false);
    const state = snapshot(db);
    // The first pair committed; the failed pair's partial writes were discarded.
    expect(state['O-dup']).not.toMatch(/^null\|/);
    expect(state['O-keep']).toBe('null|5');
    expect(state['O-dup2']).toBe('null|4');
    expect(state['O-keep2']).toBe('null|0');
    const orphan = db
      .prepare(`SELECT 1 FROM brain_page_edges WHERE to_id = 'observation:O-dup2'`)
      .get();
    expect(orphan).toBeUndefined();
  });

  it('inside a caller transaction a ROLLBACK TO failure reports nothing committed', async () => {
    const db = await seedStore();
    const { upsertEmbeddingRowsNative } = await import('../../store/memory-accessor.js');
    const insert = db.prepare(
      `INSERT INTO brain_observations (id, type, title, narrative, quality_score, memory_tier, citation_count)
       VALUES (?, 'discovery', ?, 'Second duplicate', ?, 'short', ?)`,
    );
    insert.run('O-keep2', 'Second A', 0.8, 0);
    insert.run('O-dup2', 'Second B', 0.3, 4);
    upsertEmbeddingRowsNative(db, MODEL, [
      { id: 'O-keep2', vector: unitVector(4) },
      { id: 'O-dup2', vector: unitVector(4) },
    ]);
    // The first pair merges into the caller's transaction; the second fails
    // after its edge and eviction are written.
    db.exec(`CREATE TRIGGER t14648_inject BEFORE UPDATE OF citation_count ON brain_observations
             WHEN NEW.id = 'O-keep2'
             BEGIN SELECT RAISE(ABORT, 'injected citation failure'); END`);
    const before = snapshot(db);
    const prepare = db.prepare.bind(db);
    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql === 'ROLLBACK TO sleep_merge_pair') throw new Error('injected rollback failure');
      return prepare(sql);
    });

    db.exec('BEGIN');
    const { runSleepConsolidation } = await import('../sleep-consolidation.js');
    const result = await runSleepConsolidation(tempDir);
    spy.mockRestore();

    expect(result.mergeDuplicates.merged).toBe(0);
    expect(result.mergeDuplicates.error).toMatch(/injected rollback failure/);
    expect(result.mergeDuplicates.error).toMatch(/injected citation failure/);
    expect(result.mergeDuplicates.error).toMatch(/nothing committed/);
    // The caller's transaction is left to the caller, who discards the writes.
    expect(db.isTransaction).toBe(true);
    db.exec('ROLLBACK');
    expect(snapshot(db)).toEqual(before);
    const edges = db
      .prepare(
        `SELECT 1 FROM brain_page_edges WHERE to_id IN ('observation:O-dup', 'observation:O-dup2')`,
      )
      .all();
    expect(edges).toEqual([]);
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
