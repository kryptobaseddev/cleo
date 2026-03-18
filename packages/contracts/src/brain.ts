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
  id: string;
  type: string;
  content: string;
  createdAt: string;
}

/** Brain entry reference with summary, used in superseded analysis. */
export interface BrainEntrySummary {
  id: string;
  type: string;
  createdAt: string;
  summary: string;
}

/** Contradiction detail between two brain entries. */
export interface ContradictionDetail {
  entryA: BrainEntryRef;
  entryB: BrainEntryRef;
  context?: string;
  conflictDetails: string;
}

/** Superseded entry pair showing old and replacement entries. */
export interface SupersededEntry {
  oldEntry: BrainEntrySummary;
  replacement: BrainEntrySummary;
  grouping: string;
}
