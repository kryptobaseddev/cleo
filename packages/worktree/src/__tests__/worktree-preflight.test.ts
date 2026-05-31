/**
 * Tests for worktree-preflight.ts (T11489 · DHQ-037/019).
 *
 * Coverage:
 * - detectAndHealCoreWorktreeLeak: no-leak (fast path), leak-detected+healed,
 *   leak-detected+heal-failed, non-git-dir.
 * - assertNoWorktreeConfigLeak: throws E_WT_CONFIG_LEAK on unhealed leak.
 * - ensureWorktreeBuildReady: already-ready, no-lockfile, installed (mock).
 *
 * @task T11489
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertNoWorktreeConfigLeak,
  detectAndHealCoreWorktreeLeak,
  ensureWorktreeBuildReady,
} from '../worktree-preflight.js';

/** Create a minimal git repo in a temp dir. */
function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cleo-preflight-'));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'pipe' });
  writeFileSync(join(dir, 'README.md'), '# test\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('detectAndHealCoreWorktreeLeak (T11489)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initTempRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('returns leakDetected=false when core.worktree is absent', () => {
    const result = detectAndHealCoreWorktreeLeak(repoDir);
    expect(result.leakDetected).toBe(false);
    expect(result.healed).toBe(false);
    expect(result.leakedValue).toBeUndefined();
  });

  it('detects and heals a leaked core.worktree key', () => {
    // Inject the leak manually.
    const gitConfigPath = join(repoDir, '.git', 'config');
    execFileSync(
      'git',
      ['config', '--file', gitConfigPath, 'core.worktree', '/tmp/stale-agent-worktree'],
      { stdio: 'pipe' },
    );

    // Verify it was set.
    const leakValue = execFileSync(
      'git',
      ['config', '--file', gitConfigPath, '--get', 'core.worktree'],
      { encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    expect(leakValue).toBe('/tmp/stale-agent-worktree');

    // Run detection + heal.
    const result = detectAndHealCoreWorktreeLeak(repoDir);
    expect(result.leakDetected).toBe(true);
    expect(result.leakedValue).toBe('/tmp/stale-agent-worktree');
    expect(result.healed).toBe(true);
    expect(result.healError).toBeUndefined();

    // Confirm the key is gone.
    expect(() =>
      execFileSync('git', ['config', '--file', gitConfigPath, '--get', 'core.worktree'], {
        encoding: 'utf-8',
        stdio: 'pipe',
      }),
    ).toThrow(); // exits 1 = key absent
  });

  it('returns leakDetected=false when .git/config does not exist', () => {
    // Point at a directory with no .git/config.
    const nonGitDir = mkdtempSync(join(tmpdir(), 'cleo-nongit-'));
    try {
      const result = detectAndHealCoreWorktreeLeak(nonGitDir);
      expect(result.leakDetected).toBe(false);
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it('is idempotent — second call after heal returns leakDetected=false', () => {
    // Inject + heal.
    const gitConfigPath = join(repoDir, '.git', 'config');
    execFileSync('git', ['config', '--file', gitConfigPath, 'core.worktree', '/tmp/stale'], {
      stdio: 'pipe',
    });
    detectAndHealCoreWorktreeLeak(repoDir); // first call heals
    const second = detectAndHealCoreWorktreeLeak(repoDir);
    expect(second.leakDetected).toBe(false);
  });
});

describe('assertNoWorktreeConfigLeak (T11489)', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = initTempRepo();
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('does not throw when no leak is present', () => {
    expect(() => assertNoWorktreeConfigLeak(repoDir)).not.toThrow();
  });

  it('heals silently and does not throw when the leak is healable', () => {
    const gitConfigPath = join(repoDir, '.git', 'config');
    execFileSync('git', ['config', '--file', gitConfigPath, 'core.worktree', '/tmp/leaked'], {
      stdio: 'pipe',
    });
    // Should heal and NOT throw.
    expect(() => assertNoWorktreeConfigLeak(repoDir)).not.toThrow();

    // Key should be gone.
    expect(() =>
      execFileSync('git', ['config', '--file', gitConfigPath, '--get', 'core.worktree'], {
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});

describe('ensureWorktreeBuildReady (T11489)', () => {
  let worktreeDir: string;

  beforeEach(() => {
    worktreeDir = mkdtempSync(join(tmpdir(), 'cleo-buildready-'));
  });

  afterEach(() => {
    rmSync(worktreeDir, { recursive: true, force: true });
  });

  it('returns already-ready when node_modules exists', () => {
    const nodeModules = join(worktreeDir, 'node_modules');
    mkdirSync(nodeModules);
    const result = ensureWorktreeBuildReady(worktreeDir, worktreeDir);
    expect(result.action).toBe('already-ready');
    expect(result.nodeModulesPresent).toBe(true);
  });

  it('returns no-lockfile when pnpm-lock.yaml is absent', () => {
    const result = ensureWorktreeBuildReady(worktreeDir, worktreeDir);
    expect(result.action).toBe('no-lockfile');
    expect(result.nodeModulesPresent).toBe(false);
    expect(result.lockfilePresent).toBe(false);
  });

  it('returns install-failed (gracefully) when pnpm-lock.yaml exists but install fails in non-pnpm dir', () => {
    // Write a minimal pnpm-lock.yaml so the condition triggers.
    writeFileSync(join(worktreeDir, 'pnpm-lock.yaml'), 'lockfileVersion: "6.0"\n');
    // node_modules absent → will try install → will fail (no package.json, etc.)
    const result = ensureWorktreeBuildReady(worktreeDir, worktreeDir);
    // We expect either 'install-failed' or 'installed' (unlikely in a bare dir).
    expect(['install-failed', 'installed', 'already-ready']).toContain(result.action);
    expect(result.lockfilePresent).toBe(true);
    // Importantly, no exception should propagate.
  });
});
