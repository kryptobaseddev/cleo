/**
 * Locating a worktree by asking git (T12086).
 *
 * The bug these guard is not a crash — it is a cleanup verb that reports
 * `worktreeRemoved: true, branchDeleted: true` while the directory, the git
 * registration, and the branch all still exist. Measured 2026-08-06: 23
 * worktrees destroyed "successfully", zero actually removed, because
 * `destroyWorktree` recomputed the path from the CURRENT project-hash scheme
 * and assumed the branch was `task/<taskId>` with no slug.
 *
 * 42 worktrees accumulated behind that silent success.
 *
 * @task T12086
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWorktreePorcelain, readWorktreePorcelain } from '../worktree-locate.js';

/** Real `git worktree list --porcelain` output, including a locked entry. */
const PORCELAIN = `worktree /mnt/projects/cleocode
HEAD 21336e5a9f0e6cb2fb2a3f4e5d6c7b8a9f0e1d2c
branch refs/heads/main

worktree /home/u/.local/share/cleo/worktrees/L21udC9wcm9qZWN0cy9jbGVvY29kZQ/T11248
HEAD aaaa111122223333444455556666777788889999
branch refs/heads/task/T11248-cleo-exodus
locked

worktree /home/u/.local/share/cleo/worktrees/1e3146b7352ba279/T12029
HEAD bbbb111122223333444455556666777788889999
branch refs/heads/task/T12029

worktree /home/u/.local/share/cleo/worktrees/1e3146b7352ba279/T9999
HEAD cccc111122223333444455556666777788889999
detached
`;

describe('parseWorktreePorcelain (T12086)', () => {
  it('parses every entry with its path, branch and lock state', () => {
    const entries = parseWorktreePorcelain(PORCELAIN);

    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({ path: '/mnt/projects/cleocode', branch: 'main', locked: false });
  });

  it('strips refs/heads/ and PRESERVES the branch slug', () => {
    // The whole bug: the real branch is `task/T11248-cleo-exodus`, so a lookup
    // for `task/T11248` matches nothing and the delete is silently skipped.
    const entries = parseWorktreePorcelain(PORCELAIN);
    const t11248 = entries.find((e) => e.path.endsWith('/T11248'));

    expect(t11248?.branch).toBe('task/T11248-cleo-exodus');
    expect(t11248?.branch).not.toBe('task/T11248');
  });

  it('reports a locked worktree as locked', () => {
    // `git worktree remove` refuses a locked entry; destroy must unlock first
    // rather than assume the removal worked.
    const entries = parseWorktreePorcelain(PORCELAIN);
    expect(entries.find((e) => e.path.endsWith('/T11248'))?.locked).toBe(true);
    expect(entries.find((e) => e.path.endsWith('/T12029'))?.locked).toBe(false);
  });

  it('reports a detached worktree with a null branch', () => {
    const entries = parseWorktreePorcelain(PORCELAIN);
    expect(entries.find((e) => e.path.endsWith('/T9999'))?.branch).toBeNull();
  });

  it('finds a worktree under a LEGACY project-hash directory', () => {
    // This is the path a recomputed `computeProjectHash()` cannot produce, so
    // `existsSync(recomputed)` was false and destroy concluded "already gone".
    const entries = parseWorktreePorcelain(PORCELAIN);
    const legacy = entries.find((e) => e.path.split('/').pop() === 'T11248');

    expect(legacy).toBeDefined();
    expect(legacy?.path).toContain('L21udC9wcm9qZWN0cy9jbGVvY29kZQ');
  });

  it('returns an empty list for empty input rather than a phantom entry', () => {
    expect(parseWorktreePorcelain('')).toEqual([]);
    expect(parseWorktreePorcelain('\n\n')).toEqual([]);
  });

  it('handles a final record with no trailing blank line', () => {
    const raw = 'worktree /a/b\nHEAD 1234\nbranch refs/heads/feat/x';
    expect(parseWorktreePorcelain(raw)).toEqual([
      { path: '/a/b', branch: 'feat/x', locked: false },
    ]);
  });

  it('does not leak state between records', () => {
    // A locked first entry must not mark a subsequent unlocked one as locked.
    const raw = 'worktree /a\nlocked\n\nworktree /b\nbranch refs/heads/main\n';
    const entries = parseWorktreePorcelain(raw);
    expect(entries[0]).toEqual({ path: '/a', branch: null, locked: true });
    expect(entries[1]).toEqual({ path: '/b', branch: 'main', locked: false });
  });
});

describe('T10866: bare entries and the throwing reader', () => {
  it('marks a bare repository entry, and only that one', () => {
    const raw = 'worktree /repo.git\nbare\n\nworktree /wt\nHEAD 1\ndetached\n';
    expect(parseWorktreePorcelain(raw)).toEqual([
      { path: '/repo.git', branch: null, locked: false, bare: true },
      { path: '/wt', branch: null, locked: false },
    ]);
  });

  it('readWorktreePorcelain throws outside a repository instead of answering empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-locate-'));
    try {
      expect(() => readWorktreePorcelain(dir)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
