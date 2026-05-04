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
 *  - Composable: the returned `BoundaryContract` is consumed by the git-shim
 *    and other enforcement layers without taking a runtime dep on core.
 *  - Pure: `provisionIsolatedShell` is deterministic — identical inputs always
 *    produce identical outputs, making it trivially testable.
 *
 * @task T1759
 * @adr ADR-055
 * @adr ADR-062
 */

export type {
  BoundaryContract,
  IsolationEnvKey,
  IsolationOptions,
  IsolationResult,
} from '@cleocode/contracts';
export {
  ISOLATION_ENV_KEYS,
  provisionIsolatedShell,
} from '@cleocode/contracts';
