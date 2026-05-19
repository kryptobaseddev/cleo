/**
 * Unit tests for `getEffectiveHead` (T9600 / T-WT-1).
 *
 * Covers:
 *  - No taskId → returns "HEAD"
 *  - Branch exists → returns "task/<taskId>"
 *  - Branch absent (git rev-parse exits non-zero) → returns "HEAD"
 *  - git binary fails entirely → returns "HEAD"
 *
 * @task T9600
 * @task T-WT-1
 * @epic T9586
 */

import { describe, expect, it, vi } from 'vitest';
import { getEffectiveHead } from '../effective-head.js';

// ---------------------------------------------------------------------------
// Mock child_process so tests never invoke a real git binary
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

const mockExecFileSync = vi.mocked(execFileSync);

describe('getEffectiveHead', () => {
  const PROJECT_ROOT = '/fake/project';

  it('returns "HEAD" when no taskId is provided', async () => {
    const result = await getEffectiveHead(PROJECT_ROOT);
    expect(result).toBe('HEAD');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns "HEAD" when taskId is undefined', async () => {
    const result = await getEffectiveHead(PROJECT_ROOT, undefined);
    expect(result).toBe('HEAD');
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it('returns "task/<taskId>" when the branch exists', async () => {
    mockExecFileSync.mockReturnValueOnce(Buffer.from(''));
    const result = await getEffectiveHead(PROJECT_ROOT, 'T123');
    expect(result).toBe('task/T123');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--verify', 'refs/heads/task/T123'],
      { cwd: PROJECT_ROOT, stdio: 'ignore' },
    );
  });

  it('returns "HEAD" when the branch does not exist (rev-parse exits non-zero)', async () => {
    mockExecFileSync.mockImplementationOnce(() => {
      const err = new Error('fatal: ambiguous argument');
      Object.assign(err, { status: 128 });
      throw err;
    });
    const result = await getEffectiveHead(PROJECT_ROOT, 'T999');
    expect(result).toBe('HEAD');
  });

  it('returns "HEAD" when git binary fails entirely', async () => {
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('ENOENT: git not found');
    });
    const result = await getEffectiveHead(PROJECT_ROOT, 'T456');
    expect(result).toBe('HEAD');
  });
});
