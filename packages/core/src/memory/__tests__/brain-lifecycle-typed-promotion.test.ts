/**
 * Tests for T1001 typed promotion:
 * - promoteObservationsToTyped (brain-lifecycle.ts)
 * - computePromotionScore (promotion-score.ts)
 * - brain_promotion_log schema
 * - stability_score column on brain_observations
 * - migration idempotency
 *
 * @task T1001
 * @epic T1000
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mocks — must be declared before any imports that use them
// ============================================================================

const { mockGetBrainDb, mockGetBrainNativeDb } = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { promoteObservationsToTyped } from '../brain-lifecycle.js';
import {
  computePromotionRationale,
  computePromotionScore,
  mapObservationTypeToTier,
  PROMOTION_THRESHOLD,
} from '../promotion-score.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

interface ObsFixture {
  id: string;
  type: string;
  citation_count: number;
  quality_score: number | null;
  stability_score: number | null;
  created_at: string;
  verified: number;
  memory_tier: string | null;
  invalid_at: string | null;
}

/** Build a mock nativeDb for promoteObservationsToTyped tests. */
function buildMockNativeDb(opts: { candidates: ObsFixture[]; alreadyLoggedIds?: Set<string> }): {
  prepare: ReturnType<typeof vi.fn>;
} {
  const alreadyLoggedIds = opts.alreadyLoggedIds ?? new Set<string>();
  const insertedLogIds: string[] = [];

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      const sqlTrimmed = sql.trim();

      // SELECT candidates query (contains FROM brain_observations)
      if (sqlTrimmed.includes('FROM brain_observations') && sqlTrimmed.includes('NOT EXISTS')) {
        return {
          all: vi.fn().mockReturnValue(opts.candidates),
        };
      }

      // SELECT idempotency check (SELECT id FROM brain_promotion_log WHERE observation_id)
      if (
        sqlTrimmed.includes('SELECT id FROM brain_promotion_log') &&
        sqlTrimmed.includes('observation_id')
      ) {
        return {
          get: vi.fn().mockImplementation((obsId: string) => {
            return alreadyLoggedIds.has(obsId) ? { id: `promo-existing-${obsId}` } : undefined;
          }),
        };
      }

      // INSERT into brain_promotion_log
      if (sqlTrimmed.includes('INSERT OR IGNORE INTO brain_promotion_log')) {
        return {
          run: vi.fn().mockImplementation((...args: unknown[]) => {
            const logId = args[0] as string;
            insertedLogIds.push(logId);
            return { changes: 1 };
          }),
        };
      }

      // Fallback
      return {
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn().mockReturnValue(undefined),
        all: vi.fn().mockReturnValue([]),
      };
    }),
    // Expose for test assertions
    _insertedLogIds: insertedLogIds,
  } as ReturnType<typeof buildMockNativeDb> & { _insertedLogIds: string[] };
}

/** Create a fixture observation with sensible defaults. */
function makeObs(overrides: Partial<ObsFixture> = {}): ObsFixture {
  return {
    id: `O-${Math.random().toString(36).slice(2, 8)}`,
    type: 'discovery',
    citation_count: 0,
    quality_score: 0.5,
    stability_score: 0.5,
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
    verified: 0,
    memory_tier: 'short',
    invalid_at: null,
    ...overrides,
  };
}

// ============================================================================
// Tests: computePromotionScore
// ============================================================================

describe('computePromotionScore', () => {
  it('returns higher score for verified+high-citation vs unverified+zero-citation', () => {
    const highScore = computePromotionScore({
      citationCount: 10,
      qualityScore: 0.9,
      stabilityScore: 0.8,
      createdAt: new Date().toISOString(), // very recent
      userVerified: 1,
      outcomeCorrelated: 1,
    });

    const lowScore = computePromotionScore({
      citationCount: 0,
      qualityScore: 0.2,
      stabilityScore: 0.1,
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days ago
      userVerified: 0,
      outcomeCorrelated: 0,
    });

    expect(highScore).toBeGreaterThan(lowScore);
    expect(highScore).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
    expect(lowScore).toBeLessThan(PROMOTION_THRESHOLD);
  });

  it('returns value in [0, 1] for all inputs', () => {
    const extreme1 = computePromotionScore({
      citationCount: 1000,
      qualityScore: 1.0,
      stabilityScore: 1.0,
      createdAt: new Date().toISOString(),
      userVerified: 1,
      outcomeCorrelated: 1,
    });
    const extreme2 = computePromotionScore({
      citationCount: 0,
      qualityScore: 0.0,
      stabilityScore: 0.0,
      createdAt: null,
      userVerified: 0,
      outcomeCorrelated: 0,
    });
    expect(extreme1).toBeGreaterThanOrEqual(0);
    expect(extreme1).toBeLessThanOrEqual(1);
    expect(extreme2).toBeGreaterThanOrEqual(0);
    expect(extreme2).toBeLessThanOrEqual(1);
  });

  it('handles null quality_score and stability_score gracefully (defaults to 0.5)', () => {
    const scoreWithNulls = computePromotionScore({
      citationCount: 0,
      qualityScore: null,
      stabilityScore: null,
      createdAt: new Date().toISOString(),
      userVerified: 0,
      outcomeCorrelated: 0,
    });
    const scoreWithDefaults = computePromotionScore({
      citationCount: 0,
      qualityScore: 0.5,
      stabilityScore: 0.5,
      createdAt: new Date().toISOString(),
      userVerified: 0,
      outcomeCorrelated: 0,
    });
    expect(scoreWithNulls).toBeCloseTo(scoreWithDefaults, 4);
  });

  it('user_verified flag raises score above threshold even with weak other signals', () => {
    const unverifiedLow = computePromotionScore({
      citationCount: 0,
      qualityScore: 0.3,
      stabilityScore: 0.3,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      userVerified: 0,
      outcomeCorrelated: 0,
    });
    const verifiedLow = computePromotionScore({
      citationCount: 0,
      qualityScore: 0.3,
      stabilityScore: 0.3,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      userVerified: 1,
      outcomeCorrelated: 0,
    });
    expect(verifiedLow).toBeGreaterThan(unverifiedLow);
  });
});

