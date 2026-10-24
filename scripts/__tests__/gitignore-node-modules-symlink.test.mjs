/**
 * A `node_modules` symlink is ignored (T14022).
 *
 * CLEO worktrees link `packages/<pkg>/node_modules` to the main checkout's
 * install. The pattern `node_modules/` (trailing slash) matches directories
 * only, so git did not ignore that symlink, and `git add -A` committed it
 * (#2435). `git check-ignore --no-index` on a path that does not exist judges
 * it as a non-directory, which is exactly how git sees a symlink.
 *
 * @task T14022
 */

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The pattern that ignores `path` as a non-directory, or null when none does. */
function ignoredBy(path) {
  try {
    return execFileSync('git', ['check-ignore', '-v', '--no-index', path], {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

describe('node_modules symlinks are ignored (T14022)', () => {
  it.each([
    'node_modules',
    'packages/core/node_modules',
    'packages/cleo/node_modules',
    'packages/caamp/node_modules',
    'packages/lafs/node_modules',
  ])('%s is ignored even when it is not a directory', (path) => {
    expect(ignoredBy(path), path).toMatch(/\tnode_modules|\t.*node_modules$/);
  });
});
