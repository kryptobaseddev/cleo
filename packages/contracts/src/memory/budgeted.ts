/**
 * Budget-aware BRAIN retrieval wire shapes.
 *
 * Canonical home for the parameters and result types of the public
 * `retrieveWithBudget` operation — hybrid (FTS5 + vector KNN + graph) BRAIN
 * search with token-bounded result accounting. Used by the session-briefing
 * pipeline (`buildRetrievalBundle`) to assemble cross-table context within
 * a caller-specified token budget.
 *
 * Promoted from `packages/core/src/memory/brain-retrieval.ts` (T549
 * Wave 3-A region, lines 1305-1340) to `@cleocode/contracts` in Phase 0e
 * of SG-ARCH-SOLID (E-CONTRACTS-FOUNDATION).
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */

// ── BudgetedRetrievalOptions ────────────────────────────────────────

/**
 * Optional filters for `retrieveWithBudget`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface BudgetedRetrievalOptions {
  /** Filter by cognitive types (semantic / episodic / procedural). */
  types?: Array<'semantic' | 'episodic' | 'procedural'>;
  /** Filter by memory tiers (short / medium / long). */
  tiers?: Array<'short' | 'medium' | 'long'>;
  /** When true, only return verified entries. Default: false. */
  verified?: boolean;
}

// ── BudgetedEntry ───────────────────────────────────────────────────

/**
 * A single entry returned by `retrieveWithBudget`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface BudgetedEntry {
  /** Entry identifier. */
  id: string;
  /** Source BRAIN table (e.g. `observation`, `decision`, `pattern`, `learning`). */
  type: string;
  /** Display title for the entry. */
  title: string;
  /** Full text payload (narrative / decision text / pattern body / learning insight). */
  text: string;
  /** Fused relevance score: FTS50% + vector40% + graph10% × qualityScore. */
  score: number;
  /** Estimated token cost for this entry (~chars/4). */
  tokensEstimated: number;
  /** Memory tier for this entry. */
  memoryTier?: string;
  /** Cognitive type for this entry. */
  memoryType?: string;
}

// ── BudgetedResult ──────────────────────────────────────────────────

/**
 * Result envelope returned by `retrieveWithBudget`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface BudgetedResult {
  /** Entries selected within the requested token budget, ranked by fused score. */
  entries: BudgetedEntry[];
  /** Total tokens consumed by returned entries. */
  tokensUsed: number;
  /** Tokens remaining from the original budget. */
  tokensRemaining: number;
  /** Number of entries excluded due to budget constraints. */
  excluded: number;
}