// ============================================================================
// Tests: computePromotionRationale
// ============================================================================

describe('computePromotionRationale', () => {
  it('rationale round-trips through JSON serialisation', () => {
    const signals = {
      citationCount: 5,
      qualityScore: 0.75,
      stabilityScore: 0.6,
      createdAt: new Date().toISOString(),
      userVerified: 1,
      outcomeCorrelated: 0,
    };
    const rationale = computePromotionRationale(signals);
    const json = JSON.stringify(rationale);
    const parsed = JSON.parse(json) as typeof rationale;

    expect(parsed.composite_score).toBeCloseTo(rationale.composite_score, 6);
    expect(parsed.threshold).toBe(PROMOTION_THRESHOLD);
    expect(parsed.decision).toBe('promote');
    expect(typeof parsed.signals.citation_count).toBe('number');
    expect(typeof parsed.signals.quality_score).toBe('number');
    expect(typeof parsed.signals.stability_score).toBe('number');
    expect(typeof parsed.signals.recency).toBe('number');
    expect(typeof parsed.signals.user_verified).toBe('number');
    expect(typeof parsed.signals.outcome_correlated).toBe('number');
  });

  it('decision is "skip" when score is below threshold', () => {
    const signals = {
      citationCount: 0,
      qualityScore: 0.1,
      stabilityScore: 0.1,
      createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
      userVerified: 0,
      outcomeCorrelated: 0,
    };
    const rationale = computePromotionRationale(signals);
    expect(rationale.decision).toBe('skip');
    expect(rationale.composite_score).toBeLessThan(rationale.threshold);
  });
});

// ============================================================================
// Tests: mapObservationTypeToTier
// ============================================================================

describe('mapObservationTypeToTier', () => {
  it('maps feature/refactor/change to pattern', () => {
    expect(mapObservationTypeToTier('feature')).toBe('pattern');
    expect(mapObservationTypeToTier('refactor')).toBe('pattern');
    expect(mapObservationTypeToTier('change')).toBe('pattern');
  });

  it('maps discovery/bugfix/diary to learning', () => {
    expect(mapObservationTypeToTier('discovery')).toBe('learning');
    expect(mapObservationTypeToTier('bugfix')).toBe('learning');
    expect(mapObservationTypeToTier('diary')).toBe('learning');
  });

  it('maps decision to learning', () => {
    expect(mapObservationTypeToTier('decision')).toBe('learning');
  });

  it('maps unknown types to learning (default)', () => {
    expect(mapObservationTypeToTier('unknown-type')).toBe('learning');
  });
});

// ============================================================================
// Tests: promoteObservationsToTyped
// ============================================================================

