/**
 * Tests for the declarative worktree hooks framework.
 *
 * @task T1161
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeHook } from '@cleocode/contracts';
import type {
  HookExecutor,
  HookInvocation,
  HookOutcome,
} from '@cleocode/contracts/project-hooks.js';
import { describe, expect, it } from 'vitest';
import { runProjectWorktreeHooks, runWorktreeHooks } from '../worktree-hooks.js';

describe('runWorktreeHooks', () => {
  it('returns empty array when no matching hooks exist', async () => {
    const hooks: WorktreeHook[] = [{ command: 'echo hello', event: 'post-start' }];
    const results = await runWorktreeHooks(hooks, 'post-create', tmpdir());
    expect(results).toHaveLength(0);
  });

  it('runs post-create hooks and returns results', async () => {
    const hooks: WorktreeHook[] = [{ command: 'echo "hello-create"', event: 'post-create' }];
    const results = await runWorktreeHooks(hooks, 'post-create', tmpdir());
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].stdout).toBe('hello-create');
    expect(results[0].exitCode).toBe(0);
    expect(results[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('captures stderr from failed hooks', async () => {
    const hooks: WorktreeHook[] = [
      { command: 'echo "err-msg" >&2 && exit 1', event: 'post-create' },
    ];
    const results = await runWorktreeHooks(hooks, 'post-create', tmpdir());
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].exitCode).toBe(1);
  });

  it('continues past non-fatal failing hooks', async () => {
    const hooks: WorktreeHook[] = [
      { command: 'exit 1', event: 'post-create', failOnError: false },
      { command: 'echo "second"', event: 'post-create' },
    ];
    const results = await runWorktreeHooks(hooks, 'post-create', tmpdir());
    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
  });

  it('throws on failOnError=true when hook exits non-zero', async () => {
    const hooks: WorktreeHook[] = [{ command: 'exit 2', event: 'post-create', failOnError: true }];
    await expect(runWorktreeHooks(hooks, 'post-create', tmpdir())).rejects.toThrow(
      /Worktree hook failed/,
    );
  });

  it('does not run post-start hooks when called with post-create event', async () => {
    const hooks: WorktreeHook[] = [
      { command: 'exit 99', event: 'post-start', failOnError: true },
      { command: 'echo "ok"', event: 'post-create' },
    ];
    const results = await runWorktreeHooks(hooks, 'post-create', tmpdir());
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
  });

  it('runs hooks in the given CWD', async () => {
    const dir = join(tmpdir(), `hook-cwd-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });

    const hooks: WorktreeHook[] = [{ command: 'pwd', event: 'post-create' }];
    const results = await runWorktreeHooks(hooks, 'post-create', dir);
    expect(realpathSync(results[0].stdout)).toBe(realpathSync(dir));
  });
});

describe('shared project worktree executor port', () => {
  it('passes the actual checkout and lifecycle context without a core dependency', async () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-port-')));
    execFileSync('git', ['init', '-q', path]);
    const requests: HookInvocation[] = [];
    const executor: HookExecutor = {
      execute: async (invocation) => {
        requests.push(invocation);
        return [];
      },
    };
    try {
      await runProjectWorktreeHooks(executor, [], 'post-create', path, 'T13345');
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        projectRoot: path,
        source: 'worktree',
        event: 'post-create',
        worktree: { taskId: 'T13345', path },
      });
      expect(requests[0].gitCommonDir).toBe(join(path, '.git'));
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
  it('rejects explicit duplicate registration before running either check', async () => {
    let called = false;
    const executor: HookExecutor = {
      execute: async () => {
        called = true;
        return [];
      },
    };
    await expect(
      runProjectWorktreeHooks(
        executor,
        [{ command: 'echo no', event: 'post-start', projectHookId: 'setup' }],
        'post-start',
        tmpdir(),
        'T13345',
      ),
    ).rejects.toThrow('HOOK_DUPLICATE_REGISTRATION');
    expect(called).toBe(false);
  });
  it('honors project blocks and allows executor infrastructure faults', async () => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'cleo-port-')));
    execFileSync('git', ['init', '-q', path]);
    const block: HookOutcome = {
      id: 'setup',
      status: 'block',
      blocks: true,
      code: 'HOOK_BLOCK',
      exitCode: 0,
      signal: null,
      durationMs: 0,
    };
    try {
      await expect(
        runProjectWorktreeHooks({ execute: async () => [block] }, [], 'post-start', path, 'T13345'),
      ).rejects.toThrow('HOOK_PROJECT_BLOCK');
      const result = await runProjectWorktreeHooks(
        {
          execute: async () => {
            throw new Error('failure');
          },
        },
        [],
        'post-start',
        path,
        'T13345',
      );
      expect(result[0]).toMatchObject({ status: 'infrastructure-error', blocks: false });
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });
});
