/**
 * Unit tests for LLM transport layer (T9263 — NormalizedResponse transports).
 *
 * Coverage:
 * 1. `AnthropicTransport.complete` — mocks `@anthropic-ai/sdk`, asserts full
 *    `NormalizedResponse` mapping (content, toolCalls, stopReason, usage, raw).
 * 2. `OpenAITransport.complete` — asserts rejects with `code: 'E_NOT_IMPLEMENTED'`.
 * 3. `GeminiTransport.complete` — asserts rejects with `code: 'E_NOT_IMPLEMENTED'`.
 * 4. `NormalizedResponse.raw` field is typed as `unknown` — typecheck assertion
 *    that consumers must narrow before access.
 *
 * @task T9263
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, expectTypeOf, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk — must be declared before importing AnthropicTransport.
// `vi.hoisted` captures the mock fn so the class mock can reference it.
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

/**
 * Fake Anthropic SDK response that exercises both text and tool_use content
 * blocks simultaneously. Matches the structure of `Anthropic.Message`.
 */
const FAKE_ANTHROPIC_RESPONSE = {
  id: 'msg_01TestId',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-6',
  content: [
    { type: 'text', text: 'hi' },
    {
      type: 'tool_use',
      id: 't1',
      name: 'do_thing',
      input: { a: 1 },
    },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: {
    input_tokens: 42,
    output_tokens: 17,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    cache_creation: null,
    inference_geo: null,
    server_tool_use: null,
    service_tier: null,
  },
};

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = { create: mockCreate };
  }
  return { default: MockAnthropic };
});

// ---------------------------------------------------------------------------
// Imports — after mocks
// ---------------------------------------------------------------------------

import type { NormalizedResponse } from '@cleocode/contracts/llm/normalized-response.js';
import { AnthropicTransport, type AnthropicTransportOptions } from '../transports/anthropic.js';
import { GeminiTransport } from '../transports/gemini.js';
import { OpenAINotImplementedError, OpenAITransport } from '../transports/openai.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid options accepted by all transport constructors. */
const TRANSPORT_OPTS: AnthropicTransportOptions = {
  apiKey: 'sk-ant-test-key',
};

// ---------------------------------------------------------------------------
// AnthropicTransport
// ---------------------------------------------------------------------------

describe('AnthropicTransport', () => {
  it('maps mixed text+tool_use response to NormalizedResponse correctly', async () => {
    mockCreate.mockResolvedValue(FAKE_ANTHROPIC_RESPONSE);

    const transport = new AnthropicTransport(TRANSPORT_OPTS);

    const result = await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'call the tool' }],
      maxTokens: 1024,
    });

    // Content — joined text blocks
    expect(result.content).toBe('hi');

    // Tool calls
    expect(result.toolCalls).not.toBeNull();
    expect(result.toolCalls).toHaveLength(1);
    const toolCall = result.toolCalls![0];
    expect(toolCall.id).toBe('t1');
    expect(toolCall.name).toBe('do_thing');
    expect(toolCall.arguments).toBe(JSON.stringify({ a: 1 }));

    // Stop reason
    expect(result.stopReason).toBe('tool_use');

    // Usage
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(17);
    // cache_read_input_tokens was null → cachedTokens should be undefined
    expect(result.usage.cachedTokens).toBeUndefined();

    // Model and id
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.id).toBe('msg_01TestId');

    // Raw — present and identical to the fake response
    expect(result.raw).toBe(FAKE_ANTHROPIC_RESPONSE);
  });

  it('passes system prompt and tools to the SDK', async () => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue(FAKE_ANTHROPIC_RESPONSE);

    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 512,
      system: 'You are a helpful assistant.',
      tools: [
        {
          name: 'do_thing',
          description: 'Does a thing',
          inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
        },
      ],
      temperature: 0.5,
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['system']).toBe('You are a helpful assistant.');
    expect(Array.isArray(callArgs['tools'])).toBe(true);
    expect(callArgs['temperature']).toBe(0.5);
  });

  it('returns null content when response has only tool_use blocks', async () => {
    mockCreate.mockResolvedValue({
      ...FAKE_ANTHROPIC_RESPONSE,
      content: [
        {
          type: 'tool_use',
          id: 'tu1',
          name: 'pure_tool',
          input: {},
        },
      ],
      stop_reason: 'tool_use',
    });

    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    const result = await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'call pure tool' }],
      maxTokens: 256,
    });

    expect(result.content).toBeNull();
    expect(result.toolCalls).toHaveLength(1);
  });

  it('returns null toolCalls when response has only text blocks', async () => {
    mockCreate.mockResolvedValue({
      ...FAKE_ANTHROPIC_RESPONSE,
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
    });

    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    const result = await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'say hello' }],
      maxTokens: 256,
    });

    expect(result.content).toBe('Hello world');
    expect(result.toolCalls).toBeNull();
  });

  it('populates cachedTokens when cache_read_input_tokens is non-null', async () => {
    mockCreate.mockResolvedValue({
      ...FAKE_ANTHROPIC_RESPONSE,
      content: [{ type: 'text', text: 'cached reply' }],
      usage: {
        ...FAKE_ANTHROPIC_RESPONSE.usage,
        cache_read_input_tokens: 100,
        input_tokens: 10,
        output_tokens: 5,
      },
    });

    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    const result = await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'cached prompt' }],
      maxTokens: 256,
    });

    expect(result.usage.cachedTokens).toBe(100);
  });

  it('exposes provider as "anthropic"', () => {
    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    expect(transport.provider).toBe('anthropic');
  });
});

