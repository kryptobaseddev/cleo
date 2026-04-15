/**
 * Tests for runTierPromotion in brain-lifecycle.ts (T614 fix).
 *
 * Verifies that tier promotion correctly promotes entries from short → medium
 * and medium → long based on quality score, citation count, verification status,
 * and age thresholds — WITHOUT requiring `verified = true` as a hard gate for
 * the quality/citation tracks (T614 bug fix).
 *
 * @task T614
 * @epic T569
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
// ============================================================================

const { mockGetBrainDb, mockGetBrainNativeDb } = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
}));

vi.mock('../../store/brain-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

// ============================================================================
// Import module under test (after all mocks)
// ============================================================================

import { runTierPromotion } from '../brain-lifecycle.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

/** ISO datetime string for `daysAgo` days before now. */
function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
}

type PreparedStmt = {
  run: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
};

/** Build a minimal SQLite-like prepared statement stub. */
function makeStmt(rows: unknown[] = []): PreparedStmt {
  return {
    run: vi.fn().mockReturnValue({ changes: rows.length }),
    get: vi.fn().mockReturnValue(rows[0] ?? undefined),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('runTierPromotion', () => {
  let capturedUpdates: Array<{ table: string; id: string; tier: string }> = [];

  beforeEach(() => {
    capturedUpdates = [];
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when nativeDb is unavailable', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(0);
    expect(result.evicted).toHaveLength(0);
  });

  it('promotes unverified observation with quality_score >= 0.7 (T614 fix: no verified gate)', async () => {
    // This is the core T614 regression test: an unverified (verified=0) observation
    // with quality_score=0.8 older than 24h MUST promote to medium.
    const shortObs = [
      {
        id: 'O-test-001',
        citation_count: 0,
        quality_score: 0.8,
        verified: 0, // NOT verified — was blocked before T614 fix
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: shortObs,
        mediumToLong: [],
        toEvict: [],
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      id: 'O-test-001',
      table: 'brain_observations',
      fromTier: 'short',
      toTier: 'medium',
    });
    expect(result.promoted[0]!.reason).toContain('qualityScore=0.80');
  });

  it('promotes unverified observation with citation_count >= 3 (T614 fix)', async () => {
    const shortObs = [
      {
        id: 'O-test-002',
        citation_count: 5,
        quality_score: 0.4, // low quality but high citations
        verified: 0,
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: shortObs,
        mediumToLong: [],
        toEvict: [],
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      id: 'O-test-002',
      fromTier: 'short',
      toTier: 'medium',
    });
    expect(result.promoted[0]!.reason).toContain('citationCount=5');
  });

  it('promotes verified observation with any quality (verified track)', async () => {
    const shortObs = [
      {
        id: 'O-test-003',
        citation_count: 0,
        quality_score: 0.3, // low quality, low citations, but verified
        verified: 1,
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: shortObs,
        mediumToLong: [],
        toEvict: [],
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      id: 'O-test-003',
      fromTier: 'short',
      toTier: 'medium',
    });
    expect(result.promoted[0]!.reason).toContain('verified=true');
  });

  it('promotes medium entry to long with citation_count >= 5 (no verified requirement)', async () => {
    const mediumObs = [
      {
        id: 'O-test-004',
        citation_count: 7,
        quality_score: 0.9,
        verified: 0, // not verified but high citations
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: [],
        mediumToLong: mediumObs,
        toEvict: [],
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      id: 'O-test-004',
      fromTier: 'medium',
      toTier: 'long',
    });
    expect(result.promoted[0]!.reason).toContain('citationCount=7');
  });

  it('promotes verified medium entry to long (accelerated track)', async () => {
    const mediumObs = [
      {
        id: 'O-test-005',
        citation_count: 1, // only 1 citation but verified
        quality_score: 0.6,
        verified: 1,
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: [],
        mediumToLong: mediumObs,
        toEvict: [],
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      id: 'O-test-005',
      fromTier: 'medium',
      toTier: 'long',
    });
    expect(result.promoted[0]!.reason).toContain('verified=true');
  });

  it('soft-evicts stale short entries with low quality and no promotion', async () => {
    const staleObs = [
      {
        id: 'O-test-006',
        quality_score: 0.1,
      },
    ];

    const nativeDb = buildMockDb({
      brain_observations: {
        shortToMedium: [],
        mediumToLong: [],
        toEvict: staleObs,
      },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.evicted).toHaveLength(1);
    expect(result.evicted[0]).toMatchObject({
      id: 'O-test-006',
      table: 'brain_observations',
      tier: 'short',
    });
    expect(result.promoted).toHaveLength(0);
  });

  it('processes all four memory tables', async () => {
    // Each table should get one promotion
    const obsRow = [{ id: 'O-obs', citation_count: 5, quality_score: 0.8, verified: 0 }];
    const learningRow = [{ id: 'L-learn', citation_count: 0, quality_score: 0.75, verified: 0 }];
    const patternRow = [{ id: 'P-pat', citation_count: 3, quality_score: 0.5, verified: 0 }];
    const decisionRow = [{ id: 'D-dec', citation_count: 0, quality_score: 0.0, verified: 1 }];

    const nativeDb = buildMockDb({
      brain_observations: { shortToMedium: obsRow, mediumToLong: [], toEvict: [] },
      brain_learnings: { shortToMedium: learningRow, mediumToLong: [], toEvict: [] },
      brain_patterns: { shortToMedium: patternRow, mediumToLong: [], toEvict: [] },
      brain_decisions: { shortToMedium: decisionRow, mediumToLong: [], toEvict: [] },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(4);
    const promotedTables = result.promoted.map((p) => p.table);
    expect(promotedTables).toContain('brain_observations');
    expect(promotedTables).toContain('brain_learnings');
    expect(promotedTables).toContain('brain_patterns');
    expect(promotedTables).toContain('brain_decisions');
  });

  it('returns empty result when no entries qualify', async () => {
    const nativeDb = buildMockDb({
      brain_observations: { shortToMedium: [], mediumToLong: [], toEvict: [] },
      brain_learnings: { shortToMedium: [], mediumToLong: [], toEvict: [] },
      brain_patterns: { shortToMedium: [], mediumToLong: [], toEvict: [] },
      brain_decisions: { shortToMedium: [], mediumToLong: [], toEvict: [] },
    });
    mockGetBrainNativeDb.mockReturnValue(nativeDb);

    const result = await runTierPromotion(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(0);
    expect(result.evicted).toHaveLength(0);
  });
});

// ============================================================================
// Helper: build a mock nativeDb that routes prepare() calls based on SQL content
// ============================================================================

type TableFixtures = {
  shortToMedium: unknown[];
  mediumToLong: unknown[];
  toEvict: unknown[];
};

function buildMockDb(tables: Partial<Record<string, TableFixtures>>): {
  prepare: ReturnType<typeof vi.fn>;
} {
  const allTables = ['brain_observations', 'brain_learnings', 'brain_patterns', 'brain_decisions'];

  // Normalise: every table gets a default empty fixture
  const fixtures: Record<string, TableFixtures> = {};
  for (const t of allTables) {
    fixtures[t] = tables[t] ?? { shortToMedium: [], mediumToLong: [], toEvict: [] };
  }

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      // Determine which table this statement targets
      const targetTable = allTables.find((t) => sql.includes(t)) ?? 'brain_observations';
      const fix = fixtures[targetTable]!;

      // SELECT for eviction — identified by "(verified = 0 OR verified IS NULL)"
      // Must be checked BEFORE the short-promotion check since both use memory_tier='short'
      if (sql.includes('verified = 0') || sql.includes('verified IS NULL')) {
        return {
          all: vi.fn().mockReturnValue(fix.toEvict),
        };
      }
      // SELECT for short→medium promotion — uses "(citation_count >= 3 OR quality_score >= 0.7 OR verified = 1)"
      if (sql.includes("memory_tier = 'short'") && sql.includes('SELECT')) {
        return {
          all: vi.fn().mockReturnValue(fix.shortToMedium),
        };
      }
      // SELECT for medium→long promotion
      if (sql.includes("memory_tier = 'medium'") && sql.includes('SELECT')) {
        return {
          all: vi.fn().mockReturnValue(fix.mediumToLong),
        };
      }
      // UPDATE statements (tier change, eviction)
      if (sql.includes('UPDATE')) {
        return {
          run: vi.fn().mockReturnValue({ changes: 1 }),
        };
      }
      // Fallback: SELECT returning empty
      return {
        all: vi.fn().mockReturnValue([]),
        run: vi.fn().mockReturnValue({ changes: 0 }),
      };
    }),
  };
}
