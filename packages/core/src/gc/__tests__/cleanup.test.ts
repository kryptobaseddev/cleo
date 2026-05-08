/**
 * Tests for orphan cleanup utilities (T9043).
 *
 * Covers:
 * - CLEO_TEMP_PREFIXES is non-empty and includes core production prefixes
 * - pruneOrphanTempDirs: removes dirs matching a CLEO prefix older than maxAgeMs
 * - pruneOrphanTempDirs: skips dirs younger than maxAgeMs
 * - pruneOrphanTempDirs: dry-run returns paths without deleting
 * - pruneOrphanTempDirs: skips non-CLEO dirs
 * - listOrphanTempDirs: returns sorted oldest-first
 * - pruneOrphanWorktrees: removes task dirs not in activeTaskIds
 * - pruneOrphanWorktrees: preserves task dirs in activeTaskIds
 * - pruneOrphanWorktrees: dry-run returns paths without deleting
 * - pruneOrphanWorktrees: scoped to projectHash
 * - listOrphanWorktrees: returns orphan entries
 *
 * Uses real temp directories (mkdtemp). No mocked filesystem.
 *
 * @task T9043
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLEO_TEMP_PREFIXES,
  DEFAULT_TEMP_MAX_AGE_MS,
  listOrphanTempDirs,
  listOrphanWorktrees,
  pruneOrphanTempDirs,
  pruneOrphanWorktrees,
} from '../cleanup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Backdate a path's mtime by the given number of milliseconds. */
function backdateMtime(path: string, ageMs: number): void {
  const ts = new Date(Date.now() - ageMs);
  utimesSync(path, ts, ts);
}

// ---------------------------------------------------------------------------
// CLEO_TEMP_PREFIXES contract
// ---------------------------------------------------------------------------

