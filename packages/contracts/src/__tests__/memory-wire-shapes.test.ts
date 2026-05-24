/**
 * Structural-equivalence tests for the BRAIN memory wire-shape contracts.
 *
 * These tests pin the field shapes of the 15 types promoted from
 * `packages/core/src/memory/brain-retrieval.ts` in Phase 0e of
 * SG-ARCH-SOLID (E-CONTRACTS-FOUNDATION). Accidental narrowing or
 * widening triggers a compile-time failure during `tsc -b` in the CI gate.
 *
 * The compile-time assertions use the conditional-equality trick
 * (`Equals<A, B>`) so any structural drift produces a TS2322 or TS2344
 * at build time. The runtime `expect` smoke verifies that constructible
 * literals satisfy each interface — these are pure type contracts with
 * no runtime, so this is a thin satisfies check rather than a behavior
 * test.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */

import { describe, expect, it } from 'vitest';
import type { BrainSourceConfidence } from '../brain.js';
import type { BrainObservationType } from '../facade.js';
import type {
  BudgetedEntry,
  BudgetedResult,
  BudgetedRetrievalOptions,
} from '../memory/budgeted.js';
import type {
  FetchBrainEntriesParams,
  FetchBrainEntriesResult,
  FetchedBrainEntry,
} from '../memory/fetch.js';
import {
  BRAIN_OBSERVATION_SOURCE_TYPES,
  type BrainObservationSourceType,
  type ObserveBrainParams,
  type ObserveBrainResult,
} from '../memory/observe.js';
import type {
  BrainCompactHit,
  SearchBrainCompactParams,
  SearchBrainCompactResult,
} from '../memory/search.js';
import type {
  BrainAnchor,
  TimelineBrainParams,
  TimelineBrainResult,
  TimelineNeighbor,
} from '../memory/timeline.js';

// ─── Compile-time structural-equality helpers ───────────────────────

/** Resolve to `1` IFF `A` and `B` are mutually assignable; `2` otherwise. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? 1 : 2;

/** Compile-time assert that `T` resolves to `1`. */
type AssertEquals1<T extends 1> = T;

// ─── Search: BrainCompactHit shape pin ──────────────────────────────

type _BrainCompactHitShape = {
  id: string;
  type: 'decision' | 'pattern' | 'learning' | 'observation';
  title: string;
  date: string;
  relevance?: number;
  rrfScore?: number;
  bm25Score?: number;
  _next?: Record<string, string>;
};

type _AssertBrainCompactHitPinned = AssertEquals1<Equals<BrainCompactHit, _BrainCompactHitShape>>;

// ─── Search: SearchBrainCompactParams shape pin ─────────────────────

type _SearchBrainCompactParamsShape = {
  query: string;
  limit?: number;
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  dateStart?: string;
  dateEnd?: string;
  agent?: string;
  useRRF?: boolean;
  peerId?: string;
  includeGlobal?: boolean;
  mode?: 'recency' | 'lexical' | 'hybrid';
  since?: string;
};

type _AssertSearchParamsPinned = AssertEquals1<
  Equals<SearchBrainCompactParams, _SearchBrainCompactParamsShape>
>;

// ─── Search: SearchBrainCompactResult shape pin ─────────────────────

type _SearchBrainCompactResultShape = {
  results: BrainCompactHit[];
  total: number;
  tokensEstimated: number;
};

type _AssertSearchResultPinned = AssertEquals1<
  Equals<SearchBrainCompactResult, _SearchBrainCompactResultShape>
>;

// ─── Timeline: BrainAnchor shape pin ────────────────────────────────

type _BrainAnchorShape = {
  id: string;
  type: string;
  data: unknown;
};

type _AssertBrainAnchorPinned = AssertEquals1<Equals<BrainAnchor, _BrainAnchorShape>>;

// ─── Timeline: TimelineBrainParams shape pin ────────────────────────

type _TimelineBrainParamsShape = {
  anchor: string;
  depthBefore?: number;
  depthAfter?: number;
};

type _AssertTimelineParamsPinned = AssertEquals1<
  Equals<TimelineBrainParams, _TimelineBrainParamsShape>
>;

