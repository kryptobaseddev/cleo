/**
 * Unit tests for OllamaTransport (T9355 — Task A — Ollama transport).
 *
 * Tests cover:
 * 1. Happy path — complete() returns normalized response with content.
 * 2. 5xx retry — transient 503 is retried; success on second attempt.
 * 3. Tool use — tool call in response is normalized to NormalizedToolCall.
 * 4. Streaming chunks — stream() yields incremental deltas then final usage.
 * 5. Error mapping — non-retryable 4xx throws immediately without retrying.
 * 6. Provider / apiMode identity — transport declares correct identifiers.
 *
 * All tests mock `globalThis.fetch` so no real network calls are made.
 *
 * @task T9355 (Task A — Ollama transport)
 * @epic T9354
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OLLAMA_DEFAULT_BASE_URL, OllamaTransport } from '../ollama.js';

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

/** Build a mock Response for a complete (non-streaming) Ollama reply. */
function makeCompleteResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a mock Response that streams Ollama NDJSON chunks.
 *
 * Each element of `chunks` is serialized to a newline-terminated JSON line.
 */
function makeStreamResponse(chunks: Array<Record<string, unknown>>, status = 200): Response {
  const lines = chunks.map((c) => JSON.stringify(c)).join('\n') + '\n';
  return new Response(lines, {
    status,
    headers: { 'Content-Type': 'application/x-ndjson' },
  });
}

/**
 * Build a minimal Ollama complete response body.
 */
