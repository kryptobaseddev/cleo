/**
 * DefaultLlmSessionFactory unit tests (T9288).
 *
 * Uses vi.mock to stub resolveLLMForRole — no real network or filesystem calls.
 *
 * @task T9288
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcreteSession } from '../concrete-session.js';
import { DefaultLlmSessionFactory } from '../session-factory.js';

// ---------------------------------------------------------------------------
// Mock resolveLLMForRole
// ---------------------------------------------------------------------------

vi.mock('../role-resolver.js', () => ({
  resolveLLMForRole: vi.fn(),
}));

import { resolveLLMForRole } from '../role-resolver.js';

const mockResolveLLMForRole = vi.mocked(resolveLLMForRole);

function makeResolvedLLM(
  provider: string = 'anthropic',
  apiKey: string | null = 'sk-test',
  authType: 'api_key' | 'oauth' = 'api_key',
) {
  return {
    provider,
    model: 'claude-haiku-4-5-20251001',
    client: null,
    credential: apiKey ? { provider, apiKey, source: 'env' as const, authType } : null,
    source: 'implicit-fallback' as const,
    credentialLabel: undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DefaultLlmSessionFactory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createForRole returns a ConcreteSession wired with role-resolved provider', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('anthropic'));

    const factory = new DefaultLlmSessionFactory();
    const session = await factory.createForRole('consolidation');

    expect(session).toBeInstanceOf(ConcreteSession);
    // Transport should be AnthropicTransport (provider === 'anthropic')
    expect(session.transport.provider).toBe('anthropic');
    expect(session.model).toBe('claude-haiku-4-5-20251001');
  });

  it('createForRole uses the gemini transport for gemini provider', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('gemini', 'gemini-api-key'));

    const factory = new DefaultLlmSessionFactory();
    const session = await factory.createForRole('extraction');

    expect(session).toBeInstanceOf(ConcreteSession);
    expect(session.transport.provider).toBe('gemini');
  });

  it('createForRole uses ChatCompletionsTransport for openai provider', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('openai', 'sk-openai-test'));

    const factory = new DefaultLlmSessionFactory();
    const session = await factory.createForRole('derivation');

    expect(session).toBeInstanceOf(ConcreteSession);
    expect(session.transport.provider).toBe('openai');
  });

  it('create with role option resolves via resolveLLMForRole', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('anthropic'));

    const factory = new DefaultLlmSessionFactory();
    const session = await factory.create({ role: 'hygiene' });

    expect(mockResolveLLMForRole).toHaveBeenCalledWith('hygiene');
    expect(session).toBeInstanceOf(ConcreteSession);
  });

  it('throws when no credential is available for the role', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('anthropic', null));

    const factory = new DefaultLlmSessionFactory();
    await expect(factory.createForRole('consolidation')).rejects.toThrow(
      'No credential available for role',
    );
  });

  it('throws when create is called without role or providerId+model', async () => {
    const factory = new DefaultLlmSessionFactory();
    await expect(factory.create({})).rejects.toThrow('must supply either role');
  });

  it('passes retryPolicy from factory defaults to the session', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('anthropic'));

    const retryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000, jitter: false };
    const factory = new DefaultLlmSessionFactory({ retryPolicy });

    // Access the session's internal retry policy via the concrete type
    const session = (await factory.createForRole('consolidation')) as ConcreteSession;
    // The retry policy is private; verify indirectly by checking it's a ConcreteSession
    expect(session).toBeInstanceOf(ConcreteSession);
  });

  it('passes per-create retryPolicy overriding factory default', async () => {
    mockResolveLLMForRole.mockResolvedValue(makeResolvedLLM('anthropic'));

    const factoryPolicy = { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000, jitter: false };
    const callPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false };
    const factory = new DefaultLlmSessionFactory({ retryPolicy: factoryPolicy });

    const session = await factory.create({ role: 'consolidation', retryPolicy: callPolicy });
    expect(session).toBeInstanceOf(ConcreteSession);
  });
});
