#!/usr/bin/env node
/**
 * git-shim — harness-agnostic git fence (T1118 L2 + T1591 boundary fence).
 *
 * Usage: place this binary on PATH BEFORE real git, and export:
 *   CLEO_AGENT_ROLE=worker   (or lead|subagent)
 *   CLEO_WORKTREE_ROOT=<path>   (optional — auto-detected from cwd)
 *   CLEO_TASK_ID=T<NUM>        (optional — auto-detected from worktree path)
 *
 * Layered enforcement (in order, all under restricted-role gate):
 *   1. T1118 denylist (branch-mutation ops). Bypass: `CLEO_ALLOW_BRANCH_OPS=1`.
 *   2. T1591 boundary fence:
 *      (a) git add path inside worktree
 *      (b) git commit subject contains T-ID
 *      (c) git merge requires CLEO_ORCHESTRATE_MERGE=1
 *      (d) git cherry-pick refuses task/T<NUM> source
 *      Bypass any of (a)-(d): `CLEO_ALLOW_GIT=1` (audited).
 *
 * Audit log at `<XDG>/cleo/audit/git-shim.jsonl` (override `CLEO_AUDIT_LOG_PATH`).
 *
 * Exit codes:
 *   0   — passthrough succeeded
 *   1   — generic shim error (real git not found)
 *   77  — CLEO_GIT_BLOCKED sentinel (legacy denylist + new boundary fence)
 *   N   — real git exit code propagated
 *
 * @task T1118
 * @task T1121
 * @task T1591
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AuditRecord, writeAuditRecord } from './audit-log.js';
import {
  type BoundaryViolation,
  validateAddPaths,
  validateCherryPickSource,
  validateCommitSubject,
  validateMergeAllowed,
} from './boundary.js';
import { findDeniedOp, RESTRICTED_ROLES } from './denylist.js';
import { resolveActiveWorktree } from './worktree-path.js';

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
 * 2. Walk PATH entries, skip any that contain CLEO_SHIM_MARKER.
 * 3. Fall back to /usr/bin/git, /usr/local/bin/git, /opt/homebrew/bin/git.
 *
 * @returns Absolute path to real git, or null if not found.
 */
function resolveRealGit(): string | null {
  const override = process.env['CLEO_REAL_GIT_PATH'];
  if (override && existsSync(override)) return override;

  const shimMarker = process.env['CLEO_SHIM_MARKER'] ?? '.cleo/bin/git-shim';
  const pathDirs = (process.env['PATH'] ?? '').split(':');

  for (const dir of pathDirs) {
    if (dir.includes(shimMarker)) continue;
    const candidate = join(dir, 'git');
    if (existsSync(candidate)) return candidate;
  }

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
    `${JSON.stringify({
      cleo_error: true,
      code,
      message,
      ...context,
    })}\n`,
  );
  process.stderr.write(`[git-shim] BLOCKED: ${message}\n`);
}

/**
 * Emit a boundary violation to stderr in a uniform format.
 *
 * @param violation - Predicate-emitted violation.
 * @param subcommand - Git subcommand under inspection.
 */
function emitBoundaryViolation(violation: BoundaryViolation, subcommand: string): void {
  emitBlockedError(violation.code, violation.message, {
    boundary: violation.boundary,
    subcommand,
    ...violation.context,
  });
  process.stderr.write(`[git-shim] FIX: ${violation.remediation}\n`);
}

/**
 * Apply the four T1591 boundary checks for the given subcommand.
 *
 * @param subcommand - Git subcommand (argv[0]).
 * @param args - Remaining argv entries.
 * @returns A boundary violation when blocked, else null.
 */
function evaluateBoundaries(subcommand: string, args: string[]): BoundaryViolation | null {
  const cwd = process.cwd();
  const active = resolveActiveWorktree(cwd);

  // Boundary (a) — git add path inside worktree (only meaningful when active).
  if (subcommand === 'add' && active) {
    const v = validateAddPaths(args, cwd, active.worktreePath);
    if (v) return v;
  }

  // Boundary (b) — commit subject contains a task ID.
  if (subcommand === 'commit') {
    const expected = active ? active.taskId : null;
    const v = validateCommitSubject(args, expected);
    if (v) return v;
  }

  // Boundary (c) — merge gated by CLEO_ORCHESTRATE_MERGE.
  if (subcommand === 'merge') {
    const v = validateMergeAllowed(args, {
      CLEO_ORCHESTRATE_MERGE: process.env['CLEO_ORCHESTRATE_MERGE'],
    });
    if (v) return v;
  }

  // Boundary (d) — cherry-pick rejects task/T<NUM> sources.
  if (subcommand === 'cherry-pick') {
    const v = validateCherryPickSource(args);
    if (v) return v;
  }

  return null;
}