// ─── Timeline: TimelineNeighbor shape pin ───────────────────────────

type _TimelineNeighborShape = {
  id: string;
  type: string;
  date: string;
};

type _AssertTimelineNeighborPinned = AssertEquals1<
  Equals<TimelineNeighbor, _TimelineNeighborShape>
>;

// ─── Timeline: TimelineBrainResult shape pin ────────────────────────

type _TimelineBrainResultShape = {
  anchor: BrainAnchor | null;
  before: TimelineNeighbor[];
  after: TimelineNeighbor[];
};

type _AssertTimelineResultPinned = AssertEquals1<
  Equals<TimelineBrainResult, _TimelineBrainResultShape>
>;

// ─── Fetch: FetchBrainEntriesParams shape pin ───────────────────────

type _FetchBrainEntriesParamsShape = {
  ids: string[];
};

type _AssertFetchParamsPinned = AssertEquals1<
  Equals<FetchBrainEntriesParams, _FetchBrainEntriesParamsShape>
>;

// ─── Fetch: FetchedBrainEntry shape pin ─────────────────────────────

type _FetchedBrainEntryShape = {
  id: string;
  type: string;
  data: unknown;
};

type _AssertFetchedEntryPinned = AssertEquals1<Equals<FetchedBrainEntry, _FetchedBrainEntryShape>>;

// ─── Fetch: FetchBrainEntriesResult shape pin ───────────────────────

type _FetchBrainEntriesResultShape = {
  results: FetchedBrainEntry[];
  notFound: string[];
  tokensEstimated: number;
};

type _AssertFetchResultPinned = AssertEquals1<
  Equals<FetchBrainEntriesResult, _FetchBrainEntriesResultShape>
>;

// ─── Observe: BrainObservationSourceType shape pin ──────────────────

type _BrainObservationSourceTypeShape = 'agent' | 'session-debrief' | 'claude-mem' | 'manual';

type _AssertObservationSourceTypePinned = AssertEquals1<
  Equals<BrainObservationSourceType, _BrainObservationSourceTypeShape>
>;

// ─── Observe: ObserveBrainParams shape pin ──────────────────────────

type _ObserveBrainParamsShape = {
  text: string;
  title?: string;
  type?: BrainObservationType;
  project?: string;
  sourceSessionId?: string;
  sourceType?: BrainObservationSourceType;
  agent?: string;
  sourceConfidence?: BrainSourceConfidence;
  crossRef?: string[];
  attachmentRefs?: string[];
  origin?: string | null;
  provenanceChain?: string[] | null;
  _skipGate?: boolean;
  _skipQueue?: boolean;
};

type _AssertObserveParamsPinned = AssertEquals1<
  Equals<ObserveBrainParams, _ObserveBrainParamsShape>
>;

// ─── Observe: ObserveBrainResult shape pin ──────────────────────────

type _ObserveBrainResultShape = {
  id: string;
  type: string;
  createdAt: string;
};

type _AssertObserveResultPinned = AssertEquals1<
  Equals<ObserveBrainResult, _ObserveBrainResultShape>
>;

// ─── Budgeted: BudgetedRetrievalOptions shape pin ───────────────────

type _BudgetedRetrievalOptionsShape = {
  types?: Array<'semantic' | 'episodic' | 'procedural'>;
  tiers?: Array<'short' | 'medium' | 'long'>;
  verified?: boolean;
};

type _AssertBudgetedOptionsPinned = AssertEquals1<
  Equals<BudgetedRetrievalOptions, _BudgetedRetrievalOptionsShape>
>;

// ─── Budgeted: BudgetedEntry shape pin ──────────────────────────────

type _BudgetedEntryShape = {
  id: string;
  type: string;
  title: string;
  text: string;
  score: number;
  tokensEstimated: number;
  memoryTier?: string;
  memoryType?: string;
};

type _AssertBudgetedEntryPinned = AssertEquals1<Equals<BudgetedEntry, _BudgetedEntryShape>>;

// ─── Budgeted: BudgetedResult shape pin ─────────────────────────────

type _BudgetedResultShape = {
  entries: BudgetedEntry[];
  tokensUsed: number;
  tokensRemaining: number;
  excluded: number;
};

