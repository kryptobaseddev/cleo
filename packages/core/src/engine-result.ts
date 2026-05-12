/**
 * Canonical EngineResult — re-exported from @cleocode/contracts (T1685 W1).
 *
 * All types and helpers are defined in packages/contracts/src/engine-result.ts.
 * @cleocode/core re-exports them here so existing imports from '@cleocode/core'
 * continue to resolve without change.
 *
 * @epic T1685 — T-CSL-RESET Wave 1: EngineResult canonicalization
 */

// Re-export everything from contracts so existing callers are unaffected.
export type {
  EngineErrorPayload,
  EngineFailure,
  EngineResult,
  EngineSuccess,
  ProblemDetails,
} from '@cleocode/contracts';

export {
  EngineResultError,
  engineError,
  engineSuccess,
  unwrap,
} from '@cleocode/contracts';
