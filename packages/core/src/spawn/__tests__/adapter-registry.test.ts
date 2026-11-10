import type {
  AdapterSpawnProvider,
  CLEOSpawnAdapter,
  CLEOSpawnContext,
  LeadToolStripSupport,
  SpawnContext,
  SpawnResult,
} from '@cleocode/contracts';
import { E_LEAD_TOOLS_UNSTRIPPED, LEAD_DENIED_TOOLS } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bridgeSpawnAdapter,
  initializeDefaultAdapters,
  SpawnAdapterRegistry,
  spawnRegistry,
} from '../adapter-registry.js';

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

    const ids = registry
      .list()
      .map((a) => a.id)
      .sort();
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

describe('bridgeSpawnAdapter lead tool strip (T14357)', () => {
  /** A delegate that records the contract context it receives. */
  function createDelegate(strip?: LeadToolStripSupport): {
    delegate: AdapterSpawnProvider;
    received: SpawnContext[];
  } {
    const received: SpawnContext[] = [];
    const result: SpawnResult = {
      instanceId: 'i1',
      taskId: 'T1',
      providerId: 'p',
      status: 'completed',
      startTime: '2026-11-10T00:00:00.000Z',
    };
    const delegate: AdapterSpawnProvider = {
      ...(strip !== undefined ? { leadToolStrip: strip } : {}),
      canSpawn: async () => true,
      spawn: async (context) => {
        received.push(context);
        return result;
      },
      listRunning: async () => [],
      terminate: async () => {},
    };
    return { delegate, received };
  }

  const base: CLEOSpawnContext = {
    taskId: 'T1',
    protocol: 'implementation',
    prompt: 'go',
    provider: 'p',
    options: { prompt: 'go' },
  };
  const lead: CLEOSpawnContext = { ...base, leadDeniedTools: LEAD_DENIED_TOOLS };

  it('forwards leadDeniedTools to a delegate that enforces the strip', async () => {
    const { delegate, received } = createDelegate('enforced');
    await bridgeSpawnAdapter('p', delegate).spawn(lead);
    expect(received).toHaveLength(1);
    expect(received[0]?.leadDeniedTools).toEqual([...LEAD_DENIED_TOOLS]);
  });

  it.each<[string, LeadToolStripSupport | undefined]>([
    ['unsupported', 'unsupported'],
    ['absent', undefined],
  ])('refuses a lead spawn when the declaration is %s, before the delegate runs', async (_label, strip) => {
    const { delegate, received } = createDelegate(strip);
    await expect(bridgeSpawnAdapter('p', delegate).spawn(lead)).rejects.toMatchObject({
      code: E_LEAD_TOOLS_UNSTRIPPED,
    });
    expect(received).toHaveLength(0);
  });

  it('passes worker spawns through unchanged on any provider', async () => {
    const { delegate, received } = createDelegate();
    await bridgeSpawnAdapter('p', delegate).spawn(base);
    await bridgeSpawnAdapter('p', delegate).spawn({ ...base, leadDeniedTools: [] });
    expect(received).toHaveLength(2);
    for (const ctx of received) expect(ctx.leadDeniedTools).toBeUndefined();
  });

  it('preserves the allocated worker binding and protocol authority across the execution bridge', async () => {
    const { delegate, received } = createDelegate();
    const context: CLEOSpawnContext = {
      ...base,
      workerSession: { sessionId: 'ses_worker', agentId: 'agent-t1' },
      coordinatorSessionId: 'ses_coordinator',
      protocolResolution: { protocol: 'implementation', source: 'pipelineStage', conflicts: [] },
    };
    await bridgeSpawnAdapter('p', delegate).spawn(context);
    expect(received[0]?.workerSession).toEqual(context.workerSession);
    expect(received[0]?.coordinatorSessionId).toBe('ses_coordinator');
    expect(received[0]?.protocolResolution).toEqual(context.protocolResolution);
  });
});
