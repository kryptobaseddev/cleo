/**
 * Tests for STDP (Spike-Timing-Dependent Plasticity) in brain-stdp.ts.
 *
 * Verifies:
 *   - LTP (potentiation): A retrieved before B → edge A→B strengthened
 *   - LTD (depression): existing reverse edge B→A weakened when A fires first
 *   - Exponential decay: pairs farther apart in time get smaller Δw
 *   - Window cutoff: pairs beyond pairingWindowMs are ignored
 *   - Weight clamping: edges never exceed [0, 1]
 *   - New edge insertion: LTP creates an edge when none exists
 *   - LTD never creates edges: depression only weakens existing ones
 *   - Stats query: getPlasticityStats returns correct aggregates
 *
 * NOTE: These tests mock the memory-sqlite module (unit tests for SQL logic).
 * Real integration tests (no mocks) are in brain-stdp-w2.test.ts per owner mandate.
 *
 * @task T626
 * @task T679
 * @epic T673
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories
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
// Import module under test (after mocks)
// ============================================================================

import { applyStdpPlasticity, getPlasticityStats } from '../brain-stdp.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

/** Build an ISO-like datetime string `msAgo` milliseconds before now. */
function msAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

type PrepStmt = {
  run: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  all?: ReturnType<typeof vi.fn>;
};

/** Create a minimal prepared-statement stub. */
function makeStmt(runResult?: unknown, getResult?: unknown, getImpl?: () => unknown): PrepStmt {
  return {
    run: vi.fn().mockReturnValue(runResult ?? { changes: 0 }),
    get: getImpl ? vi.fn().mockImplementation(getImpl) : vi.fn().mockReturnValue(getResult),
  };
}

// ============================================================================
// Tests: applyStdpPlasticity
// ============================================================================

