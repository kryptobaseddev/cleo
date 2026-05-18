/**
 * SDK primitive for `cleo worktree force-unlock <taskId>` (T9547).
 *
 * Exposes {@link forceUnlockWorktree} — locates the worktree owned by the
 * given task ID (`task/T<id>` branch convention), then safely clears any
 * wedged lock state:
 *
 *  1. Removes `.git/index.lock` from the worktree directory if present
 *     (the most common wedge — left behind when a git process crashes mid
 *     mutation).
 *  2. Runs `git worktree unlock <path>` when porcelain reports the worktree
 *     as locked via `git worktree lock` (the spawn flow applies this lock
 *     to every agent worktree to prevent accidental pruning).
 *  3. Warns when uncommitted changes are present but NEVER deletes them.
 *     Operators recover the work themselves with `git stash` or `git diff`.
 *
 * Every action is appended to `.cleo/audit/worktree-lifecycle.jsonl` via
 * {@link appendWorktreeAuditEntry}. The audit entry carries enough context
 * (timestamp, actor, action, target, taskId, success state, error reason) to
 * reconstruct the unlock attempt without re-running git.
 *
 * @task T9547
 * @epic T9515
 */

import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  type EngineResult,
  engineError,
  engineSuccess,
  type ForceUnlockWorktreeOpts,
  type ForceUnlockWorktreeResult,
} from '@cleocode/contracts';
import { getLogger } from '../logger.js';
import { appendWorktreeAuditEntry, resolveWorktreeAuditActor } from './audit.js';
import { listWorktrees } from './list.js';

const log = getLogger('worktree:force-unlock');

/** Default supervisor timeout for every git invocation. Matches list.ts. */
const GIT_TIMEOUT_MS = 60_000;

/**
 * Force-unlock the worktree for a given task ID.
 *
 * Routes:
 *  - Worktree not found ⇒ `engineError('E_WORKTREE_NOT_FOUND')`
 *  - Worktree found, no lock state ⇒ `engineSuccess` with `success: true` and
 *    both `indexLockRemoved` / `worktreeUnlocked` set to `false`. This is a
 *    valid no-op — the operator asked us to unlock and there was nothing to do.
 *  - Worktree found, lock state cleared ⇒ `engineSuccess` with the relevant
 *    flag(s) set to `true` plus an audit-log entry.
 *  - Uncommitted changes detected ⇒ `hadUncommittedChanges: true` plus a
 *    warning in the audit reason. The function NEVER deletes or stashes the
 *    changes — that decision belongs to the operator.
 *
 * @param opts - See {@link ForceUnlockWorktreeOpts}.
 * @returns EngineResult wrapping a {@link ForceUnlockWorktreeResult}.
 *
 * @example
 * ```ts
 * const r = await forceUnlockWorktree({
 *   projectRoot: process.cwd(),
 *   taskId: 'T9547',
 * });
 * if (r.success && r.data.indexLockRemoved) {
 *   console.log('cleared .git/index.lock');
 * }
 * ```
 */
