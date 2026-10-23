/**
 * One recall list across BRAIN tables, ranked by BM25 order, recency and
 * source (T13948). Replaces the round-robin interleave that returned every
 * `memory find` as D,P,L,O,D,P,L,O regardless of age or provenance.
 *
 * @task T13948
 */

import { describe, expect, it } from 'vitest';
import type { BrainMemorySearchResult } from '../brain-search.js';
import {
  RECENCY_HALF_LIFE_DAYS,
  rankFtsAcrossTables,
  recencyWeight,
  sourceWeight,
} from '../recall-ranking.js';

const NOW = Date.parse('2026-10-23T12:00:00Z');

type Row = Record<string, string | null>;

/** A per-table FTS result built from raw snake_case rows, as `SELECT *` returns them. */
function fts(rows: {
  decisions?: Row[];
  patterns?: Row[];
  learnings?: Row[];
  observations?: Row[];
}): BrainMemorySearchResult {
  return {
    decisions: (rows.decisions ?? []).map((r) => ({ decision: r.id, rationale: '', ...r })),
    patterns: (rows.patterns ?? []).map((r) => ({ pattern: r.id, context: '', ...r })),
    learnings: (rows.learnings ?? []).map((r) => ({ insight: r.id, source: '', ...r })),
    observations: (rows.observations ?? []).map((r) => ({ title: r.id, narrative: '', ...r })),
  } as BrainMemorySearchResult;
}

describe('recencyWeight (T13948)', () => {
  it('is 1 now, halves its bonus per half-life, and never drops below 0.5', () => {
    expect(recencyWeight('2026-10-23 12:00:00', NOW)).toBeCloseTo(1);
    const halfLifeAgo = new Date(NOW - RECENCY_HALF_LIFE_DAYS * 86_400_000).toISOString();
    expect(recencyWeight(halfLifeAgo, NOW)).toBeCloseTo(0.75);
    expect(recencyWeight('2020-01-01 00:00:00', NOW)).toBeGreaterThanOrEqual(0.5);
    expect(recencyWeight(null, NOW)).toBe(0.5);
    expect(recencyWeight('not a date', NOW)).toBe(0.5);
  });
});

describe('sourceWeight (T13948)', () => {
  it('ranks owner > task outcome > agent > speculative, and owner decisions as owner', () => {
    const owner = sourceWeight({ source_confidence: 'owner' });
    const outcome = sourceWeight({ source_confidence: 'task-outcome' });
    const agent = sourceWeight({ source_confidence: 'agent' });
    const speculative = sourceWeight({ source_confidence: 'speculative' });
    expect(owner).toBeGreaterThan(outcome);
    expect(outcome).toBeGreaterThan(agent);
    expect(agent).toBeGreaterThan(speculative);
    expect(sourceWeight({ decided_by: 'owner', source_confidence: 'agent' })).toBe(owner);
    expect(sourceWeight({})).toBe(agent);
  });
});

describe('rankFtsAcrossTables (T13948)', () => {
  it('returns one list ordered by recency and source, not a D,P,L,O quota', () => {
    const ranked = rankFtsAcrossTables(
      fts({
        decisions: [{ id: 'D-may', created_at: '2026-05-01 00:00:00' }],
        patterns: [
          { id: 'P-old', extracted_at: '2026-04-01 00:00:00', source_confidence: 'speculative' },
        ],
        learnings: [{ id: 'L-may', created_at: '2026-05-10 00:00:00' }],
        observations: [
          { id: 'O-lesson', created_at: '2026-10-19 00:00:00', source_confidence: 'owner' },
        ],
      }),
      NOW,
    );
    expect(ranked.map((hit) => hit.id)).toEqual(['O-lesson', 'L-may', 'D-may', 'P-old']);
    expect(ranked[0]?.date).toBe('2026-10-19 00:00:00');
  });

  it('keeps each table in its BM25 order', () => {
    const date = '2026-10-20 00:00:00';
    const ranked = rankFtsAcrossTables(
      fts({
        decisions: [
          { id: 'D1', created_at: date },
          { id: 'D2', created_at: date },
          { id: 'D3', created_at: date },
        ],
        observations: [
          { id: 'O1', created_at: date },
          { id: 'O2', created_at: date },
        ],
      }),
      NOW,
    );
    const ids = ranked.map((hit) => hit.id);
    expect(ids.filter((id) => id.startsWith('D'))).toEqual(['D1', 'D2', 'D3']);
    expect(ids.filter((id) => id.startsWith('O'))).toEqual(['O1', 'O2']);
  });

  it('lets a recent observation place first however many older rows other tables hold', () => {
    // T12073's regression, kept: the largest store must stay reachable.
    const old = (prefix: string): Row[] =>
      Array.from({ length: 10 }, (_, i) => ({
        id: `${prefix}${i}`,
        created_at: '2026-05-01 00:00:00',
        extracted_at: '2026-05-01 00:00:00',
      }));
    const ranked = rankFtsAcrossTables(
      fts({
        decisions: old('D'),
        patterns: old('P'),
        learnings: old('L'),
        observations: [{ id: 'O-relevant', created_at: '2026-10-22 00:00:00' }],
      }),
      NOW,
    );
    expect(ranked[0]?.id).toBe('O-relevant');
    expect(ranked).toHaveLength(31);
  });
});
