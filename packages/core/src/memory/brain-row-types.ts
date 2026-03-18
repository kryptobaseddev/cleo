/**
 * Typed row interfaces for raw SQLite queries against brain.db.
 *
 * These replace inline `as Array<{ ... }>` casts throughout the brain/memory modules,
 * giving each raw-SQL result shape a named, reusable type.
 *
 * @task T5800
 */

/** Row returned by FTS content_hash duplicate check. */
export interface BrainFtsRow {
  id: string;
  type: string;
  created_at: string;
}

/** Row returned by narrative backfill query (missing embeddings). */
export interface BrainNarrativeRow {
  id: string;
  narrative: string;
  title: string;
}

/** Flattened FTS hit used in hybrid search scoring. */
export interface BrainSearchHit {
  id: string;
  type: string;
  title: string;
  text: string;
}

/** Row returned by KNN vector similarity query. */
export interface BrainKnnRow {
  id: string;
  distance: number;
}

/** Decision node attached to a blocker in causal traces. */
export interface BrainDecisionNode {
  id: string;
  title: string;
  rationale?: string;
}

/** Anchor entry in a timeline result. */
export interface BrainAnchor {
  id: string;
  type: string;
  data: unknown;
}
