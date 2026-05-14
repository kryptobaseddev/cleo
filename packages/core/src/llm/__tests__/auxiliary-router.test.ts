/**
 * Unit tests for `routeAuxiliaryCall` (T-LLM-CRED-CENTRALIZATION Phase 3 / T9267).
 *
 * Isolation strategy: all three collaborators
 *  - `resolveLLMForRole`  (role-resolver.ts)
 *  - `CredentialPool`     (credential-pool.ts)
 *  - `AnthropicTransport` (transports/anthropic.ts)
 * are vi.mock'd so no real files, network, or Anthropic SDK are touched.
 *
 * Coverage:
 *  1. Happy path — pool returns entry, transport succeeds, response returned.
 *  2. 401 retry    — first call throws 401, second succeeds; markExhausted(401).
 *  3. 429 retry    — first call throws 429, second succeeds; markExhausted(429).
 *  4. Two-entry failover — entry-1 401, entry-2 succeeds; pool.pick called twice.
 *  5. All entries exhausted — pool.pick throws PoolExhaustedError; error bubbles.
 *  6. Non-retriable (400) — immediately re-thrown; markExhausted NOT called.
 *  7. maxRetries=1 — budget exhausted after one retry; PoolExhaustedError thrown.
 *
 * @task T9267
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it, vi } from 'vitest';
import type { StoredCredential } from '../credentials-store.js';

// ---------------------------------------------------------------------------
// Hoisted mock refs (must be declared before vi.mock calls)
// ---------------------------------------------------------------------------

const {
  mockResolveLLMForRole,
  mockPoolPick,
  mockPoolMarkOk,
  mockPoolMarkExhausted,
  mockTransportComplete,
} = vi.hoisted(() => ({
  mockResolveLLMForRole: vi.fn(),
  mockPoolPick: vi.fn(),
  mockPoolMarkOk: vi.fn(),
  mockPoolMarkExhausted: vi.fn(),
  mockTransportComplete: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../role-resolver.js', () => ({
  resolveLLMForRole: mockResolveLLMForRole,
}));

vi.mock('../credential-pool.js', async (importOriginal) => {
  // Re-export PoolExhaustedError from the real module so instanceof checks work.
  const real = await importOriginal<typeof import('../credential-pool.js')>();
  class MockCredentialPool {
    pick = mockPoolPick;
    markOk = mockPoolMarkOk;
    markExhausted = mockPoolMarkExhausted;
  }
  return {
    PoolExhaustedError: real.PoolExhaustedError,
    CredentialPool: MockCredentialPool,
  };
});

vi.mock('../transports/anthropic.js', () => {
  class MockAnthropicTransport {
    complete = mockTransportComplete;
  }
  return { AnthropicTransport: MockAnthropicTransport };
});

// ---------------------------------------------------------------------------
// Import SUT after mocks
// ---------------------------------------------------------------------------

import type {
  NormalizedResponse,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import { routeAuxiliaryCall } from '../auxiliary-router.js';
import { PoolExhaustedError } from '../credential-pool.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal resolved role (provider + model only; credential bypassed). */
const RESOLVED_ROLE = { provider: 'anthropic' as const, model: 'claude-haiku-4-5-20251001' };

/** Minimal StoredCredential returned by pool.pick. */
function makeEntry(label: string): StoredCredential {
  return {
    provider: 'anthropic',
    label,
    authType: 'api_key',
    accessToken: `tok-${label}`,
    priority: 10,
  };
}

/** Minimal TransportRequest used for all tests. */
const BASE_REQUEST: TransportRequest = {
  model: 'placeholder',
  messages: [{ role: 'user', content: 'hello' }],
  maxTokens: 128,
};

/** Minimal NormalizedResponse. */
const FAKE_RESPONSE: NormalizedResponse = {
  id: 'msg_test',
  model: 'claude-haiku-4-5-20251001',
  content: 'hello back',
  toolCalls: null,
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
  raw: {},
};

