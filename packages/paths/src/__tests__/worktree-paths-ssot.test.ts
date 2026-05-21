/**
 * AC5 tests for T9802 / E-WT-PATHS-SSOT — XDG resolution, env-var isolation,
 * `resolveWorktreeIndexPath` sentinel path, and project hash determinism.
 *
 * @task T9802
 * @saga T9800 SG-WORKTREE-CANON
 * @decision D009
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetCleoPlatformPathsCache, getCleoHome } from '../cleo-paths.js';
import {
  computeProjectHash,
  getCleoWorktreesRoot,
  resolveTaskWorktreePath,
  resolveWorktreeIndexPath,
  resolveWorktreeRootForHash,
} from '../worktree-paths.js';

// ============================================================================
// Test fixtures
// ============================================================================

const FAKE_CLEO_HOME = '/test/cleo-home';
const PROJECT_ROOT_A = '/mnt/projects/cleocode';
const PROJECT_ROOT_B = '/mnt/projects/other-project';

// ============================================================================
// Helpers
// ============================================================================

/** Restore env and reset cache after mutation. */
function restoreEnv(key: string, original: string | undefined): void {
  if (original === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = original;
  }
}

// ============================================================================
// XDG resolution on default config
// ============================================================================

describe('XDG resolution — default config', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = FAKE_CLEO_HOME;
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    restoreEnv('CLEO_HOME', originalCleoHome);
    _resetCleoPlatformPathsCache();
  });

  it('getCleoHome() returns CLEO_HOME when set', () => {
    expect(getCleoHome()).toBe(FAKE_CLEO_HOME);
  });

  it('getCleoWorktreesRoot() returns <cleoHome>/worktrees', () => {
    expect(getCleoWorktreesRoot()).toBe(`${FAKE_CLEO_HOME}/worktrees`);
  });

  it('resolveWorktreeRootForHash() returns <cleoHome>/worktrees/<hash>', () => {
    const hash = 'a'.repeat(16);
    expect(resolveWorktreeRootForHash(hash)).toBe(`${FAKE_CLEO_HOME}/worktrees/${hash}`);
  });

  it('resolveTaskWorktreePath() returns <cleoHome>/worktrees/<hash>/<taskId>', () => {
    const hash = 'b'.repeat(16);
    expect(resolveTaskWorktreePath(hash, 'T9802')).toBe(
      `${FAKE_CLEO_HOME}/worktrees/${hash}/T9802`,
    );
  });
});

// ============================================================================
// CLEO_HOME override isolation
// ============================================================================

describe('CLEO_HOME env override isolation', () => {
  let originalCleoHome: string | undefined;

  beforeEach(() => {
    originalCleoHome = process.env['CLEO_HOME'];
    _resetCleoPlatformPathsCache();
  });

  afterEach(() => {
    restoreEnv('CLEO_HOME', originalCleoHome);
    _resetCleoPlatformPathsCache();
  });

  it('uses CLEO_HOME when set', () => {
    process.env['CLEO_HOME'] = '/custom/cleo';
    _resetCleoPlatformPathsCache();
    expect(getCleoHome()).toBe('/custom/cleo');
    expect(getCleoWorktreesRoot()).toBe('/custom/cleo/worktrees');
  });

  it('switches to new CLEO_HOME after cache reset', () => {
    process.env['CLEO_HOME'] = '/first/cleo';
    _resetCleoPlatformPathsCache();
    const first = getCleoHome();

    process.env['CLEO_HOME'] = '/second/cleo';
    _resetCleoPlatformPathsCache();
    const second = getCleoHome();

    expect(first).toBe('/first/cleo');
    expect(second).toBe('/second/cleo');
    expect(first).not.toBe(second);
  });

  it('resolveWorktreeRootForHash honours override arg regardless of CLEO_HOME', () => {
    process.env['CLEO_HOME'] = '/should-not-appear/cleo';
    _resetCleoPlatformPathsCache();
    const explicit = '/explicit/worktree-root';
    expect(resolveWorktreeRootForHash('hash1234hash5678', explicit)).toBe(explicit);
  });

  it('worktree paths do not bleed across CLEO_HOME changes (isolation)', () => {
    process.env['CLEO_HOME'] = '/env-a/cleo';
    _resetCleoPlatformPathsCache();
    const hash = computeProjectHash(PROJECT_ROOT_A);
    const pathA = resolveWorktreeRootForHash(hash);

    process.env['CLEO_HOME'] = '/env-b/cleo';
    _resetCleoPlatformPathsCache();
    const pathB = resolveWorktreeRootForHash(hash);

    expect(pathA).toContain('/env-a/cleo');
    expect(pathB).toContain('/env-b/cleo');
    expect(pathA).not.toBe(pathB);
  });
});

