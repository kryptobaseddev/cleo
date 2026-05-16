/**
 * Unit tests for CodexResponsesTransport.
 *
 * Covers:
 * 1. Simple text turn — complete() returns content and usage.
 * 2. Multimodal turn — image_url block converted to input_image item.
 * 3. Tool call + tool result replay — tool call in output, result in next input.
 * 4. Error classification — SDK error propagates as thrown Error.
 * 5. Streaming SSE — stream() yields text deltas and final stopReason+usage.
 *
 * @task T9311
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `openai` — declared before imports.
// ---------------------------------------------------------------------------

const { mockResponsesCreate } = vi.hoisted(() => ({
  mockResponsesCreate: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    responses = { create: mockResponsesCreate };
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Imports — after mock declarations.
// ---------------------------------------------------------------------------

import {
  CodexResponsesTransport,
  type CodexResponsesTransportOptions,
} from '../../transports/codex-responses.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_OPTS: CodexResponsesTransportOptions = {
  provider: 'openai',
  apiKey: 'sk-test-key',
};

/**
 * Build a fake non-streaming Responses API Response object.
 */
function fakeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_test_001',
    object: 'response',
    created_at: 1700000000,
    model: 'codex-mini-latest',
    status: 'completed',
    output_text: 'Hello from Codex!',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Codex!' }],
      },
    ],
    parallel_tool_calls: false,
    temperature: 0.7,
    tool_choice: 'auto',
    tools: [],
    top_p: null,
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    ...overrides,
  };
}

/**
 * Build a fake async iterable of Responses API stream events.
 */
