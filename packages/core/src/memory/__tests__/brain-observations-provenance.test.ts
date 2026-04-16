/**
 * T759 regression tests: brain_observations provenance column hotfix.
 *
 * Root cause: packages/cleo/migrations/drizzle-brain/ only shipped the initial
 * migration. On a fresh install, brain_page_edges lacked the `provenance` column
 * (added by T528). The T626 post-migration guard ran an UPDATE using
 * `WHERE provenance LIKE ...` which threw "no such column: provenance".
 * That error propagated through observeBrain → memoryObserve and surfaced as
 * E_BRAIN_OBSERVE: no such column: provenance.
 *
 * Fix:
 *   1. All brain migrations are now synced to packages/cleo/migrations/drizzle-brain/
 *      by the build.mjs syncMigrationsToCleoPackage() step.
 *   2. brain-sqlite.ts T626 guard now calls ensureColumns for `provenance` on
 *      brain_page_edges before running the UPDATE, so the guard is safe even if
 *      T528 migration somehow hasn't run yet.
 *
 * Test plan:
 *   OBS-1: observeBrain succeeds on a fresh brain.db (all migrations run)
 *   OBS-2: brain_observations has agent + quality_score + memory_tier columns
 *   OBS-3: brain_page_edges has provenance column after DB init
 *   OBS-4: The T626 guard UPDATE runs without error (provenance column present)
 *   OBS-5: session.end memory-bridge write does not throw provenance error
 *   OBS-6: Simulate pre-T528 brain.db state: ensureColumns adds provenance
 *          and T626 guard runs without error
 *
 * @task T759
 * @epic T569
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

import { vi } from 'vitest';

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-t759-'));
  const cleoDir = join(tempDir, '.cleo');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cleoDir, { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  const { closeBrainDb } = await import('../../store/brain-sqlite.js');
  closeBrainDb();
  const { resetBrainDbState } = await import('../../store/brain-sqlite.js');
  resetBrainDbState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
  const nativeDb = getBrainNativeDb();
  if (!nativeDb) throw new Error('nativeDb is null after getBrainDb()');
  type PragmaRow = { name: string };
  const rows = nativeDb.prepare(`PRAGMA table_info(${tableName})`).all() as PragmaRow[];
  return new Set(rows.map((r) => r.name));
}

describe('T759: brain_observations provenance hotfix', () => {
  describe('OBS-1: observeBrain succeeds on fresh brain.db', () => {
    it('should store an observation without error', async () => {
      const { observeBrain } = await import('../brain-retrieval.js');
      const result = await observeBrain(tempDir, {
        text: 'T759 regression test observation',
        title: 'T759 test',
        sourceType: 'manual',
      });
      expect(result).toBeDefined();
      expect(result.id).toMatch(/^O-/);
      expect(result.type).toBe('discovery');
      expect(result.createdAt).toBeTruthy();
    });
  });

  describe('OBS-2: brain_observations has all required columns after migration', () => {
    it('should have agent, quality_score, memory_tier, source_confidence, citation_count', async () => {
      const { getBrainDb } = await import('../../store/brain-sqlite.js');
      await getBrainDb(tempDir);
      const cols = await getTableColumns('brain_observations');
      // T417 columns
      expect(cols.has('agent'), 'agent column missing (T417)').toBe(true);
      // T531 columns
      expect(cols.has('quality_score'), 'quality_score column missing (T531)').toBe(true);
      // T549 columns
      expect(cols.has('memory_tier'), 'memory_tier column missing (T549)').toBe(true);
      expect(cols.has('memory_type'), 'memory_type column missing (T549)').toBe(true);
      expect(cols.has('verified'), 'verified column missing (T549)').toBe(true);
      expect(cols.has('source_confidence'), 'source_confidence column missing (T549)').toBe(true);
      expect(cols.has('citation_count'), 'citation_count column missing (T549)').toBe(true);
      // T726 columns
      expect(cols.has('tier_promoted_at'), 'tier_promoted_at column missing (T726)').toBe(true);
      expect(cols.has('tier_promotion_reason'), 'tier_promotion_reason column missing (T726)').toBe(
        true,
      );
      // provenance MUST NOT appear — it is on brain_page_edges, not brain_observations
      expect(cols.has('provenance'), 'provenance should NOT be on brain_observations').toBe(false);
    });
  });

  describe('OBS-3: brain_page_edges has provenance column after DB init', () => {
    it('should have provenance column on brain_page_edges (added by T528 migration)', async () => {
      const { getBrainDb } = await import('../../store/brain-sqlite.js');
      await getBrainDb(tempDir);
      const cols = await getTableColumns('brain_page_edges');
      expect(cols.has('provenance'), 'provenance column missing from brain_page_edges').toBe(true);
    });
  });

  describe('OBS-4: T626 guard UPDATE runs without error', () => {
    it('should not throw when running the co_retrieved normalization UPDATE', async () => {
      const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      expect(nativeDb, 'nativeDb should be set after getBrainDb()').not.toBeNull();
      // The T626 guard UPDATE should have already run successfully during getBrainDb().
      // Verify it can run again without error (idempotent).
      expect(() => {
        nativeDb!
          .prepare(
            `UPDATE brain_page_edges
             SET edge_type = 'co_retrieved'
             WHERE edge_type = 'relates_to'
               AND provenance LIKE 'consolidation:%'`,
          )
          .run();
      }).not.toThrow();
    });
  });

  describe('OBS-5: memory bridge generation does not throw provenance error', () => {
    it('should generate memory bridge content without E_BRAIN_OBSERVE', async () => {
      // First write an observation so the bridge has content to read
      const { observeBrain } = await import('../brain-retrieval.js');
      await observeBrain(tempDir, {
        text: 'Memory bridge test observation for T759',
        title: 'T759 bridge test',
        sourceType: 'manual',
      });

      // Generating the memory bridge triggers queryRecentObservations which reads
      // brain_observations. This should not fail with "no such column: provenance".
      const { writeMemoryBridge } = await import('../memory-bridge.js');
      const result = await writeMemoryBridge(tempDir);
      expect(result, 'writeMemoryBridge should return a result object').toBeDefined();
      expect(result.path, 'result should have a path').toBeTruthy();
    });
  });

  describe('OBS-6: ensureColumns adds provenance to brain_page_edges when missing', () => {
    it('should add provenance column via ensureColumns and allow T626 guard UPDATE', async () => {
      const { DatabaseSync } = await import('node:sqlite');

      // Build an in-memory brain_page_edges table WITHOUT provenance (pre-T528 state)
      const db = new DatabaseSync(':memory:');
      db.exec(`
        CREATE TABLE brain_page_edges (
          from_id text NOT NULL, to_id text NOT NULL, edge_type text NOT NULL,
          weight real DEFAULT 1, created_at text DEFAULT (datetime('now')) NOT NULL,
          CONSTRAINT brain_page_edges_pk PRIMARY KEY(from_id, to_id, edge_type)
        );
      `);

      // Confirm provenance is absent
      type PragmaRow = { name: string };
      const colsBefore = db.prepare('PRAGMA table_info(brain_page_edges)').all() as PragmaRow[];
      expect(
        colsBefore.some((c) => c.name === 'provenance'),
        'provenance should be absent before ensureColumns',
      ).toBe(false);

      // ensureColumns should add provenance without error
      const { ensureColumns } = await import('../../store/migration-manager.js');
      expect(() => {
        ensureColumns(db, 'brain_page_edges', [{ name: 'provenance', ddl: 'text' }], 'brain');
      }).not.toThrow();

      // Confirm provenance is now present
      const colsAfter = db.prepare('PRAGMA table_info(brain_page_edges)').all() as PragmaRow[];
      expect(
        colsAfter.some((c) => c.name === 'provenance'),
        'provenance should exist after ensureColumns',
      ).toBe(true);

      // T626 guard UPDATE must not throw
      expect(() => {
        db.prepare(
          `UPDATE brain_page_edges
           SET edge_type = 'co_retrieved'
           WHERE edge_type = 'relates_to'
             AND provenance LIKE 'consolidation:%'`,
        ).run();
      }).not.toThrow();

      db.close();
    });
  });
});
