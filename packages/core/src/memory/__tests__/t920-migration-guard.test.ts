/**
 * T920 regression tests: guard T528 partial-migration duplicate-column failure.
 *
 * Root cause: When the T528 migration partially ran (brain_page_nodes ALTERs
 * succeeded but brain_page_edges.provenance ALTER did not), the migration was
 * absent from the journal. reconcileJournal Scenario 3 only marked migrations
 * as applied when ALL ALTER targets existed. With provenance missing, T528 was
 * left unjournaled — causing Drizzle to re-run it and fail with
 * "duplicate column name: quality_score" (the first ALTER statement).
 *
 * Fix (T920): reconcileJournal Scenario 3 now handles the partial-apply case:
 * when SOME ALTER columns exist but others are missing, it adds the missing
 * columns via idempotent ALTER TABLE and marks the migration as applied.
 *
 * Test plan:
 *   T920-1: Fresh brain.db — all migrations run normally, no error
 *   T920-2: brain.db where T528 fully applied but missing from journal —
 *           reconcile marks T528 applied, getBrainDb succeeds
 *   T920-3: brain.db where T528 PARTIALLY applied (brain_page_nodes ALTERs only,
 *           brain_page_edges.provenance missing) — reconcile adds provenance,
 *           marks T528 applied, getBrainDb succeeds
 *   T920-4: observeBrain succeeds on brain.db in partial-T528 state (GH #95 regression)
 *
 * @task T920
 * @see https://github.com/anthropics/cleo/issues/95
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { vi } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Resolve path to the drizzle-brain migrations folder. */
function getBrainMigrationsFolder(): string {
  // Test lives at: packages/core/src/memory/__tests__/
  // Migrations at: packages/core/migrations/drizzle-brain/
  return join(__dirname, '..', '..', '..', 'migrations', 'drizzle-brain');
}

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t920-'));
  const cleoDir = join(tempDir, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb, resetBrainDbState } = await import('../../store/brain-sqlite.js');
  closeBrainDb();
  resetBrainDbState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * Build a brain.db with all migrations through T417 applied (but not T528 or later).
 * Returns the database path.
 */
