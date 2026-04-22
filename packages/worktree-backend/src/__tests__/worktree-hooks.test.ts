/**
 * Tests for the declarative worktree hooks framework.
 *
 * @task T1161
 */

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorktreeHook } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { runWorktreeHooks } from '../worktree-hooks.js';

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
    expect(results[0].stdout).toBe(dir);
  });
});
