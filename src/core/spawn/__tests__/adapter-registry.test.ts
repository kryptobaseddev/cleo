import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SpawnAdapterRegistry,
  initializeDefaultAdapters,
  spawnRegistry,
} from '../adapter-registry.js';
import type { CLEOSpawnAdapter } from '../../../types/spawn.js';

/**
 * Create a minimal mock CLEOSpawnAdapter for testing registry operations.
 */
function createMockAdapter(id: string, providerId: string): CLEOSpawnAdapter {
  return {
    id,
    providerId,
    canSpawn: vi.fn().mockResolvedValue(true),
    spawn: vi.fn(),
    listRunning: vi.fn().mockResolvedValue([]),
    terminate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SpawnAdapterRegistry', () => {
  let registry: SpawnAdapterRegistry;

  beforeEach(() => {
    registry = new SpawnAdapterRegistry();
  });

  it('registers and retrieves an adapter by ID', () => {
    const adapter = createMockAdapter('test-adapter', 'test-provider');
    registry.register(adapter);

    expect(registry.get('test-adapter')).toBe(adapter);
  });

  it('retrieves an adapter by provider ID', () => {
    const adapter = createMockAdapter('test-adapter', 'test-provider');
    registry.register(adapter);

    expect(registry.getForProvider('test-provider')).toBe(adapter);
  });

  it('returns undefined for unknown adapter or provider', () => {
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.getForProvider('nonexistent')).toBeUndefined();
  });

  it('checks if adapter exists for a provider', () => {
    const adapter = createMockAdapter('cc', 'claude-code');
    registry.register(adapter);

    expect(registry.hasAdapterForProvider('claude-code')).toBe(true);
    expect(registry.hasAdapterForProvider('opencode')).toBe(false);
  });

  it('lists all registered adapters', () => {
    const a1 = createMockAdapter('cc', 'claude-code');
    const a2 = createMockAdapter('oc', 'opencode');
    registry.register(a1);
    registry.register(a2);

    const ids = registry.list().map((a) => a.id).sort();
    expect(ids).toEqual(['cc', 'oc']);
  });

  it('clears all registrations', () => {
    const adapter = createMockAdapter('cc', 'claude-code');
    registry.register(adapter);
    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.hasAdapterForProvider('claude-code')).toBe(false);
  });
});

describe('initializeDefaultAdapters', () => {
  beforeEach(() => {
    spawnRegistry.clear();
  });

  it('does not throw when adapter packages are unavailable', async () => {
    // initializeDefaultAdapters catches import errors gracefully
    await expect(initializeDefaultAdapters()).resolves.not.toThrow();
  });

  it('is idempotent — calling twice does not duplicate registrations', async () => {
    await initializeDefaultAdapters();
    const countAfterFirst = spawnRegistry.list().length;

    await initializeDefaultAdapters();
    const countAfterSecond = spawnRegistry.list().length;

    expect(countAfterSecond).toBe(countAfterFirst);
  });
});
