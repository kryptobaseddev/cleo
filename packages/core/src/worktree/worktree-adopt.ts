/**
 * `cleo worktree adopt` — register an externally-created worktree in the SSoT
 * (T9804 — Claude Code Agent isolation:worktree bridge).
 *
 * ## Rationale (Option B: Adopt)
 *
 * Claude Code's Agent tool `isolation:worktree` creates worktrees under
 * `.claude/worktrees/<sessionId>/` and does NOT call `cleo orchestrate spawn`.
 * CLEO cannot modify the harness directly, so we adopt the worktrees post-hoc:
 *
 *  1. `cleo worktree adopt <path>` reads the worktree's `.git` gitlink to
 *     extract the branch name.
 *  2. The entry is upserted into `<repo>/.cleo/worktrees.json` (the in-project
 *     sentinel index, council D009 hybrid pattern).
 *  3. An audit-log entry `{action:"adopt", source:"claude-agent", ...}` is
 *     appended to `.cleo/audit/worktree-lifecycle.jsonl` via the T9547 helper.
 *  4. After adoption `cleo worktree list` returns the entry tagged with
 *     `source: "claude-agent"` in addition to the git-native worktrees.
 *
 * Idempotent: re-adopting the same path updates the index entry but does not
 * create duplicate audit entries (the audit helper always appends so the
 * duplicate-adopt is still visible in the log for traceability).
 *
 * ## Lifecycle / Cleanup
 *
 * Adopted worktrees surface in `cleo worktree list` and are therefore subject
 * to the same auto-cleanup hooks as CLEO-spawned worktrees — namely:
 *
 *  - `cleo worktree prune --orphaned` will offer to remove adopted orphans.
 *  - T9805 auto-cleanup hooks will fire on PR merge for adopted branches.
 *
 * @task T9804
 * @epic T9804
 * @saga T9800
 * @adr ADR-055 — worktree canonical paths
 * @adr ADR-062 — git merge --no-ff integration semantics
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdoptWorktreeOpts, AdoptWorktreeResult, WorktreeSource } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { resolveOrCwd } from '../paths.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from './audit.js';
import { type SentinelWorktreeEntry, upsertSentinelEntry } from './sentinel-index.js';

const log = getLogger('worktree:adopt');

// Re-export contracts types so callers don't need to import from two places.
export type { AdoptWorktreeOpts, AdoptWorktreeResult };

/**
 * Register an externally-created worktree in the CLEO SSoT.
 *
 * This is the SDK primitive behind `cleo worktree adopt <path>`. It:
 *
 *  1. Validates that `worktreePath` is a real directory containing a `.git`
 *     gitlink (or `.git` directory for primary worktrees).
 *  2. Extracts the current branch name from the gitlink's `HEAD` file.
 *  3. Upserts the entry into `<projectRoot>/.cleo/worktrees.json`.
 *  4. Appends an audit-log entry to `.cleo/audit/worktree-lifecycle.jsonl`.
 *
 * @param opts - Adoption options.
 * @returns EngineResult containing an {@link AdoptWorktreeResult} on success.
 *
 * @example
 * ```ts
 * const result = await adoptWorktree({
 *   worktreePath: '/mnt/projects/cleocode/.claude/worktrees/session-abc/',
 *   projectRoot: '/mnt/projects/cleocode',
 *   source: 'claude-agent',
 * });
 * if (result.success) {
 *   console.log('Adopted:', result.data.branch, '(new:', result.data.isNew, ')');
 * }
 * ```
 */
