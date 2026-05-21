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

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
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

  describe('AC-2 (regression): refuses to bind a non-existent .cleo/', () => {
    it('THROWS when called from a directory with no project ancestor (no bootstrap)', () => {
      tempBase = makeIsolatedTempBase('throw');
      expect(() => getCleoDirAbsolute(tempBase)).toThrowError();
    });

    it('does NOT create an orphan .cleo/ inside the cwd on failure', () => {
      tempBase = makeIsolatedTempBase('no-orphan');
      expect(() => getCleoDirAbsolute(tempBase)).toThrowError();
      // Crucial regression: the path must not be materialised by the chokepoint.
      // Pre-fix, the function returned `<tempBase>/.cleo` even though it failed;
      // any subsequent mkdirSync would synthesise the orphan. Post-fix, the
      // function throws first, so no caller ever sees the synthesised path.
      const entries = readdirSync(tempBase);
      expect(entries).not.toContain('.cleo');
    });

    it('preserves the original error message for diagnosis', () => {
      tempBase = makeIsolatedTempBase('err-msg');
      try {
        getCleoDirAbsolute(tempBase);
        throw new Error('expected throw');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toBe('expected throw');
        // The error must surface getProjectRoot's diagnostics — either
        // E_NOT_INITIALIZED (git-only) or E_NO_PROJECT (no sentinels). Both
        // are acceptable; what matters is that the silent-fallback path is
        // closed.
        expect(msg.length).toBeGreaterThan(0);
      }
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
      // Simulate `.claude/worktrees/agent-XYZ/` (worktree without project
      // metadata). A real git worktree has a `.git` gitlink file; the
      // chokepoint should still refuse to bind unless cwd resolves to a
      // legitimate project root.
      const lvl1 = join(tempBase, 'wt1');
      const lvl2 = join(lvl1, 'wt2');
      const lvl3 = join(lvl2, 'wt3');
      mkdirSync(lvl3, { recursive: true });

      for (const cwd of [lvl1, lvl2, lvl3]) {
        expect(() => getCleoDirAbsolute(cwd)).toThrowError();
        // The crucial post-condition: NO orphan synthesis at any level.
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