function fakeCompleteBody(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    model: 'llama3',
    message: { role: 'assistant', content: 'Hello from Ollama!', tool_calls: null },
    done: true,
    done_reason: 'stop',
    eval_count: 15,
    prompt_eval_count: 8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const BASE_REQUEST = {
  model: 'llama3',
  messages: [{ role: 'user' as const, content: 'Hello' }],
  maxTokens: 256,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OllamaTransport', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllTimers();
  });

  // ── 1. Provider / apiMode identity ────────────────────────────────────────

  it('declares provider=ollama and apiMode=ollama_native', () => {
    const transport = new OllamaTransport();
    expect(transport.provider).toBe('ollama');
    expect(transport.apiMode).toBe('ollama_native');
  });

  // ── 2. Happy path — complete() ────────────────────────────────────────────

  it('complete() returns normalized response with content', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));
    const transport = new OllamaTransport();

    const result = await transport.complete(BASE_REQUEST);

    expect(result.content).toBe('Hello from Ollama!');
    expect(result.model).toBe('llama3');
    expect(result.stopReason).toBe('stop');
    expect(result.usage.inputTokens).toBe(8);
    expect(result.usage.outputTokens).toBe(15);
    expect(result.toolCalls).toBeNull();
  });

  it('complete() uses POST /api/chat against the base URL', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));
    const transport = new OllamaTransport({ baseUrl: 'http://localhost:11434' });

    await transport.complete(BASE_REQUEST);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/chat');
    expect(init.method).toBe('POST');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('llama3');
    expect(body['stream']).toBe(false);
  });

  it('complete() uses the default base URL when none is provided', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));
    const transport = new OllamaTransport();

    await transport.complete(BASE_REQUEST);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OLLAMA_DEFAULT_BASE_URL}/api/chat`);
  });

  it('complete() honors a custom baseUrl', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));
    const transport = new OllamaTransport({ baseUrl: 'http://192.168.1.50:11434' });

    await transport.complete(BASE_REQUEST);

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.50:11434/api/chat');
  });

  // ── 3. 5xx retry ─────────────────────────────────────────────────────────

  it('retries on 503 and succeeds on the second attempt', async () => {
    // Mock setTimeout to skip the actual backoff delay in tests
    vi.useFakeTimers();

    fetchMock
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));

    const transport = new OllamaTransport();

    // Start the promise, run timers to skip backoff, then await the result
    const promise = transport.complete(BASE_REQUEST);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result.content).toBe('Hello from Ollama!');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it('throws after all retries are exhausted on persistent 503', async () => {
    vi.useFakeTimers();

    // Always return 503
    fetchMock.mockResolvedValue(new Response('Service Unavailable', { status: 503 }));

    const transport = new OllamaTransport();

    // Attach the rejection handler BEFORE running timers to avoid an unhandled
    // rejection between the promise creation and the `await expect(...)`.
    const promise = transport.complete(BASE_REQUEST);
    const rejection = expect(promise).rejects.toThrow('OllamaTransport');

    await vi.runAllTimersAsync();
    await rejection;

    vi.useRealTimers();
  });

  it('throws immediately on non-retryable 404 without retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

    const transport = new OllamaTransport();
    await expect(transport.complete(BASE_REQUEST)).rejects.toThrow('HTTP 404');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── 4. Tool use ───────────────────────────────────────────────────────────

  it('normalizes tool calls from response — arguments are serialized to JSON string', async () => {
    const bodyWithTool = fakeCompleteBody({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'get_weather',
              arguments: { location: 'Paris', unit: 'celsius' },
            },
          },
        ],
      },
    });
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(bodyWithTool));

    const transport = new OllamaTransport();
    const result = await transport.complete({
      ...BASE_REQUEST,
      tools: [
        {
          name: 'get_weather',
          description: 'Get the weather',
          inputSchema: { type: 'object', properties: { location: { type: 'string' } } },
        },
      ],
    });

    expect(result.toolCalls).toHaveLength(1);
    const tc = result.toolCalls![0];
    expect(tc.name).toBe('get_weather');
    // Ollama returns arguments as object; transport serializes to JSON string
    const parsed = JSON.parse(tc.arguments) as Record<string, unknown>;
    expect(parsed['location']).toBe('Paris');
    expect(parsed['unit']).toBe('celsius');
    // Ollama does not assign tool-call IDs
    expect(tc.id).toBeNull();
  });

  it('sends tool definitions in the request body when tools are provided', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));

    const transport = new OllamaTransport();
    await transport.complete({
      ...BASE_REQUEST,
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const tools = body['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(1);
    const fn = tools[0]!['function'] as Record<string, unknown>;
    expect(fn['name']).toBe('search');
  });

  // ── 5. Streaming ─────────────────────────────────────────────────────────

  it('stream() yields content deltas then final usage chunk', async () => {
    const chunks = [
      { model: 'llama3', message: { role: 'assistant', content: 'Hello' }, done: false },
      { model: 'llama3', message: { role: 'assistant', content: ' world' }, done: false },
      {
        model: 'llama3',
        message: { role: 'assistant', content: '' },
        done: true,
        done_reason: 'stop',
        eval_count: 10,
        prompt_eval_count: 5,
      },
    ];
    fetchMock.mockResolvedValueOnce(makeStreamResponse(chunks));

    const transport = new OllamaTransport();
    const ctx = {} as import('@cleocode/contracts/llm/interfaces.js').TransportContext;
    const deltas: Array<import('@cleocode/contracts/llm/interfaces.js').NormalizedDelta> = [];

    for await (const delta of transport.stream(BASE_REQUEST, ctx)) {
      deltas.push(delta);
    }

    // Expect two text deltas + one final usage delta
    expect(deltas[0]).toMatchObject({ text: 'Hello', stopReason: null });
    expect(deltas[1]).toMatchObject({ text: ' world', stopReason: null });
    const finalDelta = deltas[2];
    expect(finalDelta!.stopReason).toBe('stop');
    expect(finalDelta!.usage?.inputTokens).toBe(5);
    expect(finalDelta!.usage?.outputTokens).toBe(10);
  });

  it('stream() sends request with stream=true', async () => {
    const chunks = [
      {
        model: 'llama3',
        message: { role: 'assistant', content: 'Hi' },
        done: true,
        done_reason: 'stop',
        eval_count: 3,
        prompt_eval_count: 2,
      },
    ];
    fetchMock.mockResolvedValueOnce(makeStreamResponse(chunks));

    const transport = new OllamaTransport();
    const ctx = {} as import('@cleocode/contracts/llm/interfaces.js').TransportContext;

    const drainedDeltas: unknown[] = [];
    for await (const delta of transport.stream(BASE_REQUEST, ctx)) {
      drainedDeltas.push(delta);
    }
    expect(drainedDeltas.length).toBeGreaterThan(0);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['stream']).toBe(true);
  });

  // ── 6. System prompt ─────────────────────────────────────────────────────

  it('prepends system message when request.system is set', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));

    const transport = new OllamaTransport();
    await transport.complete({ ...BASE_REQUEST, system: 'You are a helpful assistant.' });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a helpful assistant.' });
    expect(messages[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  // ── 7. Auth header ────────────────────────────────────────────────────────

  it('injects Authorization header when apiKey is provided', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));

    const transport = new OllamaTransport({ apiKey: 'my-secret-token' });
    await transport.complete(BASE_REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer my-secret-token');
  });

  it('does not inject Authorization header when no apiKey is provided', async () => {
    fetchMock.mockResolvedValueOnce(makeCompleteResponse(fakeCompleteBody()));

    const transport = new OllamaTransport();
    await transport.complete(BASE_REQUEST);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });
});
