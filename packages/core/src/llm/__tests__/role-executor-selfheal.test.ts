/**
 * Tests for the role-executor self-heal + OpenAI Codex-OAuth branch (T11617).
 *
 * Covers:
 *   1. A 401 (auth) error quarantines the resolved credential (markExhausted)
 *      and logs the warning AT MOST ONCE per `(role, provider, label)` tuple.
 *   2. An `openai` + `oauth` credential routes through CodexResponsesTransport
 *      (Codex Responses API), NOT the chat_completions path.
 *   3. A non-auth failure logs once but does NOT quarantine the credential.
 *   4. A missing credential surfaces a one-time actionable re-auth hint.
 *
 * The transports and the role resolver are mocked so the test exercises the
 * executor's branching + self-heal wiring without any network/SDK dependency.
 *
 * @module llm/__tests__/role-executor-selfheal
 * @task T11617
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedLLM } from '../role-resolver.js';

// ---------------------------------------------------------------------------
// Hoisted mock fns referenced by the module mocks below.
// ---------------------------------------------------------------------------

const {
  mockResolveLLMForRole,
  mockMarkExhausted,
  mockRefreshExpiredOAuth,
  mockCodexComplete,
  mockChatComplete,
  mockAnthropicComplete,
} = vi.hoisted(() => ({
  mockResolveLLMForRole: vi.fn(),
  mockMarkExhausted: vi.fn().mockResolvedValue(undefined),
  mockRefreshExpiredOAuth: vi.fn().mockResolvedValue(0),
  mockCodexComplete: vi.fn(),
  mockChatComplete: vi.fn(),
  mockAnthropicComplete: vi.fn(),
}));

vi.mock('../role-resolver.js', () => ({
  resolveLLMForRole: mockResolveLLMForRole,
}));

vi.mock('../credential-pool.js', () => ({
  CredentialPool: class {
    markExhausted = mockMarkExhausted;
    refreshExpiredOAuth = mockRefreshExpiredOAuth;
  },
}));

vi.mock('../transports/codex-responses.js', () => ({
  CodexResponsesTransport: class {
    complete = mockCodexComplete;
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

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import { _resetRoleWarnLatchForTests, executeForRole } from '../role-executor.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a {@link ResolvedLLM}-shaped object for the mocked resolver. */
function resolved(overrides: Partial<ResolvedLLM>): ResolvedLLM {
  return {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
    client: null,
    credential: {
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      source: 'cred-file',
      authType: 'api_key',
    },
    source: 'implicit-fallback',
    credentialLabel: 'claude-code',
    ...overrides,
  } as ResolvedLLM;
}

/** An error shaped like an SDK 401 (status fields the classifier reads). */
function authError(): Error {
  const err = new Error('401 invalid x-api-key') as Error & { status: number };
  err.status = 401;
  return err;
}

const SAMPLE_OK = {
  content: 'ok',
  usage: { inputTokens: 1, outputTokens: 1 },
  model: 'm',
};

describe('role-executor self-heal (T11617)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetRoleWarnLatchForTests();
    mockMarkExhausted.mockResolvedValue(undefined);
    mockRefreshExpiredOAuth.mockResolvedValue(0);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('quarantines the credential on a 401 and logs once per tuple', async () => {
    mockResolveLLMForRole.mockResolvedValue(
      resolved({ provider: 'anthropic', credentialLabel: 'claude-code' }),
    );
    mockAnthropicComplete.mockRejectedValue(authError());

    // First failing call — should mark exhausted + warn once.
    const r1 = await executeForRole('consolidation', 'sys', 'user');
    expect(r1).toBeNull();
    expect(mockMarkExhausted).toHaveBeenCalledTimes(1);
    expect(mockMarkExhausted).toHaveBeenCalledWith('claude-code', 401);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('Quarantined this credential');

    // Second identical failure — warning is latched (NO repeat spam).
    const r2 = await executeForRole('consolidation', 'sys', 'user');
    expect(r2).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1); // still 1 — log-once held
  });

  it('routes an openai+oauth credential through CodexResponsesTransport', async () => {
    mockResolveLLMForRole.mockResolvedValue(
      resolved({
        provider: 'openai',
        model: 'gpt-5-codex',
        credential: {
          provider: 'openai',
          apiKey: 'eyJ.fake.jwt',
          source: 'cred-file',
          authType: 'oauth',
        },
        credentialLabel: 'codex-cli',
      }),
    );
    mockCodexComplete.mockResolvedValue(SAMPLE_OK);

    const result = await executeForRole('consolidation', 'sys', 'user');

    expect(result).not.toBeNull();
    expect(result?.provider).toBe('openai');
    expect(mockCodexComplete).toHaveBeenCalledTimes(1);
    // The chat_completions path MUST NOT be used for the OAuth Codex case.
    expect(mockChatComplete).not.toHaveBeenCalled();
  });

  it('uses chat_completions for an openai+api_key credential (not Codex)', async () => {
    mockResolveLLMForRole.mockResolvedValue(
      resolved({
        provider: 'openai',
        model: 'gpt-4o',
        credential: {
          provider: 'openai',
          apiKey: 'sk-proj-abc',
          source: 'cred-file',
          authType: 'api_key',
        },
        credentialLabel: 'default',
      }),
    );
    mockChatComplete.mockResolvedValue(SAMPLE_OK);

    const result = await executeForRole('consolidation', 'sys', 'user');

    expect(result).not.toBeNull();
    expect(mockChatComplete).toHaveBeenCalledTimes(1);
    expect(mockCodexComplete).not.toHaveBeenCalled();
  });

  it('logs once but does NOT quarantine on a non-auth (5xx) failure', async () => {
    mockResolveLLMForRole.mockResolvedValue(
      resolved({ provider: 'anthropic', credentialLabel: 'claude-code' }),
    );
    const serverErr = new Error('500 internal') as Error & { status: number };
    serverErr.status = 500;
    mockAnthropicComplete.mockRejectedValue(serverErr);

    const result = await executeForRole('consolidation', 'sys', 'user');

    expect(result).toBeNull();
    expect(mockMarkExhausted).not.toHaveBeenCalled(); // no quarantine on 5xx
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('call failed');
  });

  it('surfaces a one-time actionable hint when no credential resolves', async () => {
    mockResolveLLMForRole.mockResolvedValue(
      resolved({ provider: 'anthropic', credential: null, credentialLabel: undefined }),
    );

    const r1 = await executeForRole('consolidation', 'sys', 'user');
    const r2 = await executeForRole('consolidation', 'sys', 'user');

    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(warnSpy).toHaveBeenCalledTimes(1); // log-once
    expect(warnSpy.mock.calls[0]?.[0]).toContain('cleo llm login');
  });
});
