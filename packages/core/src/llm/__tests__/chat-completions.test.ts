/**
 * Unit tests for ChatCompletionsTransport (T9272).
 *
 * Coverage (9 cases):
 * 1. Basic round-trip: gpt-4o → NormalizedResponse with content + stopReason.
 * 2. Tool call response: tool_calls present → toolCalls populated.
 * 3. Gemini quirk: gemini-1.5-pro → extra_body.thinking_config injected.
 * 4. Kimi quirk: kimi-k2 → reasoning_effort=high + extra_body.thinking.
 * 5. Moonshot quirk: moonshot-v1-8k with $schema tool → sanitized.
 * 6. OpenRouter Pareto: openrouter/anthropic/claude-sonnet-4 → extra_body.plugins.
 * 7. xAI Grok: grok-3 → extra_headers['x-grok-conv-id'] present.
 * 8. Usage mapping: prompt_tokens → NormalizedUsage.inputTokens.
 * 9. Cached tokens: prompt_tokens_details.cached_tokens → NormalizedUsage.cachedTokens.
 *
 * @task T9272
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `openai` — must be declared before importing ChatCompletionsTransport.
//
// `vi.hoisted` captures a stable reference to the mock fn across the
// module-level factory call; the mock itself is declared once here and
// re-used across all tests.
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: { create: mockCreate },
    };
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import {
  ChatCompletionsTransport,
  type ChatCompletionsTransportOptions,
} from '../transports/chat-completions.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Minimal valid options for a generic OpenAI-compatible provider. */
const BASE_OPTS: ChatCompletionsTransportOptions = {
  provider: 'openai',
  apiKey: 'sk-test-key',
};

/**
 * Build a minimal fake `ChatCompletion` response accepted by `_normalize`.
 *
 * @param overrides - Fields to merge on top of the base shape.
 */
function fakeChatCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-test123',
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello, world!', tool_calls: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ChatCompletionsTransport', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  // ── 1. Basic round-trip ──────────────────────────────────────────────────

  it('round-trip: gpt-4o returns NormalizedResponse with content + stopReason', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion());

    const transport = new ChatCompletionsTransport(BASE_OPTS);
    const result = await transport.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'Say hello' }],
      maxTokens: 256,
    });

    expect(result.id).toBe('chatcmpl-test123');
    expect(result.model).toBe('gpt-4o');
    expect(result.content).toBe('Hello, world!');
    expect(result.toolCalls).toBeNull();
    expect(result.stopReason).toBe('stop');
    expect(result.raw).toEqual(expect.objectContaining({ id: 'chatcmpl-test123' }));
  });

  // ── 2. Tool call response ────────────────────────────────────────────────

  it('tool call response: tool_calls in response → toolCalls populated', async () => {
    const withToolCalls = fakeChatCompletion({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_abc123',
                type: 'function',
                function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
          logprobs: null,
        },
      ],
    });
    mockCreate.mockResolvedValue(withToolCalls);

    const transport = new ChatCompletionsTransport(BASE_OPTS);
    const result = await transport.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'weather?' }],
      maxTokens: 256,
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather for a city',
          inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
        },
      ],
    });

    expect(result.content).toBeNull();
    expect(result.stopReason).toBe('tool_calls');
    expect(result.toolCalls).toHaveLength(1);
    const tc = result.toolCalls![0];
    expect(tc.id).toBe('call_abc123');
    expect(tc.name).toBe('get_weather');
    expect(tc.arguments).toBe('{"city":"Paris"}');
  });

  // ── 3. Gemini quirk ────────────────────────────────────────────────────

  it('Gemini quirk: gemini-1.5-pro → extra_body.thinking_config present in create call', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion({ model: 'gemini-1.5-pro' }));

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    });
    await transport.complete({
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    expect(extraBody).toBeDefined();
    expect(extraBody['thinking_config']).toEqual({ thinking_budget: 'auto' });
  });

  // ── 3b. Gemini non-flash uses 'high' budget ────────────────────────────

  it('Gemini quirk: gemini-3-pro → thinking_budget high (non-flash path)', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion({ model: 'gemini-3-pro' }));

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'gemini',
    });
    await transport.complete({
      model: 'gemini-3-pro',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    expect(extraBody['thinking_config']).toEqual({ thinking_budget: 'high' });
  });

  // ── 4. Kimi quirk ──────────────────────────────────────────────────────

  it('Kimi quirk: kimi-k2 → reasoning_effort=high + extra_body.thinking enabled', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion({ model: 'kimi-k2' }));

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    await transport.complete({
      model: 'kimi-k2',
      messages: [{ role: 'user', content: 'reason about this' }],
      maxTokens: 512,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(callArgs['reasoning_effort']).toBe('high');
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    expect(extraBody['thinking']).toEqual({ type: 'enabled' });
  });

  // ── 5. Moonshot quirk ──────────────────────────────────────────────────

  it('Moonshot quirk: moonshot-v1-8k tool with $schema + additionalProperties → sanitized', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion({ model: 'moonshot-v1-8k' }));

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      baseUrl: 'https://api.moonshot.cn/v1',
    });
    await transport.complete({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'call tool' }],
      maxTokens: 512,
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: { query: { type: 'string' } },
          },
        },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    const fn = tools[0]['function'] as Record<string, unknown>;
    const params = fn['parameters'] as Record<string, unknown>;
    expect(params['$schema']).toBeUndefined();
    expect(params['additionalProperties']).toBeUndefined();
    // Other fields preserved
    expect(params['type']).toBe('object');
    expect(params['properties']).toBeDefined();
  });

  // ── 6. OpenRouter Pareto ───────────────────────────────────────────────

  it('OpenRouter Pareto: openrouter/anthropic/claude-sonnet-4 → extra_body.plugins present', async () => {
    mockCreate.mockResolvedValue(
      fakeChatCompletion({ model: 'openrouter/anthropic/claude-sonnet-4' }),
    );

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    await transport.complete({
      model: 'openrouter/anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 512,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    const plugins = extraBody['plugins'] as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins[0]).toEqual({ id: 'pareto', min_coding_score: 0.85 });
  });

  // ── 7. xAI Grok conversation id ───────────────────────────────────────

  it('xAI Grok: grok-3 → extra_headers[x-grok-conv-id] present', async () => {
    mockCreate.mockResolvedValue(fakeChatCompletion({ model: 'grok-3' }));

    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      baseUrl: 'https://api.x.ai/v1',
    });
    await transport.complete({
      model: 'grok-3',
      messages: [{ role: 'user', content: 'hi grok' }],
      maxTokens: 256,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const headers = callArgs['extra_headers'] as Record<string, string>;
    expect(typeof headers['x-grok-conv-id']).toBe('string');
    expect(headers['x-grok-conv-id'].startsWith('cleo-')).toBe(true);
  });

  // ── 8. Usage mapping ────────────────────────────────────────────────────

  it('usage mapping: response.usage.prompt_tokens → NormalizedUsage.inputTokens', async () => {
    mockCreate.mockResolvedValue(
      fakeChatCompletion({
        usage: { prompt_tokens: 100, completion_tokens: 42, total_tokens: 142 },
      }),
    );

    const transport = new ChatCompletionsTransport(BASE_OPTS);
    const result = await transport.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'count tokens' }],
      maxTokens: 256,
    });

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(42);
    expect(result.usage.cachedTokens).toBeUndefined();
  });

  // ── 9. Cached tokens ────────────────────────────────────────────────────

  it('cached tokens: prompt_tokens_details.cached_tokens → NormalizedUsage.cachedTokens', async () => {
    const withCache = fakeChatCompletion({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 50,
        total_tokens: 250,
        prompt_tokens_details: { cached_tokens: 150, audio_tokens: 0 },
      },
    });
    mockCreate.mockResolvedValue(withCache);

    const transport = new ChatCompletionsTransport(BASE_OPTS);
    const result = await transport.complete({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'cached prompt' }],
      maxTokens: 256,
    });

    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.usage.cachedTokens).toBe(150);
  });
});
