/**
 * Contract types for the timelineBrain SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional wrapper
 * @task T10070
 * @epic T9835
 */

import type { TimelineBrainParams, TimelineBrainResult } from '../memory/timeline.js';

export type { TimelineBrainParams, TimelineBrainResult };

/** Input accepted by the timelineBrain SDK tool. */
export interface TimelineBrainInput {
  /** Project root directory for DB resolution. */
  projectRoot: string;
  /** Timeline parameters forwarded to timelineBrain. */
  params: TimelineBrainParams;
}

/** Output produced by the timelineBrain SDK tool. */
export interface TimelineBrainOutput {
  /** Result from timelineBrain. */
  result: TimelineBrainResult;
}