function makeFakeResponseStream(
  events: Array<Record<string, unknown>>,
): AsyncIterable<Record<string, unknown>> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CodexResponsesTransport', () => {
  beforeEach(() => {
    mockResponsesCreate.mockReset();
  });

  // ── 1. Simple text turn ───────────────────────────────────────────────────

  describe('complete() — simple text turn', () => {
    it('returns content and normalized usage from a text response', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse());

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const response = await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'Hello!' }],
        maxTokens: 256,
      });

      expect(response.content).toBe('Hello from Codex!');
      expect(response.toolCalls).toBeNull();
      expect(response.stopReason).toBe('completed');
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(8);
      expect(response.id).toBe('resp_test_001');
    });

    it('sends instructions from system prompt', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse());

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'Hi' }],
        maxTokens: 64,
        system: 'You are a helpful assistant.',
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs['instructions']).toBe('You are a helpful assistant.');
    });

    it('sends user messages as input items', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse());

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'What is 2+2?' }],
        maxTokens: 32,
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      const input = callArgs['input'] as Array<Record<string, unknown>>;
      expect(Array.isArray(input)).toBe(true);
      expect(input[0]).toMatchObject({
        type: 'message',
        role: 'user',
        content: 'What is 2+2?',
      });
    });

    it('populates cachedTokens when input_tokens_details.cached_tokens > 0', async () => {
      mockResponsesCreate.mockResolvedValue(
        fakeResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 80 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        }),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const response = await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'Cached query' }],
        maxTokens: 64,
      });

      expect(response.usage.cachedTokens).toBe(80);
    });

    it('reflects apiMode as codex_responses', () => {
      const transport = new CodexResponsesTransport(BASE_OPTS);
      expect(transport.apiMode).toBe('codex_responses');
    });
  });

  // ── 2. Multimodal — image + text ──────────────────────────────────────────

  describe('complete() — multimodal (image + text)', () => {
    it('converts image_url content block to input_image item', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse({ output_text: 'I see a cat.' }));

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is in this image?' },
              {
                type: 'image',
                source: {
                  type: 'url',
                  data: 'https://example.com/cat.jpg',
                  mediaType: 'image/jpeg',
                },
              },
            ],
          },
        ],
        maxTokens: 128,
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      const input = callArgs['input'] as Array<Record<string, unknown>>;
      const msgItem = input[0] as Record<string, unknown>;
      expect(msgItem['type']).toBe('message');
      const content = msgItem['content'] as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toMatchObject({ type: 'input_text', text: 'What is in this image?' });
      expect(content[1]).toMatchObject({
        type: 'input_image',
        image_url: 'https://example.com/cat.jpg',
        detail: 'auto',
      });
    });

    it('converts base64 image to data URL in input_image item', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse({ output_text: 'Blue square.' }));

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', data: 'abc123==', mediaType: 'image/png' },
              },
            ],
          },
        ],
        maxTokens: 64,
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      const input = callArgs['input'] as Array<Record<string, unknown>>;
      const content = (input[0] as Record<string, unknown>)['content'] as Array<
        Record<string, unknown>
      >;
      expect(content[0]).toMatchObject({
        type: 'input_image',
        image_url: 'data:image/png;base64,abc123==',
      });
    });
  });

  // ── 3. Tool call + tool result replay ─────────────────────────────────────

  describe('complete() — tool call + tool result replay', () => {
    it('sends tools as function-type items to the Responses API', async () => {
      mockResponsesCreate.mockResolvedValue(
        fakeResponse({
          output_text: '',
          output: [
            {
              type: 'function_call',
              id: 'fc_001',
              call_id: 'call_001',
              name: 'get_weather',
              arguments: '{"city":"SF"}',
            },
          ],
        }),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'What is the weather in SF?' }],
        maxTokens: 128,
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather for a city.',
            inputSchema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      const tools = callArgs['tools'] as Array<Record<string, unknown>>;
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        type: 'function',
        name: 'get_weather',
        description: 'Get weather for a city.',
      });
    });

    it('normalizes function_call output items as tool calls', async () => {
      mockResponsesCreate.mockResolvedValue(
        fakeResponse({
          output_text: '',
          output: [
            {
              type: 'function_call',
              id: 'fc_001',
              call_id: 'call_abc123',
              name: 'search',
              arguments: '{"query":"cleo"}',
            },
          ],
        }),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const response = await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'Search for cleo.' }],
        maxTokens: 128,
        tools: [
          {
            name: 'search',
            description: 'Search.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
          },
        ],
      });

      expect(response.toolCalls).toHaveLength(1);
      expect(response.toolCalls![0]).toMatchObject({
        id: 'call_abc123',
        name: 'search',
        arguments: '{"query":"cleo"}',
      });
      expect(response.toolCalls![0].providerData?.['call_id']).toBe('call_abc123');
    });

    it('converts tool result messages to function_call_output items for multi-turn replay', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse({ output_text: 'It is sunny in SF.' }));

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await transport.complete({
        model: 'codex-mini-latest',
        messages: [
          { role: 'user', content: 'Weather in SF?' },
          { role: 'assistant', content: '' },
          {
            role: 'tool',
            content: '{"temperature":72,"condition":"sunny"}',
            toolUseId: 'call_abc123',
          },
        ],
        maxTokens: 128,
      });

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      const input = callArgs['input'] as Array<Record<string, unknown>>;
      // Last item should be function_call_output
      const lastItem = input[input.length - 1];
      expect(lastItem).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_abc123',
        output: '{"temperature":72,"condition":"sunny"}',
      });
    });
  });

  // ── 4. Error classification ───────────────────────────────────────────────

  describe('complete() — error classification', () => {
    it('propagates SDK errors as thrown Error', async () => {
      mockResponsesCreate.mockRejectedValue(new Error('401 Unauthorized: invalid API key'));

      const transport = new CodexResponsesTransport(BASE_OPTS);
      await expect(
        transport.complete({
          model: 'codex-mini-latest',
          messages: [{ role: 'user', content: 'Hi' }],
          maxTokens: 32,
        }),
      ).rejects.toThrow('401 Unauthorized');
    });

    it('returns null content when output_text is empty and output has no message', async () => {
      mockResponsesCreate.mockResolvedValue(
        fakeResponse({
          output_text: '',
          output: [
            {
              type: 'function_call',
              id: 'fc_001',
              call_id: 'call_001',
              name: 'tool',
              arguments: '{}',
            },
          ],
        }),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const response = await transport.complete({
        model: 'codex-mini-latest',
        messages: [{ role: 'user', content: 'Use the tool.' }],
        maxTokens: 64,
      });

      expect(response.content).toBeNull();
      expect(response.toolCalls).toHaveLength(1);
    });
  });

  // ── 5. Streaming SSE ──────────────────────────────────────────────────────

  describe('stream() — streaming SSE iteration', () => {
    it('yields text deltas from response.output_text.delta events', async () => {
      mockResponsesCreate.mockResolvedValue(
        makeFakeResponseStream([
          {
            type: 'response.output_text.delta',
            delta: 'Hello',
            item_id: 'item_0',
            content_index: 0,
          },
          {
            type: 'response.output_text.delta',
            delta: ' world',
            item_id: 'item_0',
            content_index: 0,
          },
          {
            type: 'response.completed',
            response: fakeResponse({ output_text: 'Hello world' }),
          },
        ]),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const deltas = [];
      for await (const d of transport.stream(
        {
          model: 'codex-mini-latest',
          messages: [{ role: 'user', content: 'Hello' }],
          maxTokens: 64,
        },
        {} as Parameters<typeof transport.stream>[1],
      )) {
        deltas.push(d);
      }

      const textDeltas = deltas.filter((d) => d.text.length > 0);
      expect(textDeltas.map((d) => d.text).join('')).toBe('Hello world');
    });

    it('yields final delta with stopReason and usage from response.completed event', async () => {
      mockResponsesCreate.mockResolvedValue(
        makeFakeResponseStream([
          {
            type: 'response.output_text.delta',
            delta: 'Done',
            item_id: 'item_0',
            content_index: 0,
          },
          {
            type: 'response.completed',
            response: fakeResponse({
              output_text: 'Done',
              status: 'completed',
              usage: {
                input_tokens: 5,
                output_tokens: 3,
                total_tokens: 8,
                input_tokens_details: { cached_tokens: 0 },
                output_tokens_details: { reasoning_tokens: 0 },
              },
            }),
          },
        ]),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const deltas = [];
      for await (const d of transport.stream(
        {
          model: 'codex-mini-latest',
          messages: [{ role: 'user', content: 'Done?' }],
          maxTokens: 32,
        },
        {} as Parameters<typeof transport.stream>[1],
      )) {
        deltas.push(d);
      }

      const finalDelta = deltas[deltas.length - 1];
      expect(finalDelta.stopReason).toBe('completed');
      expect(finalDelta.usage?.inputTokens).toBe(5);
      expect(finalDelta.usage?.outputTokens).toBe(3);
    });

    it('yields stop delta with null usage when no response.completed event arrives', async () => {
      mockResponsesCreate.mockResolvedValue(
        makeFakeResponseStream([
          { type: 'response.output_text.delta', delta: 'Hi', item_id: 'item_0', content_index: 0 },
          // no completed event
        ]),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      const deltas = [];
      for await (const d of transport.stream(
        {
          model: 'codex-mini-latest',
          messages: [{ role: 'user', content: 'Hi' }],
          maxTokens: 16,
        },
        {} as Parameters<typeof transport.stream>[1],
      )) {
        deltas.push(d);
      }

      const finalDelta = deltas[deltas.length - 1];
      expect(finalDelta.stopReason).toBe('stop');
      expect(finalDelta.usage).toBeNull();
    });

    it('sets stream: true in the create call params', async () => {
      mockResponsesCreate.mockResolvedValue(
        makeFakeResponseStream([
          {
            type: 'response.completed',
            response: fakeResponse(),
          },
        ]),
      );

      const transport = new CodexResponsesTransport(BASE_OPTS);
      for await (const _ of transport.stream(
        { model: 'codex-mini-latest', messages: [{ role: 'user', content: 'ok' }], maxTokens: 8 },
        {} as Parameters<typeof transport.stream>[1],
      )) {
        // drain
      }

      const callArgs = mockResponsesCreate.mock.calls[0][0] as Record<string, unknown>;
      expect(callArgs['stream']).toBe(true);
    });
  });

  // ── 6. xAI Responses profile ──────────────────────────────────────────────

  describe('xAI Responses profile — constructor options wiring', () => {
    it('uses provided baseUrl and apiKey', async () => {
      mockResponsesCreate.mockResolvedValue(fakeResponse({ output_text: 'Grok says hi.' }));

      const transport = new CodexResponsesTransport({
        provider: 'xai',
        apiKey: 'xai-test-key',
        baseUrl: 'https://api.x.ai/v1',
        defaultHeaders: { 'x-grok-conv-id': 'cleo-test-conv' },
      });

      const response = await transport.complete({
        model: 'grok-3',
        messages: [{ role: 'user', content: 'Hello Grok' }],
        maxTokens: 64,
      });

      expect(response.content).toBe('Grok says hi.');
      expect(transport.provider).toBe('xai');
      expect(transport.apiMode).toBe('codex_responses');
    });
  });
});
