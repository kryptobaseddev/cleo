/**
 * Unit tests for the walk-up ancestor-scan algorithm in `getProjectRoot`.
 *
 * Covers all acceptance-criteria scenarios defined in T301:
 *   1. Nested subdir with parent .cleo/
 *   2. Nested in git-only repo (E_NOT_INITIALIZED)
 *   3. Orphan dir with no .cleo/ and no .git/ in any ancestor (E_NO_PROJECT)
 *   4. CLEO_ROOT env var override
 *   5. Ancestor boundary — must stop at first (inner) .cleo/, never drift to outer
 *   6. Integration-equivalent — deep nesting walks up to the .cleo/ root
 *
 * @task T301
 * @epic T299
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectRoot } from '../paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp base directory for each test inside Node.js tmpdir. */
function makeTempBase(label: string): string {
  const dir = join(
    tmpdir(),
    `cleo-walkup-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Create a unique temp base inside /var/tmp, which has no CLEO or git
 * sentinels in any of its ancestors (/var, /).
 *
 * Used for the E_NO_PROJECT orphan scenario where Node.js tmpdir() ancestors
 * may contain .cleo/ on a development machine.
 */
function makeTempBaseIsolated(label: string): string {
  const dir = join(
    '/var/tmp',
    `cleo-walkup-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Snapshot and restore CLEO_ROOT around a test run. */
function useCleanEnv(): { restore: () => void } {
  const savedRoot = process.env['CLEO_ROOT'];
  delete process.env['CLEO_ROOT'];
  return {
    restore() {
      if (savedRoot !== undefined) {
        process.env['CLEO_ROOT'] = savedRoot;
      } else {
        delete process.env['CLEO_ROOT'];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('getProjectRoot — walk-up algorithm', () => {
  let tempBase: string;
  let restoreEnv: () => void;

  beforeEach(() => {
    const env = useCleanEnv();
    restoreEnv = env.restore;
  });

  afterEach(() => {
    restoreEnv();
    if (tempBase) {
      try {
        rmSync(tempBase, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  // -------------------------------------------------------------------------
  // AC-1: Nested subdir with parent .cleo/
  // -------------------------------------------------------------------------
  describe('AC-1: nested subdir resolves to parent containing .cleo/', () => {
    it('returns the project root when called from a nested subdirectory', () => {
      tempBase = makeTempBase('ac1');
      // Fixture: tmp/project/.cleo/  +  tmp/project/src/nested/
      const projectRoot = join(tempBase, 'project');
      mkdirSync(join(projectRoot, '.cleo'), { recursive: true });
      const nestedDir = join(projectRoot, 'src', 'nested');
      mkdirSync(nestedDir, { recursive: true });

      const result = getProjectRoot(nestedDir);
      expect(result).toBe(projectRoot);
    });

    it('returns the root itself when called directly with the project root', () => {
      tempBase = makeTempBase('ac1-direct');
      const projectRoot = join(tempBase, 'project');
      mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

      const result = getProjectRoot(projectRoot);
      expect(result).toBe(projectRoot);
    });
  });

  // -------------------------------------------------------------------------
  // AC-2: Nested in git-only repo — E_NOT_INITIALIZED
  // -------------------------------------------------------------------------
  describe('AC-2: git-only repo without .cleo/ throws E_NOT_INITIALIZED', () => {
    it('throws when .git/ exists but .cleo/ does not', () => {
      tempBase = makeTempBase('ac2');
      // Fixture: tmp/repo/.git/  +  tmp/repo/src/
      const repoRoot = join(tempBase, 'repo');
      mkdirSync(join(repoRoot, '.git'), { recursive: true });
      const srcDir = join(repoRoot, 'src');
      mkdirSync(srcDir, { recursive: true });

      expect(() => getProjectRoot(srcDir)).toThrow(/Run cleo init at/);
    });

    it('error message contains the git root path', () => {
      tempBase = makeTempBase('ac2-path');
      const repoRoot = join(tempBase, 'repo');
      mkdirSync(join(repoRoot, '.git'), { recursive: true });
      const srcDir = join(repoRoot, 'src');
      mkdirSync(srcDir, { recursive: true });

      let caught: Error | undefined;
      try {
        getProjectRoot(srcDir);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught?.message).toContain(repoRoot);
    });
  });

  // -------------------------------------------------------------------------
  // AC-3: Orphan dir — E_NO_PROJECT
  // -------------------------------------------------------------------------
  describe('AC-3: orphan dir with no .cleo/ and no .git/ throws E_NO_PROJECT', () => {
    it('throws when neither sentinel is found in any ancestor', () => {
      // Use /var/tmp for isolation: /var and /var/tmp have no .cleo/ or .git/,
      // and the filesystem root / also has none. All ancestors between
      // our test dir and the filesystem root are guaranteed clean on any
      // standard Linux system.
      //
      // We cannot use Node.js tmpdir() here because on development machines
      // the user home directory (or the tmpdir itself) may already contain
      // a .cleo/ dir, which would be found by the walk-up and suppress the error.
      const orphanBase = makeTempBaseIsolated('ac3');
      const orphanDir = join(orphanBase, 'nested', 'path');
      mkdirSync(orphanDir, { recursive: true });

      try {
        expect(() => getProjectRoot(orphanDir)).toThrow(/Not inside a CLEO project/);
      } finally {
        try {
          rmSync(orphanBase, { recursive: true, force: true });
        } catch {
          /* ignore cleanup errors */
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // AC-4: CLEO_ROOT env var override
  // -------------------------------------------------------------------------
  describe('AC-4: CLEO_ROOT env var bypasses walk entirely', () => {
    it('returns CLEO_ROOT regardless of cwd when cwd has no sentinel', () => {
      // AC-4 also demonstrates that CLEO_ROOT prevents E_NO_PROJECT from throwing
      // even for a path that would otherwise be an orphan.
      const orphanBase = makeTempBaseIsolated('ac4');
      const orphanDir = join(orphanBase, 'nested');
      mkdirSync(orphanDir, { recursive: true });

      process.env['CLEO_ROOT'] = '/overridden/root';
      try {
        expect(getProjectRoot(orphanDir)).toBe('/overridden/root');
      } finally {
        try {
          rmSync(orphanBase, { recursive: true, force: true });
        } catch {
          /* ignore cleanup errors */
        }
      }
    });

    it('returns CLEO_ROOT when called with no arguments', () => {
      process.env['CLEO_ROOT'] = '/another/override';
      expect(getProjectRoot()).toBe('/another/override');
    });

    it('returns CLEO_ROOT even when cwd has .cleo/ present', () => {
      tempBase = makeTempBase('ac4-override');
      mkdirSync(join(tempBase, '.cleo'), { recursive: true });

      process.env['CLEO_ROOT'] = '/forced/root';
      // CLEO_ROOT should win even when a valid project exists at tempBase
      expect(getProjectRoot(tempBase)).toBe('/forced/root');
    });
  });

  // -------------------------------------------------------------------------
  // AC-5: Ancestor boundary — CRITICAL anti-drift gate
  // -------------------------------------------------------------------------
  describe('AC-5: ancestor boundary stops at inner .cleo/, never drifts to outer', () => {
    it('returns the inner project root, not the outer one', () => {
      tempBase = makeTempBase('ac5');
      // Fixture:
      //   tmp/outer/.cleo/           <- outer project
      //   tmp/outer/inner/.cleo/     <- inner project
      //   tmp/outer/inner/src/       <- cwd
      // Expected: returns tmp/outer/inner (first hit walking up from src)
      const outerRoot = join(tempBase, 'outer');
      const innerRoot = join(outerRoot, 'inner');
      const srcDir = join(innerRoot, 'src');

      mkdirSync(join(outerRoot, '.cleo'), { recursive: true });
      mkdirSync(join(innerRoot, '.cleo'), { recursive: true });
      mkdirSync(srcDir, { recursive: true });

      const result = getProjectRoot(srcDir);
      expect(result).toBe(innerRoot);
    });

    it('does NOT return the outer project root when an inner .cleo/ exists', () => {
      tempBase = makeTempBase('ac5-anti');
      const outerRoot = join(tempBase, 'outer');
      const innerRoot = join(outerRoot, 'inner');
      const srcDir = join(innerRoot, 'src');

      mkdirSync(join(outerRoot, '.cleo'), { recursive: true });
      mkdirSync(join(innerRoot, '.cleo'), { recursive: true });
      mkdirSync(srcDir, { recursive: true });

      const result = getProjectRoot(srcDir);
      expect(result).not.toBe(outerRoot);
    });

    it('three-level nesting: always returns the innermost project', () => {
      tempBase = makeTempBase('ac5-3level');
      const level1 = join(tempBase, 'l1');
      const level2 = join(level1, 'l2');
      const level3 = join(level2, 'l3');
      const deepDir = join(level3, 'deep', 'path');

      mkdirSync(join(level1, '.cleo'), { recursive: true });
      mkdirSync(join(level2, '.cleo'), { recursive: true });
      mkdirSync(join(level3, '.cleo'), { recursive: true });
      mkdirSync(deepDir, { recursive: true });

      const result = getProjectRoot(deepDir);
      expect(result).toBe(level3);
    });
  });

  // -------------------------------------------------------------------------
  // AC-6: Integration-equivalent — deep nesting walks up to .cleo/ root
  // -------------------------------------------------------------------------
  describe('AC-6: integration-equivalent deep nesting', () => {
    it('resolves correctly from several levels deep inside a project', () => {
      tempBase = makeTempBase('ac6');
      // Simulate: monorepo-root/.cleo/  +  monorepo-root/packages/lafs/src/lib/
      const monoRoot = join(tempBase, 'monorepo');
      const lafsDir = join(monoRoot, 'packages', 'lafs', 'src', 'lib');

      mkdirSync(join(monoRoot, '.cleo'), { recursive: true });
      mkdirSync(lafsDir, { recursive: true });

      const result = getProjectRoot(lafsDir);
      expect(result).toBe(monoRoot);
    });

    it('stops at the nearest .cleo/ when intermediate package has its own', () => {
      tempBase = makeTempBase('ac6-nested-pkg');
      // Simulate: monorepo-root/.cleo/  +  monorepo-root/packages/core/.cleo/
      //           calling from monorepo-root/packages/core/src/
      const monoRoot = join(tempBase, 'monorepo');
      const coreRoot = join(monoRoot, 'packages', 'core');
      const coreSrc = join(coreRoot, 'src');

      mkdirSync(join(monoRoot, '.cleo'), { recursive: true });
      mkdirSync(join(coreRoot, '.cleo'), { recursive: true });
      mkdirSync(coreSrc, { recursive: true });

      const result = getProjectRoot(coreSrc);
      expect(result).toBe(coreRoot);
    });
  });
});
