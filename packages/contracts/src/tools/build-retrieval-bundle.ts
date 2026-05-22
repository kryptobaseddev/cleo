/**
 * Contract types for the buildRetrievalBundle SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional wrapper
 * @task T10070
 * @epic T9835
 */

import type { RetrievalBundle, RetrievalRequest } from '../operations/memory.js';

export type { RetrievalBundle, RetrievalRequest };

/** Input accepted by the buildRetrievalBundle SDK tool. */
export interface BuildRetrievalBundleInput {
  /** Retrieval request forwarded to buildRetrievalBundle. */
  req: RetrievalRequest;
  /** Project root directory for DB resolution. */
  projectRoot: string;
}

/** Output produced by the buildRetrievalBundle SDK tool. */
export interface BuildRetrievalBundleOutput {
  /** Fully-structured retrieval bundle with token accounting. */
  bundle: RetrievalBundle;
}
