/**
 * The base branch a checkout is measured against, and how far a revision
 * trails it (T14007).
 *
 * One home for "origin's default branch": change-set, affected-packages and
 * gate-runner each carried their own copy, and NEXUS freshness needs the same
 * answer to say how many commits an index is behind.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @module git/base-ref
 * @task T14007
 */

import { execFileSync } from 'node:child_process';
import { discoveryEnv } from './work-tree.js';

/**
 * Run `git` in `root`; trimmed stdout, or `null` on any failure. An ambient
 * `GIT_DIR`/`GIT_WORK_TREE` (set inside a git hook) is stripped, so `root`'s
 * own repository answers, never the hook's.
 */
function git(root: string, args: readonly string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf-8',
      env: discoveryEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * `origin/<default>` from `refs/remotes/origin/HEAD`, else `origin/main` or
 * `origin/master` when that remote branch exists.
 *
 * @param root - Repository to ask.
 * @returns The remote-tracking ref, or `null` when origin has no default branch here.
 * @example
 * ```ts
 * resolveOriginDefault('/repo'); // 'origin/main'
 * ```
 */
export function resolveOriginDefault(root: string): string | null {
  const symbolic = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (symbolic) return symbolic.replace(/^refs\/remotes\//, '');
  for (const candidate of ['origin/main', 'origin/master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${candidate}`]) !== null)
      return candidate;
  }
  return null;
}

/**
 * The ref a checkout's freshness is measured against: origin's default branch,
 * else a local `main` or `master`, else `HEAD` (a remote-less repository).
 *
 * @param root - Repository to ask.
 * @returns The ref, or `null` when `root` is not a git repository with a commit.
 * @example
 * ```ts
 * resolveBaseRef('/repo'); // 'origin/main'
 * ```
 */
export function resolveBaseRef(root: string): string | null {
  const origin = resolveOriginDefault(root);
  if (origin) return origin;
  for (const local of ['main', 'master']) {
    if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`]) !== null)
      return local;
  }
  return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null ? 'HEAD' : null;
}

/**
 * The commit a ref names.
 *
 * @param root - Repository to ask.
 * @param ref - Ref or revision.
 * @returns The full sha, or `null` when it does not resolve.
 */
export function revParse(root: string, ref: string): string | null {
  return git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
}

/**
 * Commits reachable from `to` but not from `from` (`git rev-list --count from..to`).
 *
 * @param root - Repository to ask.
 * @param from - The older revision (e.g. an index's revision).
 * @param to - The newer revision (e.g. the base branch).
 * @returns The count, or `null` when either revision is unknown here.
 * @example
 * ```ts
 * commitsBetween('/repo', indexedSha, 'origin/main'); // 3239
 * ```
 */
export function commitsBetween(root: string, from: string, to: string): number | null {
  const out = git(root, ['rev-list', '--count', `${from}..${to}`]);
  if (out === null) return null;
  const count = Number.parseInt(out, 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * The merge-base of HEAD and origin's default branch: where the branch's own
 * commits begin.
 *
 * @param root - Repository to ask.
 * @returns The merge-base commit, or `null` when there is no origin default
 *   branch or git fails.
 */
export function originDefaultMergeBase(root: string): string | null {
  const base = resolveOriginDefault(root);
  return base ? git(root, ['merge-base', base, 'HEAD']) || null : null;
}