async function buildPreT528Db(dbPath: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const { readMigrationFiles } = await import('drizzle-orm/migrator');
  const migrationsFolder = getBrainMigrationsFolder();
  const allMigs = readMigrationFiles({ migrationsFolder });

  const nativeDb = new DatabaseSync(dbPath);

  // Run all migrations up to (but not including) T528
  for (const m of allMigs) {
    if (m.name && m.name >= '20260411000001') continue; // T528 and later
    if (Array.isArray(m.sql)) {
      for (const stmt of m.sql) {
        const trimmed = stmt.trim();
        if (!trimmed) continue;
        try {
          nativeDb.exec(trimmed);
        } catch {
          // ignore — some stmts may already exist in initial schema
        }
      }
    }
  }

  // Create journal with entries for everything up to T417
  nativeDb.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id INTEGER PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric,
      name text,
      applied_at TEXT
    );
  `);
  for (const m of allMigs) {
    if (m.name && m.name >= '20260411000001') continue;
    nativeDb.exec(
      `INSERT OR IGNORE INTO "__drizzle_migrations" (hash, created_at, name) VALUES ('${m.hash}', ${m.folderMillis}, '${m.name}')`,
    );
  }

  nativeDb.close();
}

/**
 * Apply only brain_page_nodes ALTER statements from T528 (not brain_page_edges.provenance).
 * Simulates a crash between the node ALTERs and the edge ALTER.
 */
async function applyT528NodesOnlyAlteration(dbPath: string): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const { readMigrationFiles } = await import('drizzle-orm/migrator');
  const migrationsFolder = getBrainMigrationsFolder();
  const allMigs = readMigrationFiles({ migrationsFolder });
  const t528 = allMigs.find((m) => m.name?.includes('t528'));
  if (!t528 || !Array.isArray(t528.sql)) throw new Error('T528 migration not found');

  const nativeDb = new DatabaseSync(dbPath);
  // T528 statements (0-indexed):
  //   [0] comment block + ALTER brain_page_nodes ADD COLUMN quality_score
  //   [1] ALTER brain_page_nodes ADD COLUMN content_hash
  //   [2] ALTER brain_page_nodes ADD COLUMN last_activity_at
  //   [3] ALTER brain_page_nodes ADD COLUMN updated_at
  //   [4] ALTER brain_page_edges ADD COLUMN provenance  ← the missing one
  //   [5..] DROP TABLE + CREATE TABLE + indexes
  for (let i = 0; i <= 3; i++) {
    const trimmed = t528.sql[i]?.trim() ?? '';
    if (!trimmed) continue;
    try {
      nativeDb.exec(trimmed);
    } catch {
      // ignore
    }
  }
  nativeDb.close();
}

describe('T920: T528 duplicate-column migration guard', () => {
  describe('T920-1: fresh brain.db — all migrations run without error', () => {
    it('should initialise brain.db from scratch without duplicate-column error', async () => {
      const { getBrainDb } = await import('../../store/brain-sqlite.js');
      await expect(getBrainDb(tempDir)).resolves.toBeDefined();

      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
      const nativeDb = getBrainNativeDb();
      expect(nativeDb).not.toBeNull();

      // brain_page_nodes must have all T528 columns
      type PragmaRow = { name: string };
      const nodesCols = nativeDb!
        .prepare('PRAGMA table_info(brain_page_nodes)')
        .all() as PragmaRow[];
      const nodesColSet = new Set(nodesCols.map((r) => r.name));
      expect(nodesColSet.has('quality_score'), 'quality_score missing from brain_page_nodes').toBe(
        true,
      );
      expect(nodesColSet.has('content_hash'), 'content_hash missing from brain_page_nodes').toBe(
        true,
      );

      // brain_page_edges must have provenance
      const edgesCols = nativeDb!
        .prepare('PRAGMA table_info(brain_page_edges)')
        .all() as PragmaRow[];
      const edgesColSet = new Set(edgesCols.map((r) => r.name));
      expect(edgesColSet.has('provenance'), 'provenance missing from brain_page_edges').toBe(true);
    });
  });

  describe('T920-2: T528 fully applied but absent from journal — reconcile marks applied', () => {
    it('should detect fully-applied T528 and mark it in the journal without error', async () => {
      const dbPath = join(tempDir, '.cleo', 'brain.db');

      // Build pre-T528 schema
      await buildPreT528Db(dbPath);

      // Apply ALL T528 statements (full migration)
      const { DatabaseSync } = await import('node:sqlite');
      const { readMigrationFiles } = await import('drizzle-orm/migrator');
      const migrationsFolder = getBrainMigrationsFolder();
      const allMigs = readMigrationFiles({ migrationsFolder });
      const t528 = allMigs.find((m) => m.name?.includes('t528'));
      expect(t528).toBeDefined();

      const nativeDb = new DatabaseSync(dbPath);
      if (Array.isArray(t528!.sql)) {
        for (const stmt of t528!.sql) {
          const trimmed = stmt.trim();
          if (!trimmed) continue;
          try {
            nativeDb.exec(trimmed);
          } catch {
            // ignore (e.g. DROP TABLE IF EXISTS on non-existent)
          }
        }
      }
      nativeDb.close();

      // getBrainDb must succeed (Scenario 3 marks T528 as applied)
      const { getBrainDb } = await import('../../store/brain-sqlite.js');
      await expect(getBrainDb(tempDir)).resolves.toBeDefined();

      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
      const nativeAfter = getBrainNativeDb();
      expect(nativeAfter).not.toBeNull();

      type PragmaRow = { name: string };
      const edgesCols = nativeAfter!
        .prepare('PRAGMA table_info(brain_page_edges)')
        .all() as PragmaRow[];
      expect(new Set(edgesCols.map((r) => r.name)).has('provenance')).toBe(true);
    });
  });

  describe('T920-3: T528 partially applied (brain_page_nodes only) — reconcile adds provenance', () => {
    it('should add provenance to brain_page_edges and mark T528 applied without error', async () => {
      const dbPath = join(tempDir, '.cleo', 'brain.db');

      // Build pre-T528 schema
      await buildPreT528Db(dbPath);

      // Apply only brain_page_nodes ALTERs from T528 (NOT brain_page_edges.provenance)
      await applyT528NodesOnlyAlteration(dbPath);

      // Verify the pre-fix state: quality_score exists, provenance does NOT
      const { DatabaseSync } = await import('node:sqlite');
      const verifyDb = new DatabaseSync(dbPath);
      type PragmaRow = { name: string };
      const nodesBefore = verifyDb
        .prepare('PRAGMA table_info(brain_page_nodes)')
        .all() as PragmaRow[];
      const edgesBefore = verifyDb
        .prepare('PRAGMA table_info(brain_page_edges)')
        .all() as PragmaRow[];
      expect(new Set(nodesBefore.map((r) => r.name)).has('quality_score')).toBe(true);
      expect(
        new Set(edgesBefore.map((r) => r.name)).has('provenance'),
        'provenance should be absent before T920 fix',
      ).toBe(false);
      verifyDb.close();

      // getBrainDb must succeed with the T920 fix
      const { getBrainDb } = await import('../../store/brain-sqlite.js');
      await expect(getBrainDb(tempDir)).resolves.toBeDefined();

      // After fix: brain_page_edges must have provenance
      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
      const nativeAfter = getBrainNativeDb();
      expect(nativeAfter).not.toBeNull();

      const edgesAfter = nativeAfter!
        .prepare('PRAGMA table_info(brain_page_edges)')
        .all() as PragmaRow[];
      expect(
        new Set(edgesAfter.map((r) => r.name)).has('provenance'),
        'provenance must be present after T920 fix',
      ).toBe(true);

      // brain_page_nodes must retain the nodes columns
      const nodesAfter = nativeAfter!
        .prepare('PRAGMA table_info(brain_page_nodes)')
        .all() as PragmaRow[];
      const nodesColSet = new Set(nodesAfter.map((r) => r.name));
      expect(nodesColSet.has('quality_score')).toBe(true);
      expect(nodesColSet.has('content_hash')).toBe(true);
      expect(nodesColSet.has('last_activity_at')).toBe(true);
      expect(nodesColSet.has('updated_at')).toBe(true);
    });
  });

  describe('T920-4: observeBrain succeeds after partial T528 state (GH #95 regression)', () => {
    it('should store an observation without duplicate-column error on partial-T528 brain.db', async () => {
      const dbPath = join(tempDir, '.cleo', 'brain.db');

      // Set up the exact GH #95 failure state
      await buildPreT528Db(dbPath);
      await applyT528NodesOnlyAlteration(dbPath);

      // observeBrain is the operation that was failing in 10+ subagent sessions
      const { observeBrain } = await import('../brain-retrieval.js');
      const result = await observeBrain(tempDir, {
        text: 'T920 regression guard: GH #95 duplicate-column fix verified',
        title: 'T920 GH #95 regression test',
        sourceType: 'manual',
      });

      expect(result, 'observeBrain should return a result').toBeDefined();
      expect(result.id, 'result should have an id').toMatch(/^O-/);
      expect(result.createdAt, 'result should have createdAt').toBeTruthy();
    });
  });
});