// ============================================================================
// resolveWorktreeIndexPath — D009 sentinel helper (AC2)
// ============================================================================

describe('resolveWorktreeIndexPath — D009 sentinel helper', () => {
  it('returns <projectRoot>/.cleo/worktrees.json', () => {
    expect(resolveWorktreeIndexPath(PROJECT_ROOT_A)).toBe(`${PROJECT_ROOT_A}/.cleo/worktrees.json`);
  });

  it('is independent of CLEO_HOME', () => {
    const original = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = '/totally-different/cleo';
    _resetCleoPlatformPathsCache();

    const result = resolveWorktreeIndexPath(PROJECT_ROOT_A);

    restoreEnv('CLEO_HOME', original);
    _resetCleoPlatformPathsCache();

    expect(result).toBe(`${PROJECT_ROOT_A}/.cleo/worktrees.json`);
    expect(result).not.toContain('totally-different');
  });

  it('uses the provided projectRoot verbatim', () => {
    expect(resolveWorktreeIndexPath('/a/b/c')).toBe('/a/b/c/.cleo/worktrees.json');
    expect(resolveWorktreeIndexPath('/x/y')).toBe('/x/y/.cleo/worktrees.json');
  });

  it('ends with .json (FILE not directory)', () => {
    const result = resolveWorktreeIndexPath(PROJECT_ROOT_A);
    expect(result.endsWith('.json')).toBe(true);
    expect(result.endsWith('/')).toBe(false);
  });

  it('differs for different projectRoots', () => {
    const a = resolveWorktreeIndexPath(PROJECT_ROOT_A);
    const b = resolveWorktreeIndexPath(PROJECT_ROOT_B);
    expect(a).not.toBe(b);
    expect(a).toContain('cleocode');
    expect(b).toContain('other-project');
  });
});

// ============================================================================
// Project hash determinism
// ============================================================================

describe('computeProjectHash — determinism', () => {
  it('produces 16 lowercase hex chars', () => {
    const hash = computeProjectHash(PROJECT_ROOT_A);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toHaveLength(16);
  });

  it('is deterministic — same input always produces same hash', () => {
    const h1 = computeProjectHash(PROJECT_ROOT_A);
    const h2 = computeProjectHash(PROJECT_ROOT_A);
    const h3 = computeProjectHash(PROJECT_ROOT_A);
    expect(h1).toBe(h2);
    expect(h2).toBe(h3);
  });

  it('differs for different project roots', () => {
    const ha = computeProjectHash(PROJECT_ROOT_A);
    const hb = computeProjectHash(PROJECT_ROOT_B);
    expect(ha).not.toBe(hb);
  });

  it('same hash → same worktree root (path determinism)', () => {
    const hash = computeProjectHash(PROJECT_ROOT_A);
    const original = process.env['CLEO_HOME'];
    process.env['CLEO_HOME'] = FAKE_CLEO_HOME;
    _resetCleoPlatformPathsCache();

    const r1 = resolveWorktreeRootForHash(hash);
    const r2 = resolveWorktreeRootForHash(hash);

    restoreEnv('CLEO_HOME', original);
    _resetCleoPlatformPathsCache();

    expect(r1).toBe(r2);
  });

  it('different projects never collide on 16-char hash space', () => {
    // Sample 10 distinct paths and assert all hashes differ.
    const roots = [
      '/a',
      '/b',
      '/a/b',
      '/mnt/projects/foo',
      '/mnt/projects/bar',
      '/home/user/code/alpha',
      '/home/user/code/beta',
      '/tmp/t1',
      '/tmp/t2',
      '/srv/app',
    ];
    const hashes = roots.map(computeProjectHash);
    const unique = new Set(hashes);
    expect(unique.size).toBe(roots.length);
  });
});
