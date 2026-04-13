/**
 * Brain/Memory domain types for brain.db cognitive memory system.
 *
 * Extracted from inline type definitions in engine-compat.ts to eliminate
 * repeated `{ id: string; type: string; content: string; createdAt: string }` patterns.
 *
 * @task T5800
 */

// ============================================================
// T549: Tiered + Typed Memory Architecture types
// ============================================================

/**
 * Memory retention tier values for the tiered cognitive memory model (T549).
 *
 * - `short`  — Session-scoped working context. Auto-evicted after TTL if not promoted.
 * - `medium` — Project-scoped verified facts. Retained for weeks.
 * - `long`   — Architectural bedrock. Permanent; supersession-only eviction.
 */
export type BrainMemoryTier = 'short' | 'medium' | 'long';

/**
 * Cognitive type taxonomy for brain entries (T549).
 *
 * NOTE: Named `BrainCognitiveType` (not `BrainMemoryType`) to avoid collision
 * with the brain_memory_links entity type enum.
 *
 * - `semantic`   — Declarative facts: brain_decisions, brain_learnings (default)
 * - `episodic`   — Event records: brain_observations, brain_learnings (transcript-derived)
 * - `procedural` — Process knowledge: brain_patterns
 */
export type BrainCognitiveType = 'semantic' | 'episodic' | 'procedural';

/**
 * Source reliability levels for brain entries (T549 §3.1.5).
 *
 * Separate dimension from content `quality_score`. Each level drives a quality
 * multiplier applied at scoring time:
 *
 * | Level         | Quality multiplier |
 * |---------------|--------------------|
 * | `owner`       | 1.0                |
 * | `task-outcome`| 0.90               |
 * | `agent`       | 0.70               |
 * | `speculative` | 0.40               |
 */
export type BrainSourceConfidence = 'owner' | 'task-outcome' | 'agent' | 'speculative';

/** Compact brain entry reference used in contradiction analysis. */
export interface BrainEntryRef {
  /** Brain.db entry identifier. */
  id: string;
  /** Entry type (e.g. `"observation"`, `"learning"`, `"decision"`). */
  type: string;
  /** Full text content of the brain entry. */
  content: string;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
}

/** Brain entry reference with summary, used in superseded analysis. */
export interface BrainEntrySummary {
  /** Brain.db entry identifier. */
  id: string;
  /** Entry type (e.g. `"observation"`, `"learning"`, `"decision"`). */
  type: string;
  /** ISO 8601 timestamp of when the entry was created. */
  createdAt: string;
  /** Truncated summary of the entry content. */
  summary: string;
}

/** Contradiction detail between two brain entries. */
export interface ContradictionDetail {
  /** First entry in the contradicting pair. */
  entryA: BrainEntryRef;
  /** Second entry in the contradicting pair. */
  entryB: BrainEntryRef;
  /**
   * Additional context explaining the scope of the contradiction.
   *
   * @defaultValue undefined
   */
  context?: string;
  /** Description of how the two entries conflict. */
  conflictDetails: string;
}

/** Superseded entry pair showing old and replacement entries. */
export interface SupersededEntry {
  /** The older entry that has been superseded. */
  oldEntry: BrainEntrySummary;
  /** The newer entry that replaces the old one. */
  replacement: BrainEntrySummary;
  /** Topic or category grouping these entries together. */
  grouping: string;
}