/**
 * Build a structured audit record for the current invocation.
 *
 * @param outcome - "blocked" | "bypassed-allow-git" | "bypassed-orchestrate-merge".
 * @param boundary - Which boundary fired (a-d, or "denylist").
 * @param code - CLEO error code.
 * @param subcommand - Git subcommand.
 * @param args - Argv tail.
 * @param context - Free-form per-violation context.
 * @returns Fully populated audit record.
 */
function buildAuditRecord(
  outcome: AuditRecord['outcome'],
  boundary: AuditRecord['boundary'],
  code: string,
  subcommand: string,
  args: string[],
  context: Record<string, string>,
): AuditRecord {
  const cwd = process.cwd();
  const active = resolveActiveWorktree(cwd);
  return {
    ts: new Date().toISOString(),
    outcome,
    boundary,
    code,
    subcommand,
    args,
    cwd,
    worktree_path: active?.worktreePath ?? null,
    task_id: active?.taskId ?? null,
    role: process.env['CLEO_AGENT_ROLE'] ?? null,
    context,
  };
}

/**
 * Main shim entry point.
 *
 * Reads argv, env, applies the denylist + the boundary fence, and either
 * blocks or passes through to the real git binary.
 */
function main(): void {
  const argv = process.argv.slice(2);
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

  const remainingArgs = argv.slice(1);
  const allowBranchOps = process.env['CLEO_ALLOW_BRANCH_OPS'] === '1';
  const allowGit = process.env['CLEO_ALLOW_GIT'] === '1';

  // ---------------------------------------------------------------------------
  // Layer 1 — T1118 denylist (branch-mutation ops).
  // ---------------------------------------------------------------------------
  const denied = findDeniedOp(subcommand, remainingArgs);
  if (denied && !allowBranchOps && !allowGit) {
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
    writeAuditRecord(
      buildAuditRecord('blocked', 'denylist', 'E_GIT_OP_BLOCKED', subcommand, remainingArgs, {
        flag: denied.flag ?? '',
        reason: denied.reason,
      }),
    );
    process.exit(BLOCKED_EXIT_CODE);
    return;
  }

  if (denied && (allowBranchOps || allowGit)) {
    process.stderr.write(
      `[git-shim] WARNING: ${allowBranchOps ? 'CLEO_ALLOW_BRANCH_OPS' : 'CLEO_ALLOW_GIT'}=1 ` +
        `bypassed denylist for 'git ${subcommand}' (role=${role}). This bypass is audited.\n`,
    );
    writeAuditRecord(
      buildAuditRecord(
        'bypassed-allow-git',
        'denylist',
        'E_GIT_OP_BLOCKED',
        subcommand,
        remainingArgs,
        { flag: denied.flag ?? '', reason: denied.reason },
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Layer 2 — T1591 boundary fence (a/b/c/d).
  // ---------------------------------------------------------------------------
  const violation = evaluateBoundaries(subcommand, remainingArgs);
  if (violation && !allowGit) {
    emitBoundaryViolation(violation, subcommand);
    writeAuditRecord(
      buildAuditRecord(
        'blocked',
        violation.boundary,
        violation.code,
        subcommand,
        remainingArgs,
        violation.context,
      ),
    );
    process.exit(BLOCKED_EXIT_CODE);
    return;
  }

  if (violation && allowGit) {
    process.stderr.write(
      `[git-shim] WARNING: CLEO_ALLOW_GIT=1 bypassed boundary ${violation.boundary} ` +
        `(${violation.code}) for 'git ${subcommand}' (role=${role}). This bypass is audited.\n`,
    );
    writeAuditRecord(
      buildAuditRecord(
        'bypassed-allow-git',
        violation.boundary,
        violation.code,
        subcommand,
        remainingArgs,
        violation.context,
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // Pass through to real git.
  // ---------------------------------------------------------------------------
  const realGit = resolveRealGit();
  if (!realGit) {
    process.stderr.write('[git-shim] ERROR: real git binary not found on PATH\n');
    process.exit(1);
  }

  const result = spawnSync(realGit, argv, { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

main();
