/**
 * BRAIN compact-search wire shapes.
 *
 * Canonical home for the parameters and result types of the public
 * `searchBrainCompact` operation — Layer 1 of CLEO's 3-layer BRAIN retrieval
 * pattern (search → timeline → fetch). Returns index-level hits (~50 tokens
 * per result) so agents can scan a wide candidate set cheaply before drilling
 * into a specific entry.
 *
 * Promoted from `packages/core/src/memory/brain-retrieval.ts` to
 * `@cleocode/contracts` in Phase 0e of SG-ARCH-SOLID
 * (E-CONTRACTS-FOUNDATION) so the Studio + CLI + downstream consumers can
 * depend on the shape without importing core. Unblocks the
 * `brain-retrieval.ts` god-module split tracked under E-CORE-DECOMP
 * (T9834).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 * @see Layer 2: {@link ./timeline.ts}
 * @see Layer 3: {@link ./fetch.ts}
 */

// ── BrainCompactHit ─────────────────────────────────────────────────

/**
 * Single compact hit returned by `searchBrainCompact`.
 *
 * Minimal projection of a BRAIN table row designed for cheap scanning —
 * the full payload is fetched on demand via `fetchBrainEntries` (Layer 3).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface BrainCompactHit {
  /** Entry identifier (e.g. `D-arch-001`, `P-feat-042`). */
  id: string;
  /** Source BRAIN table that produced the hit. */
  type: 'decision' | 'pattern' | 'learning' | 'observation';
  /** Display title for the entry. */
  title: string;
  /** ISO 8601 creation date. */
  date: string;
  /** Legacy relevance score (BM25-only path); omit when `rrfScore` is set. */
  relevance?: number;
  /**
   * RRF-fused score: sum of 1/(rank+60) across all retrieval sources.
   * Present only when the RRF path is used (`useRRF=true`, default).
   * Higher = stronger match. Comparable across results in the same query.
   */
  rrfScore?: number;
  /**
   * BM25-derived score, min-max normalized to [0, 1] across the result set.
   * 1.0 = best BM25 rank in this query, 0.0 = worst (or not found via FTS).
   * Present only when the RRF path is used and at least one FTS result exists.
   */
  bm25Score?: number;
  /**
   * Progressive-disclosure directives for follow-up operations.
   *
   * Maps follow-up keys (e.g. `fetch`, `timeline`) to suggested CLI commands.
   * `Record<string, string>` mirrors the runtime `NextDirectives` alias used
   * by `@cleocode/core`'s `mvi-helpers`.
   */
  _next?: Record<string, string>;
}

// ── SearchBrainCompactParams ────────────────────────────────────────

/**
 * Parameters for `searchBrainCompact`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface SearchBrainCompactParams {
  /** Free-text query (FTS5 + optional vector recall). */
  query: string;
  /** Maximum number of hits to return (caller-bounded). */
  limit?: number;
  /** Restrict the search to a subset of BRAIN tables. */
  tables?: Array<'decisions' | 'patterns' | 'learnings' | 'observations'>;
  /** ISO 8601 lower-bound date filter (inclusive). */
  dateStart?: string;
  /** ISO 8601 upper-bound date filter (inclusive). */
  dateEnd?: string;
  /** T418: filter results to observations produced by a specific agent (Wave 8 mental models). */
  agent?: string;
  /**
   * When true (default), use Reciprocal Rank Fusion to combine FTS5 and
   * vector search results for higher recall and better ranking.
   * When false, fall back to FTS5-only search (faster, no embeddings needed).
   */
  useRRF?: boolean;
  /**
   * T1085: Peer ID filter for CANT agent memory isolation (PSYCHE Wave 2).
   *
   * When provided, search results are scoped to entries where:
   *   `peer_id = peerId OR peer_id = 'global'`
   *
   * When omitted, all entries are returned — backward-compatible behavior.
   */
  peerId?: string;
  /**
   * T1085: When true (default when peerId is provided), include entries with
   * `peer_id = 'global'` alongside the peer-specific entries.
   *
   * Set to false for strict per-peer isolation (no global pool bleed-through).
   */
  includeGlobal?: boolean;
  /**
   * T1900: ranking mode.
   *
   * - `recency`  — ORDER BY created_at DESC, no BM25/RRF contribution.
   *                Use for recentObservations / recentLearnings where
   *                chronological freshness matters more than textual match.
   * - `lexical`  — FTS5 BM25 only (useRRF=false legacy path).
   * - `hybrid`   — Reciprocal Rank Fusion (default, useRRF=true path).
   *
   * @default 'hybrid'
   */
  mode?: 'recency' | 'lexical' | 'hybrid';
  /**
   * T1900: ISO 8601 timestamp lower-bound filter (inclusive).
   *
   * When provided, only rows with `created_at >= since` are returned.
   * Applies to all modes including recency. Useful with `mode=hybrid`
   * (e.g., `since=<30d>`) to limit pattern staleness.
   *
   * When omitted, no lower-bound date filter is applied.
   */
  since?: string;
}

// ── SearchBrainCompactResult ────────────────────────────────────────

/**
 * Result envelope returned by `searchBrainCompact`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface SearchBrainCompactResult {
  /** Ordered compact hits (best match first). */
  results: BrainCompactHit[];
  /** Total number of matches before `limit` truncation. */
  total: number;
  /** Approximate token cost of the returned payload (~chars/4). */
  tokensEstimated: number;
}
