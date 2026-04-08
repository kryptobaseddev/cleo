/**
 * Unit tests for the git worktree isolation module.
 *
 * @remarks
 * Each test creates a real temporary git repository to exercise actual
 * git worktree operations. No mocking — worktree commands need a real
 * `.git` directory to function.
 *
 * Vitest with describe/it blocks per project conventions.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createWorktree,
  mergeWorktree,
  listWorktrees,
  resolveWorktreeRoot,
} from '../src/worktree.js';
import type { WorktreeConfig, WorktreeRequest } from '../src/worktree.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tempDir: string;
let gitRoot: string;
let worktreeRoot: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'cleo-worktree-test-'));
  gitRoot = join(tempDir, 'repo');
  worktreeRoot = join(tempDir, 'worktrees');

  // Set up a minimal git repo with one commit
  execSync(
    [
      `mkdir -p "${gitRoot}"`,
      `cd "${gitRoot}"`,
      'git init',
      'git config user.email "test@cleo.dev"',
      'git config user.name "CLEO Test"',
      'git commit --allow-empty -m "init"',
    ].join(' && '),
    { stdio: 'pipe' },
  );
});

afterEach(() => {
  // Clean up any worktrees before removing the temp dir
  try {
    execSync('git worktree prune', { cwd: gitRoot, stdio: 'pipe' });
  } catch {
    // best effort
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Helper to build a config pointing at the test repo. */
function testConfig(overrides: Partial<WorktreeConfig> = {}): WorktreeConfig {
  return {
    projectHash: 'test-hash',
    gitRoot,
    worktreeRoot,
    ...overrides,
  };
}

/** Helper to build a request. */
function testRequest(overrides: Partial<WorktreeRequest> = {}): WorktreeRequest {
  return {
    baseRef: 'HEAD',
    taskId: 'T100',
    reason: 'subagent',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolveWorktreeRoot
// ---------------------------------------------------------------------------

describe('resolveWorktreeRoot', () => {
  it('uses explicit worktreeRoot when provided', () => {
    const config = testConfig({ worktreeRoot: '/custom/root' });
    expect(resolveWorktreeRoot(config)).toBe('/custom/root');
  });

  it('uses XDG_DATA_HOME when set', () => {
    const original = process.env['XDG_DATA_HOME'];
    try {
      process.env['XDG_DATA_HOME'] = '/xdg/data';
      const config = testConfig({ worktreeRoot: undefined });
      const result = resolveWorktreeRoot(config);
      expect(result).toBe(join('/xdg/data', 'cleo', 'worktrees', 'test-hash'));
    } finally {
      if (original === undefined) {
        delete process.env['XDG_DATA_HOME'];
      } else {
        process.env['XDG_DATA_HOME'] = original;
      }
    }
  });

  it('falls back to ~/.local/share when XDG_DATA_HOME is unset', () => {
    const original = process.env['XDG_DATA_HOME'];
    try {
      delete process.env['XDG_DATA_HOME'];
      const config = testConfig({ worktreeRoot: undefined });
      const result = resolveWorktreeRoot(config);
      expect(result).toContain(join('.local', 'share', 'cleo', 'worktrees', 'test-hash'));
    } finally {
      if (original !== undefined) {
        process.env['XDG_DATA_HOME'] = original;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// createWorktree
// ---------------------------------------------------------------------------

describe('createWorktree', () => {
  it('creates directory at expected path', () => {
    const config = testConfig();
    const handle = createWorktree(testRequest(), config);

    expect(existsSync(handle.path)).toBe(true);
    expect(handle.path).toBe(join(worktreeRoot, 'T100'));
  });

  it('creates branch from baseRef', () => {
    const config = testConfig();
    const handle = createWorktree(testRequest(), config);

    // Branch should exist
    const branches = execSync('git branch', { cwd: gitRoot, encoding: 'utf-8' });
    expect(branches).toContain(handle.branch);

    // Branch should start with cleo/<taskId>-
    expect(handle.branch).toMatch(/^cleo\/T100-[a-z0-9]+$/);
  });

  it('uses custom branch name when provided', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ branchName: 'custom/my-branch' }),
      config,
    );

    expect(handle.branch).toBe('custom/my-branch');
    const branches = execSync('git branch', { cwd: gitRoot, encoding: 'utf-8' });
    expect(branches).toContain('custom/my-branch');
  });

  it('replaces stale worktree at same path', () => {
    const config = testConfig();

    // Create first worktree
    const first = createWorktree(
      testRequest({ branchName: 'cleo/T100-first' }),
      config,
    );
    expect(existsSync(first.path)).toBe(true);

    // Create second worktree for same task — should replace
    const second = createWorktree(
      testRequest({ branchName: 'cleo/T100-second' }),
      config,
    );
    expect(existsSync(second.path)).toBe(true);
    expect(second.branch).toBe('cleo/T100-second');

    // Old branch should be gone (worktree removed), new branch present
    const branches = execSync('git branch', { cwd: gitRoot, encoding: 'utf-8' });
    expect(branches).toContain('cleo/T100-second');
  });

  it('populates handle fields correctly', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ baseRef: 'HEAD', taskId: 'T200', reason: 'experiment' }),
      config,
    );

    expect(handle.taskId).toBe('T200');
    expect(handle.baseRef).toBe('HEAD');
    expect(typeof handle.cleanup).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe('cleanup', () => {
  it('removes worktree directory', () => {
    const config = testConfig();
    const handle = createWorktree(testRequest(), config);
    expect(existsSync(handle.path)).toBe(true);

    handle.cleanup(false);
    expect(existsSync(handle.path)).toBe(false);
  });

  it('with deleteBranch removes the branch', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ branchName: 'cleo/T100-cleanup' }),
      config,
    );

    handle.cleanup(true);

    const branches = execSync('git branch', { cwd: gitRoot, encoding: 'utf-8' });
    expect(branches).not.toContain('cleo/T100-cleanup');
  });

  it('without deleteBranch preserves the branch', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ branchName: 'cleo/T100-keep' }),
      config,
    );

    handle.cleanup(false);

    const branches = execSync('git branch', { cwd: gitRoot, encoding: 'utf-8' });
    expect(branches).toContain('cleo/T100-keep');
  });
});

