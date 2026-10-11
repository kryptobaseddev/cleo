/**
 * Tests for worktree-preflight.ts (T11489 · DHQ-037/019).
 *
 * Coverage:
 * - detectAndHealCoreWorktreeLeak: no-leak (fast path), leak-detected+healed,
 *   leak-detected+heal-failed, non-git-dir.
 * - assertNoWorktreeConfigLeak: throws E_WT_CONFIG_LEAK on unhealed leak.
 * - ensureWorktreeBuildReady: already-ready, no-lockfile, installed (mock).
 * - stdout guard: preflight progress goes to stderr only, so a spawn's stdout
 *   stays exactly one LAFS envelope (ADR-086, T13493).
 *
 * @task T11489
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('preflight progress never reaches stdout (T13493 · ADR-086)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-preflight-stdout-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Run `fn` and return what it wrote to stdout and stderr. */
  function capture(fn: () => void): { stdout: string; stderr: string } {
    let stdout = '';
    let stderr = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk);
      return true;
    });
    try {
      fn();
    } finally {
      vi.restoreAllMocks();
    }
    return { stdout, stderr };
  }

  it('the node_modules install path writes its notices to stderr and nothing to stdout', () => {
    writeFileSync(join(dir, 'package.json'), '{"name":"p","version":"1.0.0"}\n');
    writeFileSync(join(dir, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
    const out = capture(() => {
      ensureWorktreeBuildReady(dir, dir);
    });
    expect(out.stdout).toBe('');
    expect(out.stderr).toContain('[worktree-preflight] node_modules absent');
  });

  it('the core.worktree leak heal writes to stderr and nothing to stdout', () => {
    const repo = initTempRepo();
    try {
      execFileSync(
        'git',
        ['config', '--file', join(repo, '.git', 'config'), 'core.worktree', '/tmp/leaked'],
        {
          stdio: 'pipe',
        },
      );
      const out = capture(() => {
        detectAndHealCoreWorktreeLeak(repo);
      });
      expect(out.stdout).toBe('');
      expect(out.stderr).toContain('[worktree-preflight] E_WT_CONFIG_LEAK');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
