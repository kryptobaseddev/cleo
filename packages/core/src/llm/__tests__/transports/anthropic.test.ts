/**
 * Unit tests for AnthropicTransport (T9285 — Wave 1c migration).
 *
 * Exercises the 6 @invariant constraints:
 * 1. _supportsAssistantPrefill guard — claude-4-class models reject prefill.
 * 2. thinkingBudgetTokens vs useJsonPrefill MUTEX in complete() and stream().
 * 3. structuredClone() protection — caller arrays not mutated across calls.
 * 4. injectCacheBreakpoints called POST-translation (on SDK params, not TransportRequest).
 * 5. stream tool-call yield contract — tool_use blocks DROPPED in streaming output.
 * 6. bare error pass-through — SDK errors propagate untouched.
 *
 * @task T9285
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk before any imports
// ---------------------------------------------------------------------------

const { mockCreate, mockStream, mockFinalMessage } = vi.hoisted(() => {
  const mockFinalMessage = vi.fn();
  const mockStreamIterable = vi.fn();
  const mockCreate = vi.fn();

  // mockStream returns an object that is both an AsyncIterable and has .finalMessage()
  const mockStream = vi.fn().mockReturnValue({
    [Symbol.asyncIterator]: () => mockStreamIterable(),
    finalMessage: mockFinalMessage,
  });

  return { mockCreate, mockStream, mockFinalMessage, mockStreamIterable };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      create: mockCreate,
      stream: mockStream,
    };
  }
  return { default: MockAnthropic };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { ImageRoutingError } from '../../image-routing.js';
import { AnthropicTransport } from '../../transports/anthropic.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_RESPONSE = {
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  },
};

function makeTransport(opts = {}) {
  return new AnthropicTransport({ apiKey: 'sk-ant-test', ...opts });
}

function makeRequest(model: string, extra = {}) {
  return {
    model,
    messages: [{ role: 'user' as const, content: 'hello' }],
    maxTokens: 128,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AnthropicTransport', () => {
  it('does not inject assistant-prefill for claude-sonnet-4', async () => {
    mockCreate.mockResolvedValue(FAKE_RESPONSE);
    const transport = makeTransport({ promptCaching: 'none' });

    await transport.complete(makeRequest('claude-sonnet-4-6'));

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = callArgs['messages'] as Array<Record<string, unknown>>;

    // No assistant prefill message should be appended
    expect(msgs.every((m) => m['role'] !== 'assistant')).toBe(true);
  });

  it('injects assistant-prefill for claude-3-5-haiku', async () => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      ...FAKE_RESPONSE,
      model: 'claude-3-5-haiku-20241022',
    });
    const transport = makeTransport({ promptCaching: 'none' });
    const { z } = await import('zod');
    const schema = z.object({ name: z.string() });
    const responseFormat = Object.assign(() => {}, { schema });

    await transport.complete({
      ...makeRequest('claude-3-5-haiku-20241022'),
      responseFormat,
    } as Parameters<typeof transport.complete>[0]);

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = callArgs['messages'] as Array<Record<string, unknown>>;

    // The last message should be the assistant-prefill `{`
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg?.['role']).toBe('assistant');
    expect(lastMsg?.['content']).toBe('{');
  });

  it('disables JSON prefill when thinkingBudgetTokens is set', async () => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue(FAKE_RESPONSE);
    const transport = makeTransport({ promptCaching: 'none' });
    const { z } = await import('zod');
    const schema = z.object({ result: z.string() });
    const responseFormat = Object.assign(() => {}, { schema });

    // claude-3-5-haiku normally supports prefill, but thinking budget disables it
    await transport.complete({
      ...makeRequest('claude-3-5-haiku-20241022'),
      responseFormat,
      thinkingBudgetTokens: 1024,
    } as Parameters<typeof transport.complete>[0]);

    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = callArgs['messages'] as Array<Record<string, unknown>>;

    // No assistant prefill should be present
    expect(msgs.every((m) => m['role'] !== 'assistant')).toBe(true);
    // thinking param should be set
    expect(callArgs['thinking']).toMatchObject({ type: 'enabled', budget_tokens: 1024 });
  });

  it('preserves caller message array across multi-turn calls via structuredClone', async () => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue(FAKE_RESPONSE);
    const transport = makeTransport({ promptCaching: 'system_and_3' });

    const originalMessages = [{ role: 'user' as const, content: 'first' }];
    const originalContent = originalMessages[0]!.content;

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: originalMessages,
      maxTokens: 64,
    });
    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: originalMessages,
      maxTokens: 64,
    });

    // Original array and content must not be mutated by cache_control injection
    expect(originalMessages[0]!.content).toBe(originalContent);
    expect(originalMessages).toHaveLength(1);
  });

  it('injects cache breakpoints into Anthropic SDK params not into TransportRequest', async () => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue(FAKE_RESPONSE);
    const transport = makeTransport({ promptCaching: 'system_and_3' });

    const originalMessages = [{ role: 'user' as const, content: 'test' }];

    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: originalMessages,
      maxTokens: 64,
    });

    // The SDK params should have cache_control on the message content
    const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
    const msgs = callArgs['messages'] as Array<Record<string, unknown>>;
    const msgContent = msgs[0]?.['content'];

    // cache_control was injected into SDK params (content became array)
    const hasCache =
      Array.isArray(msgContent) &&
      (msgContent as Array<Record<string, unknown>>).some((b) => 'cache_control' in b);
    expect(hasCache).toBe(true);

    // But the original TransportMessage.content must remain an unmodified string
    expect(originalMessages[0]!.content).toBe('test');
  });

  it('yields text-only deltas in stream() and drops tool_use content blocks', async () => {
    mockStream.mockClear();
    mockFinalMessage.mockResolvedValue({
      stop_reason: 'end_turn',
      usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: null },
    });

    // Simulate: thinking block, text block, tool_use block (dropped)
    async function* fakeEvents() {
      yield { type: 'content_block_start', content_block: { type: 'thinking' } };
      yield {
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: 'reasoning...' },
      };
      yield { type: 'content_block_stop' };
      yield { type: 'content_block_start', content_block: { type: 'text' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello ' } };
      yield { type: 'content_block_delta', delta: { type: 'text_delta', text: 'world' } };
      yield { type: 'content_block_stop' };
      // tool_use block — should be dropped
      yield {
        type: 'content_block_start',
        content_block: { type: 'tool_use', id: 'tu1', name: 'do_thing' },
      };
      yield {
        type: 'content_block_delta',
        delta: { type: 'input_json_delta', partial_json: '{"a":1}' },
      };
      yield { type: 'content_block_stop' };
    }

    const fakeStreamObj = {
      [Symbol.asyncIterator]: () => fakeEvents(),
      finalMessage: mockFinalMessage,
    };
    mockStream.mockReturnValue(fakeStreamObj);

    const transport = makeTransport({ promptCaching: 'none' });
    const allDeltas: import('@cleocode/contracts/llm/interfaces.js').NormalizedDelta[] = [];

    for await (const delta of transport.stream(makeRequest('claude-sonnet-4-6'), {
      requestId: 'test-stream-1',
    })) {
      allDeltas.push(delta);
    }

    const textDeltas = allDeltas.filter((d) => d.text.length > 0);
    const reasoningDeltas = allDeltas.filter((d) => d.reasoning.length > 0);

    // Text deltas are yielded
    expect(textDeltas.map((d) => d.text).join('')).toBe('hello world');
    // Reasoning/thinking deltas are yielded in delta.reasoning
    expect(reasoningDeltas.map((d) => d.reasoning).join('')).toBe('reasoning...');
    // Final delta carries stopReason
    const lastDelta = allDeltas[allDeltas.length - 1]!;
    expect(lastDelta.stopReason).toBe('end_turn');
  });

  it('propagates Anthropic.APIStatusError bare without wrapping', async () => {
    // @invariant bare error pass-through — SDK errors are NOT wrapped so
    // callers can route them through classifyError().
    class FakeApiError extends Error {
      constructor(
        public readonly status: number,
        message: string,
      ) {
        super(message);
        this.name = 'APIStatusError';
      }
    }

    const sdkError = new FakeApiError(401, 'Unauthorized');
    mockCreate.mockRejectedValue(sdkError);

    const transport = makeTransport({ promptCaching: 'none' });

    let caught: unknown;
    try {
      await transport.complete(makeRequest('claude-sonnet-4-6'));
    } catch (err) {
      caught = err;
    }

    // The exact same error instance must propagate — no wrapping
    expect(caught).toBe(sdkError);
    expect((caught as FakeApiError).status).toBe(401);
  });

  it('returns usage.cachedTokens > 0 on identical second call (mock)', async () => {
    mockCreate.mockClear();

    // First call: no cache hit
    mockCreate.mockResolvedValueOnce({
      ...FAKE_RESPONSE,
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
    });
    // Second call: cache hit
    mockCreate.mockResolvedValueOnce({
      ...FAKE_RESPONSE,
      usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 90 },
    });

    const transport = makeTransport();
    const req = makeRequest('claude-sonnet-4-6');

    const first = await transport.complete(req);
    const second = await transport.complete(req);

    expect(first.usage.cachedTokens ?? 0).toBe(0);
    expect((second.usage.cachedTokens ?? 0) > 0).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _supportsAssistantPrefill standalone
// ---------------------------------------------------------------------------

describe('AnthropicTransport._supportsAssistantPrefill', () => {
  it('returns false for claude-4-class models', () => {
    expect(AnthropicTransport._supportsAssistantPrefill('claude-opus-4-5')).toBe(false);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-sonnet-4-6')).toBe(false);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-haiku-4-5')).toBe(false);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-opus-4')).toBe(false);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-sonnet-4')).toBe(false);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-haiku-4')).toBe(false);
  });

  it('returns true for claude-3-class and earlier models', () => {
    expect(AnthropicTransport._supportsAssistantPrefill('claude-3-5-haiku-20241022')).toBe(true);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-3-opus-20240229')).toBe(true);
    expect(AnthropicTransport._supportsAssistantPrefill('claude-3-sonnet')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T9296 (W4d) — image-routing validation in complete()
// ---------------------------------------------------------------------------

describe('T9296 W4d — image-routing validators in complete()', () => {
  it('rejects requests exceeding image-count limit', async () => {
    mockCreate.mockClear();
    const transport = makeTransport({ promptCaching: 'none' });

    // Build a request with 21 images (Anthropic limit = 20)
    const imageBlock = {
      type: 'image' as const,
      source: { type: 'base64' as const, data: 'abc', mediaType: 'image/png' },
    };
    const content = Array.from({ length: 21 }, () => imageBlock);

    await expect(
      transport.complete({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user' as const, content }],
        maxTokens: 128,
      }),
    ).rejects.toBeInstanceOf(ImageRoutingError);

    // SDK should NOT have been called (validation throws before SDK)
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('rejects per-image size > 5 MB limit for Anthropic', async () => {
    mockCreate.mockClear();
    const transport = makeTransport({ promptCaching: 'none' });

    // 6 MB base64 string — exceeds 5 MB Anthropic limit
    const sixMbBase64 = 'A'.repeat(Math.ceil((6 * 1024 * 1024 * 4) / 3));
    const content = [
      {
        type: 'image' as const,
        source: { type: 'base64' as const, data: sixMbBase64, mediaType: 'image/png' },
      },
    ];

    await expect(
      transport.complete({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user' as const, content }],
        maxTokens: 128,
      }),
    ).rejects.toBeInstanceOf(ImageRoutingError);

    expect(mockCreate).not.toHaveBeenCalled();
  });
});
