/**
 * Contract types for the searchBrain SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional wrapper
 * @task T10070
 * @epic T9835
 */

import type { SearchBrainCompactParams, SearchBrainCompactResult } from '../memory/search.js';

export type { SearchBrainCompactParams, SearchBrainCompactResult };

/** Input accepted by the searchBrain SDK tool. */
export interface SearchBrainInput {
  /** Project root directory for DB resolution. */
  projectRoot: string;
  /** Search parameters forwarded to searchBrainCompact. */
  params: SearchBrainCompactParams;
}

/** Output produced by the searchBrain SDK tool. */
export interface SearchBrainOutput {
  /** Compact search results from searchBrainCompact. */
  result: SearchBrainCompactResult;
}
