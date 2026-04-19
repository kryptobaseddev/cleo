/**
 * Canonical edge-type constants for `brain_page_edges`.
 *
 * All code that writes or queries `brain_page_edges.edge_type` MUST use
 * these constants instead of raw string literals to prevent enum drift.
 *
 * The values here are a subset of `BRAIN_EDGE_TYPES` (memory-schema.ts).
 * They are duplicated as constants so callers do not need to import the
 * schema module (which carries Drizzle + SQLite dependencies).
 *
 * @epic T626
 */
export const EDGE_TYPES = {
  // Plasticity (Hebbian / STDP co-retrieval)
  CO_RETRIEVED: 'co_retrieved',
  // Temporal supersession
  SUPERSEDES: 'supersedes',
  // Task / decision / pattern → target context
  APPLIES_TO: 'applies_to',
  // Provenance
  DERIVED_FROM: 'derived_from',
  // Observation → symbol/file impact
  AFFECTS: 'affects',
  // Observation → symbol name mention
  MENTIONS: 'mentions',
  // Observation → symbol/file structural link
  DOCUMENTS: 'documents',
  // Memory node → nexus symbol/file (T645)
  CODE_REFERENCE: 'code_reference',
} as const;

/** Discriminated union of the canonical edge type constant values. */
export type EdgeType = (typeof EDGE_TYPES)[keyof typeof EDGE_TYPES];
