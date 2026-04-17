/**
 * Conduit factory test suite.
 *
 * Tests `resolveTransport` (transport selection) and `createConduit`
 * (registry-backed Conduit creation).
 *
 * `LocalTransport.isAvailable` is controlled via vi.spyOn so tests do
 * not depend on the filesystem state of the test runner's working directory.
 *
 * @see packages/core/src/conduit/factory.ts
 * @task T180
 */

import type { AgentCredential, AgentRegistryAPI } from '@cleocode/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConduit, resolveTransport } from '../factory.js';
import { HttpTransport } from '../http-transport.js';
import { LocalTransport } from '../local-transport.js';
import { SseTransport } from '../sse-transport.js';

// ============================================================================
// Helpers
// ============================================================================

/** Minimal AgentCredential with no SSE endpoint and an http apiBaseUrl. */
function makeCredential(overrides?: Partial<AgentCredential>): AgentCredential {
  return {
    agentId: 'factory-test-agent',
    displayName: 'Factory Test Agent',
    apiKey: 'sk_live_factory_test',
    apiBaseUrl: 'https://api.signaldock.io',
    privacyTier: 'private',
    capabilities: [],
    skills: [],
    transportType: 'http',
    transportConfig: {},
    isActive: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create a minimal mock AgentRegistryAPI. */
function makeRegistry(credential: AgentCredential | null): AgentRegistryAPI {
  return {
    register: vi.fn(),
    get: vi.fn().mockResolvedValue(credential),
    list: vi.fn().mockResolvedValue(credential ? [credential] : []),
    update: vi.fn(),
    remove: vi.fn(),
    rotateKey: vi.fn(),
    getActive: vi.fn().mockResolvedValue(credential),
    markUsed: vi.fn(),
  } as AgentRegistryAPI;
}

// ============================================================================
// resolveTransport
// ============================================================================

describe('resolveTransport', () => {
  let isAvailableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Default: LocalTransport is NOT available (no conduit.db in test env)
    isAvailableSpy = vi.spyOn(LocalTransport, 'isAvailable').mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // LocalTransport (highest priority)
  // --------------------------------------------------------------------------

  describe('LocalTransport selection', () => {
    it('returns LocalTransport when conduit.db is available', () => {
      isAvailableSpy.mockReturnValue(true);
      const credential = makeCredential();
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(LocalTransport);
    });

    it('prefers LocalTransport even when credential has an SSE endpoint', () => {
      isAvailableSpy.mockReturnValue(true);
      const credential = makeCredential({
        transportConfig: { sseEndpoint: 'https://sse.signaldock.io' },
      });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(LocalTransport);
    });

    it('prefers LocalTransport even when credential is cloud-backed', () => {
      isAvailableSpy.mockReturnValue(true);
      const credential = makeCredential({ apiBaseUrl: 'https://api.signaldock.io' });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(LocalTransport);
    });
  });

  // --------------------------------------------------------------------------
  // SseTransport (second priority)
  // --------------------------------------------------------------------------

  describe('SseTransport selection', () => {
    it('returns SseTransport for cloud-backed agents with an SSE endpoint', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({
        apiBaseUrl: 'https://api.signaldock.io',
        transportConfig: { sseEndpoint: 'https://sse.signaldock.io/sse' },
      });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(SseTransport);
    });

    it('returns SseTransport for legacy clawmsgr.com base URL with SSE endpoint', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({
        apiBaseUrl: 'https://api.clawmsgr.com',
        transportConfig: { sseEndpoint: 'https://api.clawmsgr.com/sse' },
      });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(SseTransport);
    });

    it('does NOT return SseTransport for "local" apiBaseUrl even with sseEndpoint', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({
        apiBaseUrl: 'local',
        transportConfig: { sseEndpoint: 'https://sse.signaldock.io/sse' },
      });
      // "local" apiBaseUrl does not start with "http" — falls back to HttpTransport
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(HttpTransport);
    });
  });

  // --------------------------------------------------------------------------
  // HttpTransport (fallback)
  // --------------------------------------------------------------------------

  describe('HttpTransport selection', () => {
    it('returns HttpTransport when LocalTransport is unavailable and no SSE endpoint', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({
        apiBaseUrl: 'https://api.signaldock.io',
        transportConfig: {},
      });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(HttpTransport);
    });

    it('returns HttpTransport when LocalTransport is unavailable and apiBaseUrl is empty', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({ apiBaseUrl: '' });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(HttpTransport);
    });

    it('returns HttpTransport when LocalTransport is unavailable and apiBaseUrl is "local"', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential({ apiBaseUrl: 'local', transportConfig: {} });
      const transport = resolveTransport(credential);
      expect(transport).toBeInstanceOf(HttpTransport);
    });

    it('returns new HttpTransport instance each call', () => {
      isAvailableSpy.mockReturnValue(false);
      const credential = makeCredential();
      const t1 = resolveTransport(credential);
      const t2 = resolveTransport(credential);
      expect(t1).toBeInstanceOf(HttpTransport);
      expect(t2).toBeInstanceOf(HttpTransport);
      // They should be separate instances (not singletons)
      expect(t1).not.toBe(t2);
    });
  });

  // --------------------------------------------------------------------------
  // Priority ordering
  // --------------------------------------------------------------------------

  describe('priority ordering', () => {
    it('LocalTransport > SseTransport > HttpTransport', () => {
      // With all three conditions met, LocalTransport wins
      isAvailableSpy.mockReturnValue(true);
      const credential = makeCredential({
        apiBaseUrl: 'https://api.signaldock.io',
        transportConfig: { sseEndpoint: 'https://sse.signaldock.io' },
      });
      expect(resolveTransport(credential)).toBeInstanceOf(LocalTransport);

      // Without LocalTransport, SseTransport wins
      isAvailableSpy.mockReturnValue(false);
      expect(resolveTransport(credential)).toBeInstanceOf(SseTransport);

      // Without SSE endpoint, HttpTransport is the fallback
      const noSseCredential = makeCredential({
        apiBaseUrl: 'https://api.signaldock.io',
        transportConfig: {},
      });
      expect(resolveTransport(noSseCredential)).toBeInstanceOf(HttpTransport);
    });
  });
});

