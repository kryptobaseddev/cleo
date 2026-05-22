/**
 * Contract types for the fetchBrainEntries SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional wrapper
 * @task T10070
 * @epic T9835
 */

import type { FetchBrainEntriesParams, FetchBrainEntriesResult } from '../memory/fetch.js';

export type { FetchBrainEntriesParams, FetchBrainEntriesResult };

/** Input accepted by the fetchBrainEntries SDK tool. */
export interface FetchBrainEntriesInput {
  /** Project root directory for DB resolution. */
  projectRoot: string;
  /** Fetch parameters forwarded to fetchBrainEntries. */
  params: FetchBrainEntriesParams;
}

/** Output produced by the fetchBrainEntries SDK tool. */
export interface FetchBrainEntriesOutput {
  /** Result from fetchBrainEntries. */
  result: FetchBrainEntriesResult;
}
