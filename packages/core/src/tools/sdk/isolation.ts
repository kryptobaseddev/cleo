/**
 * WorktreeIsolation SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for the worktree isolation contract. Every
 * harness adapter and spawn pathway that provisions an isolated agent
 * shell MUST import from this path.
 *
 * This module is an additive re-export of `../../worktree/isolation.ts`
 * (`packages/core/src/worktree/isolation.ts`), which itself re-exports the
 * canonical implementation from `@cleocode/contracts`. No logic is
 * duplicated here — the single source of truth lives in contracts.
 *
 * Callers that cannot take a runtime dep on `@cleocode/core` (e.g. harness
 * adapters with circular-dependency constraints) MUST import directly from
 * `@cleocode/contracts` instead.
 *
 * @arch See ADR-064 (Category B SDK Tool: WorktreeIsolation)
 * @task T1815
 * @task T1817
 * @epic T1768
 */

export type {
  AbsolutePathRules,
  AbsolutePathValidationResult,
  BoundaryContract,
  IsolationEnvKey,
  IsolationOptions,
  IsolationResult,
} from '../../worktree/isolation.js';
export {
  ISOLATION_ENV_KEYS,
  provisionIsolatedShell,
  validateAbsolutePath,
} from '../../worktree/isolation.js';
