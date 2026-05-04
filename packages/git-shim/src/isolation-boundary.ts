/**
 * T1761 isolation boundary check for the git-shim.
 *
 * Provides the "last line of defense" cwd-outside-worktree check that fires
 * BEFORE the T1118 denylist. When a worker agent is injected with
 * `CLEO_WORKTREE_ROOT` (via T1759's `provisionIsolatedShell` preamble) but
 * somehow drifts to the main project root, any mutation subcommand is blocked
 * with exit code 77 and a structured `cwd-outside-worktree` error.
 *
 * Design:
 *  - Reads env keys via `ISOLATION_ENV_KEYS` from `@cleocode/contracts` —
 *    the single source of truth — so the key names are never duplicated here.
 *  - Pure functions: no I/O, no spawning, easy to unit-test.
 *  - Only `CLEO_AGENT_ROLE=worker` (exact match) triggers the check — lead /
 *    subagent / orchestrator are not subject to this isolation constraint.
 *
 * @task T1761
 * @adr ADR-055
 */

import { resolve } from 'node:path';
import { ISOLATION_ENV_KEYS } from '@cleocode/contracts';
import type { BoundaryViolation } from './boundary.js';

/**
 * Mutation subcommands that write to the git index or create commits.
 *
 * Only these subcommands trigger the isolation boundary check, since
 * read-only commands (log, status, diff, show, …) cannot pollute the main
 * project even when run from the wrong cwd.
 *
 * @task T1761
 */
export const MUTATION_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'add',
  'commit',
  'rm',
  'mv',
  'restore',
  'apply',
  'am',
]);

/**
 * Check whether `cwd` is inside `worktreeRoot`.
 *
 * A path is considered "inside" when it is exactly equal to the root OR
 * starts with the root followed by the POSIX path separator `/`. Both paths
 * are resolved to absolute form first to guard against trailing-slash
 * inconsistencies and symlink quirks.
 *
 * @param cwd - Working directory to test (may be relative — resolved internally).
 * @param worktreeRoot - Expected worktree root (may be relative — resolved internally).
 * @returns true when cwd is the root or a descendant, false otherwise.
 *
 * @task T1761
 */
export function isCwdInsideWorktree(cwd: string, worktreeRoot: string): boolean {
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(worktreeRoot);
  return resolvedCwd === resolvedRoot || resolvedCwd.startsWith(`${resolvedRoot}/`);
}

/**
 * Evaluate the T1761 isolation boundary for the current git invocation.
 *
 * Fires BEFORE the T1118 denylist — if the agent's cwd is outside its
 * assigned worktree, any mutation is an isolation violation regardless of
 * what specific op is being attempted.
 *
 * Conditions required to trigger (all must be true):
 *   1. `CLEO_AGENT_ROLE=worker` (exact string match — not lead/subagent)
 *   2. `CLEO_WORKTREE_ROOT` is set to a non-empty value
 *   3. The git subcommand is a mutation op (add, commit, rm, mv, …)
 *   4. `process.cwd()` is NOT inside `CLEO_WORKTREE_ROOT`
 *
 * `ISOLATION_ENV_KEYS` from `@cleocode/contracts` is the single source of
 * truth for the env var names — this function never duplicates the key list.
 * Index 0 = `CLEO_WORKTREE_ROOT`, Index 1 = `CLEO_AGENT_ROLE` (enforced by
 * the drift-detection test in isolation-boundary.test.ts).
 *
 * @param subcommand - Git subcommand (argv[0], e.g. "add" or "commit").
 * @returns A {@link BoundaryViolation} when blocked, or `null` when allowed.
 *
 * @task T1761
 */
export function evaluateIsolationBoundary(subcommand: string): BoundaryViolation | null {
  // Only the `worker` role is subject to this isolation check.
  if (process.env[ISOLATION_ENV_KEYS[1]] !== 'worker') return null;

  const worktreeRoot = process.env[ISOLATION_ENV_KEYS[0]];
  if (!worktreeRoot) return null;

  // Only mutation subcommands can cause cross-worktree writes.
  if (!MUTATION_SUBCOMMANDS.has(subcommand)) return null;

  const cwd = process.cwd();
  if (isCwdInsideWorktree(cwd, worktreeRoot)) return null;

  return {
    code: 'E_GIT_BOUNDARY_CWD_OUTSIDE_WORKTREE',
    boundary: 'isolation',
    message:
      `git ${subcommand} refused — cwd "${cwd}" is outside the assigned worktree ` +
      `"${worktreeRoot}" (CLEO_AGENT_ROLE=worker)`,
    remediation:
      'Run all git mutations from inside your assigned worktree. ' +
      'To bypass for an emergency hotfix set CLEO_ALLOW_GIT=1 (audited).',
    context: {
      cwd,
      worktree_root: worktreeRoot,
      role: 'worker',
    },
  };
}
