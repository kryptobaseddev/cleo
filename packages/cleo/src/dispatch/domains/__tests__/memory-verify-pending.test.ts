/**
 * Unit tests for `memory.verify` and `memory.pending-verify` dispatch operations.
 *
 * Verifies that:
 *   1. `memory.verify` flips `verified=1` on a valid brain entry.
 *   2. `memory.verify` returns E_FORBIDDEN when called by a non-owner agent.
 *   3. `memory.verify` returns E_INVALID_INPUT when id is missing.
 *   4. `memory.verify` returns E_NOT_FOUND when entry does not exist.
 *   5. `memory.verify` is idempotent (alreadyVerified=true when already set).
 *   6. `memory.pending-verify` returns all unverified entries with citation_count >= threshold.
 *   7. `memory.pending-verify` respects custom minCitations param.
 *   8. `memory.pending-verify` returns E_DB_UNAVAILABLE when brain.db is absent.
 *   9. Both operations are listed in getSupportedOperations().
 *
 * @task T792
 * @epic T770
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that trigger module resolution
// ---------------------------------------------------------------------------

// Mock engine.js (MemoryHandler imports from here for all other ops)
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

// Mock getProjectRoot
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
// Shared DB mock helpers
// ---------------------------------------------------------------------------

/** Builds a minimal SQLite nativeDb stub for test control. */
function makeNativeDb(opts: {
  /** Row returned by SELECT on brain_observations for the given id. */
  row?: { id: string; verified: number } | undefined;
  /** Rows returned by SELECT ... WHERE verified = 0. */
  allRows?: unknown[];
  /** Spy to capture UPDATE .run() calls. */
  runFn?: ReturnType<typeof vi.fn>;
}) {
  const runFn = opts.runFn ?? vi.fn(() => ({ changes: 1 }));
  return {
    prepare: vi.fn().mockImplementation((sql: string) => {
      // pending-verify queries use .all()
      if (sql.includes('WHERE verified = 0')) {
        return { all: vi.fn(() => opts.allRows ?? []) };
      }
      // llm-status uses .get() with source_type filter
      if (sql.includes('source_type IN')) {
        return { get: vi.fn(() => undefined) };
      }
      // verify uses .get() + .run()
      return {
        get: vi.fn(() => opts.row),
        run: runFn,
      };
    }),
    _runFn: runFn,
  };
}

// ---------------------------------------------------------------------------
// Module-level mocks for @cleocode/core/internal (T791 + T792 dependencies)
// ---------------------------------------------------------------------------

const mockGetBrainDb = vi.fn().mockResolvedValue(undefined);
const mockGetBrainNativeDb = vi.fn();
const mockResolveAnthropicApiKeySource = vi.fn(() => 'none' as const);
const mockResolveAnthropicApiKey = vi.fn(() => null as string | null);

vi.mock('@cleocode/core/internal', async () => {
  const actual =
    await vi.importActual<typeof import('@cleocode/core/internal')>('@cleocode/core/internal');
  return {
    ...actual,
    getBrainDb: (...args: unknown[]) => mockGetBrainDb(...args),
    getBrainNativeDb: () => mockGetBrainNativeDb(),
    resolveAnthropicApiKeySource: () => mockResolveAnthropicApiKeySource(),
    resolveAnthropicApiKey: () => mockResolveAnthropicApiKey(),
  };
});

import { MemoryHandler } from '../memory.js';

// ---------------------------------------------------------------------------
// Tests: memory.verify (mutate)
// ---------------------------------------------------------------------------

