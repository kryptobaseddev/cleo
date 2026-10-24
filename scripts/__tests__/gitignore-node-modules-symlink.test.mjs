/**
 * A `node_modules` symlink is ignored (T14022).
 *
 * CLEO worktrees link `packages/<pkg>/node_modules` to the main checkout's
 * install. The pattern `node_modules/` (trailing slash) matches directories
 * only, so git did not ignore that symlink, and `git add -A` committed it
 * (#2435).
 *
 * `git check-ignore` stats the path, and after `pnpm install` the repo's own
 * `node_modules` are real directories that `node_modules/` also matches. So
 * both probes here use paths that are never directories:
 * - in this repo, `node_modules` under directories that do not exist, which
 *   git judges as non-directories;
 * - in a scratch repo carrying copies of the tracked `.gitignore` files, real
 *   symlinks named `node_modules`.
 *
 * @task T14022
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The `.gitignore` files whose `node_modules` pattern is under test. */
const IGNORE_FILES = ['.gitignore', 'packages/caamp/.gitignore', 'packages/lafs/.gitignore'];

/** `git check-ignore -v` in `cwd`: the matching rule, or null when none matches. */
function ignoredBy(cwd, path, noIndex) {
  try {
    const args = ['check-ignore', '-v', ...(noIndex ? ['--no-index'] : []), path];
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

describe('node_modules that is not a directory is ignored (T14022)', () => {
  it.each([
    '__t14022_absent__/node_modules',
    'packages/__t14022_absent__/node_modules',
    'packages/caamp/__t14022_absent__/node_modules',
    'packages/lafs/__t14022_absent__/node_modules',
  ])('%s (absent, so never a directory)', (path) => {
    expect(ignoredBy(repoRoot, path, true), path).toMatch(/:node_modules\t/);
  });

  describe('real symlinks against copies of the tracked .gitignore files', () => {
    let scratch = '';

    beforeAll(() => {
      scratch = mkdtempSync(join(tmpdir(), 'cleo-t14022-'));
      execFileSync('git', ['init', '-q', scratch]);
      const target = join(scratch, 'install');
      mkdirSync(target);
      for (const file of IGNORE_FILES) {
        mkdirSync(dirname(join(scratch, file)), { recursive: true });
        copyFileSync(join(repoRoot, file), join(scratch, file));
      }
      for (const dir of ['', 'packages/core', 'packages/caamp', 'packages/lafs']) {
        mkdirSync(join(scratch, dir), { recursive: true });
        symlinkSync(target, join(scratch, dir, 'node_modules'));
      }
    });

    afterAll(() => {
      rmSync(scratch, { recursive: true, force: true });
    });

    it.each([
      'node_modules',
      'packages/core/node_modules',
      'packages/caamp/node_modules',
      'packages/lafs/node_modules',
    ])('%s symlink is ignored', (path) => {
      expect(ignoredBy(scratch, path, false), path).toMatch(/:node_modules\t/);
    });
  });
});
