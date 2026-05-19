/**
 * Unit tests for memory public API (T9615 — CORE-first promotion).
 *
 * Tests cover the happy path for each exported function.
 * DB-backed functions are tested against mock/null DB state (empty result paths).
 * Functions that delegate to existing BRAIN accessor functions are tested via
 * integration with a real temp DB where practical.
 *
 * @task T9615
 * @epic T9592
 */

import { describe, expect, it, vi } from 'vitest';
import {
  findMemoryEntries,
  getDecisions,
  getLearnings,
  getMemoryGraph,
  getObservations,
  getPatterns,
  getPendingVerify,
  getTierStats,
} from '../public-api.js';

// ---------------------------------------------------------------------------
// Mock getBrainNativeDb — returns null (no DB) for lightweight tests
// Also mock getProjectRoot to avoid E_INVALID_PROJECT_ROOT in test environment
// ---------------------------------------------------------------------------

vi.mock('../../store/memory-sqlite.js', () => ({
  getBrainNativeDb: vi.fn(() => null),
  getBrainDb: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../paths.js', () => ({
  getProjectRoot: vi.fn(() => '/tmp/mock-project'),
}));

// ---------------------------------------------------------------------------
// findMemoryEntries
// ---------------------------------------------------------------------------

describe('findMemoryEntries', () => {
  it('returns empty result when query is empty', async () => {
    const result = await findMemoryEntries({ query: '' });
    expect(result.query).toBe('');
    expect(result.hits).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('returns empty result when db is unavailable', async () => {
    const result = await findMemoryEntries({ query: 'authentication' });
    expect(result.hits).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('accepts optional table and limit parameters', async () => {
    const result = await findMemoryEntries({
      query: 'test',
      tables: ['observations', 'decisions'],
      limit: 10,
    });
    expect(result.query).toBe('test');
    expect(result.total).toBe(0); // no DB
  });
});

// ---------------------------------------------------------------------------
// getObservations
// ---------------------------------------------------------------------------

describe('getObservations', () => {
  it('returns empty result when db is unavailable', async () => {
    const result = await getObservations();
    expect(result.observations).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.filtered).toBe(0);
  });

  it('accepts tier and type filters', async () => {
    const result = await getObservations({ tier: 'long', type: 'episodic', minQuality: 0.7 });
    expect(result.observations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getDecisions / getPatterns / getLearnings
// ---------------------------------------------------------------------------

// getBrainAccessor is mocked for all accessor-backed functions
vi.mock('../../store/memory-accessor.js', () => ({
  getBrainAccessor: vi.fn(() =>
    Promise.resolve({
      findDecisions: vi.fn(() => Promise.resolve([])),
      findPatterns: vi.fn(() => Promise.resolve([])),
      findLearnings: vi.fn(() => Promise.resolve([])),
    }),
  ),
}));

describe('getDecisions', () => {
  it('returns empty array when no decisions exist', async () => {
    const result = await getDecisions();
    expect(result.decisions).toHaveLength(0);
  });

  it('accepts query parameter', async () => {
    const result = await getDecisions({ query: 'database', limit: 10 });
    expect(result.decisions).toHaveLength(0);
  });
});

describe('getPatterns', () => {
  it('returns empty array when no patterns exist', async () => {
    const result = await getPatterns();
    expect(result.patterns).toHaveLength(0);
  });

  it('accepts query and patternType filters', async () => {
    const result = await getPatterns({ query: 'caching', patternType: 'success' });
    expect(result.patterns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getLearnings
// ---------------------------------------------------------------------------

describe('getLearnings', () => {
  it('returns empty array when no learnings exist', async () => {
    const result = await getLearnings();
    expect(result.learnings).toHaveLength(0);
  });

  it('accepts query parameter', async () => {
    const result = await getLearnings({ query: 'performance' });
    expect(result.learnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getMemoryGraph
// ---------------------------------------------------------------------------

// graphStats needs a real DB; mock it for unit test
vi.mock('../graph-queries.js', () => ({
  graphStats: vi.fn(() =>
    Promise.resolve({
      totalNodes: 42,
      totalEdges: 120,
      nodesByType: [{ nodeType: 'observation', count: 42 }],
      edgesByType: [
        { edgeType: 'informs', count: 80 },
        { edgeType: 'supersedes', count: 40 },
      ],
    }),
  ),
}));

describe('getMemoryGraph', () => {
  it('returns graph statistics', async () => {
    const result = await getMemoryGraph();
    expect(result.nodeCount).toBe(42);
    expect(result.edgeCount).toBe(120);
    expect(result.edgeTypeDistribution).toMatchObject({ informs: 80, supersedes: 40 });
    expect(result.averageEdgesPerNode).toBeCloseTo(120 / 42, 3);
  });

  it('returns zero averageEdgesPerNode when nodeCount is 0', async () => {
    const { graphStats } = await import('../graph-queries.js');
    vi.mocked(graphStats).mockResolvedValueOnce({
      totalNodes: 0,
      totalEdges: 0,
      nodesByType: [],
      edgesByType: [],
    });
    const result = await getMemoryGraph();
    expect(result.averageEdgesPerNode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getTierStats
// ---------------------------------------------------------------------------

describe('getTierStats', () => {
  it('returns empty result when db is unavailable', async () => {
    const result = await getTierStats();
    expect(result.tables).toHaveLength(0);
    expect(result.upcomingLongPromotions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// getPendingVerify
// ---------------------------------------------------------------------------

describe('getPendingVerify', () => {
  it('returns empty result when db is unavailable', async () => {
    const result = await getPendingVerify();
    expect(result.count).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(result.hint).toContain('brain.db not available');
  });

  it('applies default minCitations of 5', async () => {
    const result = await getPendingVerify();
    expect(result.minCitations).toBe(5);
  });

  it('accepts custom minCitations and limit', async () => {
    const result = await getPendingVerify(undefined, { minCitations: 3, limit: 20 });
    expect(result.minCitations).toBe(3);
    expect(result.count).toBe(0);
  });
});
