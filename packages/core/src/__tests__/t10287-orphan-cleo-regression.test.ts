/**
 * Regression tests for T10287 — orphan `.cleo/` created inside non-CLEO git repos.
 *
 * Prior to T10287, `getCleoDirAbsolute` would silently return `<cwd>/.cleo`
 * when called from a git repo that was not a CLEO project (`.git` directory
 * but no `.cleo/` + sibling `.git/` or `project-info.json`). The fallback
 * guard `_cwdHasWorktreeGitlinkAncestor` only checked for gitlink FILE `.git`
 * markers (worktrees), missing legitimate git DIRECTORIES.
 *
 * @task T10287
 * @epic T10297
 * @saga T10295
 */
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoDirAbsolute } from '../paths.js';

function useCleanEnv(): { restore: () => void } {
  const saved: Record<string, string | undefined> = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const [key, val] of Object.entries(saved)) {
        if (val !== undefined) process.env[key] = val;
        else delete process.env[key];
      }
    },
  };
}

describe('getCleoDirAbsolute T10287 regression — orphan .cleo/ in non-CLEO git repos', () => {
  let tempBase: string;
  let envGuard: { restore: () => void };

  beforeEach(() => {
    envGuard = useCleanEnv();
    tempBase = join(
      tmpdir(),
      `cleo-t10287-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tempBase, { recursive: true });
  });

  afterEach(() => {
    envGuard.restore();
    try { rmSync(tempBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('throws for a non-CLEO git repo with real .git/ directory', () => {
    // Simulate /mnt/projects/awesome-skills — a git repo with .git/ dir but no .cleo/
    mkdirSync(join(tempBase, '.git'), { recursive: true });
    expect(() => getCleoDirAbsolute(tempBase)).toThrow();
  });

  it('throws for a git worktree with .git as a gitlink file', () => {
    // Simulate a git worktree: .git is a FILE pointing to main repo
    const { writeFileSync } = require('node:fs');
    writeFileSync(join(tempBase, '.git'), 'gitdir: /real/repo/.git/worktrees/test\n');
    expect(() => getCleoDirAbsolute(tempBase)).toThrow();
  });

  it('allows fallback for a clean directory with no .git anywhere', () => {
    // Test fixture / pre-init scaffold — no .git at all
    expect(getCleoDirAbsolute(tempBase)).toBe(join(tempBase, '.cleo'));
  });

  it('allows fallback with { bootstrap: true } even inside a git repo', () => {
    mkdirSync(join(tempBase, '.git'), { recursive: true });
    const result = getCleoDirAbsolute(tempBase, { bootstrap: true });
    expect(result).toBe(join(tempBase, '.cleo'));
  });

  it('throws when any ancestor has .git (not just the immediate parent)', () => {
    // Simulate running from a subdirectory of a non-CLEO git repo
    const subdir = join(tempBase, 'deeply', 'nested', 'dir');
    mkdirSync(subdir, { recursive: true });
    mkdirSync(join(tempBase, '.git'), { recursive: true });
    expect(() => getCleoDirAbsolute(subdir)).toThrow();
  });
});
