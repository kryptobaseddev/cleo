/**
 * Tests for the T539 embedding pipeline activation.
 *
 * Verifies:
 *   1. Mock embedding provider can be registered and returns vectors
 *   2. brain_embeddings vec0 table exists when sqlite-vec is loaded
 *   3. Vectors can be stored in brain_embeddings
 *   4. searchSimilar returns results when embedding is available
 *   5. populateEmbeddings backfill generates vectors for existing observations
 *   6. initDefaultProvider registers the LocalEmbeddingProvider
 *
 * NOTE: The actual @huggingface/transformers model (all-MiniLM-L6-v2) is NOT
 * downloaded in these tests. All embedding calls use mock providers that return
 * deterministic Float32Array vectors, per the task requirements.
 *
 * @task T539
 * @epic T523
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  embedText,
  isEmbeddingAvailable,
  setEmbeddingProvider,
} from '../brain-embedding.js';

// Mock LocalEmbeddingProvider at the module level to prevent model downloads.
// The mock is hoisted by Vitest before tests run. Tests that need the real
// module should use vi.restoreAllMocks() after clearing the mock.
vi.mock('../embedding-local.js', () => ({
  LocalEmbeddingProvider: class MockLocalEmbeddingProvider {
    readonly dimensions = 384;
    isAvailable() {
      return true;
    }
    async embed(_text: string) {
      return new Float32Array(384).fill(0.1);
    }
    async embedBatch(texts: string[]) {
      return texts.map(() => new Float32Array(384).fill(0.1));
    }
  },
  getLocalEmbeddingProvider: () => ({
    dimensions: 384,
    isAvailable: () => true,
    embed: async (_text: string) => new Float32Array(384).fill(0.1),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(384).fill(0.1)),
  }),
}));

/** Check if sqlite-vec native extension is available in this environment. */
function isSqliteVecAvailable(): boolean {
  try {
    const _require = createRequire(import.meta.url);
    _require('sqlite-vec');
    return true;
  } catch {
    return false;
  }
}

/** Create a mock embedding provider that returns deterministic vectors. */
function createMockProvider(overrides?: Partial<EmbeddingProvider>): EmbeddingProvider {
  return {
    dimensions: EMBEDDING_DIMENSIONS,
    isAvailable: () => true,
    embed: vi.fn(async (_text: string) => {
      // Deterministic vector: hash text length into first few positions
      const vec = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.0);
      vec[0] = _text.length / 1000;
      vec[1] = 0.5;
      vec[2] = 0.25;
      return vec;
    }),
    ...overrides,
  };
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-embed-pipeline-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
  clearEmbeddingProvider();
});

afterEach(async () => {
  clearEmbeddingProvider();
  try {
    const { closeBrainDb } = await import('../../store/brain-sqlite.js');
    closeBrainDb();
  } catch {
    /* may not be loaded */
  }
  try {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
  } catch {
    /* may not be loaded */
  }
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
});

// ============================================================================
// Provider registration (no sqlite-vec required)
// ============================================================================

