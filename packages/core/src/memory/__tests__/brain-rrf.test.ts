/**
 * Tests for Reciprocal Rank Fusion (RRF) hybrid retrieval.
 *
 * Covers:
 *   1. RRF math — score = Σ 1/(k+rank), verified against known values
 *   2. Deduplication — items in multiple lists accumulate correctly
 *   3. Source tracking — ftsRank / vecRank exposed on results
 *   4. Graceful degradation — single source list works
 *   5. Integration — hybridSearch returns RRF-fused results over FTS-only
 */

import { describe, expect, it } from 'vitest';
import type { RrfHit } from '../brain-search.js';
import { RRF_K, reciprocalRankFusion } from '../brain-search.js';

// ============================================================================
// Pure math tests — no DB required
// ============================================================================

describe('reciprocalRankFusion', () => {
  describe('RRF_K constant', () => {
    it('equals 60 (research-proven Cormack 2009 value)', () => {
      expect(RRF_K).toBe(60);
    });
  });

  describe('empty inputs', () => {
    it('returns empty array for no sources', () => {
      const result = reciprocalRankFusion([]);
      expect(result).toEqual([]);
    });

    it('returns empty array for sources with empty hit lists', () => {
      const result = reciprocalRankFusion([
        { source: 'fts', hits: [] },
        { source: 'vec', hits: [] },
      ]);
      expect(result).toEqual([]);
    });
  });

  describe('single source list', () => {
    it('scores first item as 1/(k+0)', () => {
      const hits: RrfHit[] = [{ id: 'A', type: 'decision', title: 'A', text: 'a' }];
      const result = reciprocalRankFusion([{ source: 'fts', hits }]);

      expect(result).toHaveLength(1);
      expect(result[0]!.rrfScore).toBeCloseTo(1 / (60 + 0), 10);
      expect(result[0]!.id).toBe('A');
    });

    it('scores items by rank: score decreases with rank', () => {
      const hits: RrfHit[] = [
        { id: 'A', type: 'decision', title: 'A', text: 'a' },
        { id: 'B', type: 'pattern', title: 'B', text: 'b' },
        { id: 'C', type: 'learning', title: 'C', text: 'c' },
      ];
      const result = reciprocalRankFusion([{ source: 'fts', hits }]);

      expect(result).toHaveLength(3);
      expect(result[0]!.rrfScore).toBeGreaterThan(result[1]!.rrfScore);
      expect(result[1]!.rrfScore).toBeGreaterThan(result[2]!.rrfScore);
    });

    it('verifies exact scores: rank0=1/60, rank1=1/61, rank2=1/62', () => {
      const hits: RrfHit[] = [
        { id: 'A', type: 'observation', title: 'A', text: 'a' },
        { id: 'B', type: 'observation', title: 'B', text: 'b' },
        { id: 'C', type: 'observation', title: 'C', text: 'c' },
      ];
      const result = reciprocalRankFusion([{ source: 'fts', hits }]);

      expect(result[0]!.rrfScore).toBeCloseTo(1 / 60, 10);
      expect(result[1]!.rrfScore).toBeCloseTo(1 / 61, 10);
      expect(result[2]!.rrfScore).toBeCloseTo(1 / 62, 10);
    });
  });

  describe('two source lists', () => {
    it('accumulates scores for items in both lists', () => {
      const ftsHits: RrfHit[] = [
        { id: 'A', type: 'decision', title: 'A', text: 'a' },
        { id: 'B', type: 'decision', title: 'B', text: 'b' },
      ];
      const vecHits: RrfHit[] = [
        { id: 'B', type: 'decision', title: 'B', text: 'b' }, // B appears in both
        { id: 'C', type: 'decision', title: 'C', text: 'c' },
      ];

      const result = reciprocalRankFusion([
        { source: 'fts', hits: ftsHits },
        { source: 'vec', hits: vecHits },
      ]);

      // B is rank-1 in FTS and rank-0 in vec: 1/61 + 1/60
      const bEntry = result.find((r) => r.id === 'B')!;
      expect(bEntry).toBeDefined();
      expect(bEntry.rrfScore).toBeCloseTo(1 / 61 + 1 / 60, 10);

      // A is rank-0 in FTS only: 1/60
      const aEntry = result.find((r) => r.id === 'A')!;
      expect(aEntry.rrfScore).toBeCloseTo(1 / 60, 10);

      // B score > A score (two sources > one even though A is rank-0 FTS)
      expect(bEntry.rrfScore).toBeGreaterThan(aEntry.rrfScore);
    });

    it('item in both lists at rank 0 beats item in one list at rank 0', () => {
      const shared: RrfHit = { id: 'SHARED', type: 'decision', title: 'shared', text: 'shared' };
      const unique: RrfHit = { id: 'UNIQUE', type: 'decision', title: 'unique', text: 'unique' };

      const result = reciprocalRankFusion([
        { source: 'fts', hits: [shared, unique] },
        { source: 'vec', hits: [shared] },
      ]);

      const sharedEntry = result.find((r) => r.id === 'SHARED')!;
      const uniqueEntry = result.find((r) => r.id === 'UNIQUE')!;

      // SHARED: 1/60 (fts rank 0) + 1/60 (vec rank 0) = 2/60
      // UNIQUE: 1/61 (fts rank 1)
      expect(sharedEntry.rrfScore).toBeCloseTo(2 / 60, 10);
      expect(uniqueEntry.rrfScore).toBeCloseTo(1 / 61, 10);
      expect(sharedEntry.rrfScore).toBeGreaterThan(uniqueEntry.rrfScore);
    });
  });

  describe('source tracking', () => {
    it('reports sources array for each result', () => {
      const ftsHits: RrfHit[] = [{ id: 'A', type: 'decision', title: 'A', text: 'a' }];
      const vecHits: RrfHit[] = [
        { id: 'A', type: 'decision', title: 'A', text: 'a' }, // shared
        { id: 'B', type: 'pattern', title: 'B', text: 'b' }, // vec-only
      ];

      const result = reciprocalRankFusion([
        { source: 'fts', hits: ftsHits },
        { source: 'vec', hits: vecHits },
      ]);

      const aEntry = result.find((r) => r.id === 'A')!;
      expect(aEntry.sources).toContain('fts');
      expect(aEntry.sources).toContain('vec');
      expect(aEntry.sources).toHaveLength(2);

      const bEntry = result.find((r) => r.id === 'B')!;
      expect(bEntry.sources).toEqual(['vec']);
    });

    it('exposes ftsRank and vecRank for transparency', () => {
      const ftsHits: RrfHit[] = [
        { id: 'A', type: 'decision', title: 'A', text: 'a' },
        { id: 'B', type: 'pattern', title: 'B', text: 'b' },
      ];
      const vecHits: RrfHit[] = [
        { id: 'B', type: 'pattern', title: 'B', text: 'b' },
        { id: 'A', type: 'decision', title: 'A', text: 'a' },
      ];

      const result = reciprocalRankFusion([
        { source: 'fts', hits: ftsHits },
        { source: 'vec', hits: vecHits },
      ]);

      const aEntry = result.find((r) => r.id === 'A')!;
      expect(aEntry.ftsRank).toBe(0); // A is rank-0 in FTS
      expect(aEntry.vecRank).toBe(1); // A is rank-1 in vec

      const bEntry = result.find((r) => r.id === 'B')!;
      expect(bEntry.ftsRank).toBe(1); // B is rank-1 in FTS
      expect(bEntry.vecRank).toBe(0); // B is rank-0 in vec
    });

    it('ftsRank is undefined for vec-only items', () => {
      const vecHits: RrfHit[] = [{ id: 'VEC_ONLY', type: 'observation', title: 'v', text: 'v' }];
      const result = reciprocalRankFusion([{ source: 'vec', hits: vecHits }]);
      expect(result[0]!.ftsRank).toBeUndefined();
      expect(result[0]!.vecRank).toBe(0);
    });
  });

  describe('custom k parameter', () => {
    it('k=0 gives 1/(0+rank) = amplified top-rank signal', () => {
      const hits: RrfHit[] = [{ id: 'A', type: 'decision', title: 'A', text: 'a' }];
      const result = reciprocalRankFusion([{ source: 'fts', hits }], 0);
      // rank=0, k=0 → 1/(0+0) = Infinity? Actually 1/0 = Infinity in JS
      // More useful to test k=1
      expect(result[0]!.rrfScore).toBe(Infinity);
    });

    it('k=1 produces 1/1 = 1.0 for rank-0 item', () => {
      const hits: RrfHit[] = [{ id: 'A', type: 'decision', title: 'A', text: 'a' }];
      const result = reciprocalRankFusion([{ source: 'fts', hits }], 1);
      expect(result[0]!.rrfScore).toBeCloseTo(1.0, 10);
    });
  });

  describe('result ordering', () => {
    it('results are sorted by rrfScore descending', () => {
      const hits: RrfHit[] = [
        { id: 'rank0', type: 'decision', title: 'r0', text: 'r0' },
        { id: 'rank1', type: 'decision', title: 'r1', text: 'r1' },
        { id: 'rank2', type: 'decision', title: 'r2', text: 'r2' },
        { id: 'rank3', type: 'decision', title: 'r3', text: 'r3' },
      ];

      const result = reciprocalRankFusion([{ source: 'fts', hits }]);

      for (let i = 0; i < result.length - 1; i++) {
        expect(result[i]!.rrfScore).toBeGreaterThanOrEqual(result[i + 1]!.rrfScore);
      }
    });
  });

  describe('RRF fusion outperforms single-source ranking', () => {
    it('item ranked 3rd in FTS and 1st in vec beats item ranked 1st in FTS only', () => {
      // This is the key property of RRF: cross-source agreement elevates items
      // above single-source champions.
      const ftsHits: RrfHit[] = [
        { id: 'FTS_TOP', type: 'decision', title: 'fts top', text: 'fts top' },
        { id: 'OTHER1', type: 'decision', title: 'other1', text: 'other1' },
        { id: 'BOTH', type: 'decision', title: 'both', text: 'both' }, // rank 2 in FTS
      ];
      const vecHits: RrfHit[] = [
        { id: 'BOTH', type: 'decision', title: 'both', text: 'both' }, // rank 0 in vec
        { id: 'VEC_TOP', type: 'decision', title: 'vec top', text: 'vec top' },
      ];

      const result = reciprocalRankFusion([
        { source: 'fts', hits: ftsHits },
        { source: 'vec', hits: vecHits },
      ]);

      // BOTH: 1/(60+2) + 1/(60+0) = 1/62 + 1/60 ≈ 0.02957
      // FTS_TOP: 1/(60+0) = 1/60 ≈ 0.01667
      const bothEntry = result.find((r) => r.id === 'BOTH')!;
      const ftsTopEntry = result.find((r) => r.id === 'FTS_TOP')!;

      expect(bothEntry.rrfScore).toBeGreaterThan(ftsTopEntry.rrfScore);

      // Verify the math
      expect(bothEntry.rrfScore).toBeCloseTo(1 / 62 + 1 / 60, 8);
      expect(ftsTopEntry.rrfScore).toBeCloseTo(1 / 60, 10);
    });
  });
});

