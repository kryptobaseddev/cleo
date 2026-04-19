/**
 * Shared types for memory page shelf components.
 *
 * Kept as a plain .ts module (not .svelte) so Vitest + SvelteKit build
 * both consume the types without Svelte compilation. The components
 * themselves re-import these contracts rather than redefining them.
 *
 * @task T990
 * @wave 1D
 */

/** Allowed memory tier filter values. */
export type MemoryTierFilter = 'short' | 'medium' | 'long' | null;

/** Allowed memory cognitive-type filter values. */
export type MemoryTypeFilter = 'episodic' | 'semantic' | 'procedural' | string | null;

/** Allowed status filter values for observations / decisions / patterns / learnings. */
export type MemoryStatusFilter = 'verified' | 'prune' | 'invalidated' | null;

/** Allowed confidence filter values for learnings / decisions. */
export type MemoryConfidenceFilter = 'high' | 'medium' | 'low' | 'unknown' | null;

/** Allowed sort keys — every memory list supports the same three axes. */
export type MemorySortKey = 'created_desc' | 'quality_desc' | 'citation_desc';

/**
 * Canonical filter value consumed by `<FilterBar>`.
 *
 * Every field is optional; the bar renders only the inputs whose driver
 * slot is enabled by its caller (some surfaces have no `confidence`,
 * others have no `status`, etc).
 */
export interface FilterValue {
  /** Tier filter. Null = All. */
  tier?: MemoryTierFilter;
  /** Memory cognitive type (observations). Null = All. */
  type?: MemoryTypeFilter;
  /** Minimum quality score [0..1]. `undefined` = no floor. */
  minQuality?: number;
  /** Status filter. Null = All. */
  status?: MemoryStatusFilter;
  /** Confidence filter. Null = All. */
  confidence?: MemoryConfidenceFilter;
  /** Free-text search applied server-side (or client-side per caller). */
  q?: string;
}
