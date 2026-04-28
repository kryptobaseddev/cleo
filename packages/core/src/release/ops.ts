/**
 * Release domain Core operation signatures.
 *
 * Declares the `releaseCoreOps` registry — the type source for
 * `OpsFromCore<typeof release.releaseCoreOps>` inference in the dispatch layer.
 *
 * Each key maps to a typed operation function signature derived from the
 * canonical contracts in `@cleocode/contracts/operations/release.ts`.
 *
 * Architecture note: The two dispatch-layer operations (`gate` and `ivtr-suggest`)
 * delegate to engine functions in `packages/cleo/src/dispatch/engines/release-engine.ts`.
 * This `releaseCoreOps` registry provides the declaration-only type surface for
 * `OpsFromCore` inference without introducing a runtime dependency. This mirrors
 * the admin/playbooks domain pattern (ADR-057 D1 exception applies: engine functions
 * use positional args and are wrapped in thin dispatch wrappers in `release.ts`).
 *
 * @module release/ops
 * @task T1543 — release dispatch OpsFromCore migration
 *
 * @example
 * ```ts
 * import type { release as coreRelease } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type ReleaseDispatchOps = OpsFromCore<typeof coreRelease.releaseCoreOps>;
 * ```
 */

import type {
  IvtrAutoSuggestResult,
  ReleaseGateCheckParams,
  ReleaseGateCheckResult,
} from '@cleocode/contracts/operations/release';

/**
 * Params for `release.ivtr-suggest` operation.
 *
 * Mirrors the engine signature `releaseIvtrAutoSuggest(taskId, projectRoot?)`.
 * Not yet in `@cleocode/contracts/operations/release.ts` — defined here for
 * OpsFromCore inference parity with the dispatch handler.
 */
export interface ReleaseIvtrSuggestParams {
  /** Task ID that just reached the `released` phase. */
  taskId: string;
}

/**
 * Release operation registry used by the dispatch layer for
 * `OpsFromCore<typeof releaseCoreOps>` inference.
 *
 * @example
 * ```ts
 * import type { release } from '@cleocode/core';
 * import type { OpsFromCore } from '../adapters/typed.js';
 *
 * type ReleaseOps = OpsFromCore<typeof release.releaseCoreOps>;
 * const handler = defineTypedHandler<ReleaseOps>('release', { ... });
 * ```
 *
 * @task T1543 — release dispatch OpsFromCore migration
 */
export declare const releaseCoreOps: {
  /** Check IVTR phase state for all tasks in a release epic (RELEASE-03). */
  readonly gate: (params: ReleaseGateCheckParams) => Promise<ReleaseGateCheckResult>;
  /** Check if all epic tasks are released and suggest `release ship` (RELEASE-07). */
  readonly 'ivtr-suggest': (params: ReleaseIvtrSuggestParams) => Promise<IvtrAutoSuggestResult>;
};
