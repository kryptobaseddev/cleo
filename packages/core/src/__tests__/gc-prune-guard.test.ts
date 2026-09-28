/**
 * Tests for T11996: pruneOrphanWorktrees dirty/unpushed guard + quarantine.
 *
 * Validates the gc/cleanup path guards — dirty detection, quarantine archive
 * creation, fail-closed on empty preserve set, and idempotency.
 *
 * Test strategy:
 *  - "clean orphan" = plain directory (no git repo).
 *    git commands fail gracefully → isWorktreeDirty=false → removable.
 *  - "dirty orphan" = git repo with uncommitted changes → quarantined.
 *
 * All git repos created in /tmp — never touching ~/.local/share/cleo/worktrees.
 *
 * @task T11996
 */

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pruneOrphanWorktrees } from '../gc/cleanup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a real git repo at path with one initial commit. */
function initGitRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', path], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'config', 'user.email', 'test@test.invalid'], {
    stdio: 'pipe',
  });
  execFileSync('git', ['-C', path, 'config', 'user.name', 'Test'], { stdio: 'pipe' });
  writeFileSync(join(path, 'base.md'), '# base\n');
  execFileSync('git', ['-C', path, 'add', 'base.md'], { stdio: 'pipe' });
  execFileSync('git', ['-C', path, 'commit', '-q', '-m', 'base'], { stdio: 'pipe' });
}

/** Create a tmp worktrees tree: <tmp>/worktrees/<hash>/<taskId>/ */
function makeLayout(hash: string): {
  tmp: string;
  worktreesRoot: string;
  projectDir: string;
  cleanup: () => void;
} {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-worktree-test-')));
  const worktreesRoot = join(tmp, 'worktrees');
  const projectDir = join(worktreesRoot, hash);
  mkdirSync(projectDir, { recursive: true });
  return {
    tmp,
    worktreesRoot,
    projectDir,
    cleanup: () => rmSync(tmp, { recursive: true, force: true }),
  };
}