/** Build an error that looks like an Anthropic SDK HTTP error. */
function makeHttpError(status: number): Error {
  const err = new Error(`HTTP ${status}`);
  Object.assign(err, { status });
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('routeAuxiliaryCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveLLMForRole.mockResolvedValue(RESOLVED_ROLE);
    mockPoolMarkOk.mockResolvedValue(undefined);
    mockPoolMarkExhausted.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // 1. Happy path
  // -------------------------------------------------------------------------

  it('returns NormalizedResponse on a clean first call', async () => {
    const entry = makeEntry('primary');
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete.mockResolvedValue(FAKE_RESPONSE);

    const result = await routeAuxiliaryCall('extraction', BASE_REQUEST);

    expect(result).toBe(FAKE_RESPONSE);
    expect(mockPoolPick).toHaveBeenCalledTimes(1);
    expect(mockPoolMarkOk).toHaveBeenCalledWith(entry.label);
    expect(mockPoolMarkExhausted).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // 2. 401 retry
  // -------------------------------------------------------------------------

  it('retries once on 401 and returns the second response', async () => {
    const entry = makeEntry('primary');
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete
      .mockRejectedValueOnce(makeHttpError(401))
      .mockResolvedValueOnce(FAKE_RESPONSE);

    const result = await routeAuxiliaryCall('consolidation', BASE_REQUEST);

    expect(result).toBe(FAKE_RESPONSE);
    expect(mockPoolMarkExhausted).toHaveBeenCalledTimes(1);
    expect(mockPoolMarkExhausted).toHaveBeenCalledWith(entry.label, 401);
    expect(mockPoolPick).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 3. 429 retry
  // -------------------------------------------------------------------------

  it('retries once on 429 and returns the second response', async () => {
    const entry = makeEntry('primary');
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete
      .mockRejectedValueOnce(makeHttpError(429))
      .mockResolvedValueOnce(FAKE_RESPONSE);

    const result = await routeAuxiliaryCall('hygiene', BASE_REQUEST);

    expect(result).toBe(FAKE_RESPONSE);
    expect(mockPoolMarkExhausted).toHaveBeenCalledWith(entry.label, 429);
    expect(mockPoolPick).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 4. Two-entry failover
  // -------------------------------------------------------------------------

  it('fails over to second entry when first entry returns 401', async () => {
    const entry1 = makeEntry('primary');
    const entry2 = makeEntry('secondary');
    mockPoolPick
      .mockResolvedValueOnce({ credential: entry1, poolSize: 2 })
      .mockResolvedValueOnce({ credential: entry2, poolSize: 2 });
    mockTransportComplete
      .mockRejectedValueOnce(makeHttpError(401))
      .mockResolvedValueOnce(FAKE_RESPONSE);

    const result = await routeAuxiliaryCall('derivation', BASE_REQUEST);

    expect(result).toBe(FAKE_RESPONSE);
    expect(mockPoolMarkExhausted).toHaveBeenCalledWith(entry1.label, 401);
    expect(mockPoolMarkOk).toHaveBeenCalledWith(entry2.label);
    expect(mockPoolPick).toHaveBeenCalledTimes(2);
  });

  // -------------------------------------------------------------------------
  // 5. All entries exhausted (pool.pick throws PoolExhaustedError)
  // -------------------------------------------------------------------------

  it('bubbles PoolExhaustedError when pool.pick throws on the second pick', async () => {
    const entry = makeEntry('only');
    const exhaustedError = new PoolExhaustedError('anthropic', 1, Date.now() + 60_000);
    mockPoolPick
      .mockResolvedValueOnce({ credential: entry, poolSize: 1 })
      .mockRejectedValueOnce(exhaustedError);
    mockTransportComplete.mockRejectedValueOnce(makeHttpError(401));

    await expect(routeAuxiliaryCall('judgement', BASE_REQUEST)).rejects.toThrow(PoolExhaustedError);
  });

  // -------------------------------------------------------------------------
  // 6. Non-retriable error (400) — immediately re-thrown
  // -------------------------------------------------------------------------

  it('re-throws immediately on a 400 without calling markExhausted', async () => {
    const entry = makeEntry('primary');
    const badRequest = makeHttpError(400);
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete.mockRejectedValueOnce(badRequest);

    await expect(routeAuxiliaryCall('extraction', BASE_REQUEST)).rejects.toThrow(badRequest);
    expect(mockPoolMarkExhausted).not.toHaveBeenCalled();
    expect(mockPoolPick).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // 7. maxRetries=1 — budget exhausted
  // -------------------------------------------------------------------------

  it('throws PoolExhaustedError when maxRetries=1 and the single attempt fails', async () => {
    const entry = makeEntry('primary');
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete.mockRejectedValue(makeHttpError(429));

    await expect(routeAuxiliaryCall('extraction', BASE_REQUEST, { maxRetries: 1 })).rejects.toThrow(
      PoolExhaustedError,
    );

    expect(mockPoolMarkExhausted).toHaveBeenCalledTimes(1);
    expect(mockPoolMarkExhausted).toHaveBeenCalledWith(entry.label, 429);
  });

  // -------------------------------------------------------------------------
  // 8. opts.provider / opts.model overrides
  // -------------------------------------------------------------------------

  it('uses opts.model override instead of resolved model', async () => {
    const entry = makeEntry('primary');
    mockPoolPick.mockResolvedValue({ credential: entry, poolSize: 1 });
    mockTransportComplete.mockResolvedValue(FAKE_RESPONSE);

    await routeAuxiliaryCall('extraction', BASE_REQUEST, { model: 'claude-sonnet-4-6' });

    // The transport.complete should have been called with model overridden.
    expect(mockTransportComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-sonnet-4-6' }),
    );
  });
});
