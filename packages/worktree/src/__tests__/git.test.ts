/**
 * Regression locks for the low-level git helpers in `@cleocode/worktree`.
 *
 * Currently asserts only the published value of {@link DEFAULT_GIT_TIMEOUT_MS}
 * — T9823 bumped this from 60s to 180s so large-repo `git worktree add`
 * (~95s on the cleocode monorepo with 10,712 files) can complete without
 * triggering `spawnSync git ETIMEDOUT`. Keeping the bumped value pinned here
 * prevents accidental regressions back to 60s.
 *
 * @task T9823
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_GIT_TIMEOUT_MS, forceRemoveWorktreeDir } from '../git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

/** A one-commit repository in a fresh temp dir; caller removes it. */
function repo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-git-')));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@e.x');
  git(root, 'config', 'user.name', 'T');
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init');
  return root;
}

describe('DEFAULT_GIT_TIMEOUT_MS (T9823 regression lock)', () => {
  it('is pinned at 180_000ms (3 minutes) so large-repo worktree add completes', () => {
    expect(DEFAULT_GIT_TIMEOUT_MS).toBe(180_000);
  });

  it('is strictly larger than the legacy 60s budget that caused T9823', () => {
    // The legacy value (60_000) was provably too tight for 10k+ file repos.
    // Any future tuning MUST keep the value above 60s — this assertion catches
    // an accidental revert without locking the new value in stone.
    expect(DEFAULT_GIT_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});

describe('forceRemoveWorktreeDir (T10858)', () => {
  it('T10858: forceRemoveWorktreeDir removes a locked worktree and its git admin entry', () => {
    const root = repo();
    const path = join(root, '..', `${root.split('/').pop()}-locked`);
    try {
      git(root, 'worktree', 'add', '-q', '--detach', path);
      git(root, 'worktree', 'lock', path);
      forceRemoveWorktreeDir(root, path);
      expect(existsSync(path)).toBe(false);
      expect(git(root, 'worktree', 'list', '--porcelain').match(/^worktree /gm)).toHaveLength(1);
    } finally {
      rmSync(path, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });
});
