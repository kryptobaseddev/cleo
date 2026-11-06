/**
 * Tests for T11996: pruneOrphanWorktrees dirty/unpushed guard, now enforced by
 * the worktree package's `disposeWorktree` engine (T13924).
 *
 * Validates the gc/cleanup path: a worktree whose content or commits are not
 * proven preserved is kept on disk untouched (reported in `quarantined`; no
 * tar archive any more), a directory git cannot read is kept (a failed probe
 * is not proof), fail-closed on an empty preserve set, and idempotency.
 *
 * Test strategy:
 *  - "clean orphan" = a linked worktree of a project repository at main's
 *    commit: every commit it holds is on `main` → removable.
 *  - "dirty orphan" = a linked worktree with an untracked file → kept.
 *
 * All git repos created in /tmp — never touching ~/.local/share/cleo/worktrees.
 *
 * @task T11996
 * @task T13924
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneOrphanWorktrees } from '../gc/cleanup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
}

/** A tmp project repository plus worktrees tree: <tmp>/worktrees/<hash>/<taskId>/ */
function makeLayout(hash: string): {
  tmp: string;
  worktreesRoot: string;
  projectDir: string;
  addWorktree: (taskId: string) => string;
  cleanup: () => void;
} {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-worktree-test-')));
  const worktreesRoot = join(tmp, 'worktrees');
  const projectDir = join(worktreesRoot, hash);
  mkdirSync(projectDir, { recursive: true });
  const repo = join(tmp, 'project');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@test.invalid');
  git(repo, 'config', 'user.name', 'Test');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'base');
  return {
    tmp,
    worktreesRoot,
    projectDir,
    addWorktree: (taskId) => {
      const path = join(projectDir, taskId);
      git(repo, 'worktree', 'add', '-q', '-b', `task/${taskId}`, path);
      return path;
    },
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Dirty guard (T11996, enforced by the engine since T13924)
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees (gc/cleanup) — T11996 dirty guard', () => {
  it('a dirty worktree and an unreadable directory are kept; a clean one is removed', async () => {
    const { tmp, worktreesRoot, projectDir, addWorktree, cleanup } = makeLayout('abc123');
    try {
      const dirtyWt = addWorktree('T9050');
      writeFileSync(join(dirtyWt, 'dirty.txt'), 'uncommitted\n');
      const cleanWt = addWorktree('T9051');
      const plain = join(projectDir, 'T9052');
      mkdirSync(plain);
      writeFileSync(join(plain, 'data.txt'), 'only copy\n');

      const result = await pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc123',
        activeTaskIds: new Set(['PRESERVED']),
      });

      // Kept and reported as not proven preserved: git cannot read the plain directory.
      expect([...result.quarantinedPaths].sort()).toEqual([dirtyWt, plain]);
      expect(result.removedPaths).toEqual([cleanWt]);
      expect(result.errors).toEqual([]);
      expect(existsSync(join(dirtyWt, 'dirty.txt'))).toBe(true);
      expect(existsSync(cleanWt)).toBe(false);
      expect(readFileSync(join(plain, 'data.txt'), 'utf-8')).toBe('only copy\n');
      // Nothing is archived or written to a quarantine directory.
      expect(existsSync(join(tmp, 'quarantine', 'worktrees'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('a commit held only by the worktree branch keeps it; untracked and ignored files stay intact', async () => {
    const { worktreesRoot, addWorktree, cleanup } = makeLayout('abc456');
    try {
      const wt = addWorktree('T9053');
      writeFileSync(join(wt, 'work.ts'), 'export const w = 1;\n');
      git(wt, 'add', 'work.ts');
      git(wt, 'commit', '-q', '-m', 'unpushed');
      const ignoredWt = addWorktree('T9054');
      writeFileSync(join(ignoredWt, '.env'), 'SECRET=1\n');

      const result = await pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc456',
        activeTaskIds: new Set(['PRESERVED']),
      });

      expect(result.removed).toBe(0);
      expect(result.quarantinedPaths.sort()).toEqual([ignoredWt, wt].sort());
      expect(readFileSync(join(ignoredWt, '.env'), 'utf-8')).toBe('SECRET=1\n');
    } finally {
      cleanup();
    }
  });

  it('a symlink cycle in a dirty worktree is kept without an error (T12604)', async () => {
    const { worktreesRoot, addWorktree, cleanup } = makeLayout('abc789');
    try {
      const wt = addWorktree('T9056');
      writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');
      mkdirSync(join(wt, 'nested'));
      symlinkSync('..', join(wt, 'nested', 'loop'));

      const result = await pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc789',
        activeTaskIds: new Set(['PRESERVED']),
      });

      expect(result.errors).toEqual([]);
      expect(result.quarantinedPaths).toEqual([wt]);
      expect(existsSync(join(wt, 'nested'))).toBe(true);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed guard
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees (gc/cleanup) — T11996 fail-closed', () => {
  it('empty activeTaskIds with existing worktrees returns skippedFailClosed', async () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('def456');
    try {
      mkdirSync(join(projectDir, 'T9060'), { recursive: true });
      mkdirSync(join(projectDir, 'T9061'), { recursive: true });

      const result = await pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'def456',
        activeTaskIds: new Set<string>(),
      });

      expect(result.skippedFailClosed).toBe(true);
      expect(result.removed).toBe(0);
      expect(result.quarantined).toBe(0);
      expect(existsSync(join(projectDir, 'T9060'))).toBe(true);
      expect(existsSync(join(projectDir, 'T9061'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('empty activeTaskIds with empty project dir does NOT trigger fail-closed', async () => {
    const { worktreesRoot, cleanup } = makeLayout('empty-hash');
    try {
      const result = await pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'empty-hash',
        activeTaskIds: new Set<string>(),
      });

      expect(result.skippedFailClosed).toBeFalsy();
      expect(result.removed).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees (gc/cleanup) — T11996 idempotency', () => {
  it('second run against converged state performs zero actions', async () => {
    const { worktreesRoot, addWorktree, cleanup } = makeLayout('ghi789');
    try {
      const cleanWt = addWorktree('T9070');

      const opts = {
        worktreesRoot,
        projectHash: 'ghi789',
        activeTaskIds: new Set(['PRESERVED']),
      };

      const first = await pruneOrphanWorktrees(opts);
      expect(first.removed).toBe(1);
      expect(existsSync(cleanWt)).toBe(false);

      // Second run — nothing left to do.
      const second = await pruneOrphanWorktrees(opts);
      expect(second.removed).toBe(0);
      expect(second.quarantined).toBe(0);
      expect(second.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
