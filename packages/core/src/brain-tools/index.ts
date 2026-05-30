/**
 * BrainTools barrel — pure-functional SDK tools for BRAIN retrieval and observation.
 *
 * All tools are Category B SDK Tools (harness-agnostic, pure-functional, I/O isolated).
 * Input/output types are defined in `@cleocode/contracts` — never inline.
 *
 * Exposed tools:
 *   searchBrain           — Layer 1: compact FTS/RRF search (~50 tokens/hit)
 *   observeBrain          — unified BRAIN write path (observations)
 *   fetchBrainEntries     — Layer 3: batch-fetch full entry details by IDs
 *   timelineBrain         — Layer 2: chronological context around an anchor
 *   buildRetrievalBundle  — multi-pass cold/warm/hot bundle for agent briefing
 *
 * @arch SDK Tools (Category B) — T10070 / Epic T9835 / Saga T9831
 * @task T10070
 */

export { fetchBrainEntries } from './brain-fetch.js';
export { observeBrain } from './brain-observe.js';
export { searchBrain } from './brain-search.js';
export { timelineBrain } from './brain-timeline.js';
export { buildRetrievalBundle } from './build-retrieval-bundle.js';
