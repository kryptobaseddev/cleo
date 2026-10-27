/**
 * The core spawn path provisions worktrees ONLY through the
 * `@cleocode/worktree` facade (T10872 / T10873). With the facade stubbed,
 * `spawnWorktree` (orchestrate spawn) and `createAgentWorktree` (the
 * branch-lock replacement path, T10858) must hand `createWorktree` the task,
 * and core itself must never shell out to `git worktree add`.
 *
 * @task T10872
 * @task T10873
 */

import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CreateWorktreeOptions } from '@cleocode/contracts';
import { computeProjectHash, resolveTaskWorktreePath } from '@cleocode/paths';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { gitCalls, createCalls } = vi.hoisted(() => ({
  gitCalls: [] as string[][],
  createCalls: [] as { projectRoot: string; options: CreateWorktreeOptions }[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: (file: string, args?: readonly string[], options?: ExecFileSyncOptions) => {
      if (file === 'git') gitCalls.push([...(args ?? [])]);
      return actual.execFileSync(file, args ?? [], options);
    },
  };
});

vi.mock('@cleocode/worktree', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/worktree')>()),
  createWorktree: async (projectRoot: string, options: CreateWorktreeOptions) => {
    createCalls.push({ projectRoot, options });
    const projectHash = computeProjectHash(projectRoot);
    return {
      path: resolveTaskWorktreePath(projectHash, options.taskId),
      branch: `task/${options.taskId}`,
      baseRef: 'main',
      taskId: options.taskId,
      projectHash,
      createdAt: new Date().toISOString(),
      locked: true,
      reused: false,
    };
  },
}));

import { spawnWorktree } from '../../sentient/worktree-dispatch.js';
import { createAgentWorktree } from '../branch-lock.js';

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'spawn-facade-')));
  gitCalls.length = 0;
  createCalls.length = 0;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Any `git worktree add`, with or without a leading `-C <dir>`. */
function rawWorktreeAdds(): string[][] {
  return gitCalls.filter((args) => {
    const at = args[0] === '-C' ? 2 : 0;
    return args[at] === 'worktree' && args[at + 1] === 'add';
  });
}

describe('core spawn provisions through the @cleocode/worktree facade (T10872)', () => {
  it('the git recorder sees git calls made through node:child_process (guards the guard)', () => {
    execFileSync('git', ['--version'], { encoding: 'utf-8' });
    expect(gitCalls).toContainEqual(['--version']);
  });

  it('spawnWorktree hands createWorktree the task and returns its canonical XDG path', async () => {
    const result = await spawnWorktree(root, {
      taskId: 'T10872',
      skipInstall: true,
      gitShim: { dir: join(root, 'shim'), installed: false },
    });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.projectRoot).toBe(root);
    expect(createCalls[0]?.options.taskId).toBe('T10872');
    expect(result.path).toBe(resolveTaskWorktreePath(computeProjectHash(root), 'T10872'));
    expect(rawWorktreeAdds()).toEqual([]);
  });

  it('createAgentWorktree (the branch-lock replacement path) delegates to createWorktree', async () => {
    const state = await createAgentWorktree('T10873', root);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0]?.options).toMatchObject({
      taskId: 'T10873',
      applyIncludePatterns: false,
      skipInstall: true,
    });
    expect(state.path).toBe(resolveTaskWorktreePath(computeProjectHash(root), 'T10873'));
    expect(rawWorktreeAdds()).toEqual([]);
  });
});
