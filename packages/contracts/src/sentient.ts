/**
 * Sentient Loop Tier-2 Contracts — Proposal types.
 *
 * Defines the shared interfaces for the Tier-2 proposal pipeline:
 * ingester candidates, proposed-task metadata, and rate-limit results.
 *
 * These are LEAF types — zero runtime dependencies.
 *
 * @task T1008
 * @see ADR-054 — Sentient Loop Tier-1 (Tier-2 extension)
 */

// ---------------------------------------------------------------------------
// Proposal candidate (produced by ingesters)
// ---------------------------------------------------------------------------

/**
 * Source system from which a proposal candidate was derived.
 */
export type ProposalSource = 'brain' | 'nexus' | 'test';

/**
 * A ranked proposal candidate produced by one of the three ingesters.
 *
 * Candidates are merged, deduplicated by fingerprint, scored, and written
 * to tasks.db as rows with `status='proposed'` by the propose tick.
 *
 * Title format is ALWAYS a structured template — no freeform LLM text.
 * This is a prompt-injection defence (T1008 §3.6).
 */
export interface ProposalCandidate {
  /** Which ingester produced this candidate. */
  source: ProposalSource;
  /**
   * Stable external identifier (brain entry id, nexus node id, file path).
   * Used with `source` to compute the deduplication fingerprint.
   */
  sourceId: string;
  /**
   * Structured title — MUST match pattern `^\\[T2-(BRAIN|NEXUS|TEST)\\]`.
   * No freeform LLM text is permitted here.
   */
  title: string;
  /** Human-readable rationale (template-generated, not LLM-generated). */
  rationale: string;
  /**
   * Relative priority weight in [0, 1].
   * - BRAIN: `(citation_count / 10) * quality_score` capped at 1.0
   * - NEXUS: fixed 0.3 base weight
   * - TEST:  fixed 0.5 base weight
   */
  weight: number;
}

// ---------------------------------------------------------------------------
// Proposed task meta (stored in tasks.metadataJson)
// ---------------------------------------------------------------------------

/**
 * Metadata stored in `tasks.metadataJson` for rows created by the Tier-2
 * proposer (`status='proposed'`).
 *
 * Parsed from JSON at read time; serialized to JSON at write time.
 */
export interface ProposedTaskMeta {
  /**
   * Identifier tag for the sentient proposer.
   * Always `'sentient-tier2'` for Tier-2 proposals.
   * Used in the transactional rate-limit count query.
   */
  proposedBy: 'sentient-tier2';
  /** Source system that generated this proposal. */
  source: ProposalSource;
  /** External source ID (brain entry id, nexus node id, etc.). */
  sourceId: string;
  /** Computed weight at time of proposal. */
  weight: number;
  /** ISO-8601 timestamp when the proposal was generated. */
  proposedAt: string;
}

// ---------------------------------------------------------------------------
// Tier-2 stats
// ---------------------------------------------------------------------------

/**
 * Rolling counters for Tier-2 proposal activity, persisted in sentient-state.json.
 */
export interface Tier2Stats {
  /** Total proposals written to tasks.db as `status='proposed'`. */
  proposalsGenerated: number;
  /**
   * Total proposals transitioned to `pending` by owner accept action.
   */
  proposalsAccepted: number;
  /**
   * Total proposals transitioned to `cancelled` by owner reject action.
   */
  proposalsRejected: number;
}