export async function adoptWorktree(
  opts: AdoptWorktreeOpts,
): Promise<EngineResult<AdoptWorktreeResult>> {
  const projectRoot = resolveOrCwd(opts.projectRoot);
  const worktreePath = opts.worktreePath;
  const source: WorktreeSource = opts.source ?? 'claude-agent';
  const actor = opts.actor ?? resolveWorktreeAuditActor();

  log.debug({ worktreePath, source, actor }, 'adoptWorktree called');

  // --- Validate the worktree path ---
  if (!existsSync(worktreePath)) {
    return engineError('E_WORKTREE_NOT_FOUND', `Worktree path does not exist: ${worktreePath}`, {
      fix: 'Check the path and try again. Use `git worktree list` to enumerate real worktrees.',
    });
  }

  // --- Extract branch from gitlink ---
  const branchResult = extractBranchFromWorktree(worktreePath);
  if (!branchResult.success) {
    return engineError(
      'E_WORKTREE_NOT_FOUND',
      `Cannot read branch from worktree at ${worktreePath}: ${branchResult.error}`,
      {
        fix: 'Ensure the path is a valid git worktree directory (contains a .git file or .git/HEAD).',
      },
    );
  }
  const branch = branchResult.branch;

  // --- Resolve task ID ---
  const taskId: string | null = opts.taskId !== undefined ? opts.taskId : taskIdFromBranch(branch);

  // --- Upsert sentinel index ---
  const adoptedAt = new Date().toISOString();
  const entry: SentinelWorktreeEntry = {
    path: worktreePath,
    branch,
    taskId,
    source,
    adoptedAt,
    adoptedBy: actor,
  };

  const isNew = upsertSentinelEntry(projectRoot, entry, opts.sentinelIndexPath);

  // --- Audit log ---
  appendWorktreeAuditEntry(
    projectRoot,
    {
      actor,
      action: 'adopt',
      target: worktreePath,
      branch,
      ...(taskId !== null ? { taskId } : {}),
      reason: `source:${source}`,
      success: true,
    },
    opts.auditLogPath,
  );

  log.debug({ worktreePath, branch, taskId, isNew }, 'adoptWorktree complete');

  return engineSuccess<AdoptWorktreeResult>({
    path: worktreePath,
    branch,
    taskId,
    source,
    isNew,
    adoptedAt,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Success shape for {@link extractBranchFromWorktree}. */
interface BranchSuccess {
  success: true;
  branch: string;
}

/** Failure shape for {@link extractBranchFromWorktree}. */
interface BranchFailure {
  success: false;
  error: string;
}

/**
 * Read the branch name from a worktree directory.
 *
 * A git worktree directory may contain:
 *  - A `.git` file (gitlink) pointing to the admin dir under `.git/worktrees/<name>/`
 *  - A real `.git/` directory (primary checkout)
 *
 * In both cases the current branch is recorded in `HEAD` as either:
 *  - `ref: refs/heads/<branch>` — normal branch checkout
 *  - A raw commit SHA — detached HEAD
 *
 * @param worktreePath - Absolute path to the worktree directory.
 * @returns Branch name on success, or an error string on failure.
 * @internal Exported for tests only.
 */
export function extractBranchFromWorktree(worktreePath: string): BranchSuccess | BranchFailure {
  const gitPath = join(worktreePath, '.git');
  if (!existsSync(gitPath)) {
    return { success: false, error: '.git file/directory not found' };
  }

  let headFilePath: string;
  try {
    const gitContent = readFileSync(gitPath, 'utf-8').trim();
    if (gitContent.startsWith('gitdir: ')) {
      // Linked worktree: `.git` is a file pointing to `.git/worktrees/<name>/`
      const adminDir = gitContent.slice('gitdir: '.length).trim();
      // Resolve relative gitdir reference against the worktree path
      const resolvedAdmin = adminDir.startsWith('/') ? adminDir : join(worktreePath, adminDir);
      headFilePath = join(resolvedAdmin, 'HEAD');
    } else {
      // `.git` is a directory (primary worktree) — HEAD is directly inside
      headFilePath = join(gitPath, 'HEAD');
    }
  } catch {
    // `.git` is a directory (existsSync passed but readFileSync failed because
    // it is a directory, not a file). Try reading `.git/HEAD` directly.
    headFilePath = join(gitPath, 'HEAD');
  }

  if (!existsSync(headFilePath)) {
    return { success: false, error: `HEAD file not found at ${headFilePath}` };
  }

  let headContent: string;
  try {
    headContent = readFileSync(headFilePath, 'utf-8').trim();
  } catch (err) {
    return {
      success: false,
      error: `Failed to read HEAD: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (headContent.startsWith('ref: refs/heads/')) {
    const branch = headContent.slice('ref: refs/heads/'.length);
    return { success: true, branch };
  }

  // Detached HEAD — use the SHA as the branch label
  if (/^[0-9a-f]{7,40}$/.test(headContent)) {
    return { success: true, branch: headContent };
  }

  return { success: false, error: `Unrecognised HEAD content: ${headContent}` };
}

/**
 * Extract a task ID from a branch name following the `task/T####` or
 * `feat/T####` naming convention.
 *
 * Mirrors the same logic in `list.ts` with an extension for `feat/` branches
 * (common for Claude Code Agent worktrees). Duplicated here to avoid a circular
 * import between `adopt` and `list`.
 *
 * @param branch - Git branch name.
 * @returns The task ID string, or null if the branch does not match.
 * @internal Exported for tests only.
 */
export function taskIdFromBranch(branch: string): string | null {
  const match = branch.match(/^(?:task|feat)\/(T\d+)/);
  return match ? (match[1] ?? null) : null;
}
