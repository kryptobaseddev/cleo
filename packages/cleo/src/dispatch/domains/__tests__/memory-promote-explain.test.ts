/**
 * Unit tests for `memory.promote-explain` dispatch operation.
 *
 * Verifies that:
 *   1. Unknown id → E_NOT_FOUND
 *   2. Promoted entry → tier: 'promoted' with non-zero citation_count
 *   3. Rejected entry → tier: 'rejected' with prune_candidate: true
 *   4. Pending entry → tier: 'pending' with explanation
 *   5. Entry with no STDP data → degrades gracefully (stdpWeights: [])
 *   6. Entry with no citations → citation_count: 0 shown without error
 *   7. `promote-explain` is listed in getSupportedOperations().query
 *
 * @task T997
 * @epic T991
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that trigger module resolution
// ---------------------------------------------------------------------------

vi.mock('../../lib/engine.js', () => ({
  memoryFind: vi.fn(),
  memoryTimeline: vi.fn(),
  memoryFetch: vi.fn(),
  memoryObserve: vi.fn(),
  memoryDecisionFind: vi.fn(),
  memoryDecisionStore: vi.fn(),
  memoryPatternFind: vi.fn(),
  memoryPatternStore: vi.fn(),
  memoryLearningFind: vi.fn(),
  memoryLearningStore: vi.fn(),
  memoryLink: vi.fn(),
  memoryGraphAdd: vi.fn(),
  memoryGraphShow: vi.fn(),
  memoryGraphNeighbors: vi.fn(),
  memoryGraphTrace: vi.fn(),
  memoryGraphRelated: vi.fn(),
  memoryGraphContext: vi.fn(),
  memoryGraphStatsFull: vi.fn(),
  memoryGraphRemove: vi.fn(),
  memoryReasonWhy: vi.fn(),
  memoryReasonSimilar: vi.fn(),
  memorySearchHybrid: vi.fn(),
  memoryQualityReport: vi.fn(),
}));

vi.mock('../../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../../core/src/paths.js')>(
    '../../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getProjectRoot: vi.fn(() => '/mock/project'),
  };
});

// ---------------------------------------------------------------------------
// Module-level mocks for @cleocode/core/internal
// ---------------------------------------------------------------------------

const mockGetBrainDb = vi.fn().mockResolvedValue(undefined);
const mockGetBrainNativeDb = vi.fn();
const mockResolveAnthropicApiKeySource = vi.fn(() => 'none' as const);
const mockResolveAnthropicApiKey = vi.fn(() => null as string | null);
const mockGenerateMemoryBridgeContent = vi.fn().mockResolvedValue('');

vi.mock('@cleocode/core/internal', async () => {
  const actual =
    await vi.importActual<typeof import('@cleocode/core/internal')>('@cleocode/core/internal');
  return {
    ...actual,
    getBrainDb: (...args: unknown[]) => mockGetBrainDb(...args),
    getBrainNativeDb: () => mockGetBrainNativeDb(),
    resolveAnthropicApiKeySource: () => mockResolveAnthropicApiKeySource(),
    resolveAnthropicApiKey: () => mockResolveAnthropicApiKey(),
    generateMemoryBridgeContent: (...args: unknown[]) => mockGenerateMemoryBridgeContent(...args),
  };
});

// Mock precompact-flush subpath export (not aliased in vitest.config)
vi.mock('@cleocode/core/memory/precompact-flush.js', () => ({
  precompactFlush: vi.fn(),
}));

import { MemoryHandler } from '../memory.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal SQLite nativeDb stub that supports the three query patterns
 * used by promote-explain:
 *  - typed table SELECT (brain_observations / brain_decisions / etc.)
 *  - prune_candidate SELECT
 *  - brain_page_edges query
 *  - brain_retrieval_log aggregate query
 */