describe('MemoryHandler: mutate verify', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns E_INVALID_INPUT when id is missing', async () => {
    const result = await handler.mutate('verify', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('returns E_FORBIDDEN when a non-owner agent calls verify', async () => {
    const result = await handler.mutate('verify', { id: 'O-abc-0', agent: 'worker-rogue' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_FORBIDDEN');
    // T1258 E1: error message uses canonical 'project-orchestrator' identity
    expect(result.error?.message).toContain('project-orchestrator');
  });

  it('allows project-orchestrator canonical agent identity (T1258 E1)', async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    mockGetBrainNativeDb.mockReturnValue(
      makeNativeDb({ row: { id: 'O-abc-0', verified: 0 }, runFn }),
    );

    const result = await handler.mutate('verify', { id: 'O-abc-0', agent: 'project-orchestrator' });
    expect(result.success).toBe(true);
    expect((result.data as { verified: boolean }).verified).toBe(true);
    expect(runFn).toHaveBeenCalled();
  });

  it('allows cleo-prime legacy agent identity (T1258 E1 migration shim)', async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    mockGetBrainNativeDb.mockReturnValue(
      makeNativeDb({ row: { id: 'O-abc-0', verified: 0 }, runFn }),
    );

    const result = await handler.mutate('verify', { id: 'O-abc-0', agent: 'cleo-prime' });
    expect(result.success).toBe(true);
    expect((result.data as { verified: boolean }).verified).toBe(true);
    expect(runFn).toHaveBeenCalled();
  });

  it('allows owner agent identity', async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    mockGetBrainNativeDb.mockReturnValue(
      makeNativeDb({ row: { id: 'O-abc-0', verified: 0 }, runFn }),
    );

    const result = await handler.mutate('verify', { id: 'O-abc-0', agent: 'owner' });
    expect(result.success).toBe(true);
    expect(runFn).toHaveBeenCalled();
  });

  it('allows terminal invocation with no agent param (owner terminal)', async () => {
    const runFn = vi.fn(() => ({ changes: 1 }));
    mockGetBrainNativeDb.mockReturnValue(
      makeNativeDb({ row: { id: 'O-abc-0', verified: 0 }, runFn }),
    );

    const result = await handler.mutate('verify', { id: 'O-abc-0' });
    expect(result.success).toBe(true);
    expect(runFn).toHaveBeenCalled();
  });

  it('returns E_NOT_FOUND when entry does not exist in any table', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeNativeDb({ row: undefined }));

    const result = await handler.mutate('verify', { id: 'O-nonexistent-0' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_NOT_FOUND');
  });

  it('is idempotent — returns alreadyVerified=true and skips UPDATE when already verified', async () => {
    const runFn = vi.fn(() => ({ changes: 0 }));
    mockGetBrainNativeDb.mockReturnValue(
      makeNativeDb({ row: { id: 'O-abc-0', verified: 1 }, runFn }),
    );

    const result = await handler.mutate('verify', { id: 'O-abc-0' });
    expect(result.success).toBe(true);
    const data = result.data as { alreadyVerified: boolean; verified: boolean };
    expect(data.verified).toBe(true);
    expect(data.alreadyVerified).toBe(true);
    // UPDATE must NOT be called since entry is already verified
    expect(runFn).not.toHaveBeenCalled();
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.mutate('verify', { id: 'O-abc-0' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });

  it('is listed in getSupportedOperations().mutate', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.mutate).toContain('verify');
  });
});

// ---------------------------------------------------------------------------
// Tests: memory.pending-verify (query)
// ---------------------------------------------------------------------------

describe('MemoryHandler: query pending-verify', () => {
  let handler: MemoryHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new MemoryHandler();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty list when no highly-cited unverified entries exist', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeNativeDb({ allRows: [] }));

    const result = await handler.query('pending-verify', {});
    expect(result.success).toBe(true);
    const data = result.data as { count: number; items: unknown[] };
    expect(data.count).toBe(0);
    expect(data.items).toHaveLength(0);
  });

  it('returns pending entries when highly-cited unverified entries exist', async () => {
    const pendingRows = [
      {
        id: 'O-high-0',
        title: 'High citation entry',
        source_confidence: 'agent',
        citation_count: 12,
        memory_tier: 'short',
        created_at: '2026-04-16 10:00:00',
      },
      {
        id: 'O-low-0',
        title: 'Low citation entry',
        source_confidence: 'agent',
        citation_count: 6,
        memory_tier: 'short',
        created_at: '2026-04-15 10:00:00',
      },
    ];
    mockGetBrainNativeDb.mockReturnValue(makeNativeDb({ allRows: pendingRows }));

    const result = await handler.query('pending-verify', {});
    expect(result.success).toBe(true);
    const data = result.data as {
      count: number;
      items: Array<{ id: string; citation_count: number }>;
    };
    expect(data.count).toBeGreaterThan(0);
    // Items should be sorted DESC by citation_count
    if (data.items.length >= 2) {
      expect(data.items[0]!.citation_count).toBeGreaterThanOrEqual(data.items[1]!.citation_count);
    }
  });

  it('reflects custom minCitations in response', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeNativeDb({ allRows: [] }));

    const result = await handler.query('pending-verify', { minCitations: 10 });
    expect(result.success).toBe(true);
    const data = result.data as { minCitations: number };
    expect(data.minCitations).toBe(10);
  });

  it('includes hint field in response', async () => {
    mockGetBrainNativeDb.mockReturnValue(makeNativeDb({ allRows: [] }));

    const result = await handler.query('pending-verify', {});
    expect(result.success).toBe(true);
    const data = result.data as { hint: string };
    expect(typeof data.hint).toBe('string');
    expect(data.hint).toContain('verify');
  });

  it('returns E_DB_UNAVAILABLE when brain.db is not available', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const result = await handler.query('pending-verify', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_DB_UNAVAILABLE');
  });

  it('is listed in getSupportedOperations().query', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.query).toContain('pending-verify');
  });
});
