/**
 * Brain/Memory domain types for brain.db cognitive memory system.
 *
 * Extracted from inline type definitions in engine-compat.ts to eliminate
 * repeated `{ id: string; type: string; content: string; createdAt: string }` patterns.
 *
 * @task T5800
 */

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
