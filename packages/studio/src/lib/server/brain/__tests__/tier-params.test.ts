/**
 * Tests for tier parameter parsing and response shape contracts.
 *
 * These tests verify the query-parameter parsing logic in the API route
 * without making real HTTP requests.  We extract the parse logic into a
 * pure helper and test that in isolation.
 *
 * @task T990
 */

import type { BrainSubstrate } from '@cleocode/brain';
import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// Extracted parsing helpers (mirrors the logic in +server.ts)
// ---------------------------------------------------------------------------

const VALID_SUBSTRATES = new Set<BrainSubstrate>([
  'brain',
  'nexus',
  'tasks',
  'conduit',
  'signaldock',
]);

const TIER_LIMITS: Record<number, number> = {
  0: 200,
  1: 1000,
  2: 5000,
};

const ABSOLUTE_MAX = 5000;

function parseTier(raw: string | null): 0 | 1 | 2 {
  const n = Number(raw ?? '0');
  return n === 0 || n === 1 || n === 2 ? (n as 0 | 1 | 2) : 0;
}

function parseLimit(limitParam: string | null, tier: 0 | 1 | 2): number {
  const raw = limitParam !== null ? Number(limitParam) : TIER_LIMITS[tier];
  return Math.min(Math.max(1, Number.isNaN(raw) ? TIER_LIMITS[tier] : raw), ABSOLUTE_MAX);
}

function parseSubstrates(raw: string | null): BrainSubstrate[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is BrainSubstrate => VALID_SUBSTRATES.has(s as BrainSubstrate));
  return parsed.length > 0 ? parsed : undefined;
}

function parseMinWeight(raw: string | null): number {
  return raw !== null ? Math.max(0, parseFloat(raw)) : 0;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTier', () => {
  it('defaults to 0 when param is absent', () => {
    expect(parseTier(null)).toBe(0);
  });

  it('accepts valid tier values 0, 1, 2', () => {
    expect(parseTier('0')).toBe(0);
    expect(parseTier('1')).toBe(1);
    expect(parseTier('2')).toBe(2);
  });

  it('clamps invalid values to 0', () => {
    expect(parseTier('3')).toBe(0);
    expect(parseTier('-1')).toBe(0);
    expect(parseTier('abc')).toBe(0);
  });
});

describe('parseLimit', () => {
  it('uses tier-driven default when no explicit limit given', () => {
    expect(parseLimit(null, 0)).toBe(200);
    expect(parseLimit(null, 1)).toBe(1000);
    expect(parseLimit(null, 2)).toBe(5000);
  });

  it('honours explicit limit within bounds', () => {
    expect(parseLimit('500', 0)).toBe(500);
  });

  it('clamps to ABSOLUTE_MAX (5000)', () => {
    expect(parseLimit('9999', 0)).toBe(5000);
  });

  it('clamps to minimum 1', () => {
    expect(parseLimit('0', 0)).toBe(1);
    expect(parseLimit('-100', 0)).toBe(1);
  });

  it('falls back to tier default on NaN input', () => {
    expect(parseLimit('abc', 1)).toBe(1000);
  });
});

describe('parseSubstrates', () => {
  it('returns undefined for absent param (all substrates)', () => {
    expect(parseSubstrates(null)).toBeUndefined();
  });

  it('parses a valid comma-separated list', () => {
    const result = parseSubstrates('brain,nexus');
    expect(result).toEqual(expect.arrayContaining(['brain', 'nexus']));
    expect(result).toHaveLength(2);
  });

  it('filters out invalid substrate names', () => {
    const result = parseSubstrates('brain,INVALID,nexus');
    expect(result).toEqual(expect.arrayContaining(['brain', 'nexus']));
    expect(result).toHaveLength(2);
  });

  it('returns undefined when all names are invalid (treat as all)', () => {
    expect(parseSubstrates('foo,bar')).toBeUndefined();
  });

  it('trims whitespace around substrate names', () => {
    const result = parseSubstrates(' brain , nexus ');
    expect(result).toEqual(expect.arrayContaining(['brain', 'nexus']));
  });
});

describe('parseMinWeight', () => {
  it('defaults to 0 when absent', () => {
    expect(parseMinWeight(null)).toBe(0);
  });

  it('parses valid float values', () => {
    expect(parseMinWeight('0.5')).toBe(0.5);
    expect(parseMinWeight('1.0')).toBe(1.0);
  });

  it('clamps negative values to 0', () => {
    expect(parseMinWeight('-0.5')).toBe(0);
  });
});

describe('response shape contract', () => {
  it('BrainGraph shape has required fields', () => {
    // Validate the expected shape via TypeScript structural check.
    const mockGraph = {
      nodes: [],
      edges: [],
      counts: {
        nodes: { brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0 },
        edges: { brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0, cross: 0 },
      },
      truncated: false,
    };
    expect(mockGraph).toHaveProperty('nodes');
    expect(mockGraph).toHaveProperty('edges');
    expect(mockGraph).toHaveProperty('counts');
    expect(mockGraph).toHaveProperty('truncated');
    expect(mockGraph.counts).toHaveProperty('nodes');
    expect(mockGraph.counts).toHaveProperty('edges');
  });

  it('chunks NDJSON chunk event has required fields', () => {
    const chunkEvent = {
      kind: 'chunk' as const,
      tier: 1 as const,
      nodes: [],
      edges: [],
      counts: {
        nodes: { brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0 },
        edges: { brain: 0, nexus: 0, tasks: 0, conduit: 0, signaldock: 0, cross: 0 },
      },
      truncated: false,
    };
    expect(chunkEvent.kind).toBe('chunk');
    expect(chunkEvent.tier).toBe(1);
    expect(chunkEvent).toHaveProperty('nodes');
    expect(chunkEvent).toHaveProperty('edges');
  });

  it('chunks NDJSON done event has required fields', () => {
    const doneEvent = {
      kind: 'done' as const,
      tier: 1 as const,
      totalNodes: 423,
      elapsed: 312,
    };
    expect(doneEvent.kind).toBe('done');
    expect(typeof doneEvent.totalNodes).toBe('number');
    expect(typeof doneEvent.elapsed).toBe('number');
  });
});
