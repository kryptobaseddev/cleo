/**
 * Tests for the auto-extract promotion fulfillment pipeline (T1903).
 *
 * Verifies that fulfillPromotionLog:
 * 1. Reads pending brain_promotion_log entries.
 * 2. Converts them into actual brain_learnings rows via storeLearning.
 * 3. Returns accurate AutoExtractMetrics (invocations, candidates, promoted, rejected).
 * 4. Skips already-fulfilled entries.
 * 5. Marks fulfilled entries with fulfilled_at to prevent retries.
 * 6. Handles dedup correctly.
 *
 * @task T1903
 * @epic T1892
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mocks — declared before any imports that use them
// ============================================================================

const { mockGetBrainDb, mockGetBrainNativeDb } = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

const mockStoreLearning = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'L-test-001' }));
const mockStorePattern = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'P-test-001' }));
const mockCheckHashDedup = vi.hoisted(() => vi.fn().mockResolvedValue({ matched: false }));

vi.mock('../learnings.js', () => ({
  storeLearning: mockStoreLearning,
}));

vi.mock('../patterns.js', () => ({
  storePattern: mockStorePattern,
}));

vi.mock('../extraction-gate.js', () => ({
  checkHashDedup: mockCheckHashDedup,
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { fulfillPromotionLog } from '../brain-lifecycle.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

interface PromotionLogFixture {
  id: string;
  observation_id: string;
  to_tier: string;
  score: number;
  fulfilled_at: string | null;
}

interface ObsFixture {
  id: string;
  type: string;
  title: string;
  narrative: string | null;
  created_at: string;
  citation_count: number;
}

function buildMockNativeDb(opts: {
  promotionLogRows: PromotionLogFixture[];
  observations: ObsFixture[];
  updateFn?: (id: string) => void;
}): ReturnType<typeof mockGetBrainNativeDb> {
  const { promotionLogRows, observations, updateFn } = opts;

  return {
    prepare: (sql: string) => {
      const trimmed = sql.trim();

      if (trimmed.startsWith('SELECT 1 FROM brain_promotion_log')) {
        // Existence check — returns something so table "exists"
        return { get: () => ({ 1: 1 }), all: () => [], run: () => ({ changes: 0 }) };
      }

      if (
        trimmed.includes('FROM brain_promotion_log') &&
        trimmed.includes('fulfilled_at IS NULL')
      ) {
        return {
          get: () => undefined,
          all: () => promotionLogRows.filter((r) => r.fulfilled_at === null),
          run: () => ({ changes: 0 }),
        };
      }

      if (trimmed.includes('FROM brain_observations')) {
        return {
          get: () => undefined,
          all: (...args: unknown[]) => {
            // args are the observation IDs passed as spread params
            const ids = args as string[];
            return observations.filter((o) => ids.includes(o.id));
          },
          run: () => ({ changes: 0 }),
        };
      }

      if (trimmed.startsWith('UPDATE brain_promotion_log')) {
        return {
          get: () => undefined,
          all: () => [],
          run: (...args: unknown[]) => {
            // args: (nowVal, logRowId) — fulfilled_at = ?, ... WHERE id = ?
            const id = args[args.length - 1] as string;
            updateFn?.(id);
            const row = promotionLogRows.find((r) => r.id === id);
            if (row) row.fulfilled_at = args[0] as string;
            return { changes: 1 };
          },
        };
      }

      // Default no-op
      return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  // Restore default mock implementations after each test
  mockCheckHashDedup.mockResolvedValue({ matched: false });
  mockStoreLearning.mockResolvedValue({ id: 'L-test-001' });
  mockStorePattern.mockResolvedValue({ id: 'P-test-001' });
});

// ============================================================================
// Tests
// ============================================================================

describe('fulfillPromotionLog — T1903 auto-extract repair', () => {
  it('returns zero metrics when brain.db is unavailable', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(0);
    expect(result.promoted).toBe(0);
  });

  it('returns zero metrics when brain_promotion_log table does not exist', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        get: vi.fn().mockImplementation(() => {
          throw new Error('no such table: brain_promotion_log');
        }),
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(0);
    expect(result.promoted).toBe(0);
  });

  it('promotes 5+ matching observations to learnings', async () => {
    const observations: ObsFixture[] = Array.from({ length: 6 }, (_, i) => ({
      id: `O-00${i}`,
      type: 'discovery',
      title: `Discovery ${i}`,
      narrative: `Important finding number ${i} about the codebase`,
      created_at: '2026-04-01 00:00:00',
      citation_count: i + 1,
    }));

    const promotionLogRows: PromotionLogFixture[] = observations.map((obs, i) => ({
      id: `promo-${i}`,
      observation_id: obs.id,
      to_tier: 'learning',
      score: 0.75,
      fulfilled_at: null,
    }));

    const db = buildMockNativeDb({ promotionLogRows, observations });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(6);
    expect(result.candidates).toBe(6);
    expect(result.promoted).toBe(6);
    expect(result.rejected.dedup_hash).toBe(0);
    expect(result.rejected.store_error).toBe(0);
    expect(mockStoreLearning).toHaveBeenCalledTimes(6);
  });

  it('skips observations with no narrative or title', async () => {
    const observations: ObsFixture[] = [
      {
        id: 'O-empty',
        type: 'discovery',
        title: '',
        narrative: null,
        created_at: '2026-04-01 00:00:00',
        citation_count: 5,
      },
    ];
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-empty',
        observation_id: 'O-empty',
        to_tier: 'learning',
        score: 0.8,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({ promotionLogRows, observations });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.rejected.no_narrative).toBe(1);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });

  it('skips entries with hash dedup match', async () => {
    mockCheckHashDedup.mockResolvedValue({ matched: true, id: 'L-existing' });

    const observations: ObsFixture[] = [
      {
        id: 'O-dup',
        type: 'discovery',
        title: 'Dup',
        narrative: 'Already stored',
        created_at: '2026-04-01 00:00:00',
        citation_count: 3,
      },
    ];
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-dup',
        observation_id: 'O-dup',
        to_tier: 'learning',
        score: 0.7,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({ promotionLogRows, observations });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(1);
    expect(result.candidates).toBe(1);
    expect(result.promoted).toBe(0);
    expect(result.rejected.dedup_hash).toBe(1);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });

  it('routes pattern-tier observations to storePattern', async () => {
    const observations: ObsFixture[] = [
      {
        id: 'O-pat',
        type: 'feature',
        title: 'Pattern obs',
        narrative: 'Do X to achieve Y',
        created_at: '2026-04-01 00:00:00',
        citation_count: 4,
      },
    ];
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-pat',
        observation_id: 'O-pat',
        to_tier: 'pattern',
        score: 0.72,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({ promotionLogRows, observations });
    mockGetBrainNativeDb.mockReturnValue(db);

    await fulfillPromotionLog(PROJECT_ROOT);

    expect(mockStorePattern).toHaveBeenCalledTimes(1);
    expect(mockStoreLearning).not.toHaveBeenCalled();
  });

  it('counts store errors in rejected.store_error', async () => {
    mockStoreLearning.mockRejectedValueOnce(new Error('DB write failed'));

    const observations: ObsFixture[] = [
      {
        id: 'O-err',
        type: 'discovery',
        title: 'Err obs',
        narrative: 'Something important',
        created_at: '2026-04-01 00:00:00',
        citation_count: 2,
      },
    ];
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-err',
        observation_id: 'O-err',
        to_tier: 'learning',
        score: 0.65,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({ promotionLogRows, observations });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.rejected.store_error).toBe(1);
    expect(result.promoted).toBe(0);
  });

  it('marks rows as fulfilled after successful store', async () => {
    const updatedIds: string[] = [];

    const observations: ObsFixture[] = [
      {
        id: 'O-ok',
        type: 'bugfix',
        title: 'Fix obs',
        narrative: 'Fixed the critical bug',
        created_at: '2026-04-01 00:00:00',
        citation_count: 3,
      },
    ];
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-ok',
        observation_id: 'O-ok',
        to_tier: 'learning',
        score: 0.8,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({
      promotionLogRows,
      observations,
      updateFn: (id: string) => updatedIds.push(id),
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.promoted).toBe(1);
    expect(updatedIds).toContain('promo-ok');
  });

  it('skips rows with no matching observation', async () => {
    const promotionLogRows: PromotionLogFixture[] = [
      {
        id: 'promo-missing',
        observation_id: 'O-nonexistent',
        to_tier: 'learning',
        score: 0.75,
        fulfilled_at: null,
      },
    ];

    const db = buildMockNativeDb({ promotionLogRows, observations: [] });
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await fulfillPromotionLog(PROJECT_ROOT);

    expect(result.invocations).toBe(1);
    expect(result.rejected.other).toBe(1);
    expect(result.promoted).toBe(0);
  });
});
