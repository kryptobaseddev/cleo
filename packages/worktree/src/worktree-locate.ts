/**
 * Locate a task's worktree by asking git, not by recomputing a path (T12086).
 *
 * ## Why this exists
 *
 * `destroyWorktree` derived everything by convention:
 *
 * ```ts
 * const worktreePath = resolveTaskWorktreePath(computeProjectHash(projectRoot), taskId);
 * const branch = `task/${taskId}`;
 * ```
 *
 * Both assumptions fail in the field, and both fail **silently reporting
 * success**:
 *
 * 1. **The path.** `computeProjectHash` produces the CURRENT hash scheme. A
 *    worktree provisioned under an earlier scheme lives at a different
 *    directory, so `existsSync(worktreePath)` is false and the code takes its
 *    `else` branch — `worktreeRemoved = true // already gone` — for a worktree
 *    that is still registered and still on disk. Measured 2026-08-06: 23
 *    worktrees under `…/worktrees/L21udC9wcm9qZWN0cy9jbGVvY29kZQ/` all reported
 *    `worktreeRemoved: true` and none were touched.
 *
 * 2. **The branch.** Real branches carry a slug — `task/T11248-cleo-exodus`,
 *    not `task/T11248`. `git branch --list task/T11248` matches nothing, the
 *    delete is skipped, and `branchDeleted = true` is returned anyway.
 *
 * The cost of a cleanup verb that claims success without acting is not one bad
 * call — it is that nobody notices the mess growing. 42 worktrees accumulated
 * behind exactly this.
 *
 * ## The rule
 *
 * `git worktree list --porcelain` is the authoritative registry of what exists
 * and which branch each entry has checked out. Ask it. Fall back to the
 * computed path only when git knows nothing, and then say so.
 *
 * @task T12086
 */

import { getGitRoot, gitSync } from './git.js';

/** A worktree as git itself reports it. */
export interface LocatedWorktree {
  /** Absolute path git has registered. */
  readonly path: string;
  /** Branch checked out there, or `null` when detached. */
  readonly branch: string | null;
  /** Whether git holds a lock on this entry. */
  readonly locked: boolean;
  /** Present (true) only for a bare repository entry: no working tree, no branch (T10866). */
  readonly bare?: true;
}

/**
 * Parse `git worktree list --porcelain` into structured entries.
 *
 * The porcelain format is a blank-line-separated series of records:
 * `worktree <path>`, then optional `HEAD <sha>`, `branch <ref>`, `locked`,
 * `bare`, `detached`.
 *
 * @param raw - stdout of `git worktree list --porcelain`.
 * @returns one entry per registered worktree, in git's order.
 *
 * @task T12086
 */
export function parseWorktreePorcelain(raw: string): LocatedWorktree[] {
  const out: LocatedWorktree[] = [];
  let path: string | null = null;
  let branch: string | null = null;
  let locked = false;
  let bare = false;

  /** Flush the record under construction, if any. */
  const flush = (): void => {
    if (path !== null) out.push({ path, branch, locked, ...(bare ? { bare: true as const } : {}) });
    path = null;
    branch = null;
    locked = false;
    bare = false;
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (trimmed === '') {
      flush();
      continue;
    }
    if (trimmed.startsWith('worktree ')) {
      flush();
      path = trimmed.slice('worktree '.length);
    } else if (trimmed.startsWith('branch ')) {
      branch = trimmed.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (trimmed === 'locked' || trimmed.startsWith('locked ')) {
      locked = true;
    } else if (trimmed === 'bare') {
      bare = true;
    }
  }
  flush();
  return out;
}

/**
 * List every worktree git has registered for this repository.
 *
 * Never throws — an unreadable registry yields an empty list, which callers
 * treat as "git knows nothing", NOT as "nothing exists".
 *
 * @param projectRoot - any path inside the repository.
 * @returns registered worktrees.
 *
 * @task T12086
 */
export function listRegisteredWorktrees(projectRoot: string): LocatedWorktree[] {
  try {
    return readWorktreePorcelain(getGitRoot(projectRoot));
  } catch {
    return [];
  }
}

/**
 * Read git's worktree registry for the repository containing `cwd`.
 *
 * Unlike {@link listRegisteredWorktrees} this throws when git fails, for
 * callers that must tell "git could not answer" apart from "no worktrees"
 * (core's `cleo worktree list`, T10866). Exported on the light
 * `@cleocode/worktree/worktree-locate.js` subpath so sync callers on the CLI
 * startup path need not load the package barrel.
 *
 * @param cwd - any path inside the repository.
 * @returns registered worktrees, in git's order.
 * @throws Error when `git worktree list --porcelain` fails.
 *
 * @task T10866
 */
export function readWorktreePorcelain(cwd: string): LocatedWorktree[] {
  return parseWorktreePorcelain(gitSync(['worktree', 'list', '--porcelain'], cwd));
}

/**
 * Find the registered worktree belonging to `taskId`.
 *
 * Matching is on the path's final segment, which is the canonical layout
 * (`…/worktrees/<projectHash>/<taskId>`) regardless of which hash scheme
 * produced the parent directory — that is exactly the drift a recomputed path
 * cannot survive.
 *
 * @param projectRoot - any path inside the repository.
 * @param taskId - task whose worktree to find (e.g. `T11248`).
 * @returns the entry, or `null` when git has no worktree for this task.
 *
 * @example
 * ```ts
 * const wt = locateTaskWorktree('/repo', 'T11248');
 * // → { path: '…/worktrees/L21udC…/T11248', branch: 'task/T11248-cleo-exodus', locked: true }
 * ```
 *
 * @task T12086
 */
export function locateTaskWorktree(projectRoot: string, taskId: string): LocatedWorktree | null {
  const wanted = taskId.trim();
  if (wanted === '') return null;

  for (const entry of listRegisteredWorktrees(projectRoot)) {
    const segments = entry.path.split(/[/\\]/).filter((s) => s !== '');
    const last = segments[segments.length - 1];
    if (last === wanted) return entry;
  }
  return null;
}
