/**
 * Unit tests for CodexResponsesTransport (raw-fetch variant, T11985).
 *
 * Covers:
 * 1. Wire shape — request-shape builder asserts exact headers/body fields
 *    for a fixture credential (no live calls).
 * 2. Simple text turn — complete() returns content and usage.
 * 3. Multimodal turn — image_url block converted to input_image item.
 * 4. Tool call + tool result replay — tool call in output, result in next input.
 * 5. Error surfacing — response body included in thrown Error message.
 * 6. Streaming SSE — stream() yields text deltas and final stopReason+usage.
 * 7. resolveCodexUrl — endpoint URL normalisation.
 *
 * @task T11985
 * @task T9311
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import {
  CodexResponsesTransport,
  type CodexResponsesTransportOptions,
  resolveCodexUrl,
} from '../../transports/codex-responses.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_OPTS: CodexResponsesTransportOptions = {
  provider: 'openai',
  apiKey: 'oat-test-token',
  defaultHeaders: {
    Authorization: 'Bearer oat-test-token',
    'chatgpt-account-id': 'acct_test123',
    originator: 'codex_cli_rs',
  },
};

/**
 * Build a fake (non-streaming) Responses API JSON response object.
 */
function fakeResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'resp_test_001',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-5.5',
    status: 'completed',
    output_text: 'Hello from Codex!',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello from Codex!' }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
    },
    error: null,
    ...overrides,
  };
}

/**
 * Build a raw SSE body string from a list of JSON event objects.
 */
function buildSSEBody(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/**
 * Create a fake ReadableStream from a raw SSE string.
 */
function sseStream(raw: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(raw);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Create a fake fetch that returns a JSON response.
 */
function mockJsonFetch(body: Record<string, unknown>, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

/**
 * Create a fake fetch that returns an SSE stream response.
 */
function mockSseFetch(events: Array<Record<string, unknown>>): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(sseStream(buildSSEBody(events)), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }),
  );
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let originalFetch: typeof fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveCodexUrl', () => {
  it('appends /codex/responses to plain backend URL', () => {
    expect(resolveCodexUrl('https://chatgpt.com/backend-api')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('appends /responses when URL already ends with /codex', () => {
    expect(resolveCodexUrl('https://chatgpt.com/backend-api/codex')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('leaves URL unchanged when it already ends with /codex/responses', () => {
    expect(resolveCodexUrl('https://chatgpt.com/backend-api/codex/responses')).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    );
  });

  it('defaults to ChatGPT Codex backend when baseUrl is undefined', () => {
    expect(resolveCodexUrl(undefined)).toBe('https://chatgpt.com/backend-api/codex/responses');
  });
});

// ── 1. Wire shape ─────────────────────────────────────────────────────────────

describe('CodexResponsesTransport — wire shape (request-shape builder)', () => {
  it('sends store:false, stream:true, accept:text/event-stream for complete() (backend mandates stream:true)', async () => {
    const mockFetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Hello from Codex!' },
      { type: 'response.completed', response: fakeResponse() },
    ]);
    globalThis.fetch = mockFetch;

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
    });

    const [url, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const hdrs = init.headers as Record<string, string>;

    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(hdrs['accept']).toBe('text/event-stream');
  });

  it('sends store:false, stream:true, OpenAI-Beta, accept:text/event-stream for stream()', async () => {
    const mockFetch = mockSseFetch([{ type: 'response.completed', response: fakeResponse() }]);
    globalThis.fetch = mockFetch;

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const deltas = [];
    for await (const d of transport.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 64 },
      {} as Parameters<typeof transport.stream>[1],
    )) {
      deltas.push(d);
    }

    const [, init] = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const hdrs = init.headers as Record<string, string>;

    expect(body['store']).toBe(false);
    expect(body['stream']).toBe(true);
    expect(hdrs['OpenAI-Beta']).toBe('responses=experimental');
    expect(hdrs['accept']).toBe('text/event-stream');
  });

  it('sends Authorization, chatgpt-account-id, originator from defaultHeaders', async () => {
    globalThis.fetch = mockSseFetch([{ type: 'response.completed', response: fakeResponse() }]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32,
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const hdrs = init.headers as Record<string, string>;

    expect(hdrs['Authorization']).toBe('Bearer oat-test-token');
    expect(hdrs['chatgpt-account-id']).toBe('acct_test123');
    expect(hdrs['originator']).toBe('codex_cli_rs');
  });

  it('injects Authorization when not present in defaultHeaders', async () => {
    globalThis.fetch = mockSseFetch([{ type: 'response.completed', response: fakeResponse() }]);

    const transport = new CodexResponsesTransport({ provider: 'openai', apiKey: 'sk-test' });
    await transport.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 32,
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const hdrs = init.headers as Record<string, string>;
    expect(hdrs['Authorization']).toBe('Bearer sk-test');
  });

  it('sends instructions from system prompt', async () => {
    globalThis.fetch = mockSseFetch([{ type: 'response.completed', response: fakeResponse() }]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64,
      system: 'You are a helpful assistant.',
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['instructions']).toBe('You are a helpful assistant.');
  });

  it('sends user messages as input items', async () => {
    globalThis.fetch = mockSseFetch([{ type: 'response.completed', response: fakeResponse() }]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
      maxTokens: 32,
    });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const input = body['input'] as Array<Record<string, unknown>>;
    expect(Array.isArray(input)).toBe(true);
    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'What is 2+2?',
    });
  });
});

