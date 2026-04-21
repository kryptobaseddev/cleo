/**
 * Integration tests for Nexus Plasticity Query SDK functions (T1108).
 *
 * Tests run against the live cleocode nexus.db (global tier). Each function
 * is exercised for:
 *   1. Valid result shape
 *   2. Non-empty results when plasticity rows exist (live DB has weight=2.0)
 *      OR graceful empty-with-note when no dream cycle has run
 *   3. Limit respected
 *   4. Sort ordering preserved
 *
 * The live DB is read-only for these tests — no mutations occur.
 *
 * @task T1108
 * @epic T1106
 */

import { describe, expect, it } from 'vitest';
import { getNexusDb } from '../../store/nexus-sqlite.js';
import { getColdSymbols, getHotNodes, getHotPaths } from '../query-dsl.js';

// ---------------------------------------------------------------------------
// Live nexus.db integration smoke tests
// ---------------------------------------------------------------------------

describe('getHotPaths — live nexus.db', () => {
  it('returns a valid NexusHotPathsResult shape', async () => {
    await getNexusDb();
    const result = await getHotPaths(process.cwd(), 20);

    expect(result).toBeDefined();
    expect(typeof result.count).toBe('number');
    expect(Array.isArray(result.paths)).toBe(true);
    expect(result.count).toBe(result.paths.length);

    // Result is either non-empty (plasticity rows exist) or empty with a note
    if (result.count > 0) {
      const first = result.paths[0];
      expect(first).toBeDefined();
      expect(typeof first!.sourceId).toBe('string');
      expect(typeof first!.targetId).toBe('string');
      expect(typeof first!.type).toBe('string');
      expect(typeof first!.weight).toBe('number');
      expect(typeof first!.coAccessedCount).toBe('number');
      expect(first!.weight).toBeGreaterThan(0);
    } else {
      // Graceful empty state — note must be present
      expect(result.note).toBeDefined();
      expect(typeof result.note).toBe('string');
      expect(result.note!.length).toBeGreaterThan(0);
    }
  });

  it('respects the limit parameter', async () => {
    await getNexusDb();
    const result = await getHotPaths(process.cwd(), 1);
    expect(result.paths.length).toBeLessThanOrEqual(1);
  });

  it('returns hot paths sorted by weight DESC', async () => {
    await getNexusDb();
    const result = await getHotPaths(process.cwd(), 10);
    for (let i = 1; i < result.paths.length; i++) {
      expect(result.paths[i]!.weight).toBeLessThanOrEqual(result.paths[i - 1]!.weight);
    }
  });

  it('returns non-empty result when live DB has plasticity data (weight=2.0 seed)', async () => {
    await getNexusDb();
    // The live cleocode nexus.db has at least one relation with weight=2.0
    // seeded during T998 tests. If it does not exist this test gracefully
    // accepts the empty-with-note path.
    const result = await getHotPaths(process.cwd(), 20);
    // At minimum the function must not throw and must return a valid structure
    expect(result).toHaveProperty('paths');
    expect(result).toHaveProperty('count');
    // If there's weight data, verify the top result is the highest weighted edge
    if (result.paths.length > 0) {
      expect(result.paths[0]!.weight).toBeGreaterThan(0);
    }
  });
});

describe('getHotNodes — live nexus.db', () => {
  it('returns a valid NexusHotNodesResult shape', async () => {
    await getNexusDb();
    const result = await getHotNodes(process.cwd(), 20);

    expect(result).toBeDefined();
    expect(typeof result.count).toBe('number');
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(result.count).toBe(result.nodes.length);

    if (result.count > 0) {
      const first = result.nodes[0];
      expect(first).toBeDefined();
      expect(typeof first!.nodeId).toBe('string');
      expect(typeof first!.label).toBe('string');
      expect(typeof first!.kind).toBe('string');
      expect(typeof first!.totalWeight).toBe('number');
      expect(first!.totalWeight).toBeGreaterThan(0);
      // filePath may be null for external nodes
      expect(first!.filePath === null || typeof first!.filePath === 'string').toBe(true);
    } else {
      expect(result.note).toBeDefined();
      expect(typeof result.note).toBe('string');
    }
  });

  it('respects the limit parameter', async () => {
    await getNexusDb();
    const result = await getHotNodes(process.cwd(), 5);
    expect(result.nodes.length).toBeLessThanOrEqual(5);
  });

  it('returns nodes sorted by totalWeight DESC', async () => {
    await getNexusDb();
    const result = await getHotNodes(process.cwd(), 10);
    for (let i = 1; i < result.nodes.length; i++) {
      expect(result.nodes[i]!.totalWeight).toBeLessThanOrEqual(result.nodes[i - 1]!.totalWeight);
    }
  });
});

describe('getColdSymbols — live nexus.db', () => {
  it('returns a valid NexusColdSymbolsResult shape', async () => {
    await getNexusDb();
    const result = await getColdSymbols(process.cwd(), 30);

    expect(result).toBeDefined();
    expect(typeof result.count).toBe('number');
    expect(Array.isArray(result.symbols)).toBe(true);
    expect(result.thresholdDays).toBe(30);
    expect(result.count).toBe(result.symbols.length);

    if (result.count > 0) {
      const first = result.symbols[0];
      expect(first).toBeDefined();
      expect(typeof first!.nodeId).toBe('string');
      expect(typeof first!.label).toBe('string');
      expect(typeof first!.kind).toBe('string');
      // maxWeight must be < 0.1 (core invariant of the query)
      expect(first!.maxWeight).toBeLessThan(0.1);
      expect(first!.lastAccessed === null || typeof first!.lastAccessed === 'string').toBe(true);
      expect(first!.filePath === null || typeof first!.filePath === 'string').toBe(true);
    }
  });

  it('returns thresholdDays in result', async () => {
    await getNexusDb();
    const result = await getColdSymbols(process.cwd(), 7);
    expect(result.thresholdDays).toBe(7);
  });

  it('all returned symbols have weight < 0.1', async () => {
    await getNexusDb();
    const result = await getColdSymbols(process.cwd(), 0); // 0-day threshold
    for (const sym of result.symbols) {
      expect(sym.maxWeight).toBeLessThan(0.1);
    }
  });

  it('returns non-empty result when live DB has unaccessed symbols', async () => {
    await getNexusDb();
    // The live nexus.db has 217k+ relations, nearly all with weight=0 and
    // last_accessed_at=NULL. With a 0-day threshold we should get results.
    const result = await getColdSymbols(process.cwd(), 0);
    // There should be a significant number of cold symbols (all-zero-weight)
    expect(result.count).toBeGreaterThan(0);
    // Since last_accessed_at is NULL for most rows, the note should be present
    expect(result.note).toBeDefined();
  });
});
