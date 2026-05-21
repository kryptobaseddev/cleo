/**
 * Tests for auditWorktreeOrphansComprehensive (T9808 / council D009).
 *
 * Covers:
 *   - Returns 0 anomalies when no worktrees exist and no rogue dirs present.
 *   - Detects `rogue-worktrees-directory` when .cleo/worktrees/ is a directory.
 *   - Does NOT flag .cleo/worktrees/ when it is a file (only .json sentinel allowed).
 *   - Detects `orphan-cleo-dir` for .cleo/ inside a non-main worktree path.
 *   - Detects `non-canonical-location` for worktrees outside the XDG root.
 *   - Does NOT flag the main project checkout as non-canonical.
 *   - Anomalies are sorted by kind then path (stable output).
 *
 * These tests stub `git worktree list --porcelain` by temporarily overriding
 * PATH so that a hand-crafted `git` shim returns canned output.  This
 * avoids mutating the real git repo on disk.
 *
 * @task T9808
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditWorktreeOrphansComprehensive } from '../worktree-orphans.js';

// ---------------------------------------------------------------------------
// We stub the `spawnSync('git', [...])` call used by listGitWorktrees by
// mocking the node:child_process module.  This prevents the tests from
// touching the real git repo.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return {
    ...original,
    spawnSync: vi.fn(original.spawnSync),
  };
});

import { spawnSync } from 'node:child_process';

const spawnSyncMock = vi.mocked(spawnSync);

// ---------------------------------------------------------------------------
// We also need to control computeProjectHash + getCleoWorktreesRoot so the
// "canonical XDG root" is predictable in tests.
//
// IMPORTANT: The mock is set up PER TEST via `xdgRoot` so we can use
// tmpdir-based paths that actually exist on disk.
// ---------------------------------------------------------------------------

const PROJECT_HASH = 'test1234hash5678';

// We use a module-level variable that the factory captures by reference.
let _fakeXdgWorktreesRoot = '/tmp/placeholder';

vi.mock('@cleocode/paths', async () => {
  return {
    computeProjectHash: (_projectRoot: string) => PROJECT_HASH,
    getCleoWorktreesRoot: () => _fakeXdgWorktreesRoot,
    resolveTaskWorktreePath: (hash: string, taskId: string) =>
      join(_fakeXdgWorktreesRoot, hash, taskId),
    resolveWorktreeRootForHash: (hash: string) => join(_fakeXdgWorktreesRoot, hash),
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build `git worktree list --porcelain` output for a given list of paths. */
function buildWorktreeListOutput(entries: Array<{ path: string; sha?: string; branch?: string }>) {
  return entries
    .map((e) => {
      const lines = [
        `worktree ${e.path}`,
        `HEAD ${e.sha ?? 'abc1234def56789012345678901234567890abc12'}`,
        `branch ${e.branch ?? 'refs/heads/main'}`,
      ];
      return lines.join('\n');
    })
    .join('\n\n');
}

let tmpRoot: string;
let projectRoot: string;
let canonicalRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cleo-comprehensive-audit-'));
  projectRoot = join(tmpRoot, 'fake-project');
  mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

  // Point the XDG root at a subdir of tmpRoot so tests can actually create dirs.
  const xdgWorktreesRoot = join(tmpRoot, 'fake-xdg', 'cleo', 'worktrees');
  mkdirSync(xdgWorktreesRoot, { recursive: true });
  _fakeXdgWorktreesRoot = xdgWorktreesRoot;
  canonicalRoot = join(xdgWorktreesRoot, PROJECT_HASH);
  mkdirSync(canonicalRoot, { recursive: true });

  // Default: return worktree list with only the main checkout.
  spawnSyncMock.mockReturnValue({
    status: 0,
    stdout: buildWorktreeListOutput([{ path: projectRoot }]),
    stderr: '',
    pid: 1,
    output: [],
    signal: null,
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auditWorktreeOrphansComprehensive — baseline clean', () => {
  it('returns 0 anomalies when only the main checkout is listed and no rogue dirs exist', async () => {
    const result = await auditWorktreeOrphansComprehensive(projectRoot);
    expect(result.count).toBe(0);
    expect(result.anomalies).toEqual([]);
    expect(result.projectRoot).toBe(projectRoot);
    expect(result.canonicalWorktreesRoot).toBe(canonicalRoot);
  });
});

