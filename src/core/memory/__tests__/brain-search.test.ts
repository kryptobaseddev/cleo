/**
 * Tests for FTS5 search across BRAIN memory.
 *
 * @task T5130
 * @epic T5149
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let tempDir: string;
let cleoDir: string;

describe('Brain Search', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-brain-search-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
    const { resetFts5Cache } = await import('../brain-search.js');
    closeBrainDb();
    resetFts5Cache();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ensureFts5Tables', () => {
    it('should create FTS5 virtual tables successfully', async () => {
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { ensureFts5Tables, resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      expect(nativeDb).not.toBeNull();

      const result = ensureFts5Tables(nativeDb!);
      expect(result).toBe(true);

      // Verify tables exist
      const tables = nativeDb!.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'",
      ).all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('brain_decisions_fts');
      expect(tableNames).toContain('brain_patterns_fts');
      expect(tableNames).toContain('brain_learnings_fts');
    });
  });

  describe('searchBrain', () => {
    it('should return empty results for empty query', async () => {
      const { searchBrain } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();

      const result = await searchBrain(tempDir, '');
      expect(result.decisions).toHaveLength(0);
      expect(result.patterns).toHaveLength(0);
      expect(result.learnings).toHaveLength(0);
    });

    it('should find decisions by text search', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use SQLite for persistent storage',
        rationale: 'Reliable embedded database',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'technical',
        decision: 'Use JSON for config files',
        rationale: 'Human readable format',
        confidence: 'medium',
      });

      const result = await searchBrain(tempDir, 'SQLite');
      expect(result.decisions.length).toBeGreaterThan(0);
      expect(result.decisions[0].id).toBe('D001');
    });

    it('should find patterns by text search', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Always validate input before processing',
        context: 'API handlers and form submissions',
        frequency: 5,
      });

      const result = await searchBrain(tempDir, 'validate input');
      expect(result.patterns.length).toBeGreaterThan(0);
    });

    it('should find learnings by text search', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addLearning({
        id: 'L001',
        insight: 'Atomic file operations prevent data corruption',
        source: 'T4500 analysis',
        confidence: 0.95,
        actionable: true,
      });

      const result = await searchBrain(tempDir, 'atomic');
      expect(result.learnings.length).toBeGreaterThan(0);
    });

    it('should respect limit option', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      for (let i = 0; i < 5; i++) {
        await accessor.addDecision({
          id: `D${String(i + 1).padStart(3, '0')}`,
          type: 'technical',
          decision: `Performance optimization technique ${i}`,
          rationale: `Benchmark results show improvement ${i}`,
          confidence: 'medium',
        });
      }

      const result = await searchBrain(tempDir, 'optimization', { limit: 2 });
      expect(result.decisions.length).toBeLessThanOrEqual(2);
    });

    it('should filter by specific tables', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../../store/brain-sqlite.js');
      const { getBrainAccessor } = await import('../../../store/brain-accessor.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use performance caching',
        rationale: 'Speed improvement',
        confidence: 'high',
      });
      await accessor.addPattern({
        id: 'P001',
        type: 'optimization',
        pattern: 'Cache performance results',
        context: 'Build pipeline',
        frequency: 2,
      });

      const result = await searchBrain(tempDir, 'performance', {
        tables: ['decisions'],
      });
      expect(result.decisions.length).toBeGreaterThan(0);
      expect(result.patterns).toHaveLength(0);
      expect(result.learnings).toHaveLength(0);
    });
  });

  describe('rebuildFts5Index', () => {
    it('should rebuild FTS indexes without error', async () => {
      const { ensureFts5Tables, rebuildFts5Index, resetFts5Cache } = await import('../brain-search.js');
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import('../../../store/brain-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb()!;
      ensureFts5Tables(nativeDb);

      // Should not throw
      rebuildFts5Index(nativeDb);
    });
  });
});
