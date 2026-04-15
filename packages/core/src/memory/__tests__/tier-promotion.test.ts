/**
 * Real-SQLite Vitest tests for runTierPromotion() (T747).
 *
 * Uses an actual temporary brain.db so the SQL logic is exercised against a
 * real SQLite engine — no mocks. Covers:
 *
 *   - short → medium via citation track (citation_count >= 3, age > 24h)
 *   - short → medium via quality track (quality_score >= 0.7, age > 24h)
 *   - short → medium via verified track (verified = 1, age > 24h)
 *   - medium → long via citation track (citation_count >= 5, age > 7d)
 *   - medium → long via verified track (verified = 1, age > 7d)
 *   - long-tier entries NEVER evicted by soft-eviction pass
 *   - stale short entries (age > 7d, low quality) are soft-evicted
 *   - fresh entries (age < 24h) are NOT promoted
 *
 * @task T747
 * @epic T726
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ISO datetime `n` days before now, in the format brain.db stores (YYYY-MM-DD HH:MM:SS). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

/** ISO datetime `n` hours before now. */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'cleo-tier-promo-test-'));
  process.env['CLEO_DIR'] = join(tempDir, '.cleo');
});

afterEach(async () => {
  // Close and reset the brain.db singleton before removing the temp dir
  const { resetBrainDbState } = await import('../../store/brain-sqlite.js');
  resetBrainDbState();
  delete process.env['CLEO_DIR'];
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers — insert raw rows via the native DB (bypasses Drizzle)
// ---------------------------------------------------------------------------

interface SeedObservationArgs {
  id: string;
  tier: string;
  citationCount?: number;
  qualityScore?: number | null;
  verified?: number;
  createdAt: string;
}

async function seedObservation(args: SeedObservationArgs): Promise<void> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
  await getBrainDb(tempDir);
  const db = getBrainNativeDb()!;
  db.prepare(`
    INSERT OR REPLACE INTO brain_observations
      (id, type, title, narrative, memory_tier, citation_count, quality_score, verified, created_at, updated_at)
    VALUES (?, 'discovery', ?, NULL, ?, ?, ?, ?, ?, ?)
  `).run(
    args.id,
    `Test obs ${args.id}`,
    args.tier,
    args.citationCount ?? 0,
    args.qualityScore ?? null,
    args.verified ?? 0,
    args.createdAt,
    args.createdAt,
  );
}

async function seedDecision(args: SeedObservationArgs): Promise<void> {
  const { getBrainDb, getBrainNativeDb } = await import('../../store/brain-sqlite.js');
  await getBrainDb(tempDir);
  const db = getBrainNativeDb()!;
  db.prepare(`
    INSERT OR REPLACE INTO brain_decisions
      (id, type, decision, rationale, confidence, memory_tier, citation_count, quality_score, verified, created_at, updated_at)
    VALUES (?, 'architecture', ?, 'rationale', 'medium', ?, ?, ?, ?, ?, ?)
  `).run(
    args.id,
    `Decision ${args.id}`,
    args.tier,
    args.citationCount ?? 0,
    args.qualityScore ?? null,
    args.verified ?? 0,
    args.createdAt,
    args.createdAt,
  );
}

async function getTier(table: string, id: string): Promise<string | null> {
  const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
  const db = getBrainNativeDb();
  if (!db) return null;
  const row = db.prepare(`SELECT memory_tier FROM ${table} WHERE id = ?`).get(id) as
    | { memory_tier: string }
    | undefined;
  return row?.memory_tier ?? null;
}

async function getInvalidAt(table: string, id: string): Promise<string | null> {
  const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
  const db = getBrainNativeDb();
  if (!db) return null;
  const row = db.prepare(`SELECT invalid_at FROM ${table} WHERE id = ?`).get(id) as
    | { invalid_at: string | null }
    | undefined;
  return row?.invalid_at ?? null;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runTierPromotion — real SQLite', () => {
  // -----------------------------------------------------------------------
  // short → medium
  // -----------------------------------------------------------------------

  describe('short → medium via citation track', () => {
    it('promotes observation with citation_count >= 3 older than 24h', async () => {
      await seedObservation({
        id: 'OBS-cite-001',
        tier: 'short',
        citationCount: 3,
        qualityScore: 0.3,
        verified: 0,
        createdAt: daysAgo(2),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]).toMatchObject({
        id: 'OBS-cite-001',
        table: 'brain_observations',
        fromTier: 'short',
        toTier: 'medium',
      });
      expect(result.promoted[0]!.reason).toContain('citationCount=3');

      // Verify DB was actually updated
      const tier = await getTier('brain_observations', 'OBS-cite-001');
      expect(tier).toBe('medium');
    });

    it('does NOT promote an observation with citation_count < 3 (and no other qualifier)', async () => {
      await seedObservation({
        id: 'OBS-cite-002',
        tier: 'short',
        citationCount: 2,
        qualityScore: 0.3,
        verified: 0,
        createdAt: daysAgo(2),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(0);
      const tier = await getTier('brain_observations', 'OBS-cite-002');
      expect(tier).toBe('short');
    });
  });

  describe('short → medium via quality track', () => {
    it('promotes observation with quality_score >= 0.7 older than 24h (T614 fix: no verified gate)', async () => {
      await seedObservation({
        id: 'OBS-qual-001',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.75,
        verified: 0, // NOT verified — was blocked before T614 fix
        createdAt: daysAgo(2),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]).toMatchObject({
        id: 'OBS-qual-001',
        fromTier: 'short',
        toTier: 'medium',
      });
      expect(result.promoted[0]!.reason).toContain('qualityScore=0.75');

      const tier = await getTier('brain_observations', 'OBS-qual-001');
      expect(tier).toBe('medium');
    });

    it('does NOT promote observation with quality_score < 0.7 and no citations', async () => {
      await seedObservation({
        id: 'OBS-qual-002',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.65,
        verified: 0,
        createdAt: daysAgo(2),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(0);
    });
  });

  describe('short → medium via verified track', () => {
    it('promotes verified observation regardless of quality or citations', async () => {
      await seedObservation({
        id: 'OBS-ver-001',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.1, // very low quality
        verified: 1,
        createdAt: daysAgo(2),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]).toMatchObject({
        id: 'OBS-ver-001',
        fromTier: 'short',
        toTier: 'medium',
      });
      expect(result.promoted[0]!.reason).toContain('verified=true');

      const tier = await getTier('brain_observations', 'OBS-ver-001');
      expect(tier).toBe('medium');
    });
  });

  describe('short promotion age gate', () => {
    it('does NOT promote an entry that is less than 24h old', async () => {
      await seedObservation({
        id: 'OBS-fresh-001',
        tier: 'short',
        citationCount: 5,
        qualityScore: 0.9,
        verified: 1,
        createdAt: hoursAgo(12), // only 12 hours old
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(0);
      const tier = await getTier('brain_observations', 'OBS-fresh-001');
      expect(tier).toBe('short');
    });
  });

  // -----------------------------------------------------------------------
  // medium → long
  // -----------------------------------------------------------------------

  describe('medium → long via citation track', () => {
    it('promotes medium observation with citation_count >= 5 older than 7d', async () => {
      await seedObservation({
        id: 'OBS-mlong-001',
        tier: 'medium',
        citationCount: 7,
        qualityScore: 0.8,
        verified: 0,
        createdAt: daysAgo(8),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]).toMatchObject({
        id: 'OBS-mlong-001',
        fromTier: 'medium',
        toTier: 'long',
      });
      expect(result.promoted[0]!.reason).toContain('citationCount=7');

      const tier = await getTier('brain_observations', 'OBS-mlong-001');
      expect(tier).toBe('long');
    });

    it('does NOT promote medium entry that is only 3 days old (age gate not met)', async () => {
      await seedObservation({
        id: 'OBS-mlong-002',
        tier: 'medium',
        citationCount: 10,
        qualityScore: 0.9,
        verified: 0,
        createdAt: daysAgo(3), // only 3 days old
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.promoted).toHaveLength(0);
      const tier = await getTier('brain_observations', 'OBS-mlong-002');
      expect(tier).toBe('medium');
    });
  });

  describe('medium → long via verified track', () => {
    it('promotes verified medium decision to long after 7d (accelerated track)', async () => {
      await seedDecision({
        id: 'DEC-vlong-001',
        tier: 'medium',
        citationCount: 1, // below citation threshold
        qualityScore: 0.6,
        verified: 1,
        createdAt: daysAgo(8),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      const longPromo = result.promoted.find((p) => p.id === 'DEC-vlong-001');
      expect(longPromo).toBeDefined();
      expect(longPromo).toMatchObject({
        fromTier: 'medium',
        toTier: 'long',
        table: 'brain_decisions',
      });
      expect(longPromo!.reason).toContain('verified=true');

      const tier = await getTier('brain_decisions', 'DEC-vlong-001');
      expect(tier).toBe('long');
    });
  });

  // -----------------------------------------------------------------------
  // Long-tier protection from eviction
  // -----------------------------------------------------------------------

  describe('long-tier entries are NEVER evicted', () => {
    it('long-tier observations are protected even if stale and low quality', async () => {
      // Seed an observation that would normally qualify for soft-eviction:
      // - short tier, age > 7d, verified=0, quality_score < 0.5
      // But seed it as 'long' — it must be completely untouched.
      await seedObservation({
        id: 'OBS-long-protected',
        tier: 'long',
        citationCount: 0,
        qualityScore: 0.1, // would be evict-eligible if it were short
        verified: 0,
        createdAt: daysAgo(30),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      // Must NOT appear in evicted
      const evicted = result.evicted.find((e) => e.id === 'OBS-long-protected');
      expect(evicted).toBeUndefined();

      // Must NOT appear in promoted (already at long)
      const promoted = result.promoted.find((p) => p.id === 'OBS-long-protected');
      expect(promoted).toBeUndefined();

      // DB row must remain unchanged
      const tier = await getTier('brain_observations', 'OBS-long-protected');
      expect(tier).toBe('long');

      const invalidAt = await getInvalidAt('brain_observations', 'OBS-long-protected');
      expect(invalidAt).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Soft eviction of stale short entries
  // -----------------------------------------------------------------------

  describe('soft eviction of stale short entries', () => {
    it('evicts short entry older than 7d with quality < 0.5 and unverified', async () => {
      await seedObservation({
        id: 'OBS-evict-001',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.2,
        verified: 0,
        createdAt: daysAgo(8),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      expect(result.evicted).toHaveLength(1);
      expect(result.evicted[0]).toMatchObject({
        id: 'OBS-evict-001',
        table: 'brain_observations',
        tier: 'short',
      });

      // DB row should have invalid_at set
      const invalidAt = await getInvalidAt('brain_observations', 'OBS-evict-001');
      expect(invalidAt).not.toBeNull();
    });

    it('does NOT evict a short entry that has quality >= 0.5', async () => {
      await seedObservation({
        id: 'OBS-evict-002',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.6, // above eviction threshold
        verified: 0,
        createdAt: daysAgo(8),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      // quality >= 0.5 means also promoted (quality >= 0.7 is the promotion gate)
      // with quality=0.6, it is below the 0.7 promotion threshold AND above the 0.5 eviction
      // threshold, so it should neither be promoted nor evicted
      const evicted = result.evicted.find((e) => e.id === 'OBS-evict-002');
      expect(evicted).toBeUndefined();

      const invalidAt = await getInvalidAt('brain_observations', 'OBS-evict-002');
      expect(invalidAt).toBeNull();
    });

    it('does NOT evict a verified short entry even if stale and low quality', async () => {
      // Verified entries get promoted via the verified track, not evicted
      await seedObservation({
        id: 'OBS-evict-003',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.1,
        verified: 1, // verified — should be promoted, not evicted
        createdAt: daysAgo(8),
      });

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      // Should be promoted (verified track), not evicted
      const promoted = result.promoted.find((p) => p.id === 'OBS-evict-003');
      expect(promoted).toBeDefined();
      expect(promoted?.toTier).toBe('medium');

      const evicted = result.evicted.find((e) => e.id === 'OBS-evict-003');
      expect(evicted).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Multi-table coverage
  // -----------------------------------------------------------------------

  describe('all four tables are processed', () => {
    it('promotes qualifying entries across brain_observations, brain_decisions, brain_learnings, brain_patterns', async () => {
      // Seed one qualifying entry in each table
      await seedObservation({
        id: 'OBS-multi',
        tier: 'short',
        citationCount: 3,
        qualityScore: 0.5,
        verified: 0,
        createdAt: daysAgo(2),
      });

      await seedDecision({
        id: 'DEC-multi',
        tier: 'short',
        citationCount: 0,
        qualityScore: 0.0,
        verified: 1,
        createdAt: daysAgo(2),
      });

      // Seed pattern and learning via raw SQL (they have different columns)
      const { getBrainNativeDb } = await import('../../store/brain-sqlite.js');
      const db = getBrainNativeDb()!;

      db.prepare(`
        INSERT OR REPLACE INTO brain_learnings
          (id, insight, source, confidence, memory_tier, citation_count, quality_score, verified, created_at, updated_at)
        VALUES (?, 'test learning', 'manual', 0.8, ?, ?, ?, ?, ?, ?)
      `).run('LEARN-multi', 'short', 0, 0.8, 0, daysAgo(2), daysAgo(2));

      db.prepare(`
        INSERT OR REPLACE INTO brain_patterns
          (id, type, pattern, context, memory_tier, citation_count, quality_score, verified, extracted_at, updated_at)
        VALUES (?, 'workflow', 'test pattern', 'ctx', ?, ?, ?, ?, ?, ?)
      `).run('PAT-multi', 'short', 4, 0.4, 0, daysAgo(2), daysAgo(2));

      const { runTierPromotion } = await import('../brain-lifecycle.js');
      const result = await runTierPromotion(tempDir);

      const promotedTables = result.promoted.map((p) => p.table);
      expect(promotedTables).toContain('brain_observations');
      expect(promotedTables).toContain('brain_decisions');
      expect(promotedTables).toContain('brain_learnings');
      expect(promotedTables).toContain('brain_patterns');

      // All should now be medium
      expect(await getTier('brain_observations', 'OBS-multi')).toBe('medium');
      expect(await getTier('brain_decisions', 'DEC-multi')).toBe('medium');
      expect(await getTier('brain_learnings', 'LEARN-multi')).toBe('medium');
      expect(await getTier('brain_patterns', 'PAT-multi')).toBe('medium');
    });
  });

  // -----------------------------------------------------------------------
  // Empty DB
  // -----------------------------------------------------------------------

  it('returns empty result when no qualifying entries exist', async () => {
    // Initialize DB without seeding
    const { getBrainDb } = await import('../../store/brain-sqlite.js');
    await getBrainDb(tempDir);

    const { runTierPromotion } = await import('../brain-lifecycle.js');
    const result = await runTierPromotion(tempDir);

    expect(result.promoted).toHaveLength(0);
    expect(result.evicted).toHaveLength(0);
  });
});
