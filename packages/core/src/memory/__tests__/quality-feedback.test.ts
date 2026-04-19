/**
 * Tests for memory quality feedback loop (quality-feedback.ts).
 *
 * Covers: trackMemoryUsage, correlateOutcomes, getMemoryQualityReport.
 *
 * @task T555
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;
let cleoDir: string;

describe('Memory Quality Feedback', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-quality-feedback-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    // Close DB handles so temp dir can be removed on Windows
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* may not be loaded */
    }
    delete process.env['CLEO_DIR'];
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // ==========================================================================
  // trackMemoryUsage
  // ==========================================================================

  describe('trackMemoryUsage', () => {
    it('should insert a usage log row without throwing', async () => {
      const { trackMemoryUsage } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      // Initialise brain DB
      await getBrainDb(tempDir);

      await expect(
        trackMemoryUsage(tempDir, 'O-test001', true, 'T100', 'success'),
      ).resolves.toBeUndefined();

      const nativeDb = getBrainNativeDb();
      expect(nativeDb).toBeTruthy();

      const rows = nativeDb!
        .prepare('SELECT * FROM brain_usage_log WHERE entry_id = ?')
        .all('O-test001') as Array<{ entry_id: string; used: number; outcome: string }>;

      expect(rows).toHaveLength(1);
      expect(rows[0].used).toBe(1);
      expect(rows[0].outcome).toBe('success');
    });

    it('should handle used=false and default outcome', async () => {
      const { trackMemoryUsage } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');

      await getBrainDb(tempDir);
      await trackMemoryUsage(tempDir, 'O-test002', false);

      const nativeDb = getBrainNativeDb();
      const rows = nativeDb!
        .prepare('SELECT * FROM brain_usage_log WHERE entry_id = ?')
        .all('O-test002') as Array<{ used: number; outcome: string }>;

      expect(rows[0].used).toBe(0);
      expect(rows[0].outcome).toBe('unknown');
    });

    it('should silently ignore empty memoryId', async () => {
      const { trackMemoryUsage } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);
      await expect(trackMemoryUsage(tempDir, '', true)).resolves.toBeUndefined();
    });
  });

  // ==========================================================================
  // correlateOutcomes
  // ==========================================================================

  describe('correlateOutcomes', () => {
    it('should return zero counts when DB is empty', async () => {
      const { correlateOutcomes } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);

      const result = await correlateOutcomes(tempDir);
      expect(result.boosted).toBe(0);
      expect(result.penalized).toBe(0);
      expect(result.flaggedForPruning).toBe(0);
      expect(result.ranAt).toBeTruthy();
    });

    it('should boost quality score for entries used in successful tasks', async () => {
      const { trackMemoryUsage, correlateOutcomes } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const accessor = await getBrainAccessor(tempDir);

      // Insert an observation with known quality score
      await accessor.addObservation({
        id: 'O-boost001',
        type: 'discovery',
        title: 'Test boost observation',
        narrative: 'Some observation text for boost test',
        contentHash: 'aabb001',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.6,
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      // Record usage with success outcome
      await trackMemoryUsage(tempDir, 'O-boost001', true, 'T200', 'success');

      const result = await correlateOutcomes(tempDir);
      expect(result.boosted).toBeGreaterThanOrEqual(1);

      // Quality score should have increased
      const nativeDb = getBrainNativeDb();
      const row = nativeDb!
        .prepare('SELECT quality_score FROM brain_observations WHERE id = ?')
        .get('O-boost001') as { quality_score: number };

      expect(row.quality_score).toBeCloseTo(0.65, 2);
    });

    it('should penalise quality score for entries used in failed tasks', async () => {
      const { trackMemoryUsage, correlateOutcomes } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const accessor = await getBrainAccessor(tempDir);

      await accessor.addObservation({
        id: 'O-penalise001',
        type: 'discovery',
        title: 'Test penalty observation',
        narrative: 'Some observation for penalty test',
        contentHash: 'aabb002',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.6,
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      await trackMemoryUsage(tempDir, 'O-penalise001', true, 'T201', 'failure');

      const result = await correlateOutcomes(tempDir);
      expect(result.penalized).toBeGreaterThanOrEqual(1);

      const nativeDb = getBrainNativeDb();
      const row = nativeDb!
        .prepare('SELECT quality_score FROM brain_observations WHERE id = ?')
        .get('O-penalise001') as { quality_score: number };

      expect(row.quality_score).toBeCloseTo(0.55, 2);
    });

    it('should clamp quality score between 0.0 and 1.0', async () => {
      const { trackMemoryUsage, correlateOutcomes } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const accessor = await getBrainAccessor(tempDir);

      await accessor.addObservation({
        id: 'O-clamp001',
        type: 'discovery',
        title: 'Clamp test near 1.0',
        narrative: 'High quality score clamp test',
        contentHash: 'aabb003',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.99,
        createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19),
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      await trackMemoryUsage(tempDir, 'O-clamp001', true, 'T202', 'success');

      await correlateOutcomes(tempDir);

      const nativeDb = getBrainNativeDb();
      const row = nativeDb!
        .prepare('SELECT quality_score FROM brain_observations WHERE id = ?')
        .get('O-clamp001') as { quality_score: number };

      expect(row.quality_score).toBeLessThanOrEqual(1.0);
    });

    it('should flag old zero-citation entries as prune_candidates', async () => {
      const { correlateOutcomes } = await import('../quality-feedback.js');
      const { getBrainDb, getBrainNativeDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const nativeDb = getBrainNativeDb();
      const accessor = await getBrainAccessor(tempDir);

      // Insert observation with a very old date (35 days ago)
      const oldDate = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

      await accessor.addObservation({
        id: 'O-stale001',
        type: 'discovery',
        title: 'Stale observation for pruning',
        narrative: 'This observation should be flagged for pruning',
        contentHash: 'aabb004',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.4,
        createdAt: oldDate,
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      // Force created_at to old value (addObservation may overwrite with NOW)
      nativeDb!
        .prepare('UPDATE brain_observations SET created_at = ?, citation_count = 0 WHERE id = ?')
        .run(oldDate, 'O-stale001');

      const result = await correlateOutcomes(tempDir);
      expect(result.flaggedForPruning).toBeGreaterThanOrEqual(1);

      const row = nativeDb!
        .prepare('SELECT prune_candidate FROM brain_observations WHERE id = ?')
        .get('O-stale001') as { prune_candidate: number };
      expect(row.prune_candidate).toBe(1);
    });
  });

  // ==========================================================================
  // getMemoryQualityReport
  // ==========================================================================

  describe('getMemoryQualityReport', () => {
    it('should return zeroed report when DB is empty', async () => {
      const { getMemoryQualityReport } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      await getBrainDb(tempDir);

      const report = await getMemoryQualityReport(tempDir);

      expect(report.totalRetrievals).toBe(0);
      expect(report.uniqueEntriesRetrieved).toBe(0);
      expect(report.usageRate).toBe(0);
      expect(report.topRetrieved).toHaveLength(0);
      expect(report.neverRetrieved).toHaveLength(0);
      expect(report.noiseRatio).toBe(0);
    });

    it('should compute quality distribution from existing entries', async () => {
      const { getMemoryQualityReport } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const accessor = await getBrainAccessor(tempDir);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      // Insert one entry per quality bucket
      await accessor.addObservation({
        id: 'O-low001',
        type: 'discovery',
        title: 'Low quality entry',
        narrative: 'Low',
        contentHash: 'qq001',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.2,
        createdAt: now,
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      await accessor.addObservation({
        id: 'O-med001',
        type: 'discovery',
        title: 'Medium quality entry',
        narrative: 'Medium',
        contentHash: 'qq002',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.5,
        createdAt: now,
        memoryTier: 'medium',
        memoryType: 'semantic',
        sourceConfidence: 'agent',
        verified: false,
      });

      await accessor.addObservation({
        id: 'O-high001',
        type: 'discovery',
        title: 'High quality entry',
        narrative: 'High',
        contentHash: 'qq003',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.9,
        createdAt: now,
        memoryTier: 'long',
        memoryType: 'procedural',
        sourceConfidence: 'owner',
        verified: true,
      });

      const report = await getMemoryQualityReport(tempDir);

      expect(report.qualityDistribution.low).toBeGreaterThanOrEqual(1);
      expect(report.qualityDistribution.medium).toBeGreaterThanOrEqual(1);
      expect(report.qualityDistribution.high).toBeGreaterThanOrEqual(1);
      expect(report.noiseRatio).toBeGreaterThan(0);
      expect(report.noiseRatio).toBeLessThan(1);
    });

    it('should list entries with zero citation_count in neverRetrieved', async () => {
      const { getMemoryQualityReport } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');
      const { getBrainAccessor } = await import('../../store/memory-accessor.js');

      await getBrainDb(tempDir);
      const accessor = await getBrainAccessor(tempDir);
      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await accessor.addObservation({
        id: 'O-zero001',
        type: 'discovery',
        title: 'Never retrieved entry',
        narrative: 'This was never retrieved',
        contentHash: 'qq010',
        project: null,
        sourceSessionId: null,
        sourceType: 'agent',
        agent: null,
        qualityScore: 0.4,
        createdAt: now,
        memoryTier: 'short',
        memoryType: 'episodic',
        sourceConfidence: 'agent',
        verified: false,
      });

      const report = await getMemoryQualityReport(tempDir);
      const found = report.neverRetrieved.find((e) => e.id === 'O-zero001');
      expect(found).toBeDefined();
      expect(found?.qualityScore).toBeCloseTo(0.4, 2);
    });

    it('should compute usageRate from brain_usage_log', async () => {
      const { trackMemoryUsage, getMemoryQualityReport } = await import('../quality-feedback.js');
      const { getBrainDb } = await import('../../store/memory-sqlite.js');

      await getBrainDb(tempDir);

      // 3 used, 1 not used → rate = 0.75
      await trackMemoryUsage(tempDir, 'O-r001', true);
      await trackMemoryUsage(tempDir, 'O-r002', true);
      await trackMemoryUsage(tempDir, 'O-r003', true);
      await trackMemoryUsage(tempDir, 'O-r004', false);

      const report = await getMemoryQualityReport(tempDir);
      expect(report.usageRate).toBeCloseTo(0.75, 2);
    });
  });
});
