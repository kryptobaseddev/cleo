/**
 * Tests for the atomic shell tool primitives (E3 · T11406).
 *
 * Uses an injected executor (no real subprocess) for deterministic assertions,
 * plus one real `node -e` spawn to prove the default executor works end-to-end.
 *
 * @epic T11390
 * @task T11406
 * @saga T11387
 */

import type { ExecuteShellInput, ExecuteShellResult } from '@cleocode/contracts/tools/atomic';
import { describe, expect, it } from 'vitest';
import { executeShell, runGit, type ShellExecutor } from '../shell.js';

/** Records the input it was called with and returns a canned result. */
function spyExecutor(result: ExecuteShellResult): {
  exec: ShellExecutor;
  calls: ExecuteShellInput[];
} {
  const calls: ExecuteShellInput[] = [];
  const exec: ShellExecutor = (input) => {
    calls.push(input);
    return Promise.resolve(result);
  };
  return { exec, calls };
}

describe('executeShell (injected executor)', () => {
  it('passes the input through and returns the executor result', async () => {
    const { exec, calls } = spyExecutor({ stdout: 'ok', stderr: '', code: 0 });
    const res = await executeShell({ command: 'echo', args: ['hi'], cwd: '/tmp' }, exec);
    expect(res).toEqual({ stdout: 'ok', stderr: '', code: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'echo', args: ['hi'], cwd: '/tmp' });
  });

  it('surfaces a non-zero exit code as a result, not an error', async () => {
    const { exec } = spyExecutor({ stdout: '', stderr: 'boom', code: 2 });
    const res = await executeShell({ command: 'false' }, exec);
    expect(res.code).toBe(2);
    expect(res.stderr).toBe('boom');
  });
});

describe('runGit (injected executor)', () => {
  it('prepends command=git and forwards args/cwd/timeout', async () => {
    const { exec, calls } = spyExecutor({ stdout: 'abc123', stderr: '', code: 0 });
    const res = await runGit({ args: ['rev-parse', 'HEAD'], cwd: '/repo', timeoutMs: 5000 }, exec);
    expect(res.stdout).toBe('abc123');
    expect(calls[0]).toEqual({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: '/repo',
      timeoutMs: 5000,
    });
  });
});

describe('default executor (real subprocess)', () => {
  it('runs a real command and captures stdout + exit code 0', async () => {
    const res = await executeShell({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("hello")'],
    });
    expect(res.stdout).toBe('hello');
    expect(res.code).toBe(0);
  });

  it('captures a non-zero exit code from a real process', async () => {
    const res = await executeShell({ command: process.execPath, args: ['-e', 'process.exit(3)'] });
    expect(res.code).toBe(3);
  });
});
