/**
 * The identity of a checkout's tracked working tree: HEAD plus the git tree
 * hash of the tracked content as it sits on disk, uncommitted edits included.
 *
 * Binds targeted `test-run:` evidence to the code it tested (T12965): two
 * checkouts holding the same tracked bytes share one tree hash whatever their
 * path or HEAD, and any tracked edit after the run changes it. Untracked files
 * are excluded, matching the tool cache's tracked-only fingerprint.
 *
 * @task T12965
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { discoveryEnv } from '../git/work-tree.js';

/** HEAD and the tracked working-tree hash of one checkout. */
export interface TreeIdentity {
  /** Commit HEAD points at. */
  headSha: string;
  /** Tree hash of the tracked working-tree content (staged and unstaged edits). */
  treeHash: string;
}

function git(root: string, args: readonly string[], env: NodeJS.ProcessEnv): string | null {
  try {
    return execFileSync('git', [...args], {
      cwd: root,
      encoding: 'utf-8',
      env,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Capture the tree identity of the checkout at `root`. Read-only for the
 * checkout: the hash is computed in a throwaway index (a copy of the real one,
 * so only files whose stat changed are re-hashed), never the live index.
 *
 * @param root - Checkout to identify.
 * @returns The identity, or null when `root` is not a git checkout or git fails.
 * @example
 * ```ts
 * const id = captureTreeIdentity(executionRoot);
 * if (id) console.log(id.treeHash);
 * ```
 * @task T12965
 */
export function captureTreeIdentity(root: string): TreeIdentity | null {
  const baseEnv = discoveryEnv();
  const headSha = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], baseEnv);
  if (!headSha) return null;
  const dir = mkdtempSync(join(tmpdir(), 'cleo-tree-identity-'));
  try {
    const index = join(dir, 'index');
    const env = { ...baseEnv, GIT_INDEX_FILE: index };
    const live = git(root, ['rev-parse', '--git-path', 'index'], baseEnv);
    let seeded = false;
    if (live) {
      try {
        copyFileSync(resolve(root, live), index);
        seeded = true;
      } catch {
        seeded = false; // no live index (fresh clone state): seed from HEAD
      }
    }
    if (!seeded && git(root, ['read-tree', 'HEAD'], env) === null) return null;
    if (git(root, ['add', '--update', '--', '.'], env) === null) return null;
    const treeHash = git(root, ['write-tree'], env);
    return treeHash ? { headSha, treeHash } : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
