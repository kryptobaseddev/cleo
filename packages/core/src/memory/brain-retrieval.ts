/**
 * BRAIN Retrieval Operations — 3-layer pattern (search -> timeline -> fetch).
 *
 * Barrel re-export. Implementation split into single-concern files under
 * packages/core/src/memory/retrieval/ per Saga T9831 / Epic T9834 (T10067).
 *
 * Import paths that previously resolved to this file continue to work
 * without change — no downstream consumer needs to update its import.
 *
 * @task T5131 T5132 T5133 T5134 T5135
 * @epic T5149
 */

// ============================================================================
// Re-exports — wire shapes promoted to @cleocode/contracts/memory in T9956
// (Phase 0e of SG-ARCH-SOLID). Existing `from './brain-retrieval.js'` imports
// continue to resolve so no downstream consumer needs to change its import.
// ============================================================================

export type {
  BrainAnchor,
  BrainCompactHit,
  BrainObservationSourceType,
  FetchBrainEntriesParams,
  FetchBrainEntriesResult,
  FetchedBrainEntry,
  ObserveBrainParams,
  ObserveBrainResult,
  SearchBrainCompactParams,
  SearchBrainCompactResult,
  TimelineBrainParams,
  TimelineBrainResult,
  TimelineNeighbor,
} from '@cleocode/contracts';

// ============================================================================
// Implementation re-exports — each file owns one concern
// ============================================================================

export {
  buildRetrievalBundle,
  fetchIdentity,
  fetchPeerMemory,
  fetchSessionState,
} from './retrieval/build-retrieval-bundle.js';
export { fetchBrainEntries } from './retrieval/fetch.js';
export type {
  PopulateEmbeddingsOptions,
  PopulateEmbeddingsResult,
} from './retrieval/observe.js';
export {
  observeBrain,
  populateEmbeddings,
} from './retrieval/observe.js';
export type {
  BudgetedEntry,
  BudgetedResult,
  BudgetedRetrievalOptions,
} from './retrieval/search.js';
export { retrieveWithBudget, searchBrainCompact } from './retrieval/search.js';
export { parseIdPrefix, timelineBrain } from './retrieval/timeline.js';
