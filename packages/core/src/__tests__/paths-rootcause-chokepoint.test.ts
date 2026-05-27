/**
 * Regression suite for T9803 / council verdict D009.
 *
 * Pre-fix behaviour: `getCleoDirAbsolute(cwd)` silently fell back to
 * `<cwd>/.cleo` whenever `getProjectRoot(cwd)` threw. Any caller that then
 * `mkdirSync`'d the returned path materialised an orphan `.cleo/` inside the
 * worktree — the root cause of the 25+ leaked `.cleo/` directories under
 * `.claude/worktrees/*` documented in the T9801 forensic audit.
 *
 * Post-fix contract: the chokepoint re-throws unless the caller passes
 * `{ bootstrap: true }` (only `initProject()` legitimately needs this).
 *
 * @task T9803
 * @saga T9800
 * @decision D009
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCleoDirAbsolute } from '../paths.js';

function makeIsolatedTempBase(label: string): string {
  // `/var/tmp` has no `.cleo/` or `.git/` sentinels in any ancestor on a
  // typical dev machine, so the walk-up reliably reaches the filesystem
  // root and throws E_NO_PROJECT — the exact scenario the chokepoint must
  // refuse to swallow.
  const dir = join(
    '/var/tmp',
    `cleo-rootcause-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanEnv(): { restore: () => void } {
  const saved = {
    CLEO_ROOT: process.env['CLEO_ROOT'],
    CLEO_PROJECT_ROOT: process.env['CLEO_PROJECT_ROOT'],
    CLEO_DIR: process.env['CLEO_DIR'],
  };
  delete process.env['CLEO_ROOT'];
  delete process.env['CLEO_PROJECT_ROOT'];
  delete process.env['CLEO_DIR'];
  return {
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    },
  };
}

describe('getCleoDirAbsolute — root-cause chokepoint (T9803 / D009)', () => {
  let tempBase: string;
  let restore: () => void;

  beforeEach(() => {
    ({ restore } = cleanEnv());
  });

  afterEach(() => {
    restore();
    if (tempBase) {
      try {
        rmSync(tempBase, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  describe('AC-2 (regression): refuses fallback ONLY when inside a worktree', () => {
    it('THROWS when called from a directory with a worktree gitlink (.git as FILE)', () => {
      tempBase = makeIsolatedTempBase('throw-worktree');
      // Write `.git` as a FILE (gitlink) — simulates a `git worktree add` checkout.
      writeFileSync(join(tempBase, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/foo\n');
      expect(() => getCleoDirAbsolute(tempBase)).toThrowError();
    });

    it('does NOT create an orphan .cleo/ when inside a worktree on throw', () => {
      tempBase = makeIsolatedTempBase('no-orphan');
      writeFileSync(join(tempBase, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/bar\n');
      expect(() => getCleoDirAbsolute(tempBase)).toThrowError();
      const entries = readdirSync(tempBase);
      expect(entries).not.toContain('.cleo');
    });

    it('ALLOWS fallback when no .git ancestor exists (clean test fixture)', () => {
      tempBase = makeIsolatedTempBase('clean-slate');
      // No .git anywhere up the ancestor chain — this is a clean-slate
      // scaffold (typical test fixture). Pre-T9803 silent fallback is
      // PRESERVED here because no worktree contamination is possible.
      const result = getCleoDirAbsolute(tempBase);
      expect(result).toBe(join(tempBase, '.cleo'));
    });
  });

  describe('AC bootstrap: explicit opt-in restores legacy fallback', () => {
    it('returns <cwd>/.cleo when called with { bootstrap: true }', () => {
      tempBase = makeIsolatedTempBase('bootstrap');
      const result = getCleoDirAbsolute(tempBase, { bootstrap: true });
      expect(result).toBe(join(tempBase, '.cleo'));
    });

    it('does NOT auto-create the directory on bootstrap-mode read', () => {
      tempBase = makeIsolatedTempBase('bootstrap-no-create');
      const result = getCleoDirAbsolute(tempBase, { bootstrap: true });
      // The chokepoint only RESOLVES a path; materialisation is the caller's
      // responsibility (cleo init does `mkdirSync` explicitly). Verify that
      // simply asking for the path does not create the directory.
      expect(existsSync(result)).toBe(false);
    });

    it('falls back to process.cwd() when cwd is omitted under bootstrap', () => {
      // We do not assert the exact path (process.cwd() could be anything in
      // the test runner), but the function must not throw and must return
      // a string ending in `.cleo`.
      const result = getCleoDirAbsolute(undefined, { bootstrap: true });
      expect(typeof result).toBe('string');
      expect(result.endsWith('.cleo') || result.endsWith('\\.cleo')).toBe(true);
    });
  });

  describe('AC-3 (three-worktree-deep): nested simulated worktrees stay clean', () => {
    it('does NOT create .cleo/ in any of 3 nested worktree-like dirs', () => {
      tempBase = makeIsolatedTempBase('nested-3');
      // Simulate `.claude/worktrees/agent-XYZ/` — the worktree gitlink is at
      // tempBase, and three subdirs are nested below it. From any of the
      // nested dirs, the walk-up MUST detect the gitlink ancestor and refuse
      // the silent fallback.
      writeFileSync(join(tempBase, '.git'), 'gitdir: /tmp/some-main/.git/worktrees/agent-XYZ\n');
      const lvl1 = join(tempBase, 'wt1');
      const lvl2 = join(lvl1, 'wt2');
      const lvl3 = join(lvl2, 'wt3');
      mkdirSync(lvl3, { recursive: true });

      for (const cwd of [lvl1, lvl2, lvl3]) {
        expect(() => getCleoDirAbsolute(cwd)).toThrowError();
        const entries = readdirSync(cwd);
        expect(entries).not.toContain('.cleo');
      }
    });
  });

  describe('AC SSoT: absolute CLEO_DIR bypass still wins', () => {
    it('returns CLEO_DIR verbatim when it is absolute (no walk, no throw)', () => {
      tempBase = makeIsolatedTempBase('cleo-dir-bypass');
      const pinned = join(tempBase, 'pinned-cleo-dir');
      process.env['CLEO_DIR'] = pinned;
      try {
        const result = getCleoDirAbsolute(tempBase);
        expect(result).toBe(pinned);
      } finally {
        delete process.env['CLEO_DIR'];
      }
    });
  });
});
