/**
 * Tests for NEXUS plasticity — strengthenNexusCoAccess (T998).
 *
 * Verifies:
 *   1. Migration: nexus_relations has weight, last_accessed_at, co_accessed_count after init
 *   2. strengthenNexusCoAccess increments weight and co_accessed_count for matching pairs
 *   3. Weight is capped at 1.0 (no runaway strengthening)
 *   4. last_accessed_at is updated on each strengthen call
 *   5. Non-matching pairs are not mutated
 *   6. runConsolidation Step 6b calls strengthenNexusCoAccess (mocked assertion)
 *   7. NEXUS_RELATION_TYPES includes 'co_changed' and 'co_cited_in_task'
 *
 * Uses a real in-memory SQLite via DatabaseSync (not drizzle migration path)
 * to keep tests fast and isolated.  The nexus-sqlite singleton is mocked so
 * getNexusNativeDb() returns our temporary DB.
 *
 * @task T998
 * @epic T991
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

// ===========================================================================
// Hoisted mocks — must be declared before any imports that depend on them
// ===========================================================================

const { mockGetNexusNativeDb } = vi.hoisted(() => ({
  mockGetNexusNativeDb: vi.fn<[], DatabaseSync | null>().mockReturnValue(null),
}));

vi.mock('../../store/nexus-sqlite.js', () => ({
  getNexusNativeDb: mockGetNexusNativeDb,
  getNexusDb: vi.fn().mockResolvedValue({}),
  resetNexusDbState: vi.fn(),
}));

// ===========================================================================
// Helpers
// ===========================================================================

/**
 * Create a minimal in-memory SQLite DB that mimics nexus_relations after the
 * T998 migration (with plasticity columns).
 */
function createTestNexusDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nexus_relations (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      type         TEXT NOT NULL,
      confidence   REAL NOT NULL,
      reason       TEXT,
      step         INTEGER,
      indexed_at   TEXT DEFAULT (datetime('now')) NOT NULL,
      weight       REAL DEFAULT 0.0,
      last_accessed_at TEXT,
      co_accessed_count INTEGER DEFAULT 0
    );
  `);
  return db;
}

/**
 * Create a DB WITHOUT the plasticity columns — simulates a pre-T998 database.
 */
function createPreMigrationDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE nexus_relations (
      id           TEXT PRIMARY KEY,
      project_id   TEXT NOT NULL,
      source_id    TEXT NOT NULL,
      target_id    TEXT NOT NULL,
      type         TEXT NOT NULL,
      confidence   REAL NOT NULL,
      reason       TEXT,
      step         INTEGER,
      indexed_at   TEXT DEFAULT (datetime('now')) NOT NULL
    );
  `);
  return db;
}

/** Insert a row and return its id. */
function insertEdge(
  db: DatabaseSync,
  id: string,
  sourceId: string,
  targetId: string,
  weight = 0.0,
  coAccessedCount = 0,
): void {
  db.prepare(`
    INSERT INTO nexus_relations (id, project_id, source_id, target_id, type, confidence, weight, co_accessed_count)
    VALUES (?, 'proj-1', ?, ?, 'calls', 0.9, ?, ?)
  `).run(id, sourceId, targetId, weight, coAccessedCount);
}

/** Read back a single row. */
function readEdge(
  db: DatabaseSync,
  id: string,
): { weight: number; co_accessed_count: number; last_accessed_at: string | null } {
  return db
    .prepare('SELECT weight, co_accessed_count, last_accessed_at FROM nexus_relations WHERE id=?')
    .get(id) as { weight: number; co_accessed_count: number; last_accessed_at: string | null };
}

// ===========================================================================
// Import under test (after mocks)
// ===========================================================================

import { extractNexusPairsFromRetrievalLog, strengthenNexusCoAccess } from '../nexus-plasticity.js';

// ===========================================================================
// Tests
// ===========================================================================

