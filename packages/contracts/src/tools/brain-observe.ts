/**
 * Contract types for the observeBrain SDK tool.
 *
 * @arch SDK Tool (Category B) — harness-agnostic, pure-functional wrapper
 * @task T10070
 * @epic T9835
 */

import type { ObserveBrainParams, ObserveBrainResult } from '../memory/observe.js';

export type { ObserveBrainParams, ObserveBrainResult };

/** Input accepted by the observeBrain SDK tool. */
export interface ObserveBrainInput {
  /** Project root directory for DB resolution. */
  projectRoot: string;
  /** Observation data forwarded to observeBrain. */
  params: ObserveBrainParams;
}

/** Output produced by the observeBrain SDK tool. */
export interface ObserveBrainOutput {
  /** Result from observeBrain. */
  result: ObserveBrainResult;
}