type _AssertBudgetedResultPinned = AssertEquals1<Equals<BudgetedResult, _BudgetedResultShape>>;

// ─── Runtime constructibility smoke ─────────────────────────────────

describe('memory wire-shape contracts (T9956)', () => {
  it('BrainCompactHit is constructible with the canonical shape', () => {
    const hit: BrainCompactHit = {
      id: 'O-abc123',
      type: 'observation',
      title: 'sample',
      date: '2026-05-21T00:00:00Z',
    };
    expect(hit.id).toBe('O-abc123');
    expect(hit.type).toBe('observation');
  });

  it('SearchBrainCompactResult composes BrainCompactHit and token accounting', () => {
    const result: SearchBrainCompactResult = {
      results: [{ id: 'O-1', type: 'observation', title: 't', date: '2026-05-21' }],
      total: 1,
      tokensEstimated: 50,
    };
    expect(result.results).toHaveLength(1);
    expect(result.tokensEstimated).toBe(50);
  });

  it('BrainAnchor and TimelineBrainResult compose correctly', () => {
    const anchor: BrainAnchor = { id: 'O-anchor', type: 'observation', data: { x: 1 } };
    const result: TimelineBrainResult = {
      anchor,
      before: [{ id: 'O-prev', type: 'observation', date: '2026-05-20' }],
      after: [{ id: 'O-next', type: 'observation', date: '2026-05-22' }],
    };
    expect(result.anchor?.id).toBe('O-anchor');
    expect(result.before).toHaveLength(1);
    expect(result.after).toHaveLength(1);
  });

  it('TimelineBrainResult accepts null anchor for unresolved IDs', () => {
    const result: TimelineBrainResult = { anchor: null, before: [], after: [] };
    expect(result.anchor).toBeNull();
  });

  it('FetchBrainEntriesResult tracks notFound IDs alongside resolved entries', () => {
    const result: FetchBrainEntriesResult = {
      results: [{ id: 'O-1', type: 'observation', data: null }],
      notFound: ['O-missing'],
      tokensEstimated: 100,
    };
    expect(result.results).toHaveLength(1);
    expect(result.notFound).toContain('O-missing');
  });

  it('BRAIN_OBSERVATION_SOURCE_TYPES is the runtime tuple backing BrainObservationSourceType', () => {
    expect(BRAIN_OBSERVATION_SOURCE_TYPES).toEqual([
      'agent',
      'session-debrief',
      'claude-mem',
      'manual',
    ]);
    // The derived type must include every const member.
    const sample: BrainObservationSourceType[] = [...BRAIN_OBSERVATION_SOURCE_TYPES];
    expect(sample).toHaveLength(4);
  });

  it('ObserveBrainParams accepts the minimal required shape (text only)', () => {
    const params: ObserveBrainParams = { text: 'hello world' };
    expect(params.text).toBe('hello world');
  });

  it('ObserveBrainResult mirrors the persisted row identity tuple', () => {
    const result: ObserveBrainResult = {
      id: 'O-new',
      type: 'observation',
      createdAt: '2026-05-21T12:00:00Z',
    };
    expect(result.id).toBe('O-new');
    expect(result.type).toBe('observation');
  });

  it('BudgetedRetrievalOptions composes all three optional filter axes', () => {
    const opts: BudgetedRetrievalOptions = {
      types: ['semantic', 'procedural'],
      tiers: ['medium', 'long'],
      verified: true,
    };
    expect(opts.types).toHaveLength(2);
    expect(opts.tiers).toHaveLength(2);
    expect(opts.verified).toBe(true);
  });

  it('BudgetedResult tracks token usage, remaining budget, and exclusion count', () => {
    const result: BudgetedResult = {
      entries: [
        {
          id: 'L-1',
          type: 'learning',
          title: 'insight',
          text: 'body',
          score: 0.42,
          tokensEstimated: 32,
        },
      ],
      tokensUsed: 32,
      tokensRemaining: 468,
      excluded: 0,
    };
    expect(result.entries).toHaveLength(1);
    expect(result.tokensUsed + result.tokensRemaining).toBe(500);
  });
});
