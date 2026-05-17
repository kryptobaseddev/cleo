/**
 * Unit tests for the 60-second supervisor timeout added to `runGitWithLockRetry`
 * and all `execFileSync('git'|'gh', ...)` call-sites in `engine-ops.ts`.
 *
 * Problem (T9501): `runGitWithLockRetry` used `execFileSync` with NO supervisor
 * timeout. When the `git` child process hanged (e.g. waiting for a network
 * remote), the parent process stayed wedged indefinitely. PID 4011255 required
 * a manual kill during `cleo release ship v2026.5.74`.
 *
 * Fix: every `execFileSync('git'|'gh', ...)` call now carries `timeout: 60_000`.
 * `runGitWithLockRetry` detects `ETIMEDOUT` / killed-by-timeout and:
 *   1. Cleans up any stale `.git/index.lock`
 *   2. Throws `Error('git timeout after 60s: git <args>')` — never swallows silently.
 *
 * @task T9501
 */

import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runGitWithLockRetry } from '../engine-ops.js';

// ---------------------------------------------------------------------------
// Mock node:child_process so we control execFileSync without spawning real git.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(),
    spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
  };
});

const mockExecFileSync = vi.mocked(execFileSync);

describe('runGitWithLockRetry — supervisor timeout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path: no timeout needed
  // -------------------------------------------------------------------------

  it('returns output on success', () => {
    mockExecFileSync.mockReturnValue('abc123\n' as never);

    const result = runGitWithLockRetry(['rev-parse', 'HEAD'], { cwd: '/tmp', stdio: 'pipe' });

    expect(result).toBe('abc123\n');
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Timeout detection via error code ETIMEDOUT
  // -------------------------------------------------------------------------

  it('throws "git timeout" error when execFileSync signals ETIMEDOUT', () => {
    const timeoutErr = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    mockExecFileSync.mockImplementation(() => {
      throw timeoutErr;
    });

    expect(() =>
      runGitWithLockRetry(['push', 'origin', 'main'], { cwd: '/tmp', stdio: 'pipe' }),
    ).toThrowError(/git timeout after \d+s: git push origin main/);
  });

  it('timeout error message includes the full git command', () => {
    const timeoutErr = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    mockExecFileSync.mockImplementation(() => {
      throw timeoutErr;
    });

    let caught: Error | undefined;
    try {
      runGitWithLockRetry(['fetch', '--tags', 'origin'], { cwd: '/repo', stdio: 'pipe' });
    } catch (e) {
      caught = e as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/git timeout/);
    expect(caught!.message).toContain('git fetch --tags origin');
  });

  // -------------------------------------------------------------------------
  // Timeout detection via `.killed === true` (Node sends SIGTERM on timeout)
  // -------------------------------------------------------------------------

  it('throws "git timeout" error when process is killed (SIGTERM) by timeout', () => {
    const killedErr = Object.assign(new Error('Command timed out'), {
      killed: true,
    });
    mockExecFileSync.mockImplementation(() => {
      throw killedErr;
    });

    expect(() =>
      runGitWithLockRetry(['commit', '-m', 'test'], { cwd: '/tmp', stdio: 'pipe' }),
    ).toThrowError(/git timeout after \d+s/);
  });

  // -------------------------------------------------------------------------
  // Timeout detection via error message substring (fallback)
  // -------------------------------------------------------------------------

  it('throws "git timeout" error on spawnSync ETIMEDOUT message pattern', () => {
    const msgErr = new Error('spawnSync git ETIMEDOUT');
    mockExecFileSync.mockImplementation(() => {
      throw msgErr;
    });

    expect(() =>
      runGitWithLockRetry(['tag', '-a', 'v1.0.0', '-m', 'release'], {
        cwd: '/repo',
        stdio: 'pipe',
      }),
    ).toThrowError(/git timeout/);
  });

  // -------------------------------------------------------------------------
  // Timeout does NOT retry — fails immediately (no lock-retry on hung process)
  // -------------------------------------------------------------------------

  it('does NOT retry on timeout — fails on first attempt', () => {
    const timeoutErr = Object.assign(new Error('spawnSync git ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    mockExecFileSync.mockImplementation(() => {
      throw timeoutErr;
    });

    expect(() =>
      runGitWithLockRetry(['push', 'origin', 'main'], { cwd: '/tmp', stdio: 'pipe' }, 3),
    ).toThrow();

    // Called exactly once — timeout short-circuits all retries
    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Timeout always injects 60_000 when caller omits a timeout
  // -------------------------------------------------------------------------

  it('injects timeout:60_000 when caller opts has no timeout field', () => {
    mockExecFileSync.mockReturnValue('ok' as never);

    runGitWithLockRetry(['status'], { cwd: '/tmp', encoding: 'utf-8', stdio: 'pipe' });

    const calledOpts = mockExecFileSync.mock.calls[0]![2] as { timeout?: number };
    expect(calledOpts).toHaveProperty('timeout', 60_000);
  });

  it('preserves caller-supplied timeout when provided', () => {
    mockExecFileSync.mockReturnValue('ok' as never);

    runGitWithLockRetry(['status'], {
      cwd: '/tmp',
      encoding: 'utf-8',
      stdio: 'pipe',
      timeout: 120_000,
    });

    const calledOpts = mockExecFileSync.mock.calls[0]![2] as { timeout?: number };
    expect(calledOpts).toHaveProperty('timeout', 120_000);
  });

  // -------------------------------------------------------------------------
  // Lock-conflict retry still works (regression guard)
  // -------------------------------------------------------------------------

  it('retries on stale-lock error and succeeds on second attempt', () => {
    const lockErr = Object.assign(new Error('lock conflict'), {
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists",
    });
    mockExecFileSync
      .mockImplementationOnce(() => {
        throw lockErr;
      })
      .mockReturnValueOnce('success' as never);

    const result = runGitWithLockRetry(['add', 'CHANGELOG.md'], {
      cwd: '/repo',
      encoding: 'utf-8',
      stdio: 'pipe',
    });

    expect(result).toBe('success');
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  it('throws the last lock error after exhausting all retries', () => {
    const lockErr = Object.assign(new Error('lock conflict'), {
      stderr: "fatal: Unable to create '/repo/.git/index.lock': File exists",
    });
    mockExecFileSync.mockImplementation(() => {
      throw lockErr;
    });

    // maxRetries=1 → 2 attempts total
    expect(() =>
      runGitWithLockRetry(['add', 'file.ts'], { cwd: '/repo', stdio: 'pipe' }, 1),
    ).toThrow();

    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // Non-lock, non-timeout errors propagate immediately
  // -------------------------------------------------------------------------

  it('propagates non-lock non-timeout errors immediately without retry', () => {
    const otherErr = new Error('fatal: not a git repository');
    mockExecFileSync.mockImplementation(() => {
      throw otherErr;
    });

    expect(() => runGitWithLockRetry(['status'], { cwd: '/not-a-repo', stdio: 'pipe' }, 3)).toThrow(
      'fatal: not a git repository',
    );

    expect(mockExecFileSync).toHaveBeenCalledOnce();
  });
});
