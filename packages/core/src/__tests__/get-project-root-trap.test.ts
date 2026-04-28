/**
 * Unit tests for the T1463/P1-7 getProjectRoot "parent .cleo/ trap" fix.
 *
 * Validates that `getProjectRoot` rejects any `.cleo/` directory that lacks
 * the required sibling markers (`.git/` or `package.json`). Without this
 * guard a stray parent `.cleo/` dir — e.g. `~/.cleo/` left over from a buggy
 * prior run — would be silently accepted, causing CLEO to operate on the
 * wrong project and potentially corrupt data.
 *
 * @task T1463
 * @epic T1461
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getProjectRoot, validateProjectRoot } from '../paths.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a unique temp base under /var/tmp so ancestors (/var, /) have no
 * .cleo/ or .git/ sentinels on any standard Linux/macOS system.
 */
function makeTempBase(label: string): string {
  const dir = join(
    '/var/tmp',
    `cleo-trap-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Snapshot and restore CLEO env vars around a test. */
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
        if (val !== undefined) {
          process.env[key] = val;
        } else {
          delete process.env[key];
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('validateProjectRoot', () => {
  let tempBase: string;

  afterEach(() => {
    if (tempBase) {
      try {
        rmSync(tempBase, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  });

  it('returns true when .git/ sibling exists', () => {
    tempBase = makeTempBase('vpr-git');
    mkdirSync(join(tempBase, '.cleo'), { recursive: true });
    mkdirSync(join(tempBase, '.git'), { recursive: true });

    expect(validateProjectRoot(tempBase)).toBe(true);
  });

  it('returns true when package.json sibling exists', () => {
    tempBase = makeTempBase('vpr-pkgjson');
    mkdirSync(join(tempBase, '.cleo'), { recursive: true });
    writeFileSync(join(tempBase, 'package.json'), '{"name":"test"}');

    expect(validateProjectRoot(tempBase)).toBe(true);
  });

  it('returns true when both .git/ and package.json exist', () => {
    tempBase = makeTempBase('vpr-both');
    mkdirSync(join(tempBase, '.cleo'), { recursive: true });
    mkdirSync(join(tempBase, '.git'), { recursive: true });
    writeFileSync(join(tempBase, 'package.json'), '{"name":"test"}');

    expect(validateProjectRoot(tempBase)).toBe(true);
  });

  it('returns false when .cleo/ exists but neither .git/ nor package.json is present', () => {
    tempBase = makeTempBase('vpr-none');
    mkdirSync(join(tempBase, '.cleo'), { recursive: true });

    expect(validateProjectRoot(tempBase)).toBe(false);
  });

  it('returns false for an empty directory with no markers', () => {
    tempBase = makeTempBase('vpr-empty');

    expect(validateProjectRoot(tempBase)).toBe(false);
  });
});

describe('getProjectRoot — P1-7 parent .cleo/ trap guard', () => {
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
  // TC-1: Stray parent .cleo/ without sibling — must be rejected
  // -------------------------------------------------------------------------
  describe('TC-1: stray parent .cleo/ without sibling markers is rejected', () => {
    it('throws E_INVALID_PROJECT_ROOT when the only .cleo/ has no sibling', () => {
      tempBase = makeTempBase('tc1');
      // Fixture: temp/stray/.cleo/  (no .git/, no package.json)
      //          temp/stray/project/src/   <- cwd
      const strayRoot = join(tempBase, 'stray');
      mkdirSync(join(strayRoot, '.cleo'), { recursive: true });
      const cwd = join(strayRoot, 'project', 'src');
      mkdirSync(cwd, { recursive: true });

      expect(() => getProjectRoot(cwd)).toThrow(/E_INVALID_PROJECT_ROOT/);
    });

    it('error message includes the starting directory', () => {
      tempBase = makeTempBase('tc1-msg');
      const strayRoot = join(tempBase, 'stray');
      mkdirSync(join(strayRoot, '.cleo'), { recursive: true });
      const cwd = join(strayRoot, 'project', 'src');
      mkdirSync(cwd, { recursive: true });

      let caught: Error | undefined;
      try {
        getProjectRoot(cwd);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught?.message).toContain(cwd);
    });

    it('error message identifies the skipped stray .cleo/ directory', () => {
      tempBase = makeTempBase('tc1-skip');
      const strayRoot = join(tempBase, 'stray');
      mkdirSync(join(strayRoot, '.cleo'), { recursive: true });
      const cwd = join(strayRoot, 'project', 'src');
      mkdirSync(cwd, { recursive: true });

      let caught: Error | undefined;
      try {
        getProjectRoot(cwd);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught?.message).toContain('skipped:');
      expect(caught?.message).toContain(strayRoot);
    });
  });

  // -------------------------------------------------------------------------
  // TC-2: Valid .cleo/ with .git/ sibling — must be accepted
  // -------------------------------------------------------------------------
  describe('TC-2: valid .cleo/ with .git/ sibling is accepted', () => {
    it('returns the project root when .git/ is present alongside .cleo/', () => {
      tempBase = makeTempBase('tc2-git');
      // Fixture: temp/project/.cleo/ + .git/
      //          temp/project/src/    <- cwd
      const project = join(tempBase, 'project');
      mkdirSync(join(project, '.cleo'), { recursive: true });
      mkdirSync(join(project, '.git'), { recursive: true });
      const cwd = join(project, 'src');
      mkdirSync(cwd, { recursive: true });

      expect(getProjectRoot(cwd)).toBe(project);
    });
  });

  // -------------------------------------------------------------------------
  // TC-3: Valid .cleo/ with package.json sibling — must be accepted
  // -------------------------------------------------------------------------
  describe('TC-3: valid .cleo/ with package.json sibling is accepted', () => {
    it('returns the project root when package.json is present alongside .cleo/', () => {
      tempBase = makeTempBase('tc3-pkg');
      const project = join(tempBase, 'project');
      mkdirSync(join(project, '.cleo'), { recursive: true });
      writeFileSync(join(project, 'package.json'), '{"name":"test"}');
      const cwd = join(project, 'src');
      mkdirSync(cwd, { recursive: true });

      expect(getProjectRoot(cwd)).toBe(project);
    });
  });

  // -------------------------------------------------------------------------
  // TC-4: Inner valid root takes precedence over outer stray .cleo/
  // -------------------------------------------------------------------------
  describe('TC-4: inner valid project root preferred over outer stray .cleo/', () => {
    it('returns the inner root (with .git/) and ignores the stray outer .cleo/', () => {
      tempBase = makeTempBase('tc4-inner');
      // Fixture:
      //   temp/outer/.cleo/   (no .git/, no package.json — stray)
      //   temp/outer/inner/.cleo/ + .git/  (valid project)
      //   temp/outer/inner/src/  <- cwd
      const outer = join(tempBase, 'outer');
      const inner = join(outer, 'inner');
      mkdirSync(join(outer, '.cleo'), { recursive: true });
      mkdirSync(join(inner, '.cleo'), { recursive: true });
      mkdirSync(join(inner, '.git'), { recursive: true });
      const cwd = join(inner, 'src');
      mkdirSync(cwd, { recursive: true });

      expect(getProjectRoot(cwd)).toBe(inner);
    });

    it('does NOT return the outer stray root when inner valid root exists', () => {
      tempBase = makeTempBase('tc4-anti');
      const outer = join(tempBase, 'outer');
      const inner = join(outer, 'inner');
      mkdirSync(join(outer, '.cleo'), { recursive: true });
      mkdirSync(join(inner, '.cleo'), { recursive: true });
      mkdirSync(join(inner, '.git'), { recursive: true });
      const cwd = join(inner, 'src');
      mkdirSync(cwd, { recursive: true });

      const result = getProjectRoot(cwd);
      expect(result).not.toBe(outer);
    });
  });

  // -------------------------------------------------------------------------
  // TC-5: Multiple stray .cleo/ dirs — all must be rejected with one error
  // -------------------------------------------------------------------------
  describe('TC-5: multiple stray .cleo/ dirs are all rejected', () => {
    it('throws E_INVALID_PROJECT_ROOT listing all skipped dirs', () => {
      tempBase = makeTempBase('tc5-multi');
      // Fixture: two levels of stray .cleo/ without sibling markers
      const l1 = join(tempBase, 'l1');
      const l2 = join(l1, 'l2');
      mkdirSync(join(l1, '.cleo'), { recursive: true });
      mkdirSync(join(l2, '.cleo'), { recursive: true });
      const cwd = join(l2, 'work');
      mkdirSync(cwd, { recursive: true });

      let caught: Error | undefined;
      try {
        getProjectRoot(cwd);
      } catch (err) {
        caught = err as Error;
      }

      expect(caught?.message).toMatch(/E_INVALID_PROJECT_ROOT/);
      // Both stray dirs should appear in the error message
      expect(caught?.message).toContain(l1);
      expect(caught?.message).toContain(l2);
    });
  });

  // -------------------------------------------------------------------------
  // TC-6: CLEO_ROOT env var bypasses trap validation (escape hatch)
  // -------------------------------------------------------------------------
  describe('TC-6: CLEO_ROOT env var bypasses trap validation', () => {
    it('returns CLEO_ROOT even when the directory has no sibling markers', () => {
      tempBase = makeTempBase('tc6-env');
      // CLEO_ROOT explicitly set — bypass is intentional, no validation
      process.env['CLEO_ROOT'] = tempBase;

      const cwd = join(tempBase, 'sub');
      mkdirSync(cwd, { recursive: true });

      expect(getProjectRoot(cwd)).toBe(tempBase);
    });
  });
});
