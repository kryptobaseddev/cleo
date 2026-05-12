/**
 * Tests for getDreamStatus — T1895 engine liveness probe.
 *
 * Verifies:
 * 1. Healthy state returns isOverdue=false
 * 2. Stale state (old consolidation + pending observations) returns isOverdue=true
 * 3. Never-consolidated but has observations returns isOverdue=true
 * 4. dreamInFlight reflected in status
 * 5. Tick loop alive detection via mocked sentient state
 *
 * @task T1895
 * @epic T1892
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mocks
// ============================================================================

const { mockGetBrainDb, mockGetBrainNativeDb } = vi.hoisted(() => ({
  mockGetBrainDb: vi.fn().mockResolvedValue({}),
  mockGetBrainNativeDb: vi.fn(),
}));

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainDb: mockGetBrainDb,
  getBrainNativeDb: mockGetBrainNativeDb,
}));

const mockReadSentientState = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ lastTickAt: new Date().toISOString() }),
);

vi.mock('../../sentient/state.js', () => ({
  readSentientState: mockReadSentientState,
}));

vi.mock('../../paths.js', () => ({
  getCleoDirAbsolute: vi.fn().mockReturnValue('/fake/.cleo'),
}));

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { ...actual };
});

// ============================================================================
// Import under test (after mocks)
// ============================================================================

import { _resetDreamState, getDreamStatus } from '../dream-cycle.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

/** ISO timestamp N hours in the past */
function hoursAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function buildDb(opts: {
  consolidationAt: string | null;
  observationCount: number;
  lastRetrievalAt: string | null;
}) {
  return {
    prepare: (sql: string) => {
      const trimmed = sql.trim();

      if (trimmed.includes('FROM brain_consolidation_events')) {
        return {
          get: () => (opts.consolidationAt ? { started_at: opts.consolidationAt } : undefined),
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      }

      if (trimmed.includes('FROM brain_observations') && trimmed.includes('COUNT(*)')) {
        return {
          get: () => ({ cnt: opts.observationCount }),
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      }

      if (trimmed.includes('FROM brain_retrieval_log')) {
        return {
          get: () => (opts.lastRetrievalAt ? { created_at: opts.lastRetrievalAt } : undefined),
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      }

      return { get: () => undefined, all: () => [], run: () => ({ changes: 0 }) };
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
  _resetDreamState();
  mockReadSentientState.mockResolvedValue({ lastTickAt: new Date().toISOString() });
});

// ============================================================================
// Tests
// ============================================================================

describe('getDreamStatus — T1895 liveness probe', () => {
  it('returns isOverdue=false when recently consolidated and few observations', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(1),
      observationCount: 3,
      lastRetrievalAt: hoursAgo(5),
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.isOverdue).toBe(false);
    expect(status.observationsSinceLastConsolidation).toBe(3);
    expect(status.lastConsolidatedAt).toBeTruthy();
  });

  it('returns isOverdue=true when stale (old consolidation + pending observations)', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(30), // 30 hours ago — beyond 24h threshold
      observationCount: 100, // has observations
      lastRetrievalAt: hoursAgo(2),
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.isOverdue).toBe(true);
    expect(status.observationsSinceLastConsolidation).toBe(100);
  });

  it('returns isOverdue=true when volume exceeds volumeThreshold * 5 (=50)', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(2), // recent consolidation — not stale by age
      observationCount: 51, // > 10 * 5 = 50
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.isOverdue).toBe(true);
  });

  it('returns isOverdue=true when never consolidated and has observations', async () => {
    const db = buildDb({
      consolidationAt: null,
      observationCount: 5,
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.isOverdue).toBe(true);
    expect(status.lastConsolidatedAt).toBeNull();
  });

  it('returns isOverdue=false when never consolidated but no observations', async () => {
    const db = buildDb({
      consolidationAt: null,
      observationCount: 0,
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.isOverdue).toBe(false);
  });

  it('reflects dreamInFlight=false when no dream running', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(1),
      observationCount: 0,
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.dreamInFlight).toBe(false);
  });

  it('reports tickLoopAlive=true when last tick is recent', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(1),
      observationCount: 0,
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);
    mockReadSentientState.mockResolvedValue({
      lastTickAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    }); // 5 min ago

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.tickLoopAlive).toBe(true);
    expect(status.lastTickAt).toBeTruthy();
  });

  it('reports tickLoopAlive=false when last tick is old', async () => {
    const db = buildDb({
      consolidationAt: hoursAgo(1),
      observationCount: 0,
      lastRetrievalAt: null,
    });
    mockGetBrainNativeDb.mockReturnValue(db);
    mockReadSentientState.mockResolvedValue({
      lastTickAt: new Date(Date.now() - 120 * 60 * 1000).toISOString(), // 2 hours ago — beyond 90min window
    });

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.tickLoopAlive).toBe(false);
  });

  it('returns degraded status when brain.db is unavailable', async () => {
    mockGetBrainDb.mockRejectedValueOnce(new Error('DB not found'));

    const status = await getDreamStatus(PROJECT_ROOT);

    expect(status.lastError).toContain('brain.db unavailable');
    expect(status.isOverdue).toBe(false);
  });
});
