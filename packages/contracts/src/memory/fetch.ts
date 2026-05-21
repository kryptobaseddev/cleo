/**
 * BRAIN entry-fetch wire shapes.
 *
 * Canonical home for the parameters and result types of the public
 * `fetchBrainEntries` operation — Layer 3 of CLEO's 3-layer BRAIN retrieval
 * pattern (search → timeline → fetch). Returns the full row payload for a
 * caller-supplied list of IDs, typically derived from a prior `searchBrainCompact`
 * or `timelineBrain` call.
 *
 * Promoted from `packages/core/src/memory/brain-retrieval.ts` to
 * `@cleocode/contracts` in Phase 0e of SG-ARCH-SOLID
 * (E-CONTRACTS-FOUNDATION).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 * @see Layer 1: {@link ./search.ts}
 * @see Layer 2: {@link ./timeline.ts}
 */

// ── FetchBrainEntriesParams ─────────────────────────────────────────

/**
 * Parameters for `fetchBrainEntries`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface FetchBrainEntriesParams {
  /** Entry identifiers to fetch in a single batch. */
  ids: string[];
}

// ── FetchedBrainEntry ───────────────────────────────────────────────

/**
 * A single fetched entry with its full row payload.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface FetchedBrainEntry {
  /** Entry identifier. */
  id: string;
  /** Source BRAIN table (e.g. `observation`, `decision`, `pattern`, `learning`). */
  type: string;
  /**
   * Raw row payload as returned by the underlying SQL query.
   *
   * Typed as `unknown` because the shape varies by `type`. Callers narrow
   * via a discriminated read or pass the value through to a renderer.
   */
  data: unknown;
}

// ── FetchBrainEntriesResult ─────────────────────────────────────────

/**
 * Result envelope returned by `fetchBrainEntries`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface FetchBrainEntriesResult {
  /** Resolved entries, in the order they were found (not necessarily input order). */
  results: FetchedBrainEntry[];
  /** Entry identifiers that could not be resolved against any BRAIN table. */
  notFound: string[];
  /** Approximate token cost of the returned payload (~chars/4). */
  tokensEstimated: number;
}
