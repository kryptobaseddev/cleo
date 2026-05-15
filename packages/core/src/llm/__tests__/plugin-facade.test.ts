/**
 * Unit tests for `pluginLlmComplete` (T9305 — plugin LLM facade).
 *
 * Isolation strategy: `getLlmExecutor` is vi.mock'd so no real credentials,
 * network, or SDK calls are made.
 *
 * Coverage:
 *  1. Allows model in plugin manifest allow-list.
 *  2. Rejects model NOT in plugin allow-list with PluginModelGateError.
 *  3. Redacts sk-ant-oat-* tokens from error messages.
 *  4. Redacts Bearer <token> from error stack traces.
 *  5. Forwards call to getLlmExecutor('plugin').auxiliary.
 *
 * @task T9305
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { PluginLlmError, PluginModelGateError } from '@cleocode/contracts';
import type {
  NormalizedResponse,
  TransportMessage,
} from '@cleocode/contracts/llm/normalized-response.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
// Test helpers
// ---------------------------------------------------------------------------

function makeResponse(overrides?: Partial<NormalizedResponse>): NormalizedResponse {
  return {
    id: 'resp-1',
    model: 'claude-haiku-4-5-20251001',
    content: 'Hello from plugin',
    toolCalls: null,
    stopReason: 'end_turn',
    usage: { inputTokens: 10, outputTokens: 5 },
    raw: null,
    ...overrides,
  };
}

const MESSAGES: TransportMessage[] = [{ role: 'user', content: 'What is 2+2?' }];

// ---------------------------------------------------------------------------
// Module under test — imported AFTER mocks are set up
// ---------------------------------------------------------------------------

import {
  clearPluginRegistry,
  pluginLlmComplete,
  registerPluginManifest,
} from '../plugin-facade.js';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.resetAllMocks();
  clearPluginRegistry();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pluginLlmComplete', () => {
  it('allows model in plugin allowlist', async () => {
    const response = makeResponse();
    mockAuxiliary.mockResolvedValueOnce(response);
    mockGetLlmExecutor.mockResolvedValueOnce({ auxiliary: mockAuxiliary });

    registerPluginManifest({
      pluginId: 'test-plugin',
      allowedModels: ['claude-haiku-4-5-20251001'],
      allowedProviders: [],
    });

    const result = await pluginLlmComplete('test-plugin', MESSAGES, {
      model: 'claude-haiku-4-5-20251001',
    });

    expect(result).toBe(response);
    expect(mockGetLlmExecutor).toHaveBeenCalledWith('plugin');
    expect(mockAuxiliary).toHaveBeenCalledWith(
      MESSAGES,
      expect.objectContaining({ model: 'claude-haiku-4-5-20251001' }),
    );
  });

  it('rejects model NOT in plugin allowlist with PluginModelGateError', async () => {
    registerPluginManifest({
      pluginId: 'restricted-plugin',
      allowedModels: ['claude-haiku-4-5-20251001'],
      allowedProviders: [],
    });

    await expect(
      pluginLlmComplete('restricted-plugin', MESSAGES, { model: 'claude-opus-4-7' }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof PluginModelGateError)) return false;
      expect(err.pluginId).toBe('restricted-plugin');
      expect(err.denied).toBe('claude-opus-4-7');
      expect(err.axis).toBe('model');
      return true;
    });

    // Executor must NOT have been called.
    expect(mockGetLlmExecutor).not.toHaveBeenCalled();
  });

  it('redacts sk-ant-oat-* tokens from error messages', async () => {
    const secret = 'sk-ant-oat-01-supersecrettoken1234567890abcdef';
    const rawError = new Error(`Authentication failed: apiKey=${secret}`);
    mockAuxiliary.mockRejectedValueOnce(rawError);
    mockGetLlmExecutor.mockResolvedValueOnce({ auxiliary: mockAuxiliary });

    await expect(pluginLlmComplete('plugin-a', MESSAGES)).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof PluginLlmError)) return false;
      expect(err.message).not.toContain(secret);
      expect(err.message).toContain('[REDACTED]');
      expect(err.pluginId).toBe('plugin-a');
      return true;
    });
  });

  it('redacts Bearer <token> from error stack traces', async () => {
    const token = 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
    const rawError = new Error('Request failed');
    rawError.stack = `Error: Request failed\n    at authorize (auth.ts:10)\n    Authorization: ${token}`;
    mockAuxiliary.mockRejectedValueOnce(rawError);
    mockGetLlmExecutor.mockResolvedValueOnce({ auxiliary: mockAuxiliary });

    await expect(pluginLlmComplete('plugin-b', MESSAGES)).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof PluginLlmError)) return false;
      expect(err.stack).not.toContain(token);
      expect(err.stack).toContain('[REDACTED]');
      return true;
    });
  });

  it('forwards to getLlmExecutor("plugin").auxiliary', async () => {
    const response = makeResponse();
    mockAuxiliary.mockResolvedValueOnce(response);
    mockGetLlmExecutor.mockResolvedValueOnce({ auxiliary: mockAuxiliary });

    await pluginLlmComplete('any-plugin', MESSAGES);

    expect(mockGetLlmExecutor).toHaveBeenCalledOnce();
    expect(mockGetLlmExecutor).toHaveBeenCalledWith('plugin');
    expect(mockAuxiliary).toHaveBeenCalledOnce();
    expect(mockAuxiliary).toHaveBeenCalledWith(MESSAGES, undefined);
  });
});
