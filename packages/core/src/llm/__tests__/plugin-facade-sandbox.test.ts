/**
 * Unit tests for the T9313 plugin facade sandboxing layer.
 *
 * Coverage:
 *  1. Permissions deny — maxTokens cap exceeded → PluginDeniedError.
 *  2. Permissions allow — maxTokens within cap, request succeeds.
 *  3. Permissions deny — role not in allowedRoles → PluginDeniedError.
 *  4. Permissions allow — role in allowedRoles, request succeeds.
 *  5. Filesystem ACL deny — read path outside declared patterns → false.
 *  6. Filesystem ACL allow — read path matches declared pattern → true.
 *  7. Filesystem ACL deny — write path outside declared patterns → false.
 *  8. Filesystem ACL allow — write path matches declared pattern → true.
 *  9. Rate limit exhausted — consecutive calls drain bucket → PluginRateLimitedError.
 * 10. Rate limit refilled — after elapsed time tokens restore, call succeeds.
 *
 * Isolation strategy: `getLlmExecutor` is vi.mock'd so no real credentials,
 * network, or SDK calls are made.
 *
 * @task T9313
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { PluginDeniedError, PluginRateLimitedError } from '@cleocode/contracts';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoisted mock refs
// ---------------------------------------------------------------------------

const { mockAuxiliary, mockGetLlmExecutor } = vi.hoisted(() => ({
  mockAuxiliary: vi.fn<[TransportMessage[], unknown], Promise<NormalizedResponse>>(),
  mockGetLlmExecutor: vi.fn(),
}));

vi.mock('../executor-factory.js', () => ({
  getLlmExecutor: mockGetLlmExecutor,
}));

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  clearPluginRegistry,
  pluginLlmComplete,
  registerPluginManifest,
  validateFsAccess,
} from '../plugin-facade.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides?: Partial<NormalizedResponse>): NormalizedResponse {
  return {
    id: 'resp-sandbox-1',
    model: 'claude-haiku-4-5-20251001',
    content: 'sandbox response',
    toolCalls: null,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: null,
    ...overrides,
  };
}

const MESSAGES: TransportMessage[] = [{ role: 'user', content: 'ping' }];

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockAuxiliary.mockResolvedValue(makeResponse());
  mockGetLlmExecutor.mockResolvedValue({ auxiliary: mockAuxiliary });
});

afterEach(() => {
  vi.resetAllMocks();
  clearPluginRegistry();
});

// ---------------------------------------------------------------------------
// Permission descriptor tests
// ---------------------------------------------------------------------------

describe('permissions — maxTokens cap', () => {
  it('denies request when opts.maxTokens exceeds the cap', async () => {
    registerPluginManifest({
      pluginId: 'capped-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { maxTokens: 500 },
    });

    await expect(
      pluginLlmComplete('capped-plugin', MESSAGES, { maxTokens: 1000 }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof PluginDeniedError)) return false;
      expect(err.pluginId).toBe('capped-plugin');
      expect(err.code).toBe('E_PLUGIN_DENIED');
      expect(err.reason).toMatch(/maxTokens/);
      return true;
    });

    expect(mockGetLlmExecutor).not.toHaveBeenCalled();
  });

  it('allows request when opts.maxTokens is within the cap', async () => {
    registerPluginManifest({
      pluginId: 'capped-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { maxTokens: 500 },
    });

    const result = await pluginLlmComplete('capped-plugin', MESSAGES, { maxTokens: 400 });
    expect(result).toBeDefined();
    expect(mockAuxiliary).toHaveBeenCalledOnce();
  });

  it('allows request when maxTokens is exactly at the cap', async () => {
    registerPluginManifest({
      pluginId: 'exact-cap-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { maxTokens: 256 },
    });

    const result = await pluginLlmComplete('exact-cap-plugin', MESSAGES, { maxTokens: 256 });
    expect(result).toBeDefined();
  });
});

describe('permissions — allowedRoles', () => {
  it('denies request when role is not in allowedRoles', async () => {
    registerPluginManifest({
      pluginId: 'role-restricted-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { allowedRoles: ['summarizer', 'extractor'] },
    });

    await expect(
      pluginLlmComplete('role-restricted-plugin', MESSAGES, { role: 'admin' }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof PluginDeniedError)) return false;
      expect(err.pluginId).toBe('role-restricted-plugin');
      expect(err.reason).toMatch(/role/);
      return true;
    });

    expect(mockGetLlmExecutor).not.toHaveBeenCalled();
  });

  it('allows request when role is in allowedRoles', async () => {
    registerPluginManifest({
      pluginId: 'role-restricted-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { allowedRoles: ['summarizer', 'extractor'] },
    });

    const result = await pluginLlmComplete('role-restricted-plugin', MESSAGES, {
      role: 'summarizer',
    });
    expect(result).toBeDefined();
    expect(mockAuxiliary).toHaveBeenCalledOnce();
  });

  it('allows request when no role is specified and allowedRoles is set', async () => {
    registerPluginManifest({
      pluginId: 'role-restricted-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: { allowedRoles: ['summarizer'] },
    });

    // No role in opts — constraint does not apply when role is not provided.
    const result = await pluginLlmComplete('role-restricted-plugin', MESSAGES);
    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Filesystem ACL tests
// ---------------------------------------------------------------------------

describe('validateFsAccess', () => {
  beforeEach(() => {
    registerPluginManifest({
      pluginId: 'fs-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: {
        fsAccess: {
          read: ['/tmp/plugin-scratch/**', '/workspace/data/*.json'],
          write: ['/tmp/plugin-scratch/**'],
        },
      },
    });
  });

  it('denies read for path outside declared read patterns', () => {
    expect(validateFsAccess('fs-plugin', '/etc/passwd', 'read')).toBe(false);
  });

  it('allows read for path matching declared read pattern', () => {
    expect(validateFsAccess('fs-plugin', '/tmp/plugin-scratch/output.txt', 'read')).toBe(true);
  });

  it('allows read for deeply nested path matching wildcard', () => {
    expect(validateFsAccess('fs-plugin', '/tmp/plugin-scratch/a/b/c.txt', 'read')).toBe(true);
  });

  it('allows read for path matching second read pattern', () => {
    expect(validateFsAccess('fs-plugin', '/workspace/data/results.json', 'read')).toBe(true);
  });

  it('denies read for path that matches write-only pattern', () => {
    // /tmp/plugin-scratch/** is in write but also in read — both have it; test
    // a path that's only in write patterns:
    registerPluginManifest({
      pluginId: 'write-only-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: {
        fsAccess: {
          read: [],
          write: ['/tmp/write-only/**'],
        },
      },
    });

    expect(validateFsAccess('write-only-plugin', '/tmp/write-only/file.txt', 'read')).toBe(false);
  });

  it('denies write for path outside declared write patterns', () => {
    expect(validateFsAccess('fs-plugin', '/workspace/data/results.json', 'write')).toBe(false);
  });

  it('allows write for path matching declared write pattern', () => {
    expect(validateFsAccess('fs-plugin', '/tmp/plugin-scratch/output.txt', 'write')).toBe(true);
  });

  it('returns false for unknown plugin (no manifest, default deny)', () => {
    expect(validateFsAccess('unknown-plugin', '/tmp/anything', 'read')).toBe(false);
  });

  it('returns false when fsAccess is not declared in permissions', () => {
    registerPluginManifest({
      pluginId: 'no-fs-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: {},
    });

    expect(validateFsAccess('no-fs-plugin', '/tmp/anything', 'read')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rate-limit token-bucket tests
// ---------------------------------------------------------------------------

describe('rate limit — token bucket', () => {
  it('exhausts bucket after burst calls and throws PluginRateLimitedError', async () => {
    registerPluginManifest({
      pluginId: 'rate-limited-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: {
        rateLimit: { tokensPerSecond: 1, burst: 2 },
      },
    });

    // First two calls consume the burst (2 tokens).
    await pluginLlmComplete('rate-limited-plugin', MESSAGES);
    await pluginLlmComplete('rate-limited-plugin', MESSAGES);

    // Third call should fail — bucket is empty.
    await expect(pluginLlmComplete('rate-limited-plugin', MESSAGES)).rejects.toSatisfy(
      (err: unknown) => {
        if (!(err instanceof PluginRateLimitedError)) return false;
        expect(err.pluginId).toBe('rate-limited-plugin');
        expect(err.code).toBe('E_PLUGIN_RATE_LIMITED');
        expect(err.retryAfterMs).toBeGreaterThan(0);
        return true;
      },
    );
  });

  it('allows call after simulated time passes to refill the bucket', async () => {
    registerPluginManifest({
      pluginId: 'refillable-plugin',
      allowedModels: [],
      allowedProviders: [],
      permissions: {
        rateLimit: { tokensPerSecond: 10, burst: 1 },
      },
    });

    // Consume the single burst token.
    await pluginLlmComplete('refillable-plugin', MESSAGES);

    // Advance time by 200ms (10 tok/s → 2 tokens refilled, enough for 1 call).
    vi.useFakeTimers();
    vi.advanceTimersByTime(200);

    const result = await pluginLlmComplete('refillable-plugin', MESSAGES);
    expect(result).toBeDefined();

    vi.useRealTimers();
  });

  it('does not rate-limit a plugin with no rateLimit config', async () => {
    registerPluginManifest({
      pluginId: 'unlimited-plugin',
      allowedModels: [],
      allowedProviders: [],
    });

    // Should succeed many times with no rate limiting.
    for (let i = 0; i < 20; i++) {
      await pluginLlmComplete('unlimited-plugin', MESSAGES);
    }

    expect(mockAuxiliary).toHaveBeenCalledTimes(20);
  });
});
