/**
 * Tests for git checkpoint (git-checkpoint.ts).
 * @task T4552
 * @epic T4545
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies
vi.mock('../json.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/paths.js', () => ({
  getCleoDir: vi.fn().mockReturnValue('.cleo'),
  getConfigPath: vi.fn().mockReturnValue('.cleo/config.json'),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn((cmd: string, args: string[], opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    // Default: return failure (not in git repo)
    if (typeof opts === 'function') {
      (opts as Function)(new Error('not a git repo'), { stdout: '', stderr: '' });
      return;
    }
    cb(new Error('not a git repo'), { stdout: '', stderr: '' });
  }),
}));

import { loadCheckpointConfig } from '../git-checkpoint.js';

describe('loadCheckpointConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return defaults when no config exists', async () => {
    const config = await loadCheckpointConfig();

    expect(config.enabled).toBe(true);
    expect(config.debounceMinutes).toBe(5);
    expect(config.messagePrefix).toBe('chore(cleo):');
    expect(config.noVerify).toBe(true);
  });
});

describe('shouldCheckpoint', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GIT_CHECKPOINT_SUPPRESS'];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should return false when suppressed', async () => {
    process.env['GIT_CHECKPOINT_SUPPRESS'] = 'true';

    // Import fresh to get the function
    const { shouldCheckpoint } = await import('../git-checkpoint.js');
    const result = await shouldCheckpoint();
    expect(result).toBe(false);
  });
});
