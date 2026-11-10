import * as caamp from '@cleocode/caamp';
import type { CLEOSpawnAdapter, CLEOSpawnResult } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as spawnAdapters from '../../spawn/adapter-registry.js';
import { spawnRegistry } from '../../spawn/adapter-registry.js';
import { selectHarnessSpawnProvider } from '../spawn-provider-selection.js';

const TEST_SPAWN_RESULT: CLEOSpawnResult = {
  instanceId: 'test-instance',
  output: '',
  exitCode: 0,
  taskId: 'T-test',
  providerId: 'claude-code',
  timing: {
    startTime: '2026-04-24T00:00:00.000Z',
  },
};

function createTestAdapter(canSpawnResult: boolean): CLEOSpawnAdapter {
  return {
    id: 'harness-test-claude-code',
    providerId: 'claude-code',
    canSpawn: async () => canSpawnResult,
    spawn: async () => TEST_SPAWN_RESULT,
    listRunning: async () => [],
    terminate: async (_instanceId: string) => {},
  };
}

describe('selectHarnessSpawnProvider', () => {
  beforeEach(() => {
    spawnRegistry.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    spawnRegistry.clear();
  });

  it('requires at least one capability', async () => {
    const result = await selectHarnessSpawnProvider([]);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(result.error?.exitCode).toBe(2);
  });

  it('selects a registered adapter through the core harness boundary', async () => {
    spawnRegistry.register(createTestAdapter(true));

    const result = await selectHarnessSpawnProvider(['supportsSubagents', 'supportsParallelSpawn']);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({
      providerId: 'claude-code',
      adapterId: 'harness-test-claude-code',
      capabilities: ['supportsSubagents', 'supportsParallelSpawn'],
    });
  });

  it('reports unavailable adapters before returning a provider selection', async () => {
    spawnRegistry.register(createTestAdapter(false));

    const result = await selectHarnessSpawnProvider(['supportsSubagents']);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_SPAWN_ADAPTER_UNAVAILABLE');
    expect(result.error?.exitCode).toBe(63);
    expect(result.error?.fix).toContain('--adapter');
    expect(result.error?.fix).toContain('harness-test-claude-code: cannot spawn');
    expect(result.error?.fix).toContain('cursor: manifest does not support spawning');
  });

  it('explains missing providers and every discovered adapter', async () => {
    vi.spyOn(caamp, 'getProvidersBySpawnCapability').mockReturnValue([]);
    const result = await selectHarnessSpawnProvider(['supportsSubagents']);
    expect(result.error?.code).toBe('E_SPAWN_NO_PROVIDER');
    expect(result.error?.fix).toContain(
      'cleo orchestrate spawn-execute <taskId> --adapter claude-code',
    );
    expect(result.error?.fix).toContain('cleo orchestrate lead <epicId> --adapter <id>');
    expect(result.error?.fix).toContain('claude-code:');
    expect(result.error?.fix).toContain('cursor: manifest does not support spawning');
  });

  it('explains missing registrations when discovery cannot load a spawn provider', async () => {
    vi.spyOn(spawnAdapters, 'initializeDefaultAdapters').mockResolvedValue();
    const result = await selectHarnessSpawnProvider(['supportsSubagents']);
    expect(result.error?.code).toBe('E_SPAWN_NO_ADAPTER');
    expect(result.error?.fix).toContain('--adapter');
    expect(result.error?.fix).toContain('claude-code: spawn provider not registered');
  });
});