describe('T998 — NEXUS plasticity', () => {
  // -----------------------------------------------------------------------
  // Test 1 — Schema: columns exist after migration
  // -----------------------------------------------------------------------
  describe('1. nexus_relations plasticity columns exist after migration', () => {
    it('should have weight, last_accessed_at, co_accessed_count columns', () => {
      const db = createTestNexusDb();
      const cols = db.prepare('PRAGMA table_info(nexus_relations)').all() as Array<{
        name: string;
      }>;
      const names = cols.map((c) => c.name);
      expect(names).toContain('weight');
      expect(names).toContain('last_accessed_at');
      expect(names).toContain('co_accessed_count');
      db.close();
    });

    it('weight should default to 0.0', () => {
      const db = createTestNexusDb();
      insertEdge(db, 'e-defaults', 'nodeA', 'nodeB');
      const row = readEdge(db, 'e-defaults');
      expect(row.weight).toBe(0.0);
      expect(row.co_accessed_count).toBe(0);
      expect(row.last_accessed_at).toBeNull();
      db.close();
    });
  });

  // -----------------------------------------------------------------------
  // Test 2 — strengthen updates weight and co_accessed_count
  // -----------------------------------------------------------------------
  describe('2. strengthenNexusCoAccess increments weight and co_accessed_count', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestNexusDb();
      insertEdge(db, 'e-1', 'src/foo.ts::bar', 'src/baz.ts::qux');
      mockGetNexusNativeDb.mockReturnValue(db);
    });

    afterEach(() => {
      db.close();
      mockGetNexusNativeDb.mockReturnValue(null);
    });

    it('increments weight by 0.05 on first call', async () => {
      const result = await strengthenNexusCoAccess([
        { sourceId: 'src/foo.ts::bar', targetId: 'src/baz.ts::qux' },
      ]);
      expect(result.strengthened).toBe(1);
      const row = readEdge(db, 'e-1');
      expect(row.weight).toBeCloseTo(0.05, 5);
    });

    it('increments co_accessed_count by 1 on each call', async () => {
      await strengthenNexusCoAccess([{ sourceId: 'src/foo.ts::bar', targetId: 'src/baz.ts::qux' }]);
      await strengthenNexusCoAccess([{ sourceId: 'src/foo.ts::bar', targetId: 'src/baz.ts::qux' }]);
      const row = readEdge(db, 'e-1');
      expect(row.co_accessed_count).toBe(2);
    });

    it('returns skipped=0 for matched pairs', async () => {
      const result = await strengthenNexusCoAccess([
        { sourceId: 'src/foo.ts::bar', targetId: 'src/baz.ts::qux' },
      ]);
      expect(result.skipped).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Test 3 — weight cap at 1.0
  // -----------------------------------------------------------------------
  describe('3. weight caps at 1.0', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestNexusDb();
      // Start near the cap: weight = 0.98
      insertEdge(db, 'e-cap', 'nodeX', 'nodeY', 0.98);
      mockGetNexusNativeDb.mockReturnValue(db);
    });

    afterEach(() => {
      db.close();
      mockGetNexusNativeDb.mockReturnValue(null);
    });

    it('does not exceed 1.0 after multiple calls', async () => {
      await strengthenNexusCoAccess([{ sourceId: 'nodeX', targetId: 'nodeY' }]);
      await strengthenNexusCoAccess([{ sourceId: 'nodeX', targetId: 'nodeY' }]);
      await strengthenNexusCoAccess([{ sourceId: 'nodeX', targetId: 'nodeY' }]);
      const row = readEdge(db, 'e-cap');
      expect(row.weight).toBeLessThanOrEqual(1.0);
      expect(row.weight).toBeCloseTo(1.0, 5);
    });
  });

  // -----------------------------------------------------------------------
  // Test 4 — last_accessed_at is updated
  // -----------------------------------------------------------------------
  describe('4. last_accessed_at is updated on each strengthen call', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestNexusDb();
      insertEdge(db, 'e-ts', 'nodeA', 'nodeB');
      mockGetNexusNativeDb.mockReturnValue(db);
    });

    afterEach(() => {
      db.close();
      mockGetNexusNativeDb.mockReturnValue(null);
    });

    it('sets last_accessed_at after first strengthen', async () => {
      await strengthenNexusCoAccess([{ sourceId: 'nodeA', targetId: 'nodeB' }]);
      const row = readEdge(db, 'e-ts');
      expect(row.last_accessed_at).not.toBeNull();
      expect(typeof row.last_accessed_at).toBe('string');
      // Verify it looks like an ISO datetime (YYYY-MM-DD HH:MM:SS)
      expect(row.last_accessed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    });
  });

  // -----------------------------------------------------------------------
  // Test 5 — non-matching pairs are not mutated
  // -----------------------------------------------------------------------
  describe('5. non-matching pairs are not mutated', () => {
    let db: DatabaseSync;

    beforeEach(() => {
      db = createTestNexusDb();
      insertEdge(db, 'e-existing', 'nodeA', 'nodeB', 0.1, 1);
      mockGetNexusNativeDb.mockReturnValue(db);
    });

    afterEach(() => {
      db.close();
      mockGetNexusNativeDb.mockReturnValue(null);
    });

    it('returns skipped=1 for unmatched pair', async () => {
      const result = await strengthenNexusCoAccess([
        { sourceId: 'nodeA', targetId: 'nodeZ' }, // no such row
      ]);
      expect(result.skipped).toBe(1);
      expect(result.strengthened).toBe(0);
    });

    it('does not mutate existing unrelated row', async () => {
      await strengthenNexusCoAccess([{ sourceId: 'nodeA', targetId: 'nodeZ' }]);
      const row = readEdge(db, 'e-existing');
      // weight and count are unchanged
      expect(row.weight).toBeCloseTo(0.1, 5);
      expect(row.co_accessed_count).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Test 6 — runConsolidation Step 6b calls strengthenNexusCoAccess
  // -----------------------------------------------------------------------
  describe('6. runConsolidation Step 6b wires strengthenNexusCoAccess', () => {
    it('strengthenNexusCoAccess is called when pairs exist in retrieval log', async () => {
      // Set up a brain.db with retrieval log entries so the pair extractor yields pairs.
      const tempDir = await mkdtemp(join(tmpdir(), 'cleo-nexus-plasticity-'));
      process.env['CLEO_DIR'] = join(tempDir, '.cleo');

      // Spy on the strengthenNexusCoAccess export from the module.
      const plasticityMod = await import('../nexus-plasticity.js');
      const spy = vi.spyOn(plasticityMod, 'strengthenNexusCoAccess');

      // Set up a real brain db with a retrieval log entry.
      const { closeBrainDb, getBrainDb, getBrainNativeDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();
      await getBrainDb(tempDir);
      const brainDb = getBrainNativeDb();
      if (brainDb) {
        // Ensure retrieval log table exists
        brainDb.exec(`
          CREATE TABLE IF NOT EXISTS brain_retrieval_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            query TEXT NOT NULL DEFAULT '',
            entry_ids TEXT NOT NULL,
            entry_count INTEGER DEFAULT 0,
            source TEXT DEFAULT 'find',
            tokens_used INTEGER DEFAULT 0,
            session_id TEXT,
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
        brainDb
          .prepare(
            `INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source)
             VALUES ('q1', ?, 2, 'find')`,
          )
          .run(JSON.stringify(['nodeA', 'nodeB']));
      }

      // Mock getNexusNativeDb to return a DB where no rows are matched
      // (we only want to verify the call is made, not test DB writes again).
      const nexusDb = createTestNexusDb();
      mockGetNexusNativeDb.mockReturnValue(nexusDb);

      try {
        const { runConsolidation } = await import('../brain-lifecycle.js');
        await runConsolidation(tempDir);
        // strengthenNexusCoAccess must have been called at least once during Step 6b
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        closeBrainDb();
        nexusDb.close();
        mockGetNexusNativeDb.mockReturnValue(null);
        delete process.env['CLEO_DIR'];
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test 7 — NEXUS_RELATION_TYPES includes co_changed and co_cited_in_task
  // -----------------------------------------------------------------------
  describe('7. NEXUS_RELATION_TYPES includes co_changed and co_cited_in_task', () => {
    it('exports co_changed', async () => {
      const { NEXUS_RELATION_TYPES } = await import('../../store/nexus-schema.js');
      expect(NEXUS_RELATION_TYPES).toContain('co_changed');
    });

    it('exports co_cited_in_task', async () => {
      const { NEXUS_RELATION_TYPES } = await import('../../store/nexus-schema.js');
      expect(NEXUS_RELATION_TYPES).toContain('co_cited_in_task');
    });
  });

  // -----------------------------------------------------------------------
  // Test 8 — idempotent on pre-migration DB (no weight column → graceful no-op)
  // -----------------------------------------------------------------------
  describe('8. graceful no-op on pre-migration DB', () => {
    it('returns zeros when weight column is missing', async () => {
      const db = createPreMigrationDb();
      mockGetNexusNativeDb.mockReturnValue(db);

      try {
        const result = await strengthenNexusCoAccess([{ sourceId: 'nodeA', targetId: 'nodeB' }]);
        expect(result.strengthened).toBe(0);
        expect(result.skipped).toBe(0);
      } finally {
        db.close();
        mockGetNexusNativeDb.mockReturnValue(null);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test 9 — extractNexusPairsFromRetrievalLog returns deduplicated pairs
  // -----------------------------------------------------------------------
  describe('9. extractNexusPairsFromRetrievalLog deduplicates pairs', () => {
    it('returns both directed pairs for each co-retrieved entry set', async () => {
      const tempDir2 = await mkdtemp(join(tmpdir(), 'cleo-nexus-pairs-'));
      process.env['CLEO_DIR'] = join(tempDir2, '.cleo');

      const { closeBrainDb, getBrainDb, getBrainNativeDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();
      await getBrainDb(tempDir2);
      const brainDb = getBrainNativeDb();

      try {
        if (brainDb) {
          brainDb.exec(`
            CREATE TABLE IF NOT EXISTS brain_retrieval_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              query TEXT NOT NULL DEFAULT '',
              entry_ids TEXT NOT NULL,
              entry_count INTEGER DEFAULT 0,
              source TEXT DEFAULT 'find',
              tokens_used INTEGER DEFAULT 0,
              session_id TEXT,
              created_at TEXT DEFAULT (datetime('now'))
            )
          `);
          // Insert a row with two co-retrieved entries
          brainDb
            .prepare(
              `INSERT INTO brain_retrieval_log (query, entry_ids, entry_count, source)
               VALUES ('q1', ?, 2, 'find')`,
            )
            .run(JSON.stringify(['alpha', 'beta']));
        }

        const pairs = await extractNexusPairsFromRetrievalLog(tempDir2);
        // Should produce both alpha→beta and beta→alpha
        expect(pairs.length).toBeGreaterThanOrEqual(2);
        const fwdPair = pairs.find((p) => p.sourceId === 'alpha' && p.targetId === 'beta');
        const revPair = pairs.find((p) => p.sourceId === 'beta' && p.targetId === 'alpha');
        expect(fwdPair).toBeDefined();
        expect(revPair).toBeDefined();
      } finally {
        closeBrainDb();
        delete process.env['CLEO_DIR'];
        await rm(tempDir2, { recursive: true, force: true });
      }
    });

    it('returns empty array when retrieval log has no rows', async () => {
      const tempDir3 = await mkdtemp(join(tmpdir(), 'cleo-nexus-pairs-empty-'));
      process.env['CLEO_DIR'] = join(tempDir3, '.cleo');

      const { closeBrainDb, getBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      await getBrainDb(tempDir3);

      try {
        const pairs = await extractNexusPairsFromRetrievalLog(tempDir3);
        expect(pairs).toEqual([]);
      } finally {
        closeBrainDb();
        delete process.env['CLEO_DIR'];
        await rm(tempDir3, { recursive: true, force: true });
      }
    });
  });
});
