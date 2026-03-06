import { beforeEach, describe, expect, it } from 'vitest';
import {
  initializeDefaultAdapters,
  spawnRegistry,
} from '../adapter-registry.js';

describe('spawn adapter registry', () => {
  beforeEach(() => {
    spawnRegistry.clear();
  });

  it('registers built-in adapters exactly once', async () => {
    await initializeDefaultAdapters();
    await initializeDefaultAdapters();

    const adapters = spawnRegistry.list().map(adapter => adapter.id).sort();
    expect(adapters).toEqual(['claude-code', 'opencode']);
    expect(spawnRegistry.getForProvider('claude-code')?.id).toBe('claude-code');
    expect(spawnRegistry.getForProvider('opencode')?.id).toBe('opencode');
  });

  it('lists registered spawn-capable adapters from CAAMP capabilities', async () => {
    const adapters = await spawnRegistry.listSpawnCapable();
    const ids = adapters.map(adapter => adapter.id).sort();

    expect(ids).toEqual(['claude-code', 'opencode']);
  });
});
