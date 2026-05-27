/**
 * Focused tests for partial worktree recovery (T10456 / T10457).
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock,
}));

import { detectPartialWorktree, recoverPartialWorktree } from '../recovery.js';

describe('partial worktree recovery', () => {
  let tmpDir: string;
  let worktreePath: string;
  let adminDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cleo-worktree-recovery-'));
    worktreePath = join(tmpDir, 'wt');
    adminDir = join(tmpDir, 'admin');
    mkdirSync(worktreePath, { recursive: true });
    mkdirSync(adminDir, { recursive: true });
    writeFileSync(join(worktreePath, '.git'), `gitdir: ${adminDir}\n`);
    writeFileSync(join(adminDir, 'HEAD'), 'ref: refs/heads/task/T10456\n');
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue('');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects missing node_modules and linked-worktree admin index.lock', () => {
    writeFileSync(join(adminDir, 'index.lock'), 'stale lock');

    const signals = detectPartialWorktree(worktreePath);

    expect(signals).toEqual({
      hasUncommittedChanges: false,
      nodeModulesMissing: true,
      indexLockPresent: true,
      worktreeExists: true,
    });
  });

  it('runs pnpm install and unlocks a linked-worktree stale lock', () => {
    writeFileSync(join(adminDir, 'index.lock'), 'stale lock');

    const result = recoverPartialWorktree(tmpDir, worktreePath, 'T10456');

    expect(result.success).toBe(true);
    expect(result.actions).toContain('pnpm-install');
    expect(result.actions).toContain('unlock-git-index');
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['install'],
      expect.objectContaining({ cwd: worktreePath, timeout: 120_000 }),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'git',
      ['worktree', 'unlock', worktreePath],
      expect.objectContaining({ cwd: tmpDir, timeout: 10_000 }),
    );
    expect(existsSync(join(adminDir, 'index.lock'))).toBe(false);
  });
});