describe('auditWorktreeOrphansComprehensive — rogue-worktrees-directory', () => {
  it('detects .cleo/worktrees/ as a DIRECTORY (council D009 violation)', async () => {
    const rogueDir = join(projectRoot, '.cleo', 'worktrees');
    mkdirSync(rogueDir, { recursive: true });

    const result = await auditWorktreeOrphansComprehensive(projectRoot);

    expect(result.count).toBe(1);
    expect(result.anomalies[0]?.kind).toBe('rogue-worktrees-directory');
    expect(result.anomalies[0]?.path).toBe(rogueDir);
    expect(result.anomalies[0]?.worktreePath).toBeNull();
    expect(result.anomalies[0]?.description).toContain('D009');
  });

  it('does NOT flag .cleo/worktrees when it is a file (json sentinel)', async () => {
    const sentinelFile = join(projectRoot, '.cleo', 'worktrees');
    writeFileSync(sentinelFile, '{"sentinel":true}');

    const result = await auditWorktreeOrphansComprehensive(projectRoot);
    expect(result.anomalies.filter((a) => a.kind === 'rogue-worktrees-directory')).toHaveLength(0);
  });
});

describe('auditWorktreeOrphansComprehensive — orphan-cleo-dir', () => {
  it('detects .cleo/ inside a non-main worktree', async () => {
    const wtPath = join(canonicalRoot, 'T9808-test');
    mkdirSync(join(wtPath, '.cleo'), { recursive: true });

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: buildWorktreeListOutput([
        { path: projectRoot },
        { path: wtPath, branch: 'refs/heads/task/T9808-test' },
      ]),
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = await auditWorktreeOrphansComprehensive(projectRoot);

    const orphans = result.anomalies.filter((a) => a.kind === 'orphan-cleo-dir');
    expect(orphans.length).toBeGreaterThanOrEqual(1);
    expect(orphans[0]?.path).toBe(join(wtPath, '.cleo'));
    expect(orphans[0]?.worktreePath).toBe(wtPath);

    // Clean up.
    rmSync(wtPath, { recursive: true, force: true });
  });

  it('does NOT flag .cleo/ inside the main project checkout', async () => {
    // The main checkout has .cleo/ by design.
    const result = await auditWorktreeOrphansComprehensive(projectRoot);
    const orphans = result.anomalies.filter((a) => a.kind === 'orphan-cleo-dir');
    expect(orphans).toHaveLength(0);
  });
});

describe('auditWorktreeOrphansComprehensive — non-canonical-location', () => {
  it('flags a worktree outside the XDG root', async () => {
    const nonCanonical = join(tmpRoot, 'non-canonical-wt');
    mkdirSync(nonCanonical, { recursive: true });

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: buildWorktreeListOutput([
        { path: projectRoot },
        { path: nonCanonical, branch: 'refs/heads/task/T9999' },
      ]),
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = await auditWorktreeOrphansComprehensive(projectRoot);

    const nonCanon = result.anomalies.filter((a) => a.kind === 'non-canonical-location');
    expect(nonCanon.length).toBeGreaterThanOrEqual(1);
    expect(nonCanon[0]?.path).toBe(nonCanonical);
    expect(nonCanon[0]?.description).toContain('XDG');
  });

  it('does NOT flag worktrees inside the canonical XDG root', async () => {
    const canonicalWt = join(canonicalRoot, 'T9808-good');
    mkdirSync(canonicalWt, { recursive: true });

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: buildWorktreeListOutput([
        { path: projectRoot },
        { path: canonicalWt, branch: 'refs/heads/task/T9808-good' },
      ]),
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = await auditWorktreeOrphansComprehensive(projectRoot);
    const nonCanon = result.anomalies.filter((a) => a.kind === 'non-canonical-location');
    expect(nonCanon).toHaveLength(0);

    rmSync(canonicalWt, { recursive: true, force: true });
  });
});

describe('auditWorktreeOrphansComprehensive — sorted output', () => {
  it('returns anomalies sorted by kind then path', async () => {
    const rogueDir = join(projectRoot, '.cleo', 'worktrees');
    mkdirSync(rogueDir, { recursive: true });
    const nonCanonical = join(tmpRoot, 'zzz-wt');
    mkdirSync(nonCanonical, { recursive: true });

    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: buildWorktreeListOutput([
        { path: projectRoot },
        { path: nonCanonical, branch: 'refs/heads/task/T9999' },
      ]),
      stderr: '',
      pid: 1,
      output: [],
      signal: null,
    });

    const result = await auditWorktreeOrphansComprehensive(projectRoot);
    const kinds = result.anomalies.map((a) => a.kind);
    const sorted = [...kinds].sort();
    expect(kinds).toEqual(sorted);
  });
});