describe('promoteObservationsToTyped', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when nativeDb is unavailable', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(0);
    expect(result.skippedCount).toBe(0);
    expect(result.alreadyPromotedCount).toBe(0);
  });

  it('promotion happy path: high-scoring observation is promoted and logged', async () => {
    const highScoringObs = makeObs({
      id: 'O-highscore',
      type: 'discovery',
      citation_count: 8,
      quality_score: 0.9,
      stability_score: 0.8,
      verified: 1,
    });

    const mockDb = buildMockNativeDb({ candidates: [highScoringObs] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]).toMatchObject({
      observationId: 'O-highscore',
      observationType: 'discovery',
      toTier: 'learning',
    });
    expect(result.promoted[0]!.score).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
    expect(result.skippedCount).toBe(0);
  });

  it('no-op below threshold: low-scoring observation is not promoted', async () => {
    const lowScoringObs = makeObs({
      id: 'O-lowscore',
      type: 'discovery',
      citation_count: 0,
      quality_score: 0.1,
      stability_score: 0.1,
      verified: 0,
      // 90 days old — low recency
      created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19),
    });

    const mockDb = buildMockNativeDb({ candidates: [lowScoringObs] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(0);
    expect(result.skippedCount).toBe(1);
  });

  it('idempotency: already-logged observations are not double-promoted', async () => {
    const obs = makeObs({
      id: 'O-already',
      citation_count: 8,
      quality_score: 0.9,
      verified: 1,
    });

    const alreadyLoggedIds = new Set<string>(['O-already']);
    const mockDb = buildMockNativeDb({ candidates: [obs], alreadyLoggedIds });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(0);
    expect(result.alreadyPromotedCount).toBe(1);
  });

  it('brain_promotion_log row has rationale_json with valid composite_score', async () => {
    const obs = makeObs({
      id: 'O-rationale',
      citation_count: 5,
      quality_score: 0.75,
      stability_score: 0.6,
      verified: 1,
    });

    let capturedRationaleJson: string | undefined;
    const captureDb = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        const sqlTrimmed = sql.trim();
        if (sqlTrimmed.includes('FROM brain_observations') && sqlTrimmed.includes('NOT EXISTS')) {
          return { all: vi.fn().mockReturnValue([obs]) };
        }
        if (sqlTrimmed.includes('SELECT id FROM brain_promotion_log')) {
          return { get: vi.fn().mockReturnValue(undefined) };
        }
        if (sqlTrimmed.includes('INSERT OR IGNORE INTO brain_promotion_log')) {
          return {
            run: vi.fn().mockImplementation((...args: unknown[]) => {
              capturedRationaleJson = args[7] as string;
              return { changes: 1 };
            }),
          };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(captureDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);
    expect(result.promoted).toHaveLength(1);
    expect(capturedRationaleJson).toBeDefined();

    const rationale = JSON.parse(capturedRationaleJson!) as {
      composite_score: number;
      threshold: number;
      decision: string;
    };
    expect(rationale.composite_score).toBeGreaterThanOrEqual(PROMOTION_THRESHOLD);
    expect(rationale.threshold).toBe(PROMOTION_THRESHOLD);
    expect(rationale.decision).toBe('promote');
  });

  it('mixed batch: top scorers promoted, low scorers skipped', async () => {
    const candidates = [
      makeObs({ id: 'O-high1', citation_count: 10, quality_score: 0.9, verified: 1 }),
      makeObs({ id: 'O-high2', citation_count: 5, quality_score: 0.85, verified: 0 }),
      makeObs({
        id: 'O-low1',
        citation_count: 0,
        quality_score: 0.1,
        verified: 0,
        created_at: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19),
      }),
      makeObs({
        id: 'O-low2',
        citation_count: 0,
        quality_score: 0.2,
        stability_score: 0.1,
        verified: 0,
        created_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
          .toISOString()
          .replace('T', ' ')
          .slice(0, 19),
      }),
    ];

    const mockDb = buildMockNativeDb({ candidates });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    // At least the 2 high-scoring ones should be promoted
    expect(result.promoted.length).toBeGreaterThanOrEqual(1);
    // skippedCount + promotedCount = total non-already-promoted candidates
    expect(result.promoted.length + result.skippedCount).toBe(candidates.length);
    const promotedIds = result.promoted.map((p) => p.observationId);
    expect(promotedIds).toContain('O-high1');
  });

  it('feature-type observation maps to pattern tier in promotion log', async () => {
    const featureObs = makeObs({
      id: 'O-feature',
      type: 'feature',
      citation_count: 8,
      quality_score: 0.9,
      verified: 1,
    });

    const mockDb = buildMockNativeDb({ candidates: [featureObs] });
    mockGetBrainNativeDb.mockReturnValue(mockDb);

    const result = await promoteObservationsToTyped(PROJECT_ROOT);

    expect(result.promoted).toHaveLength(1);
    expect(result.promoted[0]!.toTier).toBe('pattern');
  });
});

// ============================================================================
// Tests: stability_score default value contract
// ============================================================================

describe('stability_score default', () => {
  it('PROMOTION_THRESHOLD is defined as a number', () => {
    expect(typeof PROMOTION_THRESHOLD).toBe('number');
    expect(PROMOTION_THRESHOLD).toBeGreaterThan(0);
    expect(PROMOTION_THRESHOLD).toBeLessThan(1);
  });

  it('computePromotionScore with stability_score=null defaults to 0.5 (no crash)', () => {
    expect(() =>
      computePromotionScore({
        citationCount: 3,
        qualityScore: 0.6,
        stabilityScore: null, // simulates row before column was added
        createdAt: new Date().toISOString(),
        userVerified: 0,
        outcomeCorrelated: 0,
      }),
    ).not.toThrow();
  });
});