// ============================================================================
// createConduit
// ============================================================================

describe('createConduit', () => {
  let isAvailableSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    isAvailableSpy = vi.spyOn(LocalTransport, 'isAvailable').mockReturnValue(false);
    // Stub fetch so HttpTransport.connect() doesn't error (no health probe needed for no-fallback config)
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws when no credential is found (registry returns null)', async () => {
    const registry = makeRegistry(null);
    await expect(createConduit(registry)).rejects.toThrow('No agent credential');
  });

  it('returns a connected Conduit using the active credential when no agentId is given', async () => {
    const credential = makeCredential();
    const registry = makeRegistry(credential);

    // Stub the push that connect() eventually triggers via HttpTransport.connect()
    // HttpTransport.connect() does NOT call fetch when there's no fallback URL
    const conduit = await createConduit(registry);

    expect(registry.getActive).toHaveBeenCalled();
    expect(conduit.agentId).toBe('factory-test-agent');
    expect(conduit.getState()).toBe('connected');
  });

  it('looks up a specific agent when agentId is provided', async () => {
    const credential = makeCredential({ agentId: 'specific-agent' });
    const registry = makeRegistry(credential);

    const conduit = await createConduit(registry, 'specific-agent');

    expect(registry.get).toHaveBeenCalledWith('specific-agent');
    expect(conduit.agentId).toBe('specific-agent');
  });

  it('returns a Conduit whose getState() is "connected" after factory call', async () => {
    const credential = makeCredential();
    const registry = makeRegistry(credential);

    const conduit = await createConduit(registry);
    expect(conduit.getState()).toBe('connected');
  });

  it('throws when specific agentId is not found in registry', async () => {
    const registry = makeRegistry(null);
    (registry.get as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    await expect(createConduit(registry, 'missing-agent')).rejects.toThrow('No agent credential');
  });

  it('uses LocalTransport when conduit.db is available', async () => {
    isAvailableSpy.mockReturnValue(true);

    // LocalTransport.connect() needs a conduit.db — stub it to avoid FS access
    const connectSpy = vi.spyOn(LocalTransport.prototype, 'connect').mockResolvedValue(undefined);

    const credential = makeCredential();
    const registry = makeRegistry(credential);
    const conduit = await createConduit(registry);

    expect(connectSpy).toHaveBeenCalled();
    expect(conduit.getState()).toBe('connected');
  });
});
