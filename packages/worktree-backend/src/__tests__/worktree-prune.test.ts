/**
 * Tests for worktree prune operation.
 *
 * @task T1161
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeProjectHash } from '../paths.js';
import { pruneWorktrees } from '../worktree-prune.js';

/** Creates a fake project root (just a dir, no git) with some fake worktrees. */
function setupFakeProject(): {
  projectRoot: string;
  worktreeRoot: string;
  taskDirs: string[];
  cleanup: () => void;
} {
  const base = join(tmpdir(), `prune-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const projectRoot = join(base, 'project');
  mkdirSync(projectRoot, { recursive: true });

  const hash = computeProjectHash(projectRoot);
  const cleo = process.env['CLEO_HOME'];
  process.env['CLEO_HOME'] = base;

  // Create fake worktree directories
  const worktreeRoot = join(base, 'worktrees', hash);
  const t1 = join(worktreeRoot, 'T1001');
  const t2 = join(worktreeRoot, 'T1002');
  const t3 = join(worktreeRoot, 'T1003');
  mkdirSync(t1, { recursive: true });
  mkdirSync(t2, { recursive: true });
  mkdirSync(t3, { recursive: true });

  return {
    projectRoot,
    worktreeRoot,
    taskDirs: [t1, t2, t3],
    cleanup: () => {
      if (cleo === undefined) {
        delete process.env['CLEO_HOME'];
      } else {
        process.env['CLEO_HOME'] = cleo;
      }
      rmSync(base, { recursive: true });
    },
  };
}

describe('pruneWorktrees', () => {
  it('removes directories not in preserveTaskIds', () => {
    const { projectRoot, worktreeRoot, cleanup } = setupFakeProject();

    try {
      const result = pruneWorktrees({
        projectRoot,
        preserveTaskIds: new Set(['T1001']), // preserve only T1001
        gitPrune: false, // skip git commands since this isn't a real repo
      });

      // T1002 and T1003 should be removed
      expect(result.removed).toBe(2);
      expect(result.removedPaths).toHaveLength(2);
      expect(existsSync(join(worktreeRoot, 'T1001'))).toBe(true);
      expect(existsSync(join(worktreeRoot, 'T1002'))).toBe(false);
      expect(existsSync(join(worktreeRoot, 'T1003'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('preserves all when preserveTaskIds contains all task IDs', () => {
    const { projectRoot, worktreeRoot, cleanup } = setupFakeProject();

    try {
      const result = pruneWorktrees({
        projectRoot,
        preserveTaskIds: new Set(['T1001', 'T1002', 'T1003']),
        gitPrune: false,
      });

      expect(result.removed).toBe(0);
      expect(result.removedPaths).toHaveLength(0);
      expect(existsSync(join(worktreeRoot, 'T1001'))).toBe(true);
      expect(existsSync(join(worktreeRoot, 'T1002'))).toBe(true);
      expect(existsSync(join(worktreeRoot, 'T1003'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('removes all when preserveTaskIds is empty set', () => {
    const { projectRoot, cleanup } = setupFakeProject();

    try {
      const result = pruneWorktrees({
        projectRoot,
        preserveTaskIds: new Set<string>(),
        gitPrune: false,
      });

      expect(result.removed).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('does nothing when preserveTaskIds is undefined (no dir removal)', () => {
    const { projectRoot, worktreeRoot, cleanup } = setupFakeProject();

    try {
      const result = pruneWorktrees({
        projectRoot,
        // preserveTaskIds not set — only git prune runs, no dir removal
        gitPrune: false,
      });

      expect(result.removed).toBe(0);
      expect(existsSync(join(worktreeRoot, 'T1001'))).toBe(true);
      expect(existsSync(join(worktreeRoot, 'T1002'))).toBe(true);
      expect(existsSync(join(worktreeRoot, 'T1003'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('returns gitPruneRan=false when gitPrune is false', () => {
    const { projectRoot, cleanup } = setupFakeProject();

    try {
      const result = pruneWorktrees({
        projectRoot,
        preserveTaskIds: new Set<string>(),
        gitPrune: false,
      });

      expect(result.gitPruneRan).toBe(false);
    } finally {
      cleanup();
    }
  });
});