// ---------------------------------------------------------------------------
// mergeWorktree
// ---------------------------------------------------------------------------

describe('mergeWorktree', () => {
  it('ff-only succeeds with clean branch', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ branchName: 'cleo/T100-merge' }),
      config,
    );

    // Add a commit to the worktree branch
    writeFileSync(join(handle.path, 'new-file.txt'), 'content');
    execSync('git add . && git commit -m "add file"', {
      cwd: handle.path,
      stdio: 'pipe',
    });

    const result = mergeWorktree(handle, config);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Worktree should be cleaned up
    expect(existsSync(handle.path)).toBe(false);
  });

  it('retains worktree on conflict', () => {
    const config = testConfig();
    const handle = createWorktree(
      testRequest({ branchName: 'cleo/T100-conflict' }),
      config,
    );

    // Add a commit on the main branch that will conflict
    writeFileSync(join(gitRoot, 'conflict.txt'), 'main content');
    execSync('git add . && git commit -m "main commit"', {
      cwd: gitRoot,
      stdio: 'pipe',
    });

    // Add a divergent commit on the worktree branch
    writeFileSync(join(handle.path, 'conflict.txt'), 'branch content');
    execSync('git add . && git commit -m "branch commit"', {
      cwd: handle.path,
      stdio: 'pipe',
    });

    // ff-only merge should fail because branches have diverged
    const result = mergeWorktree(handle, config);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Merge failed');
    expect(result.error).toContain('retained');

    // Worktree should still exist for forensics
    expect(existsSync(handle.path)).toBe(true);

    // Manual cleanup for afterEach
    handle.cleanup(true);
  });
});

// ---------------------------------------------------------------------------
// listWorktrees
// ---------------------------------------------------------------------------

describe('listWorktrees', () => {
  it('returns active project worktrees', () => {
    const config = testConfig();
    createWorktree(
      testRequest({ taskId: 'T301', branchName: 'cleo/T301-list' }),
      config,
    );
    createWorktree(
      testRequest({ taskId: 'T302', branchName: 'cleo/T302-list' }),
      config,
    );

    const entries = listWorktrees(config);
    expect(entries).toHaveLength(2);

    const paths = entries.map((e) => e.path);
    expect(paths).toContain(join(worktreeRoot, 'T301'));
    expect(paths).toContain(join(worktreeRoot, 'T302'));

    const branches = entries.map((e) => e.branch);
    expect(branches).toContain('cleo/T301-list');
    expect(branches).toContain('cleo/T302-list');

    // Cleanup
    for (const entry of entries) {
      try {
        execSync(`git worktree remove "${entry.path}" --force`, {
          cwd: gitRoot,
          stdio: 'pipe',
        });
      } catch {
        // best effort
      }
    }
  });

  it('excludes worktrees outside project root', () => {
    const config = testConfig();
    createWorktree(testRequest({ branchName: 'cleo/T100-inside' }), config);

    // Create a worktree outside our managed root
    const outsidePath = join(tempDir, 'outside-wt');
    execSync(
      `git worktree add "${outsidePath}" -b outside-branch HEAD`,
      { cwd: gitRoot, stdio: 'pipe' },
    );

    const entries = listWorktrees(config);
    const paths = entries.map((e) => e.path);
    expect(paths).not.toContain(outsidePath);

    // Only our managed worktree should appear
    expect(entries).toHaveLength(1);
    expect(entries[0].path).toBe(join(worktreeRoot, 'T100'));

    // Cleanup
    execSync(`git worktree remove "${outsidePath}" --force`, {
      cwd: gitRoot,
      stdio: 'pipe',
    });
    entries[0] && execSync(`git worktree remove "${entries[0].path}" --force`, {
      cwd: gitRoot,
      stdio: 'pipe',
    });
  });

  it('returns empty array when no worktrees exist', () => {
    const config = testConfig();
    const entries = listWorktrees(config);
    expect(entries).toEqual([]);
  });
});
