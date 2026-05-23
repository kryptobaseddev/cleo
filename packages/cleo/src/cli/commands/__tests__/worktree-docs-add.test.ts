/**
 * Regression test for T10389 — worktree-aware routing in `cleo docs add` +
 * `cleo changeset add`.
 *
 * Exercises the three central helpers (`resolveWorktreeRouting`,
 * `resolveWorktreeFilePath`, `detectStrayCleoDb`) against a real on-disk
 * fixture that mimics the failure surface T10353 + T10354 + T10294 workers
 * hit: a temp "canonical project root" with `.cleo/` + `.git/` (directory),
 * and a sibling "worktree" with `.git` as a FILE (gitlink) pointing back
 * to the canonical root.
 *
 * The test fixture matches the runtime contract — when `cwd` resolves to a
 * worktree, the canonical root walks back through the gitlink, relative
 * file paths resolve against the worktree's cwd, and stray `.cleo/tasks.db`
 * inside the worktree is detected up front.
 *
 * @task T10389
 * @epic T10289 (E1-DOCS-SLUG-NAMESPACE)
 * @saga T10288 (SG-DOCS-INTEGRITY)
 * @closes T10365
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectStrayCleoDb, resolveWorktreeFilePath, resolveWorktreeRouting } from '@cleocode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Fixture {
  readonly mainRepo: string;
  readonly worktreeDir: string;
  readonly subDir: string;
}

let fixture: Fixture;

function buildFixture(): Fixture {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const mainRepo = join(tmpdir(), `cleo-T10389-main-${stamp}`);
  const worktreeDir = join(tmpdir(), `cleo-T10389-wt-${stamp}`);

  // Canonical project root: has `.cleo/` and `.git/` (directory).
  mkdirSync(mainRepo, { recursive: true });
  mkdirSync(join(mainRepo, '.cleo'), { recursive: true });
  mkdirSync(join(mainRepo, '.git'), { recursive: true });
  // `getProjectRoot` validates the sentinel by checking for sibling
  // `.git` OR `package.json`. The `.git` directory above satisfies that.

  // Worktree directory: `.git` is a FILE (gitlink) pointing to
  // `<mainRepo>/.git/worktrees/<name>` — the standard git format.
  mkdirSync(worktreeDir, { recursive: true });
  const gitDirPointer = join(mainRepo, '.git', 'worktrees', 'tworkbench');
  mkdirSync(gitDirPointer, { recursive: true });
  writeFileSync(join(worktreeDir, '.git'), `gitdir: ${gitDirPointer}\n`, 'utf-8');

  // Subdirectory inside the worktree, used to assert relative-path
  // resolution lands inside the worktree (not the main repo).
  const subDir = join(worktreeDir, 'docs');
  mkdirSync(subDir, { recursive: true });
  writeFileSync(join(subDir, 'note.md'), '# example\n', 'utf-8');

  return { mainRepo, worktreeDir, subDir };
}

describe('T10389 — worktree-aware routing helpers', () => {
  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    rmSync(fixture.mainRepo, { recursive: true, force: true });
    rmSync(fixture.worktreeDir, { recursive: true, force: true });
  });

  describe('resolveWorktreeRouting', () => {
    it('detects worktree when cwd is inside a gitlinked worktree', () => {
      const routing = resolveWorktreeRouting(fixture.worktreeDir);

      expect(routing.cwd).toBe(fixture.worktreeDir);
      expect(routing.canonicalRoot).toBe(fixture.mainRepo);
      expect(routing.isWorktree).toBe(true);
      expect(routing.worktreePath).toBe(fixture.worktreeDir);
    });

    it('detects worktree when cwd is a subdirectory of a worktree', () => {
      const routing = resolveWorktreeRouting(fixture.subDir);

      expect(routing.cwd).toBe(fixture.subDir);
      expect(routing.canonicalRoot).toBe(fixture.mainRepo);
      expect(routing.isWorktree).toBe(true);
      expect(routing.worktreePath).toBe(fixture.worktreeDir);
    });

    it('reports non-worktree when cwd IS the canonical project root', () => {
      const routing = resolveWorktreeRouting(fixture.mainRepo);

      expect(routing.canonicalRoot).toBe(fixture.mainRepo);
      expect(routing.isWorktree).toBe(false);
      expect(routing.worktreePath).toBeUndefined();
    });
  });

  describe('resolveWorktreeFilePath', () => {
    it('resolves relative file path against the worktree cwd, NOT the canonical root', () => {
      const routing = resolveWorktreeRouting(fixture.worktreeDir);
      const resolved = resolveWorktreeFilePath('docs/note.md', routing);

      expect(resolved).toBe(join(fixture.worktreeDir, 'docs', 'note.md'));
      expect(resolved.startsWith(fixture.worktreeDir)).toBe(true);
      expect(resolved.startsWith(fixture.mainRepo)).toBe(false);
    });

    it('passes absolute paths through unchanged', () => {
      const routing = resolveWorktreeRouting(fixture.worktreeDir);
      const abs = '/absolute/path/file.md';
      const resolved = resolveWorktreeFilePath(abs, routing);

      expect(resolved).toBe(abs);
    });

    it('falls back to process.cwd() resolution when not in a worktree', () => {
      const routing = resolveWorktreeRouting(fixture.mainRepo);
      const resolved = resolveWorktreeFilePath('rel/path.md', routing);

      // Non-worktree branch returns `resolve(filePath)` which is
      // process.cwd()-anchored. The exact value depends on the test
      // runner's cwd, but it MUST be absolute.
      expect(resolved.startsWith('/')).toBe(true);
    });
  });

  describe('detectStrayCleoDb', () => {
    it('returns undefined when no stray .cleo/tasks.db exists', () => {
      const routing = resolveWorktreeRouting(fixture.worktreeDir);
      expect(detectStrayCleoDb(routing)).toBeUndefined();
    });

    it('returns the absolute path when a stray .cleo/tasks.db is present', () => {
      // Plant a leaked tasks.db inside the worktree.
      mkdirSync(join(fixture.worktreeDir, '.cleo'), { recursive: true });
      const strayPath = join(fixture.worktreeDir, '.cleo', 'tasks.db');
      writeFileSync(strayPath, 'fake-sqlite\n', 'utf-8');

      const routing = resolveWorktreeRouting(fixture.worktreeDir);
      expect(detectStrayCleoDb(routing)).toBe(strayPath);
    });

    it('returns undefined when .cleo/ exists but tasks.db does NOT', () => {
      // Intentional cache: `.cleo/cache/` is allowed; only `tasks.db`
      // is a hard signal of a leaked state directory.
      mkdirSync(join(fixture.worktreeDir, '.cleo', 'cache'), { recursive: true });
      const routing = resolveWorktreeRouting(fixture.worktreeDir);

      expect(detectStrayCleoDb(routing)).toBeUndefined();
    });

    it('returns undefined when not in a worktree (no false positives)', () => {
      // Plant a `.cleo/tasks.db` at the canonical root — this is the
      // legitimate file, not a stray.
      writeFileSync(join(fixture.mainRepo, '.cleo', 'tasks.db'), 'real-sqlite\n', 'utf-8');
      const routing = resolveWorktreeRouting(fixture.mainRepo);

      expect(routing.isWorktree).toBe(false);
      expect(detectStrayCleoDb(routing)).toBeUndefined();
    });
  });
});
