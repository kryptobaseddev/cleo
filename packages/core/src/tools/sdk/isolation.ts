/**
 * WorktreeIsolation SDK Tool — Category B re-export entry point.
 *
 * Canonical SDK path for the worktree isolation contract defined in
 * `@cleocode/contracts`. Every harness adapter and spawn pathway that
 * provisions an isolated agent shell MUST import from this path (or directly
 * from `@cleocode/contracts` to avoid circular dependencies).
 *
 * Re-exports `provisionIsolatedShell`, `validateAbsolutePath`, and
 * `ISOLATION_ENV_KEYS` from `@cleocode/contracts` so that core-internal
 * callers have a single consistent import location within the SDK surface.
 *
 * @arch See ADR-064 (Category B SDK Tool: WorktreeIsolation)
 * @task T1815
 * @epic T1768
 */

export type {
  AbsolutePathRules,
  AbsolutePathValidationResult,
  BoundaryContract,
  IsolationEnvKey,
  IsolationOptions,
  IsolationResult,
} from '@cleocode/contracts';
export {
  ISOLATION_ENV_KEYS,
  provisionIsolatedShell,
  validateAbsolutePath,
} from '@cleocode/contracts';
