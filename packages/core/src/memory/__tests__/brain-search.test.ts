/**
 * Tests for FTS5 search across BRAIN memory.
 *
 * @task T5130
 * @epic T5149
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    const { resetFts5Cache } = await import('../brain-search.js');
    closeBrainDb();
    resetFts5Cache();
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('ensureFts5Tables', () => {
    it('should create FTS5 virtual tables successfully', async () => {
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      const { ensureFts5Tables, resetFts5Cache } = await import('../brain-search.js');
      closeBrainDb();
      resetFts5Cache();

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb(tempDir);
      expect(nativeDb).not.toBeNull();

      const result = ensureFts5Tables(nativeDb!);
      expect(result).toBe(true);

      // Verify tables exist
      const tables = nativeDb!
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('brain_decisions_fts');
      expect(tableNames).toContain('brain_patterns_fts');
      expect(tableNames).toContain('brain_learnings_fts');
    });
  });

  describe('searchBrain', () => {
    it.each([
      'fts',
      'fallback',
    ] as const)('excludes invalidated and superseded decisions in %s retrieval while preserving history', async (strategy) => {
      const { searchBrain } = await import('../brain-search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const accessor = await getBrainAccessor(tempDir);
      for (const id of ['current', 'invalidated', 'superseded', 'replaced']) {
        await accessor.addDecision({
          id,
          type: 'architecture',
          decision: 'SQLite authority guidance',
          rationale: 'Sourced project decision',
          confidence: 'high',
        });
      }
      const db = getBrainNativeDb(tempDir)!;
      db.prepare(
        "UPDATE brain_decisions SET invalid_at = datetime('now') WHERE id = 'invalidated'",
      ).run();
      db.prepare(
        "UPDATE brain_decisions SET confirmation_state = 'superseded' WHERE id = 'superseded'",
      ).run();
      db.prepare(
        "UPDATE brain_decisions SET superseded_by = 'current' WHERE id = 'replaced'",
      ).run();
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
        if (strategy === 'fallback' && sql.includes(' MATCH ?')) throw new Error('FTS unavailable');
        return prepare(sql);
      });
      try {
        const current = await searchBrain(tempDir, 'SQLite', { tables: ['decisions'] });
        expect(current.decisions.map((row) => row.id)).toEqual(['current']);
        const history = await searchBrain(tempDir, 'SQLite', {
          tables: ['decisions'],
          includeHistory: true,
        });
        expect(history.decisions.map((row) => row.id).sort()).toEqual([
          'current',
          'invalidated',
          'replaced',
          'superseded',
        ]);
      } finally {
        spy.mockRestore();
      }
    });

    it.each([
      'lexical',
      'hybrid',
      'recency',
    ] as const)('keeps retired decisions out of compact %s search and permits explicit history', async (mode) => {
      const { searchBrainCompact } = await import('../retrieval/search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(tempDir);
      for (const id of ['D-current', 'D-retired']) {
        await accessor.addDecision({
          id,
          type: 'architecture',
          decision: 'Database policy',
          rationale: 'Owner sourced',
          confidence: 'high',
        });
      }
      await accessor.updateDecision('D-retired', { invalidAt: new Date().toISOString() });
      const current = await searchBrainCompact(tempDir, {
        query: 'Database',
        tables: ['decisions'],
        mode,
      });
      expect(current.results.map((row) => row.id)).toEqual(['D-current']);
      const history = await searchBrainCompact(tempDir, {
        query: 'Database',
        tables: ['decisions'],
        mode,
        includeHistory: true,
      });
      expect(history.results.map((row) => row.id).sort()).toEqual(['D-current', 'D-retired']);
      expect((await accessor.findDecisions()).map((row) => row.id)).toEqual(['D-current']);
      expect(await accessor.getDecision('D-retired')).not.toBeNull();
    });

    it('resolves obsolete wording to the explicitly sourced successor without rewriting history', async () => {
      const { searchBrainCompact } = await import('../retrieval/search.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Always fail closed',
        rationale: 'Original owner guidance',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'architecture',
        decision: 'Missing evidence is unknown',
        rationale: 'Explicit sourced owner correction',
        confidence: 'high',
      });
      await accessor.updateDecision('D001', {
        supersededBy: 'D002',
        confirmationState: 'superseded',
      });
      const result = await searchBrainCompact(tempDir, {
        query: 'fail closed',
        tables: ['decisions'],
      });
      expect(result.results).toEqual([
        expect.objectContaining({ id: 'D002', matchedHistoricalIds: ['D001'] }),
      ]);
      expect((await accessor.getDecision('D001'))?.decision).toBe('Always fail closed');
    });

    it('reports structural scan failures instead of a clean empty diagnosis', async () => {
      const { scanBrainNoise } = await import('../brain-doctor.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      await getBrainAccessor(tempDir);
      const healthy = await scanBrainNoise(tempDir);
      expect(healthy.structure?.status).toBe('clean');
      expect(healthy.semantics?.status).toBe('unavailable');
      const db = getBrainNativeDb(tempDir)!;
      const prepare = db.prepare.bind(db);
      const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
        if (sql.includes('COUNT(*) as c')) throw new Error('simulated read failure');
        return prepare(sql);
      });
      try {
        const result = await scanBrainNoise(tempDir);
        expect(result.isClean).toBe(false);
        expect(result.structure?.status).toBe('failed');
        expect(result.structure?.reasons).toContain('simulated read failure');
      } finally {
        spy.mockRestore();
      }
    });

    it('should return empty results for empty query', async () => {
      const { searchBrain } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();

      const result = await searchBrain(tempDir, '');
      expect(result.decisions).toHaveLength(0);
      expect(result.patterns).toHaveLength(0);
      expect(result.learnings).toHaveLength(0);
    });

    it('should find decisions by text search', async () => {
      const { searchBrain, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
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
      const { ensureFts5Tables, rebuildFts5Index, resetFts5Cache } = await import(
        '../brain-search.js'
      );
      const { getBrainDb, getBrainNativeDb, closeBrainDb } = await import(
        '../../store/memory-sqlite.js'
      );
      closeBrainDb();
      resetFts5Cache();

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb(tempDir)!;
      ensureFts5Tables(nativeDb);

      // Should not throw
      rebuildFts5Index(nativeDb);
    });
  });
});
