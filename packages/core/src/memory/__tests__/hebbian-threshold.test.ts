/**
 * Tests for the T790 fix: Hebbian co_retrieved edge threshold gate.
 *
 * `strengthenCoRetrievedEdges` (brain-lifecycle.ts) must require a pair of
 * brain nodes to co-appear in >= 3 DISTINCT query strings before emitting a
 * co_retrieved edge. Repeating the same search N times must NOT inflate the
 * count — only distinct query texts count.
 *
 * @task T790
 * @epic T770
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Hoisted mock factories (must be hoisted so vi.mock can reference them)
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
// Import module under test (after all mocks are registered)
// ============================================================================

import { strengthenCoRetrievedEdgesForTest } from '../brain-lifecycle.js';

// ============================================================================
// Helpers
// ============================================================================

const PROJECT_ROOT = '/fake/project';

/** One retrieval log row. */
interface LogRow {
  query: string;
  entry_ids: string;
}

/**
 * Build a minimal SQLite-like nativeDb stub that:
 * - Accepts `SELECT 1 FROM brain_retrieval_log LIMIT 1` (table-exists check)
 * - Returns `logRows` from `SELECT query, entry_ids FROM brain_retrieval_log`
 * - Records INSERT/UPDATE calls in `edgeCalls`
 */
function buildMockDb(logRows: LogRow[]): {
  db: { prepare: ReturnType<typeof vi.fn> };
  edgeInserts: string[];
  edgeUpdates: string[];
} {
  const edgeInserts: string[] = [];
  const edgeUpdates: string[] = [];

  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => {
      // Table-exists probe
      if (sql.includes('SELECT 1 FROM brain_retrieval_log LIMIT 1')) {
        return { get: vi.fn().mockReturnValue({ 1: 1 }) };
      }
      // Log fetch
      if (
        sql.includes('SELECT') &&
        sql.includes('entry_ids') &&
        sql.includes('FROM brain_retrieval_log')
      ) {
        return { all: vi.fn().mockReturnValue(logRows) };
      }
      // Edge UPDATE
      if (sql.includes('UPDATE brain_page_edges')) {
        return {
          run: vi.fn().mockImplementation((...args: unknown[]) => {
            edgeUpdates.push(String(args[0]) + '|' + String(args[1]));
            // Simulate no existing edge → changes=0 so INSERT path is taken
            return { changes: 0 };
          }),
        };
      }
      // Edge INSERT OR IGNORE
      if (sql.includes('INSERT OR IGNORE INTO brain_page_edges')) {
        return {
          run: vi.fn().mockImplementation((...args: unknown[]) => {
            edgeInserts.push(String(args[0]) + '|' + String(args[1]));
            return { changes: 1 };
          }),
        };
      }
      // Fallback — return a no-op stub
      return {
        run: vi.fn().mockReturnValue({ changes: 0 }),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([]),
      };
    }),
  };

  return { db, edgeInserts, edgeUpdates };
}

// ============================================================================
// Tests
// ============================================================================

describe('strengthenCoRetrievedEdges — T790 distinct-query threshold', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Case 1: single batch (1 log row) with pair [A,B] — no edge emitted', async () => {
    // Only 1 log row, so the pair (A, B) appears in exactly 1 distinct query.
    // The threshold is >= 3 distinct queries → no edge should be created.
    const logRows: LogRow[] = [
      {
        query: 'brain audit',
        entry_ids: JSON.stringify(['A-abc123', 'B-def456', 'C-789000']),
      },
    ];

    const { db, edgeInserts } = buildMockDb(logRows);
    mockGetBrainNativeDb.mockReturnValue(db);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    expect(count).toBe(0);
    expect(edgeInserts).toHaveLength(0);
  });

  it('Case 2: same query repeated 3 times — distinct count is 1, no edge emitted', async () => {
    // Repeating "brain audit" three times should NOT create an edge, because the
    // distinct query count is 1 (same query text appears 3 times in the log).
    const logRows: LogRow[] = [
      { query: 'brain audit', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'brain audit', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'brain audit', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
    ];

    const { db, edgeInserts } = buildMockDb(logRows);
    mockGetBrainNativeDb.mockReturnValue(db);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    expect(count).toBe(0);
    expect(edgeInserts).toHaveLength(0);
  });

  it('Case 3: 3 distinct queries each co-returning [A,B] — edge is emitted', async () => {
    // Three different queries (distinct text) all return A and B together.
    // Distinct query count for pair (A, B) = 3 → meets threshold → emit edge.
    const logRows: LogRow[] = [
      { query: 'brain audit', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'memory cleanup', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'hebbian edges', entry_ids: JSON.stringify(['A-abc123', 'B-def456', 'C-789000']) },
    ];

    const { db, edgeInserts } = buildMockDb(logRows);
    mockGetBrainNativeDb.mockReturnValue(db);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    // Pair (A, B): 3 distinct queries → edge emitted
    // Pair (A, C): only 1 query → no edge
    // Pair (B, C): only 1 query → no edge
    expect(count).toBeGreaterThanOrEqual(1);
    // The edge for A-B must have been inserted
    const abEdge = edgeInserts.find(
      (e) =>
        (e.includes('A-abc123') && e.includes('B-def456')) ||
        (e.includes('B-def456') && e.includes('A-abc123')),
    );
    expect(abEdge).toBeDefined();
    // C-only edges must NOT have been inserted
    const cEdge = edgeInserts.find((e) => e.includes('C-789000'));
    expect(cEdge).toBeUndefined();
  });

  it('Case 4: 3 queries with 2 different cases each returning [A,B] — edge is emitted', async () => {
    // Query strings are case-sensitive. Three distinct queries (all different text)
    // each return A and B together → meets threshold → emit edge.
    const logRows: LogRow[] = [
      { query: 'brain audit', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'memory cleanup', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
      { query: 'semantic edges', entry_ids: JSON.stringify(['A-abc123', 'B-def456']) },
    ];

    const { db, edgeInserts } = buildMockDb(logRows);
    mockGetBrainNativeDb.mockReturnValue(db);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    expect(count).toBeGreaterThanOrEqual(1);
    const abEdge = edgeInserts.find(
      (e) =>
        (e.includes('A-abc123') && e.includes('B-def456')) ||
        (e.includes('B-def456') && e.includes('A-abc123')),
    );
    expect(abEdge).toBeDefined();
  });

  it('Case 5: nativeDb unavailable — returns 0 without throwing', async () => {
    mockGetBrainNativeDb.mockReturnValue(null);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    expect(count).toBe(0);
  });

  it('Case 6: retrieval log table does not exist — returns 0', async () => {
    const db = {
      prepare: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT 1 FROM brain_retrieval_log')) {
          return {
            get: vi.fn().mockImplementation(() => {
              throw new Error('no such table: brain_retrieval_log');
            }),
          };
        }
        return { run: vi.fn(), get: vi.fn(), all: vi.fn().mockReturnValue([]) };
      }),
    };
    mockGetBrainNativeDb.mockReturnValue(db);

    const count = await strengthenCoRetrievedEdgesForTest(PROJECT_ROOT);

    expect(count).toBe(0);
  });
});
