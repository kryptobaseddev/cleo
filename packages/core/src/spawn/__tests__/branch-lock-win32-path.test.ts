/**
 * T12605 — the worker's PATH must put the git shim first on every platform.
 *
 * `buildWorktreeSpawnResult` built PATH as `${shimDir}:${PATH}`. On Windows
 * the delimiter is `;`, so the shim dir fused with the first real entry and
 * both were lost: `git` never resolved to the shim and branch protection was
 * silently absent. `ensureGitShimDir` installed an extensionless symlink,
 * which PATHEXT never matches.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import type { AgentWorktreeState } from '@cleocode/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildWorktreeSpawnResult } from '../branch-lock.js';

const realPlatform = process.platform;
const WIN_PATH = 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd';
const SHIM_DIR = 'C:\\repo\\.cleo\\bin\\git-shim';

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

const worktree: AgentWorktreeState = {
  path: 'C:\\wt\\T1',
  branch: 'task/T1',
  taskId: 'T1',
  baseRef: 'main',
  projectHash: 'abc',
  createdAt: '2026-09-28T00:00:00.000Z',
  locked: false,
};

afterEach(() => {
  setPlatform(realPlatform);
  vi.unstubAllEnvs();
});

describe('buildWorktreeSpawnResult PATH on win32 (T12605)', () => {
  it('prepends the shim with ";" so every real PATH entry survives', () => {
    setPlatform('win32');
    vi.stubEnv('PATH', WIN_PATH);
    const { envVars } = buildWorktreeSpawnResult(worktree, SHIM_DIR);
    expect(envVars['PATH']).toBe(`${SHIM_DIR};${WIN_PATH}`);
    expect(envVars['PATH']?.split(win32.delimiter)).toEqual([
      SHIM_DIR,
      'C:\\Windows\\system32',
      'C:\\Program Files\\Git\\cmd',
    ]);
  });

  it('keeps ":" on POSIX', () => {
    setPlatform('linux');
    vi.stubEnv('PATH', '/usr/bin:/bin');
    const { envVars } = buildWorktreeSpawnResult(worktree, '/repo/.cleo/bin/git-shim');
    expect(envVars['PATH']).toBe('/repo/.cleo/bin/git-shim:/usr/bin:/bin');
  });
});

describe('ensureGitShimDir launcher on win32 (T12605)', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('writes a git.cmd launcher, not an extensionless symlink', async () => {
    const { ensureGitShimDir } = await import('../branch-lock.js');
    root = mkdtempSync(join(tmpdir(), 'shim-win32-'));
    const shimBin = join(root, 'shim.js');
    writeFileSync(shimBin, '// shim\n');
    setPlatform('win32');
    const shim = ensureGitShimDir(root, shimBin);
    setPlatform(realPlatform);
    expect(shim.installed).toBe(true);
    const cmd = readFileSync(join(shim.dir, 'git.cmd'), 'utf-8');
    expect(cmd).toContain(shimBin);
    expect(cmd).toContain('%*');
  });
});