// ============================================================================
// Integration: hybridSearch with real (in-memory) brain.db
// ============================================================================

describe('hybridSearch (RRF integration)', () => {
  let tempDir: string;

  // Dynamic imports used to avoid module-singleton issues across tests
  async function setup() {
    const { mkdir, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-rrf-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  }

  async function teardown() {
    const { closeBrainDb } = await import('../../store/memory-sqlite.js');
    const { resetFts5Cache } = await import('../brain-search.js');
    closeBrainDb();
    resetFts5Cache();
    delete process.env['CLEO_DIR'];
    const { rm } = await import('node:fs/promises');
    await rm(tempDir, { recursive: true, force: true });
  }

  it('returns empty array for empty query', async () => {
    await setup();
    try {
      const { hybridSearch } = await import('../brain-search.js');
      const result = await hybridSearch('', tempDir);
      expect(result).toEqual([]);
    } finally {
      await teardown();
    }
  });

  it('returns FTS results when vector unavailable (RRF graceful degradation)', async () => {
    await setup();
    try {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { hybridSearch, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'architecture',
        decision: 'Use SQLite for embedded storage',
        rationale: 'Zero-dependency, serverless, reliable',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'technical',
        decision: 'Use JSON for config files',
        rationale: 'Human readable format',
        confidence: 'medium',
      });

      // No embedding provider registered — vector path will yield empty results.
      // RRF should still return FTS results correctly.
      const results = await hybridSearch('SQLite embedded', tempDir, { limit: 10 });

      expect(results.length).toBeGreaterThan(0);
      // D001 mentions SQLite — should appear
      const d001 = results.find((r) => r.id === 'D001');
      expect(d001).toBeDefined();
      // All results should carry sources array
      for (const r of results) {
        expect(r.sources).toBeInstanceOf(Array);
        expect(r.sources.length).toBeGreaterThan(0);
      }
    } finally {
      await teardown();
    }
  });

  it('exposes rrfScore (via score field) and sources on all results', async () => {
    await setup();
    try {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { hybridSearch, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addPattern({
        id: 'P001',
        type: 'workflow',
        pattern: 'Always validate input before processing',
        context: 'API handlers and form validation',
        frequency: 5,
      });

      const results = await hybridSearch('validate input', tempDir);
      expect(results.length).toBeGreaterThan(0);

      for (const r of results) {
        expect(r.score).toBeGreaterThan(0);
        expect(r.score).toBeLessThanOrEqual(1); // RRF max score for rank-0 with k=60 is 1/60 ≈ 0.0167
        expect(r.sources).toBeInstanceOf(Array);
        expect(r.id).toBeTruthy();
        expect(r.type).toBeTruthy();
        expect(r.title).toBeTruthy();
      }
    } finally {
      await teardown();
    }
  });

  it('respects limit option', async () => {
    await setup();
    try {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { hybridSearch, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      for (let i = 0; i < 8; i++) {
        await accessor.addDecision({
          id: `D${String(i + 1).padStart(3, '0')}`,
          type: 'technical',
          decision: `Performance optimization technique ${i}`,
          rationale: `Benchmark results show improvement ${i}`,
          confidence: 'medium',
        });
      }

      const results = await hybridSearch('performance optimization', tempDir, { limit: 3 });
      expect(results.length).toBeLessThanOrEqual(3);
    } finally {
      await teardown();
    }
  });

  it('results are sorted by score descending', async () => {
    await setup();
    try {
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');
      const { hybridSearch, resetFts5Cache } = await import('../brain-search.js');
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
      resetFts5Cache();

      const accessor = await getBrainAccessor(tempDir);
      await accessor.addDecision({
        id: 'D001',
        type: 'tech',
        decision: 'caching strategy for performance',
        rationale: 'perf',
        confidence: 'high',
      });
      await accessor.addDecision({
        id: 'D002',
        type: 'tech',
        decision: 'use performance profiling',
        rationale: 'bottlenecks',
        confidence: 'medium',
      });
      await accessor.addLearning({
        id: 'L001',
        insight: 'performance benchmarks guide decisions',
        source: 'T100',
        confidence: 0.9,
        actionable: true,
      });

      const results = await hybridSearch('performance', tempDir, { limit: 10 });
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i]!.score).toBeGreaterThanOrEqual(results[i + 1]!.score);
      }
    } finally {
      await teardown();
    }
  });
});