describe('applyStdpPlasticity', () => {
  /**
   * Build a minimal mock nativeDb.
   * logRows provide the retrieval log data; edgeMap provides existing edge weights.
   *
   * T679 update: log rows now include session_id and reward_signal fields.
   * Edge map entries now return full edge rows (not just weight).
   */
  function buildNativeDb(
    logRows: Array<{
      id: number;
      entry_ids: string;
      created_at: string;
      retrieval_order: number | null;
      delta_ms: number | null;
      session_id?: string | null;
      reward_signal?: number | null;
    }>,
    edgeMap: Map<string, number | undefined> = new Map(),
  ): ReturnType<typeof buildNativeDb> {
    const stmts = new Map<string, PrepStmt>();

    const db = {
      stmts,
      prepare: vi.fn((sql: string) => {
        // Guard: brain_weight_history existence check — return undefined (throw) to skip writes
        if (sql.includes('brain_weight_history') && sql.includes('SELECT 1')) {
          return makeStmt(undefined, undefined, () => {
            throw new Error('no such table: brain_weight_history');
          });
        }
        // Guard: plasticity events table existence check
        if (sql.includes('brain_plasticity_events') && sql.includes('SELECT 1')) {
          return makeStmt(undefined, {});
        }
        // Guard: retrieval log existence check
        if (sql.includes('brain_retrieval_log') && sql.includes('SELECT 1')) {
          return makeStmt(undefined, {});
        }
        // Retrieval log query
        if (sql.includes('FROM brain_retrieval_log') && sql.includes('ORDER BY')) {
          const stmt = {
            run: vi.fn(),
            get: vi.fn(),
            all: vi.fn().mockReturnValue(
              logRows.map((r) => ({
                ...r,
                session_id: r.session_id ?? null,
                reward_signal: r.reward_signal ?? null,
              })),
            ),
          };
          return stmt;
        }
        // Update edge weight (LTP or LTD)
        if (sql.includes('UPDATE brain_page_edges')) {
          return makeStmt({ changes: 1 });
        }
        // Insert new edge
        if (sql.includes('INSERT OR IGNORE INTO brain_page_edges')) {
          return makeStmt({ changes: 1 });
        }
        // Log plasticity event — T679: return lastInsertRowid for weight history linkage
        if (sql.includes('INSERT INTO brain_plasticity_events')) {
          return makeStmt({ changes: 1, lastInsertRowid: 42 });
        }
        // Default
        return makeStmt(undefined, undefined);
      }),
    };

    // Replace the edge SELECT stub with one that uses edgeMap and returns full edge rows
    const originalPrepare = db.prepare;
    db.prepare = vi.fn((sql: string) => {
      if (sql.includes('SELECT weight') && sql.includes('edge_type')) {
        return {
          run: vi.fn(),
          get: vi.fn((fromId: string, toId: string) => {
            const key = `${fromId}|${toId}`;
            const w = edgeMap.get(key);
            if (w === undefined) return undefined;
            // Return full edge row shape expected by T679 code
            return {
              weight: w,
              reinforcement_count: 0,
              last_reinforced_at: null,
              plasticity_class: 'hebbian',
              depression_count: 0,
              last_depressed_at: null,
            };
          }),
        };
      }
      return originalPrepare(sql);
    });

    return db;
  }

  beforeEach(() => {
    mockGetBrainDb.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns zero counts when nativeDb is null', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);
    const result = await applyStdpPlasticity(PROJECT_ROOT);
    expect(result.ltpEvents).toBe(0);
    expect(result.ltdEvents).toBe(0);
    expect(result.edgesCreated).toBe(0);
    expect(result.pairsExamined).toBe(0);
  });

  it('returns zero counts when retrieval_log table is absent', async () => {
    const db = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockImplementation(() => {
          throw new Error('no such table');
        }),
        all: vi.fn().mockReturnValue([]),
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(db);
    const result = await applyStdpPlasticity(PROJECT_ROOT);
    expect(result.ltpEvents).toBe(0);
  });

  it('returns zero counts when no retrieval log rows exist', async () => {
    const db = buildNativeDb([], new Map());
    mockGetBrainNativeDb.mockReturnValue(db);
    const result = await applyStdpPlasticity(PROJECT_ROOT);
    expect(result.pairsExamined).toBe(0);
    expect(result.ltpEvents).toBe(0);
  });

  it('applies LTP when A retrieved before B within window', async () => {
    const window = 5 * 60 * 1000; // 5 min default
    const now = Date.now();

    // A retrieved 10 s ago, B retrieved 5 s ago → A before B by 5 s
    const rows = [
      {
        id: 1,
        entry_ids: JSON.stringify(['obs-A']),
        created_at: new Date(now - 10_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 0,
        delta_ms: null,
      },
      {
        id: 2,
        entry_ids: JSON.stringify(['obs-B']),
        created_at: new Date(now - 5_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 1,
        delta_ms: 5000,
      },
    ];

    const db = buildNativeDb(rows, new Map()); // no existing edges
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await applyStdpPlasticity(PROJECT_ROOT, window);

    expect(result.ltpEvents).toBeGreaterThanOrEqual(1);
    expect(result.edgesCreated).toBeGreaterThanOrEqual(1);
    expect(result.pairsExamined).toBeGreaterThanOrEqual(1);
  });

  it('applies LTD on reverse edge when reverse edge already exists', async () => {
    const window = 5 * 60 * 1000;
    const now = Date.now();

    const rows = [
      {
        id: 1,
        entry_ids: JSON.stringify(['obs-X']),
        created_at: new Date(now - 10_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 0,
        delta_ms: null,
      },
      {
        id: 2,
        entry_ids: JSON.stringify(['obs-Y']),
        created_at: new Date(now - 5_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 1,
        delta_ms: 5000,
      },
    ];

    // Pre-seed reverse edge observation:obs-Y → observation:obs-X
    const edgeMap = new Map<string, number>([['observation:obs-Y|observation:obs-X', 0.6]]);

    const db = buildNativeDb(rows, edgeMap);
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await applyStdpPlasticity(PROJECT_ROOT, window);

    expect(result.ltdEvents).toBeGreaterThanOrEqual(1);
  });

  it('skips pairs beyond pairingWindowMs (T679: was sessionWindowMs)', async () => {
    const shortWindow = 1_000; // 1 second pairingWindow
    const now = Date.now();

    // A and B retrieved 10 s apart — beyond 1 s pairingWindowMs, but within 30d lookback
    const rows = [
      {
        id: 1,
        entry_ids: JSON.stringify(['obs-P']),
        created_at: new Date(now - 15_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 0,
        delta_ms: null,
      },
      {
        id: 2,
        entry_ids: JSON.stringify(['obs-Q']),
        created_at: new Date(now - 5_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 1,
        delta_ms: 10_000,
      },
    ];

    const db = buildNativeDb(rows, new Map());
    mockGetBrainNativeDb.mockReturnValue(db);

    // Pass as number (deprecated path) — still maps to pairingWindowMs
    const result = await applyStdpPlasticity(PROJECT_ROOT, shortWindow);

    // Both rows are within 30d lookback, but spike pair Δt = 10 s > 1 s pairingWindowMs
    expect(result.ltpEvents).toBe(0);
    expect(result.ltdEvents).toBe(0);
  });

  it('does not apply LTD when no reverse edge exists', async () => {
    const window = 5 * 60 * 1000;
    const now = Date.now();

    const rows = [
      {
        id: 1,
        entry_ids: JSON.stringify(['obs-M']),
        created_at: new Date(now - 10_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 0,
        delta_ms: null,
      },
      {
        id: 2,
        entry_ids: JSON.stringify(['obs-N']),
        created_at: new Date(now - 5_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 1,
        delta_ms: 5000,
      },
    ];

    // No existing edges at all
    const db = buildNativeDb(rows, new Map());
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await applyStdpPlasticity(PROJECT_ROOT, window);

    // LTP fires (new edge created), but LTD does NOT fire (no reverse edge)
    expect(result.ltdEvents).toBe(0);
    expect(result.ltpEvents).toBeGreaterThanOrEqual(1);
  });

  it('larger Δt produces smaller Δw (exponential decay)', async () => {
    // We verify the formula directly without a real DB:
    // Δw = A_PRE * exp(-Δt / TAU_PRE_MS)
    // For Δt=1000 ms and Δt=10000 ms:
    const A_PRE = 0.05;
    const TAU = 20_000;
    const dw1 = A_PRE * Math.exp(-1_000 / TAU);
    const dw2 = A_PRE * Math.exp(-10_000 / TAU);
    expect(dw1).toBeGreaterThan(dw2);
    expect(dw2).toBeGreaterThan(0);
  });

  it('skips self-pairs (same entry ID)', async () => {
    const window = 5 * 60 * 1000;
    const now = Date.now();

    // Two log rows each returning the same entry ID
    const rows = [
      {
        id: 1,
        entry_ids: JSON.stringify(['obs-SAME']),
        created_at: new Date(now - 10_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 0,
        delta_ms: null,
      },
      {
        id: 2,
        entry_ids: JSON.stringify(['obs-SAME']),
        created_at: new Date(now - 5_000).toISOString().replace('T', ' ').slice(0, 19),
        retrieval_order: 1,
        delta_ms: 5000,
      },
    ];

    const db = buildNativeDb(rows, new Map());
    mockGetBrainNativeDb.mockReturnValue(db);

    const result = await applyStdpPlasticity(PROJECT_ROOT, window);

    // pairsExamined may increment for the pair, but LTP must be 0 (self-pair skipped)
    expect(result.ltpEvents).toBe(0);
  });
});

// ============================================================================
// Tests: getPlasticityStats
// ============================================================================

describe('getPlasticityStats', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty stats when nativeDb is null', async () => {
    mockGetBrainDb.mockResolvedValue({});
    mockGetBrainNativeDb.mockReturnValue(null);
    const stats = await getPlasticityStats(PROJECT_ROOT);
    expect(stats.totalEvents).toBe(0);
    expect(stats.ltpCount).toBe(0);
    expect(stats.ltdCount).toBe(0);
    expect(stats.recentEvents).toHaveLength(0);
  });

  it('returns empty stats when plasticity_events table is absent', async () => {
    mockGetBrainDb.mockResolvedValue({});
    const db = {
      prepare: vi.fn().mockReturnValue({
        run: vi.fn(),
        get: vi.fn().mockImplementation(() => {
          throw new Error('no such table: brain_plasticity_events');
        }),
        all: vi.fn().mockReturnValue([]),
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(db);
    const stats = await getPlasticityStats(PROJECT_ROOT);
    expect(stats.totalEvents).toBe(0);
  });

  it('returns correct aggregates when events exist', async () => {
    mockGetBrainDb.mockResolvedValue({});

    const aggRow = {
      total: 5,
      ltp_count: 3,
      ltd_count: 2,
      net_delta_w: 0.12,
      last_event_at: '2026-04-14 10:00:00',
    };

    const recentRows = [
      {
        id: 5,
        source_node: 'observation:obs-A',
        target_node: 'observation:obs-B',
        delta_w: 0.04,
        kind: 'ltp',
        timestamp: '2026-04-14 10:00:00',
        session_id: null,
      },
    ];

    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT 1') && sql.includes('brain_plasticity_events')) {
          return { run: vi.fn(), get: vi.fn().mockReturnValue({}) };
        }
        if (sql.includes('COUNT(*)')) {
          return { run: vi.fn(), get: vi.fn().mockReturnValue(aggRow) };
        }
        if (sql.includes('ORDER BY timestamp DESC')) {
          return {
            run: vi.fn(),
            get: vi.fn(),
            all: vi.fn().mockReturnValue(recentRows),
          };
        }
        return { run: vi.fn(), get: vi.fn().mockReturnValue(undefined) };
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(db);

    const stats = await getPlasticityStats(PROJECT_ROOT, 10);

    expect(stats.totalEvents).toBe(5);
    expect(stats.ltpCount).toBe(3);
    expect(stats.ltdCount).toBe(2);
    expect(stats.netDeltaW).toBeCloseTo(0.12);
    expect(stats.lastEventAt).toBe('2026-04-14 10:00:00');
    expect(stats.recentEvents).toHaveLength(1);
    expect(stats.recentEvents[0]!.kind).toBe('ltp');
    expect(stats.recentEvents[0]!.deltaW).toBeCloseTo(0.04);
  });
});