// ── 2. Simple text turn ───────────────────────────────────────────────────────

describe('CodexResponsesTransport — complete() — simple text turn', () => {
  it('aggregates SSE deltas and returns content+usage from response.completed', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Hello ' },
      { type: 'response.output_text.delta', delta: 'from Codex!' },
      { type: 'response.completed', response: fakeResponse() },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const response = await transport.complete({
      model: 'gpt-5.5',
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

  it('populates cachedTokens when cached_tokens > 0', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Cached answer.' },
      {
        type: 'response.completed',
        response: fakeResponse({
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            total_tokens: 120,
            input_tokens_details: { cached_tokens: 80 },
          },
        }),
      },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const response = await transport.complete({
      model: 'gpt-5.5',
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

// ── 3. Multimodal — image + text ──────────────────────────────────────────────

describe('CodexResponsesTransport — complete() — multimodal (image + text)', () => {
  it('converts image_url content block to input_image item', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'I see a cat.' },
      { type: 'response.completed', response: fakeResponse({ output_text: 'I see a cat.' }) },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
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

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const input = body['input'] as Array<Record<string, unknown>>;
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
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Blue square.' },
      { type: 'response.completed', response: fakeResponse({ output_text: 'Blue square.' }) },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
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

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const input = body['input'] as Array<Record<string, unknown>>;
    const content = (input[0] as Record<string, unknown>)['content'] as Array<
      Record<string, unknown>
    >;
    expect(content[0]).toMatchObject({
      type: 'input_image',
      image_url: 'data:image/png;base64,abc123==',
    });
  });
});

// ── 4. Tool call + tool result replay ─────────────────────────────────────────

describe('CodexResponsesTransport — complete() — tool call + tool result replay', () => {
  it('sends tools as function-type items', async () => {
    globalThis.fetch = mockSseFetch([
      {
        type: 'response.completed',
        response: fakeResponse({
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
      },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
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

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      type: 'function',
      name: 'get_weather',
      description: 'Get weather for a city.',
    });
  });

  it('normalizes function_call output items as tool calls (via response.completed output array)', async () => {
    globalThis.fetch = mockSseFetch([
      {
        type: 'response.completed',
        response: fakeResponse({
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
      },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const response = await transport.complete({
      model: 'gpt-5.5',
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
  });

  it('converts tool result messages to function_call_output items', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'It is sunny in SF.' },
      { type: 'response.completed', response: fakeResponse({ output_text: 'It is sunny in SF.' }) },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await transport.complete({
      model: 'gpt-5.5',
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

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const input = body['input'] as Array<Record<string, unknown>>;
    const lastItem = input[input.length - 1];
    expect(lastItem).toMatchObject({
      type: 'function_call_output',
      call_id: 'call_abc123',
      output: '{"temperature":72,"condition":"sunny"}',
    });
  });
});

// ── 5. Error surfacing ────────────────────────────────────────────────────────

describe('CodexResponsesTransport — error surfacing', () => {
  it('includes JSON error body in thrown error message', async () => {
    const errBody = { error: { message: 'store must be false', code: 'invalid_request' } };
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errBody), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await expect(
      transport.complete({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 32,
      }),
    ).rejects.toThrow('store must be false');
  });

  it('includes raw text body when JSON parse fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('Bad Gateway', {
        status: 502,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await expect(
      transport.complete({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 32,
      }),
    ).rejects.toThrow('502 Bad Gateway');
  });

  it('falls back to "(no body)" when response body is empty', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 403,
        headers: {},
      }),
    );

    const transport = new CodexResponsesTransport(BASE_OPTS);
    await expect(
      transport.complete({
        model: 'gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 32,
      }),
    ).rejects.toThrow('403 status code (no body)');
  });
});

// ── 6. Streaming SSE ──────────────────────────────────────────────────────────

describe('CodexResponsesTransport — stream() — SSE iteration', () => {
  it('yields text deltas from response.output_text.delta events', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' world' },
      { type: 'response.completed', response: fakeResponse({ output_text: 'Hello world' }) },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const deltas = [];
    for await (const d of transport.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hello' }], maxTokens: 64 },
      {} as Parameters<typeof transport.stream>[1],
    )) {
      deltas.push(d);
    }

    const textDeltas = deltas.filter((d) => d.text.length > 0);
    expect(textDeltas.map((d) => d.text).join('')).toBe('Hello world');
  });

  it('yields final delta with stopReason and usage from response.completed', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Done' },
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
          },
        }),
      },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const deltas = [];
    for await (const d of transport.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'Done?' }], maxTokens: 32 },
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
    globalThis.fetch = mockSseFetch([{ type: 'response.output_text.delta', delta: 'Hi' }]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const deltas = [];
    for await (const d of transport.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'Hi' }], maxTokens: 16 },
      {} as Parameters<typeof transport.stream>[1],
    )) {
      deltas.push(d);
    }

    const finalDelta = deltas[deltas.length - 1];
    expect(finalDelta.stopReason).toBe('stop');
    expect(finalDelta.usage).toBeNull();
  });

  it('exits with failed stopReason on response.failed event', async () => {
    globalThis.fetch = mockSseFetch([
      {
        type: 'response.failed',
        response: {
          status: 'failed',
          error: { code: 'server_error', message: 'Internal server error' },
        },
      },
    ]);

    const transport = new CodexResponsesTransport(BASE_OPTS);
    const deltas = [];
    for await (const d of transport.stream(
      { model: 'gpt-5.5', messages: [{ role: 'user', content: 'hi' }], maxTokens: 16 },
      {} as Parameters<typeof transport.stream>[1],
    )) {
      deltas.push(d);
    }
    const finalDelta = deltas[deltas.length - 1];
    expect(finalDelta.stopReason).toBe('failed');
  });
});

// ── 7. xAI Responses profile ──────────────────────────────────────────────────

describe('CodexResponsesTransport — xAI profile', () => {
  it('uses provided baseUrl for endpoint', async () => {
    globalThis.fetch = mockSseFetch([
      { type: 'response.output_text.delta', delta: 'Grok says hi.' },
      { type: 'response.completed', response: fakeResponse({ output_text: 'Grok says hi.' }) },
    ]);

    const transport = new CodexResponsesTransport({
      provider: 'xai',
      apiKey: 'xai-test-key',
      baseUrl: 'https://api.x.ai/v1',
    });

    await transport.complete({
      model: 'grok-3',
      messages: [{ role: 'user', content: 'Hello Grok' }],
      maxTokens: 64,
    });

    const mockFetch = globalThis.fetch as ReturnType<typeof vi.fn>;
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://api.x.ai/v1/codex/responses');
    expect(transport.provider).toBe('xai');
    expect(transport.apiMode).toBe('codex_responses');
  });
});
