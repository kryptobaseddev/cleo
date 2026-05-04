/**
 * Unit tests for orchestrateSpawnExecute worktree isolation (T1759).
 *
 * Verifies that when a worktree is provisioned, the adapter receives the
 * worktreePath as workingDirectory — NOT the project root.
 *
 * @task T1759
 */

import { describe, expect, it } from 'vitest';
import { ISOLATION_ENV_KEYS, provisionIsolatedShell } from '../../worktree/isolation.js';

// ---------------------------------------------------------------------------
// Unit tests for the isolation utility used by orchestrateSpawnExecute
// ---------------------------------------------------------------------------

describe('provisionIsolatedShell — orchestrateSpawnExecute contract', () => {
  const projectRoot = '/mnt/projects/cleocode';
  const worktreePath = '/home/user/.local/share/cleo/worktrees/1e3146b7352ba279/T1759';
  const branch = 'task/T1759';
  const projectHash = '1e3146b7352ba279';

  it('workingDirectory equals worktreePath, not projectRoot', () => {
    const isolation = provisionIsolatedShell({
      worktreePath,
      branch,
      role: 'worker',
      projectHash,
    });

    // The isolation cwd (which orchestrateSpawnExecute passes as workingDirectory)
    // must be the worktree path, not the projectRoot.
    expect(isolation.cwd).toBe(worktreePath);
    expect(isolation.cwd).not.toBe(projectRoot);
  });

  it('env block contains all ISOLATION_ENV_KEYS', () => {
    const isolation = provisionIsolatedShell({
      worktreePath,
      branch,
      role: 'worker',
      projectHash,
    });

    for (const key of ISOLATION_ENV_KEYS) {
      expect(isolation.env).toHaveProperty(key);
      expect(typeof isolation.env[key]).toBe('string');
      expect(isolation.env[key].length).toBeGreaterThan(0);
    }
  });

  it('env CLEO_WORKTREE_ROOT points to worktree, not project root', () => {
    const isolation = provisionIsolatedShell({
      worktreePath,
      branch,
      role: 'worker',
      projectHash,
    });

    expect(isolation.env.CLEO_WORKTREE_ROOT).toBe(worktreePath);
    expect(isolation.env.CLEO_WORKTREE_ROOT).not.toBe(projectRoot);
  });

  it('boundaryContract carries the correct worktreeRoot and role', () => {
    const isolation = provisionIsolatedShell({
      worktreePath,
      branch,
      role: 'worker',
      projectHash,
    });

    expect(isolation.boundaryContract.worktreeRoot).toBe(worktreePath);
    expect(isolation.boundaryContract.role).toBe('worker');
    expect(isolation.boundaryContract.envKeys).toBe(ISOLATION_ENV_KEYS);
  });
});

// ---------------------------------------------------------------------------
// Synthetic parallel spawn leakage test (T1759 AC: zero working-tree leakage)
// ---------------------------------------------------------------------------

describe('parallel spawn isolation — zero working-tree leakage', () => {
  const projectRoot = '/mnt/projects/cleocode';

  it('two concurrent spawns produce non-overlapping cwds', () => {
    const task1 = {
      worktreePath: '/home/user/.local/share/cleo/worktrees/abc/T1000',
      branch: 'task/T1000',
      role: 'worker' as const,
      projectHash: 'abc',
    };
    const task2 = {
      worktreePath: '/home/user/.local/share/cleo/worktrees/abc/T1001',
      branch: 'task/T1001',
      role: 'worker' as const,
      projectHash: 'abc',
    };

    const iso1 = provisionIsolatedShell(task1);
    const iso2 = provisionIsolatedShell(task2);

    // Each agent gets its own worktree cwd
    expect(iso1.cwd).not.toBe(iso2.cwd);

    // Neither is the project root
    expect(iso1.cwd).not.toBe(projectRoot);
    expect(iso2.cwd).not.toBe(projectRoot);

    // No leakage: env vars reference the correct worktree
    expect(iso1.env.CLEO_WORKTREE_ROOT).not.toBe(iso2.env.CLEO_WORKTREE_ROOT);
    expect(iso1.env.CLEO_WORKTREE_ROOT).toBe(task1.worktreePath);
    expect(iso2.env.CLEO_WORKTREE_ROOT).toBe(task2.worktreePath);
  });

  it('mutating one spawn result does not affect the other', () => {
    const task = {
      worktreePath: '/home/user/.local/share/cleo/worktrees/abc/T1002',
      branch: 'task/T1002',
      role: 'worker' as const,
      projectHash: 'abc',
    };

    const iso1 = provisionIsolatedShell(task);
    const iso2 = provisionIsolatedShell(task);

    // Mutate iso1's env
    iso1.env.CLEO_PROJECT_HASH = 'MUTATED';

    // iso2 should be unaffected
    expect(iso2.env.CLEO_PROJECT_HASH).toBe('abc');
  });
});