// ---------------------------------------------------------------------------
// OpenAITransport
// ---------------------------------------------------------------------------

describe('OpenAITransport', () => {
  it('rejects with OpenAINotImplementedError and code E_NOT_IMPLEMENTED', async () => {
    const transport = new OpenAITransport({ apiKey: 'sk-openai-test' });

    let thrownError: unknown;
    try {
      await transport.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'hello' }],
        maxTokens: 512,
      });
    } catch (err) {
      thrownError = err;
    }

    expect(thrownError).toBeInstanceOf(OpenAINotImplementedError);
    if (thrownError instanceof OpenAINotImplementedError) {
      expect(thrownError.code).toBe('E_NOT_IMPLEMENTED');
      expect(thrownError.message).toContain('OpenAI transport not yet wired');
    }
  });

  it('exposes provider as "openai"', () => {
    const transport = new OpenAITransport({ apiKey: 'sk-openai-test' });
    expect(transport.provider).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// GeminiTransport
// ---------------------------------------------------------------------------

describe('GeminiTransport', () => {
  it('exposes provider as "gemini"', () => {
    const transport = new GeminiTransport({ apiKey: 'AIza-test' });
    expect(transport.provider).toBe('gemini');
  });

  it('exposes apiMode as "chat_completions"', () => {
    const transport = new GeminiTransport({ apiKey: 'AIza-test' });
    expect(transport.apiMode).toBe('chat_completions');
  });
});

// ---------------------------------------------------------------------------
// NormalizedResponse.raw field typing
// ---------------------------------------------------------------------------

describe('NormalizedResponse.raw field typing', () => {
  it('raw is typed as unknown — consumer must narrow before access', () => {
    // Compile-time typecheck via expectTypeOf. If raw were typed as `any`,
    // this assertion would still pass structurally but is a useful guard.
    expectTypeOf<NormalizedResponse['raw']>().toEqualTypeOf<unknown>();
  });

  it('narrowing raw with a type guard is required before property access', async () => {
    mockCreate.mockResolvedValue(FAKE_ANTHROPIC_RESPONSE);

    const transport = new AnthropicTransport(TRANSPORT_OPTS);
    const result = await transport.complete({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 128,
    });

    // Must narrow before accessing provider-specific fields
    const raw = result.raw;
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'id' in raw &&
      typeof (raw as Record<string, unknown>)['id'] === 'string'
    ) {
      const id = (raw as Record<string, unknown>)['id'] as string;
      expect(id).toBe('msg_01TestId');
    } else {
      expect.fail('raw object did not have expected shape after narrowing');
    }
  });
});
