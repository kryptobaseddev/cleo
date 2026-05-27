/**
 * Tests for checkpoint CLI command (native citty).
 * @task T4551
 * @epic T4545
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../../../../core/src/store/json.js', () => ({
  readJson: vi.fn().mockResolvedValue(null),
}));

// T633: use importActual + spread to preserve ALL OTHER paths.js exports.
// Replacing the whole module breaks any test that runs later in the same shard
// and tries to call other paths.js functions (getBrainDbPath, getCleoHome, etc.)
// which hit the polluted module from vitest's registry.
vi.mock('../../../../core/src/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../core/src/paths.js')>(
    '../../../../core/src/paths.js',
  );
  return {
    ...actual,
    getCleoDir: vi.fn().mockReturnValue('.cleo'),
    getConfigPath: vi.fn().mockReturnValue('.cleo/config.json'),
  };
});

import { checkpointCommand } from '../commands/checkpoint.js';

describe('checkpointCommand (native citty)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exports a command with the correct name', () => {
    expect(checkpointCommand).toBeDefined();
    const meta =
      typeof checkpointCommand.meta === 'function'
        ? checkpointCommand.meta()
        : checkpointCommand.meta;
    expect((meta as { name: string }).name).toBe('checkpoint');
  });

  it('has a description containing "Git checkpoint"', () => {
    const meta =
      typeof checkpointCommand.meta === 'function'
        ? checkpointCommand.meta()
        : checkpointCommand.meta;
    expect((meta as { description: string }).description).toContain('Git checkpoint');
  });

  it('defines --status and --dry-run args', () => {
    const args = checkpointCommand.args as Record<string, { type: string }> | undefined;
    expect(args).toBeDefined();
    expect(args?.['status']).toBeDefined();
    expect(args?.['status'].type).toBe('boolean');
    expect(args?.['dry-run']).toBeDefined();
    expect(args?.['dry-run'].type).toBe('boolean');
  });
});
