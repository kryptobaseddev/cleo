/**
 * BRAIN timeline wire shapes.
 *
 * Canonical home for the parameters and result types of the public
 * `timelineBrain` operation — Layer 2 of CLEO's 3-layer BRAIN retrieval
 * pattern (search → timeline → fetch). Surfaces chronological neighbors
 * around an anchor entry so an agent can reconstruct the surrounding
 * memory context cheaply.
 *
 * Promoted from `packages/core/src/memory/brain-retrieval.ts` to
 * `@cleocode/contracts` in Phase 0e of SG-ARCH-SOLID
 * (E-CONTRACTS-FOUNDATION). `BrainAnchor` is co-located here because it
 * is the only `brain-row-types.ts` shape that escapes the core boundary
 * via `TimelineBrainResult`; `packages/core/src/memory/brain-row-types.ts`
 * continues to re-export it for internal callers.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 * @see Layer 1: {@link ./search.ts}
 * @see Layer 3: {@link ./fetch.ts}
 */

// ── BrainAnchor ─────────────────────────────────────────────────────

/**
 * Anchor entry around which a timeline is built.
 *
 * Carries the entry identifier, its source table (`type`), and the full
 * payload (`data`) so the caller can render the anchor inline with the
 * neighbor list without an additional `fetchBrainEntries` round trip.
 *
 * Originally defined in `packages/core/src/memory/brain-row-types.ts:46`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface BrainAnchor {
  /** Entry identifier (e.g. `O-abc123`, `D-arch-001`). */
  id: string;
  /** Source BRAIN table (e.g. `observation`, `decision`, `pattern`, `learning`). */
  type: string;
  /**
   * Raw row payload as returned by the underlying SQL query.
   *
   * Typed as `unknown` because the shape varies by `type`. Callers narrow
   * via a discriminated read or pass the value through to a renderer that
   * already understands every BRAIN table shape.
   */
  data: unknown;
}

// ── TimelineBrainParams ─────────────────────────────────────────────

/**
 * Parameters for `timelineBrain`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface TimelineBrainParams {
  /** Anchor entry ID to build the timeline around. */
  anchor: string;
  /** Number of chronologically-earlier neighbors to include. */
  depthBefore?: number;
  /** Number of chronologically-later neighbors to include. */
  depthAfter?: number;
}

// ── TimelineNeighbor ────────────────────────────────────────────────

/**
 * Compact neighbor projection used in timeline results.
 *
 * Each neighbor is reduced to an `{id, type, date}` triple so callers can
 * cheaply scan a large window before drilling into specific entries via
 * `fetchBrainEntries`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface TimelineNeighbor {
  /** Entry identifier. */
  id: string;
  /** Source BRAIN table (e.g. `observation`, `decision`). */
  type: string;
  /** ISO 8601 creation date. */
  date: string;
}

// ── TimelineBrainResult ─────────────────────────────────────────────

/**
 * Result envelope returned by `timelineBrain`.
 *
 * @since SG-ARCH-SOLID Saga T9831 · E-CONTRACTS-FOUNDATION T9832 · T9956 (Phase 0e)
 */
export interface TimelineBrainResult {
  /** The anchor entry, or `null` when the requested ID does not resolve. */
  anchor: BrainAnchor | null;
  /** Chronologically-earlier neighbors, oldest first. */
  before: TimelineNeighbor[];
  /** Chronologically-later neighbors, newest last. */
  after: TimelineNeighbor[];
}
