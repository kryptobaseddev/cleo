/**
 * Tests for git checkpoint (git-checkpoint.ts).
 * @task T4552
 * @epic T4545
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies
vi.mock('../json.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/paths.js', () => ({
  getCleoDir: vi.fn().mockReturnValue('.cleo'),
  getConfigPath: vi.fn().mockReturnValue('.cleo/config.json'),
}));

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      cmd: string,
      args: string[],
      opts: unknown,
      cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => {
      // Default: return failure (not in git repo)
      if (typeof opts === 'function') {
        (opts as (err: Error | null, result: { stdout: string; stderr: string }) => void)(
          new Error('not a git repo'),
          { stdout: '', stderr: '' },
        );
        return;
      }
      cb(new Error('not a git repo'), { stdout: '', stderr: '' });
    },
  ),
}));

import { loadCheckpointConfig, loadStateFileAllowlist } from '../git-checkpoint.js';
import { readJson } from '../json.js';

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

describe('gitCheckpoint commit args', () => {
  it('includes -- path restriction to prevent sweeping pre-staged project files', async () => {
    // Structural test: verify the commit call in git-checkpoint.ts
    // includes '--' followed by file paths, not just bare 'git commit -m ...'
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/store/git-checkpoint.ts'), 'utf-8');
    // Verify the commit args include '--' path restriction
    expect(src).toMatch(/commitArgs\.push\(['"]--['"]/);
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

describe('loadStateFileAllowlist', () => {
  const mockedReadJson = vi.mocked(readJson);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty array when no config exists', async () => {
    mockedReadJson.mockResolvedValue(null);
    const result = await loadStateFileAllowlist();
    expect(result).toEqual([]);
  });

  it('should return empty array when checkpoint key is absent', async () => {
    mockedReadJson.mockResolvedValue({ gitCheckpoint: { enabled: true } });
    const result = await loadStateFileAllowlist();
    expect(result).toEqual([]);
  });

  it('should return empty array when stateFileAllowlist is not an array', async () => {
    mockedReadJson.mockResolvedValue({ checkpoint: { stateFileAllowlist: 'not-array' } });
    const result = await loadStateFileAllowlist();
    expect(result).toEqual([]);
  });

  it('should return allowlist entries from config', async () => {
    mockedReadJson.mockResolvedValue({
      checkpoint: { stateFileAllowlist: ['custom.json', 'my-data/'] },
    });
    const result = await loadStateFileAllowlist();
    expect(result).toEqual(['custom.json', 'my-data/']);
  });

  it('should filter out non-string entries', async () => {
    mockedReadJson.mockResolvedValue({
      checkpoint: { stateFileAllowlist: ['valid.json', 42, null, 'also-valid/'] },
    });
    const result = await loadStateFileAllowlist();
    expect(result).toEqual(['valid.json', 'also-valid/']);
  });

  it('should return empty array when readJson throws', async () => {
    mockedReadJson.mockRejectedValue(new Error('corrupt config'));
    const result = await loadStateFileAllowlist();
    expect(result).toEqual([]);
  });
});

describe('state file merging', () => {
  it('core STATE_FILES are always present in the source', async () => {
    // Structural: verify the hardcoded array includes the expected core files
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/store/git-checkpoint.ts'), 'utf-8');
    expect(src).toContain("'config.json'");
    expect(src).toContain("'project-info.json'");
    expect(src).toContain("'project-context.json'");
    expect(src).toContain("'adrs/'");
    expect(src).toContain("'agent-outputs/'");
  });

  it('getAllStateFiles merges core and config allowlist', async () => {
    // Structural: verify getAllStateFiles spreads both STATE_FILES and custom
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(process.cwd(), 'src/store/git-checkpoint.ts'), 'utf-8');
    expect(src).toMatch(/\[\.\.\.STATE_FILES,\s*\.\.\.custom\]/);
  });
});