// ---------------------------------------------------------------------------
// Dirty guard + quarantine
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees (gc/cleanup) — T11996 dirty guard', () => {
  it('dirty worktree is quarantined, not deleted; clean plain dir is removed', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('abc123');
    try {
      // Dirty worktree (git repo with uncommitted changes).
      const dirtyWt = join(projectDir, 'T9050');
      initGitRepo(dirtyWt);
      writeFileSync(join(dirtyWt, 'dirty.txt'), 'uncommitted\n');

      // Clean orphan: plain directory, no git.
      const cleanWt = join(projectDir, 'T9051');
      mkdirSync(cleanWt, { recursive: true });
      writeFileSync(join(cleanWt, 'data.txt'), 'content\n');

      const result = pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc123',
        // Non-empty so fail-closed doesn't trigger.
        activeTaskIds: new Set(['PRESERVED']),
      });

      // T9050 dirty → quarantined; T9051 plain dir → removed.
      expect(result.quarantined).toBe(1);
      expect(result.quarantinedPaths).toHaveLength(1);
      expect(result.quarantinedPaths[0]).toContain('T9050');
      expect(result.removed).toBe(1);
      expect(result.removedPaths[0]).toContain('T9051');

      // T9050 directory must still exist.
      expect(existsSync(dirtyWt)).toBe(true);
      // T9051 must be gone.
      expect(existsSync(cleanWt)).toBe(false);

      // Quarantine archive must exist.
      const quarantineDir = join(worktreesRoot, '..', 'quarantine', 'worktrees');
      expect(existsSync(quarantineDir)).toBe(true);
      const archives = readdirSync(quarantineDir).filter(
        (f) => f.startsWith('T9050') && f.endsWith('.tar.gz'),
      );
      expect(archives).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('quarantine archive captures untracked AND ignored files (.env)', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('abc456');
    try {
      const wt = join(projectDir, 'T9055');
      initGitRepo(wt);
      // Make dirty and add .env.
      writeFileSync(join(wt, '.env'), 'SECRET=topsecret\n');
      writeFileSync(join(wt, 'notes.txt'), 'local notes\n');

      pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc456',
        activeTaskIds: new Set(['PRESERVED']),
      });

      const quarantineDir = join(worktreesRoot, '..', 'quarantine', 'worktrees');
      const archives = readdirSync(quarantineDir).filter(
        (f) => f.startsWith('T9055') && f.endsWith('.tar.gz'),
      );
      expect(archives).toHaveLength(1);

      const archivePath = join(quarantineDir, archives[0]!);
      const tarList = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' });
      // Both files must be captured.
      expect(tarList).toContain('.env');
      expect(tarList).toContain('notes.txt');
    } finally {
      cleanup();
    }
  });

  it('a symlink cycle is archived as a link, not ELOOP + a partial archive (T12604)', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('abc789');
    try {
      const wt = join(projectDir, 'T9056');
      initGitRepo(wt);
      writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');
      mkdirSync(join(wt, 'nested'));
      symlinkSync('..', join(wt, 'nested', 'loop'));

      const result = pruneOrphanWorktrees({
        worktreesRoot,
        projectHash: 'abc789',
        activeTaskIds: new Set(['PRESERVED']),
      });

      expect(result.errors).toEqual([]);
      const quarantineDir = join(worktreesRoot, '..', 'quarantine', 'worktrees');
      const archives = readdirSync(quarantineDir).filter((f) => f.startsWith('T9056'));
      expect(archives).toHaveLength(1);
      const tarList = execFileSync('tar', ['-tzf', join(quarantineDir, archives[0]!)], {
        encoding: 'utf-8',
      });
      expect(tarList).toContain('dirty.txt');
      expect(tarList).toContain('nested/loop');
    } finally {
      cleanup();
    }
  });

  it('an archive that overruns the 120s bound fails closed with no partial archive (T12604)', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('abcdef');
    try {
      const wt = join(projectDir, 'T9057');
      initGitRepo(wt);
      writeFileSync(join(wt, 'dirty.txt'), 'uncommitted\n');

      // Every clock read advances 61s, so the walk crosses the deadline on
      // its second entry — the path a huge or hung filesystem would take.
      let now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
        now += 61_000;
        return now;
      });
      let result: ReturnType<typeof pruneOrphanWorktrees>;
      try {
        result = pruneOrphanWorktrees({
          worktreesRoot,
          projectHash: 'abcdef',
          activeTaskIds: new Set(['PRESERVED']),
        });
      } finally {
        clock.mockRestore();
      }

      expect(result.errors.map((e) => e.reason)).toEqual([
        'quarantine tar failed — worktree preserved (T11996)',
      ]);
      expect(existsSync(wt)).toBe(true);
      const quarantineDir = join(worktreesRoot, '..', 'quarantine', 'worktrees');
      const leftovers = existsSync(quarantineDir)
        ? readdirSync(quarantineDir).filter((f) => f.endsWith('.tar.gz'))
        : [];
      expect(leftovers).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Fail-closed guard
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees (gc/cleanup) — T11996 fail-closed', () => {
  it('empty activeTaskIds with existing worktrees returns skippedFailClosed', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('def456');
    try {
      mkdirSync(join(projectDir, 'T9060'), { recursive: true });
      mkdirSync(join(projectDir, 'T9061'), { recursive: true });

      const result = pruneOrphanWorktrees({
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

  it('empty activeTaskIds with empty project dir does NOT trigger fail-closed', () => {
    const { worktreesRoot, cleanup } = makeLayout('empty-hash');
    try {
      const result = pruneOrphanWorktrees({
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
  it('second run against converged state performs zero actions', () => {
    const { worktreesRoot, projectDir, cleanup } = makeLayout('ghi789');
    try {
      // Clean plain-dir orphan.
      const cleanWt = join(projectDir, 'T9070');
      mkdirSync(cleanWt, { recursive: true });
      writeFileSync(join(cleanWt, 'data.txt'), 'content\n');

      const opts = {
        worktreesRoot,
        projectHash: 'ghi789',
        activeTaskIds: new Set(['PRESERVED']),
      };

      const first = pruneOrphanWorktrees(opts);
      expect(first.removed).toBe(1);
      expect(existsSync(cleanWt)).toBe(false);

      // Second run — nothing left to do.
      const second = pruneOrphanWorktrees(opts);
      expect(second.removed).toBe(0);
      expect(second.quarantined).toBe(0);
      expect(second.errors).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