describe('EmbeddingProvider registration', () => {
  it('starts with no provider registered', () => {
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('setEmbeddingProvider makes isEmbeddingAvailable return true', () => {
    setEmbeddingProvider(createMockProvider());
    expect(isEmbeddingAvailable()).toBe(true);
  });

  it('embedText returns a Float32Array of correct length with mock provider', async () => {
    setEmbeddingProvider(createMockProvider());
    const vec = await embedText('hello world');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(EMBEDDING_DIMENSIONS);
  });

  it('embedText returns null with no provider', async () => {
    const vec = await embedText('hello world');
    expect(vec).toBeNull();
  });

  it('clearEmbeddingProvider resets availability', () => {
    setEmbeddingProvider(createMockProvider());
    expect(isEmbeddingAvailable()).toBe(true);
    clearEmbeddingProvider();
    expect(isEmbeddingAvailable()).toBe(false);
  });

  it('rejects provider with wrong dimensions', () => {
    const bad = createMockProvider({ dimensions: 768 });
    expect(() => setEmbeddingProvider(bad)).toThrow(/dimensions.*768.*384/);
  });
});

// ============================================================================
// initDefaultProvider wiring (mocks LocalEmbeddingProvider)
// ============================================================================

describe('initDefaultProvider', () => {
  it('registers a LocalEmbeddingProvider when called', async () => {
    // embedding-local.js is mocked at module level (vi.mock hoisted to top).
    // initDefaultProvider dynamically imports LocalEmbeddingProvider and calls
    // setEmbeddingProvider — the mock intercepts the import.
    const { initDefaultProvider } = await import('../brain-embedding.js');
    await initDefaultProvider();

    expect(isEmbeddingAvailable()).toBe(true);
    const vec = await embedText('test text');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec!.length).toBe(EMBEDDING_DIMENSIONS);
  });
});

// ============================================================================
// sqlite-vec extension + vec0 table (skipped if sqlite-vec unavailable)
// ============================================================================

describe.skipIf(!isSqliteVecAvailable())('brain_embeddings vec0 table', () => {
  it('isBrainVecLoaded is true after getBrainDb when sqlite-vec is installed', async () => {
    const { getBrainDb, isBrainVecLoaded, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    expect(isBrainVecLoaded()).toBe(true);
  });

  it('brain_embeddings vec0 table exists after getBrainDb', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb();
    expect(nativeDb).toBeTruthy();

    const row = nativeDb!
      .prepare("SELECT name FROM sqlite_master WHERE name = 'brain_embeddings'")
      .get() as { name: string } | undefined;

    expect(row?.name).toBe('brain_embeddings');
  });

  it('vec_version() returns a version string', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb();
    const result = nativeDb!.prepare('SELECT vec_version()').get() as Record<string, string>;
    const version = Object.values(result)[0];
    expect(version).toMatch(/^v?\d+\.\d+/);
  });

  it('can insert and retrieve a Float32Array vector in brain_embeddings', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();

    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    const vec = new Float32Array(EMBEDDING_DIMENSIONS);
    vec[0] = 1.0;
    vec[1] = 0.5;
    vec[2] = 0.25;

    nativeDb
      .prepare('INSERT INTO brain_embeddings (id, embedding) VALUES (?, ?)')
      .run('test-obs-001', Buffer.from(vec.buffer));

    const rows = nativeDb
      .prepare('SELECT id FROM brain_embeddings WHERE id = ?')
      .all('test-obs-001') as Array<{ id: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('test-obs-001');
  });
});

// ============================================================================
// searchSimilar with mock provider (skipped if sqlite-vec unavailable)
// ============================================================================

describe.skipIf(!isSqliteVecAvailable())('searchSimilar with mock provider', () => {
  it('returns empty array when embedding is unavailable', async () => {
    clearEmbeddingProvider();
    const { searchSimilar } = await import('../brain-similarity.js');
    const results = await searchSimilar('anything', tempDir, 5);
    expect(results).toEqual([]);
  });

  it('returns results when embedding provider is registered and vec table has entries', async () => {
    // Setup brain db
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    // Insert test observation into brain_observations
    const obsId = 'O-test001-0';
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    nativeDb
      .prepare(`
      INSERT OR IGNORE INTO brain_observations
        (id, type, title, narrative, content_hash, project, source_session_id, source_type, agent, quality_score, created_at)
      VALUES (?, 'context', 'Test Observation', 'This is a test', 'deadbeef00000001', NULL, NULL, 'agent', NULL, 0.8, ?)
    `)
      .run(obsId, now);

    // Create a query vector
    const queryVec = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1);
    queryVec[0] = 0.9;

    // Insert into brain_embeddings
    nativeDb
      .prepare('INSERT OR REPLACE INTO brain_embeddings (id, embedding) VALUES (?, ?)')
      .run(obsId, Buffer.from(queryVec.buffer));

    // Register mock provider that returns same vector (distance = 0)
    const mockProvider = createMockProvider({
      embed: vi.fn(async (_text: string) => {
        const v = new Float32Array(EMBEDDING_DIMENSIONS).fill(0.1);
        v[0] = 0.9;
        return v;
      }),
    });
    setEmbeddingProvider(mockProvider);

    const { searchSimilar } = await import('../brain-similarity.js');
    const results = await searchSimilar('test observation', tempDir, 5);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe(obsId);
    expect(typeof results[0]!.distance).toBe('number');
    expect(results[0]!.type).toBe('observation');
  });
});

