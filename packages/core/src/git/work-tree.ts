/**
 * Whether a directory can host a `git`/`gh` evidence invocation, and what to
 * say when it cannot (gh#1462).
 *
 * `pr:` and `commit:` atoms shell out to `gh` / `git` from a working directory.
 * `gh` does its OWN repo discovery: it walks up from its cwd and, finding no
 * repository before the filesystem boundary, fails with
 *
 *   fatal: not a git repository (or any parent up to mount point /mnt)
 *
 * That message arrives as `E_EVIDENCE_TOOL_FAILED` — the same code a tool that
 * genuinely ran and failed produces — so a CLEO root that is a PARENT of the
 * checkout is indistinguishable from a broken `gh` or an atom this project
 * cannot satisfy. The layout is the cause; the error has to say so.
 *
 * Both atoms ask the same question and need the same remediation, so it lives
 * here rather than being spelled out twice.
 *
 * @task gh#1462
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Error code for "no git work tree at or above the evidence execution root".
 *
 * Deliberately distinct from `E_EVIDENCE_TOOL_FAILED` (the tool ran and failed)
 * and from `E_EVIDENCE_INVALID` (the atom itself cannot hold here). The reader
 * of this code is being told to fix the directory, not to stop trusting the
 * evidence route.
 *
 * @task gh#1462
 */
export const E_EVIDENCE_GIT_ROOT = 'E_EVIDENCE_GIT_ROOT' as const;

/**
 * True when `dir` is inside a git work tree — its own checkout or a descendant
 * of one, since git walks up. False when the directory is missing, is not a
 * work tree, or `git` itself cannot be spawned.
 *
 * @param dir - Directory the tools would run in.
 * @task gh#1462
 */
export function isGitWorkTree(dir: string): boolean {
  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * The single git work tree directly below `dir`, or `null` when there is none
 * or more than one.
 *
 * One level only, on purpose. A CLEO root that parents its checkout — the
 * layout gh#1462 reports — has the repository as a direct child, while a
 * recursive search would descend into `node_modules` and vendored trees and
 * would still have to guess which repository a `pr:` atom was about. Ambiguity
 * returns `null` so the caller can report it instead of picking one.
 *
 * @param dir - Candidate parent directory (the CLEO store root).
 * @task gh#1462
 */
export function findNestedGitWorkTree(dir: string): string | null {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const child = join(dir, entry);
    if (!existsSync(join(child, '.git'))) continue;
    found.push(child);
  }
  const only = found[0];
  if (only === undefined || found.length !== 1) return null;
  try {
    return realpathSync(only);
  } catch {
    return only;
  }
}

/**
 * Reason text for {@link E_EVIDENCE_GIT_ROOT}: names the directory that was
 * tried and the two environment variables that pin a checkout CLEO could not
 * find on its own.
 *
 * @param dir - Directory the tools would have run in.
 * @task gh#1462
 */
export function describeMissingGitWorkTree(dir: string): string {
  return (
    `No git work tree at or above ${dir}, so git and gh cannot run there. ` +
    `This is a directory/layout problem — not a failing PR, a missing commit, ` +
    `or a broken gh. If the checkout lives elsewhere, point the tools at it ` +
    `explicitly: GIT_DIR=<repo>/.git GIT_WORK_TREE=<repo> cleo verify ... ` +
    `(or run the command from inside the checkout).`
  );
}