describe('CLEO_TEMP_PREFIXES', () => {
  it('is non-empty', () => {
    expect(CLEO_TEMP_PREFIXES.length).toBeGreaterThan(0);
  });

  it('includes the canonical injection-chain prefix', () => {
    expect(CLEO_TEMP_PREFIXES).toContain('cleo-injection-chain-');
  });

  it('includes cleo-init-e2e- prefix', () => {
    expect(CLEO_TEMP_PREFIXES).toContain('cleo-init-e2e-');
  });

  it('includes cleo-test- prefix', () => {
    expect(CLEO_TEMP_PREFIXES).toContain('cleo-test-');
  });

  it('includes backup pack/unpack prefixes', () => {
    expect(CLEO_TEMP_PREFIXES).toContain('cleo-unpack-');
    expect(CLEO_TEMP_PREFIXES).toContain('cleo-pack-');
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_TEMP_MAX_AGE_MS
// ---------------------------------------------------------------------------

describe('DEFAULT_TEMP_MAX_AGE_MS', () => {
  it('is 2 hours in milliseconds', () => {
    expect(DEFAULT_TEMP_MAX_AGE_MS).toBe(2 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanTempDirs
// ---------------------------------------------------------------------------

describe('pruneOrphanTempDirs', () => {
  let tempBase: string;
  const MAX_AGE_MS = 1000; // 1 second for tests

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'cleo-cleanup-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('removes CLEO-prefix dirs older than maxAgeMs', () => {
    const old = mkdtempSync(join(tempBase, 'cleo-injection-chain-'));
    backdateMtime(old, MAX_AGE_MS + 5000);

    const result = pruneOrphanTempDirs({ maxAgeMs: MAX_AGE_MS, tempDir: tempBase });

    expect(result.removed).toBe(1);
    expect(result.removedPaths).toContain(old);
    expect(existsSync(old)).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it('skips dirs younger than maxAgeMs', () => {
    // Create a fresh dir — mtime is now, so it's younger than maxAgeMs.
    mkdtempSync(join(tempBase, 'cleo-injection-chain-'));

    const result = pruneOrphanTempDirs({ maxAgeMs: MAX_AGE_MS, tempDir: tempBase });

    expect(result.removed).toBe(0);
    expect(result.skipped).toBeGreaterThanOrEqual(1);
  });

  it('dry-run returns paths without deleting', () => {
    const old = mkdtempSync(join(tempBase, 'cleo-injection-chain-'));
    backdateMtime(old, MAX_AGE_MS + 5000);

    const result = pruneOrphanTempDirs({ maxAgeMs: MAX_AGE_MS, tempDir: tempBase, dryRun: true });

    expect(result.removed).toBe(1);
    expect(result.removedPaths).toContain(old);
    expect(result.dryRun).toBe(true);
    // Must NOT have actually deleted it.
    expect(existsSync(old)).toBe(true);
  });

  it('skips non-CLEO dirs', () => {
    const nonCleo = join(tempBase, 'some-other-tool-dir');
    mkdirSync(nonCleo, { recursive: true });
    backdateMtime(nonCleo, MAX_AGE_MS + 5000);

    const result = pruneOrphanTempDirs({ maxAgeMs: MAX_AGE_MS, tempDir: tempBase });

    expect(result.removed).toBe(0);
    expect(existsSync(nonCleo)).toBe(true);
  });

  it('handles non-existent tempDir gracefully', () => {
    const result = pruneOrphanTempDirs({
      maxAgeMs: MAX_AGE_MS,
      tempDir: join(tempBase, 'does-not-exist'),
    });

    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listOrphanTempDirs
// ---------------------------------------------------------------------------

describe('listOrphanTempDirs', () => {
  let tempBase: string;
  const MAX_AGE_MS = 1000;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), 'cleo-cleanup-list-'));
  });

  afterEach(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns old CLEO dirs sorted oldest-first', () => {
    const older = mkdtempSync(join(tempBase, 'cleo-test-'));
    const newer = mkdtempSync(join(tempBase, 'cleo-init-e2e-'));
    backdateMtime(older, MAX_AGE_MS + 10000);
    backdateMtime(newer, MAX_AGE_MS + 2000);

    const result = listOrphanTempDirs(MAX_AGE_MS, tempBase);

    expect(result.length).toBe(2);
    // Oldest-first: older should come before newer.
    expect(result[0]!.path).toBe(older);
    expect(result[1]!.path).toBe(newer);
    expect(result[0]!.ageMs).toBeGreaterThan(result[1]!.ageMs);
  });

  it('excludes dirs younger than maxAgeMs', () => {
    mkdtempSync(join(tempBase, 'cleo-test-'));
    const result = listOrphanTempDirs(MAX_AGE_MS, tempBase);
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanWorktrees
// ---------------------------------------------------------------------------

describe('pruneOrphanWorktrees', () => {
  let worktreesRoot: string;
  let projectDir: string;
  const PROJECT_HASH = 'aabbccdd11223344';

  beforeEach(() => {
    worktreesRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-test-'));
    projectDir = join(worktreesRoot, PROJECT_HASH);
    mkdirSync(join(projectDir, 'T1001'), { recursive: true });
    mkdirSync(join(projectDir, 'T1002'), { recursive: true });
    mkdirSync(join(projectDir, 'T1003'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(worktreesRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('removes task dirs not in activeTaskIds', () => {
    const result = pruneOrphanWorktrees({
      worktreesRoot,
      activeTaskIds: new Set(['T1001']),
    });

    expect(result.removed).toBe(2);
    expect(existsSync(join(projectDir, 'T1001'))).toBe(true);
    expect(existsSync(join(projectDir, 'T1002'))).toBe(false);
    expect(existsSync(join(projectDir, 'T1003'))).toBe(false);
  });

  it('preserves all dirs when all IDs are in activeTaskIds', () => {
    const result = pruneOrphanWorktrees({
      worktreesRoot,
      activeTaskIds: new Set(['T1001', 'T1002', 'T1003']),
    });

    expect(result.removed).toBe(0);
    expect(existsSync(join(projectDir, 'T1001'))).toBe(true);
    expect(existsSync(join(projectDir, 'T1002'))).toBe(true);
    expect(existsSync(join(projectDir, 'T1003'))).toBe(true);
  });

  it('removes all dirs when activeTaskIds is empty', () => {
    const result = pruneOrphanWorktrees({
      worktreesRoot,
      activeTaskIds: new Set<string>(),
    });

    expect(result.removed).toBe(3);
  });

  it('dry-run returns paths without deleting', () => {
    const result = pruneOrphanWorktrees({
      worktreesRoot,
      activeTaskIds: new Set<string>(),
      dryRun: true,
    });

    expect(result.removed).toBe(3);
    expect(result.dryRun).toBe(true);
    // Dirs must still exist.
    expect(existsSync(join(projectDir, 'T1001'))).toBe(true);
    expect(existsSync(join(projectDir, 'T1002'))).toBe(true);
    expect(existsSync(join(projectDir, 'T1003'))).toBe(true);
  });

  it('scopes to projectHash when provided', () => {
    // Create a second project.
    const other = join(worktreesRoot, 'other-hash');
    mkdirSync(join(other, 'T9999'), { recursive: true });

    const result = pruneOrphanWorktrees({
      worktreesRoot,
      projectHash: PROJECT_HASH,
      activeTaskIds: new Set<string>(),
    });

    // Only T1001-T1003 should be removed; T9999 in 'other-hash' is untouched.
    expect(result.removed).toBe(3);
    expect(existsSync(join(other, 'T9999'))).toBe(true);
  });

  it('handles non-existent worktreesRoot gracefully', () => {
    const result = pruneOrphanWorktrees({
      worktreesRoot: join(worktreesRoot, 'does-not-exist'),
      activeTaskIds: new Set<string>(),
    });

    expect(result.removed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listOrphanWorktrees
// ---------------------------------------------------------------------------

describe('listOrphanWorktrees', () => {
  let worktreesRoot: string;
  let projectDir: string;
  const PROJECT_HASH = 'aabbccdd11223344';

  beforeEach(() => {
    worktreesRoot = mkdtempSync(join(tmpdir(), 'cleo-wt-list-'));
    projectDir = join(worktreesRoot, PROJECT_HASH);
    mkdirSync(join(projectDir, 'T1001'), { recursive: true });
    mkdirSync(join(projectDir, 'T1002'), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(worktreesRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('returns orphan entries for task IDs not in activeTaskIds', () => {
    const result = listOrphanWorktrees(worktreesRoot, new Set(['T1001']));

    expect(result.length).toBe(1);
    expect(result[0]!.path).toBe(join(projectDir, 'T1002'));
  });

  it('returns empty array when all task IDs are active', () => {
    const result = listOrphanWorktrees(worktreesRoot, new Set(['T1001', 'T1002']));
    expect(result).toHaveLength(0);
  });

  it('returns empty array for non-existent worktreesRoot', () => {
    const result = listOrphanWorktrees(join(worktreesRoot, 'nope'), new Set<string>());
    expect(result).toHaveLength(0);
  });
});