// ============================================================================
// populateEmbeddings backfill with mock provider (skipped if sqlite-vec unavailable)
// ============================================================================

describe.skipIf(!isSqliteVecAvailable())('populateEmbeddings backfill', () => {
  it('backfills vectors for observations missing embeddings', async () => {
    // Setup brain db
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    // Insert test observations without embeddings
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const obsIds = ['O-backfill01-0', 'O-backfill02-0'];
    for (const id of obsIds) {
      nativeDb
        .prepare(`
        INSERT OR IGNORE INTO brain_observations
          (id, type, title, narrative, content_hash, project, source_session_id, source_type, agent, quality_score, created_at)
        VALUES (?, 'context', 'Backfill Test', 'Narrative for backfill', ?, NULL, NULL, 'agent', NULL, 0.7, ?)
      `)
        .run(id, `hash-${id}`, now);
    }

    // Verify no embeddings yet
    const beforeCount = (
      nativeDb
        .prepare('SELECT COUNT(*) AS cnt FROM brain_embeddings WHERE id IN (?, ?)')
        .get(...obsIds) as { cnt: number }
    ).cnt;
    expect(beforeCount).toBe(0);

    // Register mock provider
    setEmbeddingProvider(createMockProvider());

    const { populateEmbeddings } = await import('../brain-retrieval.js');
    const result = await populateEmbeddings(tempDir, { batchSize: 10 });

    expect(result.processed).toBeGreaterThanOrEqual(obsIds.length);
    expect(result.errors).toBe(0);

    // Verify embeddings were written
    const afterCount = (
      nativeDb
        .prepare('SELECT COUNT(*) AS cnt FROM brain_embeddings WHERE id IN (?, ?)')
        .get(...obsIds) as { cnt: number }
    ).cnt;
    expect(afterCount).toBe(obsIds.length);
  });

  it('skips observations without narrative', async () => {
    const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
      '../../store/brain-sqlite.js'
    );
    closeBrainDb();
    await getBrainDb(tempDir);
    const nativeDb = getBrainNativeDb()!;

    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    // Observation with NULL narrative — should be skipped by populateEmbeddings
    // (the query filters WHERE narrative IS NOT NULL)
    nativeDb
      .prepare(`
      INSERT OR IGNORE INTO brain_observations
        (id, type, title, narrative, content_hash, project, source_session_id, source_type, agent, quality_score, created_at)
      VALUES ('O-nonarr01-0', 'context', 'No Narrative', NULL, 'hashnonarr01', NULL, NULL, 'agent', NULL, 0.5, ?)
    `)
      .run(now);

    setEmbeddingProvider(createMockProvider());

    const { populateEmbeddings } = await import('../brain-retrieval.js');
    const result = await populateEmbeddings(tempDir, { batchSize: 10 });

    // The no-narrative observation should not appear in processed
    const row = nativeDb
      .prepare("SELECT id FROM brain_embeddings WHERE id = 'O-nonarr01-0'")
      .get() as { id: string } | undefined;
    expect(row).toBeUndefined();
    // result.skipped tracks embedText returning null (provider returns null for empty)
    // but our mock always returns a vector; actual skipping is done by the SQL filter
    expect(result.errors).toBe(0);
  });
});
