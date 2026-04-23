#!/usr/bin/env node
/**
 * git-shim — harness-agnostic git branch-mutation fence (T1118 L2).
 *
 * Usage: place this binary on PATH BEFORE real git, and export:
 *   CLEO_AGENT_ROLE=worker   (or lead|subagent)
 *   CLEO_WORKTREE_ROOT=<path>
 *
 * Behaviour:
 *   - If CLEO_AGENT_ROLE is a restricted role AND the git subcommand is in
 *     the denylist AND CLEO_ALLOW_BRANCH_OPS is not set: print structured
 *     error to stderr, exit 1.
 *   - If CLEO_ALLOW_BRANCH_OPS=1: log a warning and pass through (escape hatch).
 *   - Otherwise: exec real git with all original args (zero overhead path).
 *
 * The real git binary is resolved from CLEO_REAL_GIT_PATH env (override) or
 * discovered by walking PATH and skipping any entry that resolves to this
 * shim itself (detected via CLEO_SHIM_MARKER env set by the shim installer).
 *
 * Exit codes:
 *   0   — passthrough succeeded (real git exited 0)
 *   1   — git op blocked by shim
 *   77  — well-known CLEO_GIT_BLOCKED sentinel (same as exit 1 but distinguishable)
 *   N   — real git exit code propagated
 *
 * @task T1118
 * @task T1121
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findDeniedOp, RESTRICTED_ROLES } from './denylist.js';

/** Sentinel exit code for a shim-blocked git operation. */
const BLOCKED_EXIT_CODE = 77;

/**
 * Read and validate the CLEO agent role from the environment.
 *
 * @returns The agent role string, or null if not set or not restricted.
 */
function getAgentRole(): string | null {
  const role = process.env['CLEO_AGENT_ROLE'];
  if (!role) return null;
  return RESTRICTED_ROLES.has(role) ? role : null;
}

/**
 * Resolve the path to the real git binary.
 *
 * Strategy:
 * 1. If CLEO_REAL_GIT_PATH env is set, use it (override for testing).
 * 2. Walk PATH entries, skip the first one that contains CLEO_SHIM_MARKER.
 * 3. Fall back to /usr/bin/git, /usr/local/bin/git, /opt/homebrew/bin/git.
 *
 * @returns Absolute path to real git, or null if not found.
 */
function resolveRealGit(): string | null {
  // Explicit override wins — useful for tests.
  const override = process.env['CLEO_REAL_GIT_PATH'];
  if (override && existsSync(override)) return override;

  const shimMarker = process.env['CLEO_SHIM_MARKER'] ?? '.cleo/bin/git-shim';
  const pathDirs = (process.env['PATH'] ?? '').split(':');

  for (const dir of pathDirs) {
    // Skip directories that look like the shim directory.
    if (dir.includes(shimMarker)) continue;
    const candidate = join(dir, 'git');
    if (existsSync(candidate)) return candidate;
  }

  // Hard fallbacks for common installations.
  const fallbacks = ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
  for (const fb of fallbacks) {
    if (existsSync(fb)) return fb;
  }
  return null;
}

/**
 * Emit a structured JSON error line to stderr.
 *
 * Format mirrors LAFS error envelopes so parsers can detect it.
 *
 * @param code - CLEO error code string.
 * @param message - Human-readable message.
 * @param context - Additional key/value context.
 */
function emitBlockedError(code: string, message: string, context: Record<string, string>): void {
  process.stderr.write(
    JSON.stringify({
      cleo_error: true,
      code,
      message,
      ...context,
    }) + '\n',
  );
  // Also emit a plain-text line so human readers can understand without parsing.
  process.stderr.write(
    `[git-shim] BLOCKED: ${message}\n` +
      `[git-shim] Set CLEO_ALLOW_BRANCH_OPS=1 to bypass (audited).\n`,
  );
}

/**
 * Main shim entry point.
 *
 * Reads argv, env, applies the denylist, and either blocks or passes through
 * to the real git binary.
 */
function main(): void {
  const argv = process.argv.slice(2); // strip "node" and shim path
  const subcommand = argv[0];

  // Fast path: no subcommand → pass through (git with no args shows usage).
  if (!subcommand) {
    const realGit = resolveRealGit();
    if (!realGit) {
      process.stderr.write('[git-shim] ERROR: real git binary not found\n');
      process.exit(1);
    }
    const result = spawnSync(realGit, argv, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
    return;
  }

  const role = getAgentRole();

  // Fast path: no restricted role → pass through unconditionally.
  if (!role) {
    const realGit = resolveRealGit();
    if (!realGit) {
      process.stderr.write('[git-shim] ERROR: real git binary not found\n');
      process.exit(1);
    }
    const result = spawnSync(realGit, argv, { stdio: 'inherit' });
    process.exit(result.status ?? 1);
    return;
  }

  // Check escape hatch — operator has explicitly permitted this one invocation.
  const allowBranchOps = process.env['CLEO_ALLOW_BRANCH_OPS'] === '1';

  const remainingArgs = argv.slice(1);
  const denied = findDeniedOp(subcommand, remainingArgs);

  if (denied && !allowBranchOps) {
    const worktreeRoot = process.env['CLEO_WORKTREE_ROOT'] ?? '(unknown)';
    emitBlockedError(
      'E_GIT_OP_BLOCKED',
      `git ${subcommand}${denied.flag ? ` ${denied.flag}` : ''} is not allowed for role '${role}': ${denied.reason}`,
      {
        subcommand,
        flag: denied.flag ?? '',
        role,
        worktree_root: worktreeRoot,
      },
    );
    process.exit(BLOCKED_EXIT_CODE);
    return;
  }

  if (denied && allowBranchOps) {
    // Escape hatch used — log an audit warning.
    process.stderr.write(
      `[git-shim] WARNING: CLEO_ALLOW_BRANCH_OPS=1 bypassed block for ` +
        `'git ${subcommand}' (role=${role}). This bypass is audited.\n`,
    );
  }

  // Pass through to real git.
  const realGit = resolveRealGit();
  if (!realGit) {
    process.stderr.write('[git-shim] ERROR: real git binary not found on PATH\n');
    process.exit(1);
  }

  const result = spawnSync(realGit, argv, { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

main();