export async function forceUnlockWorktree(
  opts: ForceUnlockWorktreeOpts,
): Promise<EngineResult<ForceUnlockWorktreeResult>> {
  const actor = opts.actor ?? resolveWorktreeAuditActor();

  // Locate the worktree via the T9546 listing — single source of truth for
  // path resolution + lock state (no re-parsing porcelain).
  const listResult = await listWorktrees({ projectRoot: opts.projectRoot });
  if (!listResult.success) {
    return engineError<ForceUnlockWorktreeResult>(
      listResult.error.code,
      `Failed to enumerate worktrees: ${listResult.error.message}`,
      { fix: listResult.error.fix },
    );
  }

  const wt = listResult.data.worktrees.find((w) => w.taskId === opts.taskId);
  if (!wt) {
    const errMsg = `No worktree found for task ${opts.taskId} (expected branch task/${opts.taskId}).`;
    appendWorktreeAuditEntry(
      opts.projectRoot,
      {
        actor,
        action: 'force-unlock',
        target: '',
        taskId: opts.taskId,
        success: false,
        error: errMsg,
      },
      opts.auditLogPath,
    );
    return engineError<ForceUnlockWorktreeResult>('E_WORKTREE_NOT_FOUND', errMsg, {
      fix: 'Run `cleo worktree list` to see the canonical taskId set.',
    });
  }

  // Step 1: remove .git/index.lock if present. Worktree git dirs live under
  // `<main-gitdir>/worktrees/<name>` BUT the worktree itself proxies the lock
  // file via `<wt>/.git` (a regular file pointing back into the admin dir).
  // For wedge-cleanup we ALSO check the actual admin path since some git
  // versions leave a stale lock there too. We do not attempt to lex the proxy
  // file — `git rev-parse --git-dir` gives the canonical admin dir for free.
  const indexLockPaths = resolveIndexLockCandidates(wt.path);
  let indexLockRemoved = false;
  for (const candidate of indexLockPaths) {
    if (existsSync(candidate)) {
      try {
        unlinkSync(candidate);
        indexLockRemoved = true;
        log.debug({ candidate }, 'removed git index.lock');
      } catch (err) {
        log.warn(
          { candidate, err: err instanceof Error ? err.message : String(err) },
          'failed to remove index.lock',
        );
      }
    }
  }

  // Step 2: if porcelain reported the worktree as locked, ask git to unlock it.
  let worktreeUnlocked = false;
  if (wt.isLocked) {
    if (gitSilent(['worktree', 'unlock', wt.path], opts.projectRoot)) {
      worktreeUnlocked = true;
    }
  }

  // Step 3: detect uncommitted changes — warn-only, never destructive.
  const hadUncommittedChanges = detectUncommittedChanges(wt.path);

  const success = true;
  const reasonParts: string[] = [];
  if (indexLockRemoved) reasonParts.push('index-lock-removed');
  if (worktreeUnlocked) reasonParts.push('git-worktree-unlocked');
  if (!indexLockRemoved && !worktreeUnlocked) reasonParts.push('no-action-needed');
  if (hadUncommittedChanges) reasonParts.push('uncommitted-changes-preserved');
  const reason = reasonParts.join(',');

  appendWorktreeAuditEntry(
    opts.projectRoot,
    {
      actor,
      action: 'force-unlock',
      target: wt.path,
      ...(wt.branch ? { branch: wt.branch } : {}),
      taskId: opts.taskId,
      reason,
      success,
    },
    opts.auditLogPath,
  );

  return engineSuccess<ForceUnlockWorktreeResult>({
    taskId: opts.taskId,
    path: wt.path,
    indexLockRemoved,
    worktreeUnlocked,
    hadUncommittedChanges,
    success,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers — exported for tests only.
// ---------------------------------------------------------------------------

/**
 * Build the list of candidate `index.lock` paths to inspect for a given
 * worktree directory.
 *
 * Worktrees use a split git-dir layout: `<wt>/.git` is a small text file
 * (`gitdir: <admin>/worktrees/<name>`) and the actual index, refs, and lock
 * files live under `<admin>/worktrees/<name>/`. When a process crashes,
 * stale `index.lock` can appear in either place — so we check both
 * `<wt>/.git/index.lock` AND the admin path resolved via `git rev-parse
 * --git-dir`.
 *
 * @internal Exported for tests only.
 */
export function resolveIndexLockCandidates(worktreePath: string): string[] {
  const candidates: string[] = [];

  // Candidate 1: the in-worktree proxy path (covers older git versions).
  candidates.push(join(worktreePath, '.git', 'index.lock'));

  // Candidate 2: the canonical admin dir resolved via `git rev-parse`.
  // Failures here are fine — we just fall back to the proxy path above.
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitDir && gitDir !== '.git') {
      // `git rev-parse --git-dir` returns either an absolute path or a path
      // relative to the worktree; resolve both correctly.
      const adminLock = gitDir.startsWith('/')
        ? join(gitDir, 'index.lock')
        : join(worktreePath, gitDir, 'index.lock');
      if (!candidates.includes(adminLock)) {
        candidates.push(adminLock);
      }
    }
  } catch (err) {
    log.debug(
      { worktreePath, err: err instanceof Error ? err.message : String(err) },
      'rev-parse --git-dir failed during force-unlock',
    );
  }

  return candidates;
}

/**
 * Returns `true` when the worktree has uncommitted changes (anything that
 * `git status --porcelain` would print). The check is purely informational —
 * the unlock path never touches working-tree content.
 *
 * @internal Exported for tests only.
 */
export function detectUncommittedChanges(worktreePath: string): boolean {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return out.length > 0;
  } catch {
    // If git status itself can't run (e.g. wedge so bad it errors), we can't
    // assert anything — return false rather than over-warning.
    return false;
  }
}

/**
 * Run a git command and return `true` on exit-0, `false` otherwise. Local
 * mirror of the helper in `prune.ts` — duplicated intentionally so each
 * lifecycle module is self-contained.
 *
 * @internal
 */
function gitSilent(args: readonly string[], cwd: string): boolean {
  try {
    execFileSync('git', args as string[], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err), args }, 'git silent failed');
    return false;
  }
}