function makeDb(opts: {
  /** Row returned from the typed table SELECT (null = not found). */
  typedRow?: {
    id: string;
    citation_count: number;
    quality_score: number | null;
    memory_tier: string | null;
    tier_promoted_at: string | null;
    verified: number;
  } | null;
  /** prune_candidate column value (default 0). */
  pruneCandidate?: number;
  /** Edge rows from brain_page_edges (default []). */
  edgeRows?: unknown[];
  /** Retrieval log summary row. */
  retrievalSummary?: { retrieval_count: number; last_accessed_at: string | null };
}) {
  const {
    typedRow = null,
    pruneCandidate = 0,
    edgeRows = [],
    retrievalSummary = { retrieval_count: 0, last_accessed_at: null },
  } = opts;

  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      // Typed table lookup: SELECT id, citation_count, quality_score, memory_tier, ...
      if (sql.includes('citation_count') && sql.includes('quality_score')) {
        return { get: vi.fn(() => typedRow ?? undefined) };
      }
      // prune_candidate lookup
      if (sql.includes('prune_candidate')) {
        return { get: vi.fn(() => ({ prune_candidate: pruneCandidate })) };
      }
      // brain_page_edges query
      if (sql.includes('brain_page_edges')) {
        return { all: vi.fn(() => edgeRows) };
      }
      // brain_retrieval_log aggregate
      if (sql.includes('brain_retrieval_log')) {
        return { get: vi.fn(() => retrievalSummary) };
      }
      // Fallback
      return { get: vi.fn(() => undefined), all: vi.fn(() => []) };
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryHandler: query promote-explain', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns E_INVALID_INPUT when id is missing', async () => {
    const result = await handler.query('promote-explain', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('returns E_NOT_FOUND for an unknown id', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeDb({ typedRow: null }));

    const result = await handler.query('promote-explain', { id: 'O-nonexistent-0' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('returns tier: promoted for an entry with medium memory_tier and non-zero citations', async () => {
    mockGetBrainNativeDb.mockReturnValue(
      makeDb({
        typedRow: {
          id: 'O-promo-0',
          citation_count: 7,
          quality_score: 0.85,
          memory_tier: 'medium',
          tier_promoted_at: '2026-04-10 12:00:00',
          verified: 0,
        },
        pruneCandidate: 0,
        retrievalSummary: { retrieval_count: 12, last_accessed_at: '2026-04-15 08:00:00' },
      }),
    );

    const result = await handler.query('promote-explain', { id: 'O-promo-0' });
    expect(result.success).toBe(true);
    const data = result.data as {
      id: string;
      tier: string;
      scoreBreakdown: { citationCount: number };
    };
    expect(data.tier).toBe('promoted');
    expect(data.scoreBreakdown.citationCount).toBeGreaterThan(0);
  });

  it('returns tier: rejected for an entry with prune_candidate=1', async () => {
    mockGetBrainNativeDb.mockReturnValue(
      makeDb({
        typedRow: {
          id: 'O-prune-0',
          citation_count: 0,
          quality_score: 0.05,
          memory_tier: 'short',
          tier_promoted_at: null,
          verified: 0,
        },
        pruneCandidate: 1,
        retrievalSummary: { retrieval_count: 0, last_accessed_at: null },
      }),
    );

    const result = await handler.query('promote-explain', { id: 'O-prune-0' });
    expect(result.success).toBe(true);
    const data = result.data as {
      tier: string;
      scoreBreakdown: { pruneCandidate: boolean };
    };
    expect(data.tier).toBe('rejected');
    expect(data.scoreBreakdown.pruneCandidate).toBe(true);
  });

  it('returns tier: pending for an entry with no promotion signals', async () => {
    mockGetBrainNativeDb.mockReturnValue(
      makeDb({
        typedRow: {
          id: 'O-pend-0',
          citation_count: 1,
          quality_score: 0.5,
          memory_tier: 'short',
          tier_promoted_at: null,
          verified: 0,
        },
        pruneCandidate: 0,
        retrievalSummary: { retrieval_count: 2, last_accessed_at: '2026-04-12 10:00:00' },
      }),
    );

    const result = await handler.query('promote-explain', { id: 'O-pend-0' });
    expect(result.success).toBe(true);
    const data = result.data as { tier: string; explanation: string };
    expect(data.tier).toBe('pending');
    expect(data.explanation).toContain('not yet been promoted');
  });

  it('returns empty stdpWeights and degrades gracefully when no STDP data exists', async () => {
    mockGetBrainNativeDb.mockReturnValue(
      makeDb({
        typedRow: {
          id: 'O-nostdp-0',
          citation_count: 3,
          quality_score: 0.6,
          memory_tier: 'short',
          tier_promoted_at: null,
          verified: 0,
        },
        edgeRows: [],
        retrievalSummary: { retrieval_count: 5, last_accessed_at: null },
      }),
    );

    const result = await handler.query('promote-explain', { id: 'O-nostdp-0' });
    expect(result.success).toBe(true);
    const data = result.data as {
      stdpWeights: unknown[];
      scoreBreakdown: { stdpWeightMax: number };
    };
    expect(data.stdpWeights).toHaveLength(0);
    expect(data.scoreBreakdown.stdpWeightMax).toBe(0);
  });

  it('shows citation_count: 0 without error for an entry with no citations', async () => {
    mockGetBrainNativeDb.mockReturnValue(
      makeDb({
        typedRow: {
          id: 'O-nocite-0',
          citation_count: 0,
          quality_score: 0.4,
          memory_tier: 'short',
          tier_promoted_at: null,
          verified: 0,
        },
        pruneCandidate: 0,
        retrievalSummary: { retrieval_count: 0, last_accessed_at: null },
      }),
    );

    const result = await handler.query('promote-explain', { id: 'O-nocite-0' });
    expect(result.success).toBe(true);
    const data = result.data as { scoreBreakdown: { citationCount: number } };
    expect(data.scoreBreakdown.citationCount).toBe(0);
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('promote-explain', { id: 'O-any-0' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });

  it('is listed in getSupportedOperations().query', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('promote-explain');
  });
});
