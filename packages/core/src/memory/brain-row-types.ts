/**
 * Typed row interfaces for raw SQLite queries against brain.db.
 *
 * These replace inline `as Array<{ ... }>` casts throughout the brain/memory modules,
 * giving each raw-SQL result shape a named, reusable type.
 *
 * @task T5800
 */

/** Row returned by FTS content_hash duplicate check (brain-retrieval.ts observeBrain). */
export interface BrainFtsRow {
  id: string;
  type: string;
  created_at: string;
}

/** Row returned by narrative backfill query (brain-retrieval.ts populateEmbeddings). */
export interface BrainNarrativeRow {
  id: string;
  narrative: string;
  title: string;
}

/** Flattened FTS hit used in hybrid search scoring (brain-search.ts hybridSearch). */
export interface BrainSearchHit {
  id: string;
  type: string;
  title: string;
  text: string;
}

/** Row returned by KNN vector similarity query (brain-similarity.ts searchSimilar). */
export interface BrainKnnRow {
  id: string;
  distance: number;
}

/** Decision node attached to a blocker in causal traces (brain-reasoning.ts reasonWhy). */
export interface BrainDecisionNode {
  id: string;
  title: string;
  rationale?: string;
}

/** Anchor entry in a timeline result (brain-retrieval.ts timelineBrain). */
export interface BrainAnchor {
  id: string;
  type: string;
  data: unknown;
}

/**
 * Row returned by timeline UNION ALL neighbor queries (brain-retrieval.ts timelineBrain).
 *
 * Represents an entry from any of the four brain tables projected to
 * a common {id, type, date} shape for chronological ordering.
 */
export interface BrainTimelineNeighborRow {
  id: string;
  type: string;
  date: string;
}

/**
 * Row returned by the consolidation observation query (brain-lifecycle.ts consolidateMemories).
 *
 * Fetches old observations for keyword-based clustering and archival.
 * Uses snake_case column names matching the raw SQLite row shape.
 */
export interface BrainConsolidationObservationRow {
  id: string;
  type: string;
  title: string;
  narrative: string | null;
  project: string | null;
  created_at: string;
}

/**
 * Row returned by ID existence check queries (claude-mem-migration.ts).
 *
 * Used by `SELECT id FROM brain_observations WHERE id = ?` and similar
 * single-column lookups for idempotent migration dedup.
 */
export interface BrainIdCheckRow {
  id: string;
}
