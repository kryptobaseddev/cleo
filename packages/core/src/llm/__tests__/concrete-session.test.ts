/**
 * ConcreteSession unit tests (T9287).
 *
 * Uses mock LlmTransport implementations — no real network calls.
 *
 * @task T9287
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import type {
  NormalizedDelta,
  RetryPolicy,
  TransportContext,
} from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  NormalizedUsage,
  TransportMessage,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConcreteSession } from '../concrete-session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(): NormalizedUsage {
  return { inputTokens: 10, outputTokens: 5 };
}

function makeResponse(content = 'Hello!'): NormalizedResponse {
  return {
    id: 'resp-1',
    model: 'claude-haiku-4-5-20251001',
    content,
    toolCalls: null,
    stopReason: 'end_turn',
    usage: makeUsage(),
    raw: {},
  };
}

function makeCredential(
  authType: ResolvedCredential['authType'] = 'api_key',
  expiresAt: number | null = null,
): ResolvedCredential {
  return {
    provider: 'anthropic',
    label: 'personal',
    token: 'sk-test',
    authType,
    expiresAt,
    refreshToken: null,
    extraHeaders: {},
    baseUrl: null,
    awsProfile: null,
  };
}

function makeMockTransport(response?: NormalizedResponse): LlmTransport & {
  calls: Array<{ request: TransportRequest; ctx?: TransportContext }>;
} {
  const calls: Array<{ request: TransportRequest; ctx?: TransportContext }> = [];
  return {
    provider: 'anthropic' as const,
    apiMode: 'anthropic_messages' as const,
    async complete(request, ctx) {
      calls.push({ request, ctx });
      return response ?? makeResponse();
    },
    async *stream(_request, _ctx): AsyncIterable<NormalizedDelta> {
      yield { text: 'Hello', reasoning: '', stopReason: null, usage: null };
      yield { text: '!', reasoning: '', stopReason: 'end_turn', usage: makeUsage() };
    },
    calls,
  };
}

const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: false };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConcreteSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns defensive copy from history()', () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });

    session.append({ role: 'user', content: 'Hi' });
    const snap1 = session.history();
    // Mutating the returned array must not affect the internal history.
    (snap1 as TransportMessage[]).push({ role: 'assistant', content: 'Injected' });

    const snap2 = session.history();
    expect(snap2).toHaveLength(1);
    expect(snap1).not.toBe(snap2);
  });

  it('truncateHistory keeps head and tail, drops middle', () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });

    for (let i = 0; i < 5; i++) {
      session.append({ role: 'user', content: `msg-${i}` });
    }

    session.truncateHistory(1, 2);
    const h = session.history();
    expect(h).toHaveLength(3);
    expect(h[0]?.content).toBe('msg-0');
    expect(h[1]?.content).toBe('msg-3');
    expect(h[2]?.content).toBe('msg-4');
  });

  it('truncateHistory is a no-op when keepFirst + keepLast >= length', () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
    });

    session.append({ role: 'user', content: 'a' });
    session.append({ role: 'assistant', content: 'b' });

    session.truncateHistory(1, 2);
    expect(session.history()).toHaveLength(2);
  });

  it('send calls transport.complete with the supplied messages', async () => {
    const transport = makeMockTransport();
    const session = new ConcreteSession({
      transport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: NO_RETRY,
    });

    const msgs: TransportMessage[] = [{ role: 'user', content: 'Test' }];
    await session.send(msgs);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.request.messages).toEqual(msgs);
  });

  it('send does NOT append messages to history', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: NO_RETRY,
    });

    await session.send([{ role: 'user', content: 'Hello' }]);
    expect(session.history()).toHaveLength(0);
  });

  it('does NOT refresh api_key credentials before send', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential('api_key', Date.now() + 10), // expires in 10ms
      retryPolicy: NO_RETRY,
    });

    const refreshSpy = vi.spyOn(session, 'refreshCredential');
    await session.send([{ role: 'user', content: 'Hi' }]);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('refreshes oauth credential when expiresAt < 60s', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      // expires in 30s — below the 60s threshold
      credential: makeCredential('oauth', Date.now() + 30_000),
      retryPolicy: NO_RETRY,
    });

    const refreshSpy = vi.spyOn(session, 'refreshCredential');
    await session.send([{ role: 'user', content: 'Hi' }]);
    expect(refreshSpy).toHaveBeenCalledOnce();
  });

  it('does NOT refresh oauth credential when expiresAt is well in the future', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential('oauth', Date.now() + 300_000), // 5 min
      retryPolicy: NO_RETRY,
    });

    const refreshSpy = vi.spyOn(session, 'refreshCredential');
    await session.send([{ role: 'user', content: 'Hi' }]);
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('retries on 5xx error up to retryPolicy.maxAttempts', async () => {
    let callCount = 0;
    const failingTransport: LlmTransport = {
      provider: 'anthropic' as const,
      apiMode: 'anthropic_messages' as const,
      async complete() {
        callCount++;
        if (callCount < 3) throw new Error('HTTP 500 Internal Server Error');
        return makeResponse();
      },
      async *stream(): AsyncIterable<NormalizedDelta> {},
    };

    const policy: RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    };

    const session = new ConcreteSession({
      transport: failingTransport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: policy,
    });

    const response = await session.send([{ role: 'user', content: 'Hi' }]);
    expect(callCount).toBe(3);
    expect(response.content).toBe('Hello!');
  });

  it('does not retry on 4xx error (non-429)', async () => {
    let callCount = 0;
    const failingTransport: LlmTransport = {
      provider: 'anthropic' as const,
      apiMode: 'anthropic_messages' as const,
      async complete() {
        callCount++;
        throw new Error('HTTP 400 Bad Request');
      },
      async *stream(): AsyncIterable<NormalizedDelta> {},
    };

    const policy: RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    };

    const session = new ConcreteSession({
      transport: failingTransport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: policy,
    });

    await expect(session.send([{ role: 'user', content: 'Hi' }])).rejects.toThrow('400');
    expect(callCount).toBe(1);
  });

  it('throws after exhausting maxAttempts on persistent 5xx', async () => {
    const failingTransport: LlmTransport = {
      provider: 'anthropic' as const,
      apiMode: 'anthropic_messages' as const,
      async complete() {
        throw new Error('HTTP 503 Service Unavailable');
      },
      async *stream(): AsyncIterable<NormalizedDelta> {},
    };

    const policy: RetryPolicy = {
      maxAttempts: 2,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitter: false,
    };

    const session = new ConcreteSession({
      transport: failingTransport,
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: policy,
    });

    await expect(session.send([{ role: 'user', content: 'Hi' }])).rejects.toThrow('503');
  });

  it('streams deltas from transport.stream', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential(),
      retryPolicy: NO_RETRY,
    });

    const deltas: NormalizedDelta[] = [];
    for await (const delta of session.stream([{ role: 'user', content: 'Hi' }])) {
      deltas.push(delta);
    }

    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.text).toBe('Hello');
    expect(deltas[1]?.stopReason).toBe('end_turn');
  });

  it('refreshCredential is a no-op for api_key credentials', async () => {
    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: makeCredential('api_key'),
    });

    // Should not throw
    await expect(session.refreshCredential()).resolves.toBeUndefined();
  });

  it('refreshCredential is a no-op for aws_sdk credentials', async () => {
    const cred: ResolvedCredential = {
      provider: 'bedrock',
      label: 'aws',
      token: '',
      authType: 'aws_sdk',
      expiresAt: null,
      refreshToken: null,
      extraHeaders: {},
      baseUrl: null,
      awsProfile: 'default',
    };

    const session = new ConcreteSession({
      transport: makeMockTransport(),
      model: 'claude-haiku-4-5-20251001',
      credential: cred,
    });

    await expect(session.refreshCredential()).resolves.toBeUndefined();
  });
});
