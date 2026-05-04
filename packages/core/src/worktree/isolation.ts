/**
 * Centralized worktree isolation utility (T1759).
 *
 * Provides `provisionIsolatedShell` — the single source of truth for computing
 * the cwd, env-var block, shell preamble, and boundary contract that every
 * harness-agnostic agent spawn MUST use.
 *
 * The implementation lives in `@cleocode/contracts` (pure function, no I/O,
 * no side effects) so harness adapters that cannot take a runtime dep on
 * `@cleocode/core` (due to circular dependency constraints) can import the
 * canonical implementation directly from contracts. This module re-exports
 * everything so all consumers that CAN import from core get a stable, single
 * import path.
 *
 * Design goals:
 *  - Harness-agnostic: works with PiHarness, ClaudeCodeSpawnProvider, and any
 *    future adapter — no harness-specific imports here.
 *  - Single source of truth: `ISOLATION_ENV_KEYS` is the only canonical list
 *    of env keys injected into every isolated agent process.
 *  - Composable: the returned `BoundaryContract` is consumed by the git-shim,
 *    `validateAbsolutePath`, and other enforcement layers without taking a
 *    runtime dep on core.
 *  - Pure: `provisionIsolatedShell` and `validateAbsolutePath` are deterministic
 *    — identical inputs always produce identical outputs, making them trivially
 *    testable.
 *
 * T1851 extension: `validateAbsolutePath` closes the bypass vector discovered
 * in T1763 — a worker used Edit/Write with absolute paths outside its worktree,
 * which the git-shim alone could not prevent (it only intercepts `git` binary
 * calls). The `BoundaryContract.absolutePathRules` field carries the per-spawn
 * enforcement configuration.
 *
 * @task T1759
 * @task T1851
 * @adr ADR-055
 * @adr ADR-062
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
