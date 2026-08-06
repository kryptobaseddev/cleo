/**
 * Cross-provider failover for role calls (T12082).
 *
 * `executeForRole` drives the entire brain layer — consolidation, extraction,
 * hygiene, the dream cycle. It resolved ONE provider and returned `null` on any
 * failure, so a credential that is present but rejected took every background
 * capability down with it. Measured on 2026-08-06: an openai Codex OAuth
 * answering `400 The 'gpt-5.5-pro' model is not supported when using Codex with
 * a ChatGPT account` disabled the whole layer while other providers — including
 * a live local daemon — sat unconsulted. The classifier had already computed
 * `shouldFallback`; nothing acted on it.
 *
 * @task T12082
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLLM } from '../role-resolver.js';

const { mockResolveLLMForRole, mockChatComplete, mockAnthropicComplete, mockOllamaComplete } =
  vi.hoisted(() => ({
    mockResolveLLMForRole: vi.fn(),
    mockChatComplete: vi.fn(),
    mockAnthropicComplete: vi.fn(),
    mockOllamaComplete: vi.fn(),
  }));

vi.mock('../role-resolver.js', () => ({ resolveLLMForRole: mockResolveLLMForRole }));

vi.mock('../credential-pool.js', () => ({
  CredentialPool: class {
    markExhausted = vi.fn().mockResolvedValue(undefined);
    refreshExpiredOAuth = vi.fn().mockResolvedValue(0);
  },
}));

vi.mock('../transports/chat-completions.js', () => ({
  ChatCompletionsTransport: class {
    complete = mockChatComplete;
  },
}));

vi.mock('../transports/anthropic.js', () => ({
  AnthropicTransport: class {
    complete = mockAnthropicComplete;
  },
}));

vi.mock('../transports/ollama.js', () => ({
  OllamaTransport: class {
    complete = mockOllamaComplete;
  },
}));

import { _resetRoleWarnLatchForTests, executeForRole } from '../role-executor.js';

/**
 * Build a resolver envelope for `provider`, with or without a credential.
 *
 * @param provider - provider id to resolve to.
 * @param withCredential - whether a usable credential is present.
 * @returns the envelope.
 */
function resolved(provider: string, withCredential = true): ResolvedLLM {
  return {
    provider,
    model: `${provider}-model`,
    client: null,
    credential: withCredential ? { provider, source: 'cred-file', authType: 'api_key' } : null,
    sealedCredential: withCredential
      ? {
          provider,
          account: 'default',
          fetch: async () => ({ __decryptedToken: 'DecryptedToken' as const, value: 'tok' }),
        }
      : null,
    source: 'cross-provider',
    credentialLabel: 'default',
  } as ResolvedLLM;
}

/** The exact production failure: present credential, terminal 400 on the model. */
function codexModelUnsupported(): Error {
  const err = new Error(
    `400 {"detail":"The 'gpt-5.5-pro' model is not supported when using Codex with a ChatGPT account."}`,
  ) as Error & { status: number };
  err.status = 400;
  return err;
}

const OK = { content: 'pong', usage: { inputTokens: 1, outputTokens: 1 }, model: 'ollama-model' };

describe('role-executor cross-provider failover (T12082)', () => {
  beforeEach(() => {
    // `clearAllMocks` clears CALLS but leaves the `…Once` implementation queue
    // in place, so a leftover success from a previous test satisfies the next
    // one's first attempt. Reset the implementations outright.
    mockResolveLLMForRole.mockReset();
    mockChatComplete.mockReset();
    mockAnthropicComplete.mockReset();
    mockOllamaComplete.mockReset();
    _resetRoleWarnLatchForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails over to another provider after a terminal 400', async () => {
    mockResolveLLMForRole
      .mockResolvedValueOnce(resolved('openai'))
      .mockResolvedValueOnce(resolved('ollama'));
    mockChatComplete.mockRejectedValueOnce(codexModelUnsupported());
    mockOllamaComplete.mockResolvedValueOnce(OK);

    const result = await executeForRole('consolidation', 'sys', 'user');

    expect(result?.content).toBe('pong');
    expect(result?.provider).toBe('ollama');
  });

  it('tells the second resolution to skip the provider that just failed', async () => {
    mockResolveLLMForRole
      .mockResolvedValueOnce(resolved('openai'))
      .mockResolvedValueOnce(resolved('ollama'));
    mockChatComplete.mockRejectedValueOnce(codexModelUnsupported());
    mockOllamaComplete.mockResolvedValueOnce(OK);

    await executeForRole('consolidation', 'sys', 'user');

    expect(mockResolveLLMForRole).toHaveBeenNthCalledWith(
      1,
      'consolidation',
      expect.objectContaining({ excludeProviders: [] }),
    );
    expect(mockResolveLLMForRole).toHaveBeenNthCalledWith(
      2,
      'consolidation',
      expect.objectContaining({ excludeProviders: ['openai'] }),
    );
  });

  it('fails over when the resolved provider has NO credential', async () => {
    // Previously an immediate null: the first provider having no key ended the
    // call even though a configured one was next in line.
    mockResolveLLMForRole
      .mockResolvedValueOnce(resolved('anthropic', false))
      .mockResolvedValueOnce(resolved('ollama'));
    mockOllamaComplete.mockResolvedValueOnce(OK);

    expect((await executeForRole('consolidation', 'sys', 'user'))?.provider).toBe('ollama');
  });

  it('stops after MAX_ROLE_FAILOVERS rather than walking every provider', async () => {
    mockResolveLLMForRole
      .mockResolvedValueOnce(resolved('openai'))
      .mockResolvedValueOnce(resolved('gemini'))
      .mockResolvedValueOnce(resolved('groq'))
      .mockResolvedValue(resolved('deepseek'));
    mockChatComplete.mockRejectedValue(codexModelUnsupported());

    expect(await executeForRole('consolidation', 'sys', 'user')).toBeNull();
    // Initial attempt + 2 failovers. A background pass that fails eleven times
    // is worse than one that fails fast.
    expect(mockResolveLLMForRole).toHaveBeenCalledTimes(3);
  });

  it('stops when the resolver keeps returning the SAME provider', async () => {
    // A resolver that cannot honour the exclusion (nothing else provisioned)
    // must not spin.
    mockResolveLLMForRole.mockResolvedValue(resolved('openai'));
    mockChatComplete.mockRejectedValue(codexModelUnsupported());

    expect(await executeForRole('consolidation', 'sys', 'user')).toBeNull();
    expect(mockResolveLLMForRole).toHaveBeenCalledTimes(2);
  });

  it('does NOT fail over when the CALLER aborted', async () => {
    // The caller gave up; trying a second provider would ignore that.
    const controller = new AbortController();
    controller.abort();
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';

    mockResolveLLMForRole.mockResolvedValue(resolved('openai'));
    mockChatComplete.mockRejectedValue(abortErr);

    expect(
      await executeForRole('consolidation', 'sys', 'user', { signal: controller.signal }),
    ).toBeNull();
    expect(mockResolveLLMForRole).toHaveBeenCalledTimes(1);
  });

  it('does not resolve twice when the first provider succeeds', async () => {
    mockResolveLLMForRole.mockResolvedValue(resolved('anthropic'));
    mockAnthropicComplete.mockResolvedValue({ ...OK, model: 'anthropic-model' });

    expect((await executeForRole('consolidation', 'sys', 'user'))?.content).toBe('pong');
    expect(mockResolveLLMForRole).toHaveBeenCalledTimes(1);
  });
});
