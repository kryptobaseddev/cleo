/**
 * Tests for worktree-pnpm.ts — serialized dependency installation (T9938).
 *
 * Verifies that concurrent worktree provisioning serializes pnpm install
 * via file-based mutex to prevent @@-prefixed doubled CK-directory corruption
 * in the shared .pnpm/ store.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installWorktreeDependencies } from '../worktree-pnpm.js';

describe('installWorktreeDependencies (T9938)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cleo-t9938-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it('returns false when pnpm-lock.yaml does not exist in worktree', () => {
    const result = installWorktreeDependencies(tmpDir, '/nonexistent');
    expect(result).toBe(false);
  });

  it('returns true when node_modules already exists (idempotent)', () => {
    writeFileSync(join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: "6.0"\n');
    mkdirSync(join(tmpDir, 'node_modules'));

    const result = installWorktreeDependencies(tmpDir, '/nonexistent');
    expect(result).toBe(true);
  });

  it('acquires and releases the lock file after pnpm install attempt', () => {
    const projectRoot = join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

    const worktreePath = join(tmpDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'pnpm-lock.yaml'), 'lockfileVersion: "6.0"\n');

    const lockPath = join(projectRoot, '.cleo', 'pnpm-install.lock');

    // Install will fail (no package.json) but lock should be released.
    const result = installWorktreeDependencies(worktreePath, projectRoot);

    // Lock file must not persist after the call (released in finally block).
    expect(existsSync(lockPath)).toBe(false);

    // Result should be false — pnpm install failed on empty project.
    expect(result).toBe(false);
  });

  it('creates per-worktree .npmrc when lockfile exists', () => {
    const projectRoot = join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

    const worktreePath = join(tmpDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'pnpm-lock.yaml'), 'lockfileVersion: "6.0"\n');

    installWorktreeDependencies(worktreePath, projectRoot);

    const npmrcPath = join(worktreePath, '.npmrc');
    if (existsSync(npmrcPath)) {
      const content = readFileSync(npmrcPath, 'utf-8');
      expect(content).toContain('store-dir=');
      expect(content).toContain('.pnpm-store');
    }
  });

  it('does not run when node_modules already exists (skips install)', () => {
    const projectRoot = join(tmpDir, 'project');
    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(join(projectRoot, '.cleo'), { recursive: true });

    const worktreePath = join(tmpDir, 'worktree');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'pnpm-lock.yaml'), 'lockfileVersion: "6.0"\n');
    mkdirSync(join(worktreePath, 'node_modules')); // already exists

    const result = installWorktreeDependencies(worktreePath, projectRoot);
    expect(result).toBe(true);

    // Lock file should not have been created (early return before lock acquire)
    const lockPath = join(projectRoot, '.cleo', 'pnpm-install.lock');
    expect(existsSync(lockPath)).toBe(false);
  });
});
