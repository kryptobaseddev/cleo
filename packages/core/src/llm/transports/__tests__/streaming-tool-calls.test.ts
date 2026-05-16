/**
 * Unit tests for streaming tool-call delta emission (T9316 + T9362).
 *
 * Covers:
 * 1. AnthropicTransport.stream() — tool_use sequence yields start/args/end deltas
 * 2. ChatCompletionsTransport.stream() — OpenAI tool_calls yields incremental args
 * 3. OpenAITransport.stream() — tool_calls yields start/args deltas (T9362 parity)
 * 4. GeminiTransport.stream() — functionCall parts yield start/args/end deltas (T9362 parity)
 * 5. Consumers can accumulate argumentsChunk fragments to reconstruct full JSON
 *
 * @task T9316
 * @task T9362 (openai+gemini streaming parity)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 5)
 */

import type { NormalizedDelta } from '@cleocode/contracts/llm/interfaces.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock transitive deps before any transport imports
// ---------------------------------------------------------------------------

vi.mock('jsonrepair', () => ({
  jsonrepair: (s: string) => s,
}));

vi.mock('../../prompt-caching.js', () => ({
  injectCacheBreakpoints: () => undefined,
}));

vi.mock('../../structured-output.js', () => ({
  repairResponseModelJson: (s: string) => s,
}));

vi.mock('../think-scrubber.js', () => ({
  StreamingThinkScrubber: class {
    feed(text: string) {
      return text;
    }
    flush() {
      return '';
    }
  },
}));

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk before any imports
// ---------------------------------------------------------------------------

const { mockMessagesStream } = vi.hoisted(() => {
  const mockMessagesStream = vi.fn();
  return { mockMessagesStream };
});

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    messages = {
      stream: mockMessagesStream,
    };
  }
  return { default: MockAnthropic };
});

// ---------------------------------------------------------------------------
// Mock openai before any imports
// ---------------------------------------------------------------------------

const { mockChatCompletionsCreate } = vi.hoisted(() => {
  const mockChatCompletionsCreate = vi.fn();
  return { mockChatCompletionsCreate };
});

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: mockChatCompletionsCreate,
      },
    };
  }
  return { default: MockOpenAI, OpenAI: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Mock @google/generative-ai before any imports
// ---------------------------------------------------------------------------

const { mockGenerateContentStream } = vi.hoisted(() => {
  const mockGenerateContentStream = vi.fn();
  return { mockGenerateContentStream };
});

vi.mock('@google/generative-ai', () => {
  class MockGoogleGenerativeAI {
    getGenerativeModel(_opts: unknown) {
      return {
        generateContentStream: mockGenerateContentStream,
      };
    }
  }
  return { GoogleGenerativeAI: MockGoogleGenerativeAI };
});

// Mock caching helpers used by GeminiTransport
vi.mock('../../caching.js', () => ({
  buildCacheKey: () => 'test-key',
  geminiCacheStore: { get: () => undefined, set: () => null },
}));

// ---------------------------------------------------------------------------
// Mock image-routing (no-op for transport tests)
// ---------------------------------------------------------------------------

vi.mock('../../image-routing.js', () => ({
  validateImagesForProvider: () => undefined,
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

import { AnthropicTransport } from '../anthropic.js';
import { ChatCompletionsTransport } from '../chat-completions.js';
import { GeminiTransport } from '../gemini.js';
import { OpenAITransport } from '../openai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect all deltas from an async iterable. */
async function collectDeltas(iter: AsyncIterable<NormalizedDelta>): Promise<NormalizedDelta[]> {
  const out: NormalizedDelta[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

/** Build a minimal TransportContext for tests. */
function makeCtx() {
  return { requestId: 'test-req-001' };
}

// ---------------------------------------------------------------------------
// Anthropic streaming tool-call tests
// ---------------------------------------------------------------------------

describe('AnthropicTransport.stream() — tool-call deltas', () => {
  let transport: AnthropicTransport;

  beforeEach(() => {
    transport = new AnthropicTransport({ apiKey: 'test-key' });
    vi.clearAllMocks();
  });

  it('yields start, args, and end deltas for a single tool_use block', async () => {
    // Simulate Anthropic SSE sequence for one tool call.
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_weather' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"city":' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"Paris"}' },
      },
      { type: 'content_block_stop', index: 0 },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () =>
            i < events.length
              ? { value: events[i++], done: false }
              : { value: undefined, done: true },
        };
      },
      finalMessage: async () => ({
        stop_reason: 'tool_use',
        usage: { input_tokens: 20, output_tokens: 10, cache_read_input_tokens: null },
      }),
    };
    mockMessagesStream.mockReturnValue(mockStream);

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    // Filter to only tool-call deltas
    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(3);

    // Start marker: name present, empty argumentsChunk
    const start = toolDeltas[0];
    expect(start.toolCallDelta?.index).toBe(0);
    expect(start.toolCallDelta?.name).toBe('get_weather');
    expect(start.toolCallDelta?.argumentsChunk).toBe('');

    // Args chunks: contain partial JSON
    const argChunks = toolDeltas.slice(1, -1);
    const accumulated = argChunks.map((d) => d.toolCallDelta?.argumentsChunk ?? '').join('');
    expect(accumulated).toBe('{"city":"Paris"}');

    // End marker: no name, empty argumentsChunk
    const end = toolDeltas[toolDeltas.length - 1];
    expect(end.toolCallDelta?.index).toBe(0);
    expect(end.toolCallDelta?.name).toBeUndefined();
    expect(end.toolCallDelta?.argumentsChunk).toBe('');

    // Final delta carries usage
    const final = deltas[deltas.length - 1];
    expect(final.stopReason).toBe('tool_use');
    expect(final.usage?.inputTokens).toBe(20);
  });

  it('does not interfere with text deltas in a mixed stream', async () => {
    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello ' },
      },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_02', name: 'calculator' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"expr":"1+1"}' },
      },
      { type: 'content_block_stop', index: 1 },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () =>
            i < events.length
              ? { value: events[i++], done: false }
              : { value: undefined, done: true },
        };
      },
      finalMessage: async () => ({
        stop_reason: 'tool_use',
        usage: { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: null },
      }),
    };
    mockMessagesStream.mockReturnValue(mockStream);

    const deltas = await collectDeltas(
      transport.stream(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'calc' }],
          maxTokens: 100,
        },
        makeCtx(),
      ),
    );

    const textDeltas = deltas.filter((d) => d.text.length > 0);
    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);

    expect(textDeltas.map((d) => d.text).join('')).toBe('Hello ');
    const toolStart = toolDeltas[0];
    expect(toolStart.toolCallDelta?.name).toBe('calculator');
    const argsChunk = toolDeltas
      .slice(1, -1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');
    expect(argsChunk).toBe('{"expr":"1+1"}');
  });

  it('consumer can reconstruct full arguments JSON from accumulated chunks', async () => {
    const fullArgs = JSON.stringify({ query: 'climate change', limit: 10, format: 'json' });
    // Split into 4 chunks to simulate realistic streaming
    const chunk1 = fullArgs.slice(0, 10);
    const chunk2 = fullArgs.slice(10, 30);
    const chunk3 = fullArgs.slice(30, 50);
    const chunk4 = fullArgs.slice(50);

    const events = [
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_03', name: 'web_search' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk1 },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk2 },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk3 },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: chunk4 },
      },
      { type: 'content_block_stop', index: 0 },
    ];

    const mockStream = {
      [Symbol.asyncIterator]: () => {
        let i = 0;
        return {
          next: async () =>
            i < events.length
              ? { value: events[i++], done: false }
              : { value: undefined, done: true },
        };
      },
      finalMessage: async () => ({
        stop_reason: 'tool_use',
        usage: { input_tokens: 30, output_tokens: 15, cache_read_input_tokens: null },
      }),
    };
    mockMessagesStream.mockReturnValue(mockStream);

    const deltas = await collectDeltas(
      transport.stream(
        {
          model: 'claude-sonnet-4-6',
          messages: [{ role: 'user', content: 'search' }],
          maxTokens: 200,
        },
        makeCtx(),
      ),
    );

    // Accumulate all argument chunks (skip start/end markers which have empty argumentsChunk)
    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    const accumulated = toolDeltas.map((d) => d.toolCallDelta?.argumentsChunk ?? '').join('');

    const parsed = JSON.parse(accumulated) as Record<string, unknown>;
    expect(parsed).toEqual({ query: 'climate change', limit: 10, format: 'json' });
  });
});

// ---------------------------------------------------------------------------
// ChatCompletionsTransport streaming tool-call tests
// ---------------------------------------------------------------------------

describe('ChatCompletionsTransport.stream() — tool-call deltas', () => {
  let transport: ChatCompletionsTransport;

  beforeEach(() => {
    transport = new ChatCompletionsTransport({ provider: 'openai', apiKey: 'test-key' });
    vi.clearAllMocks();
  });

  it('yields start and incremental args deltas for OpenAI-style tool_calls', async () => {
    // Simulate OpenAI streaming tool-call chunks
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: '', arguments: '{"city":' } }],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: '', arguments: '"London"}' } }],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: null,
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 25, completion_tokens: 12 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'weather?' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

    // First chunk: start marker with name
    const first = toolDeltas[0];
    expect(first.toolCallDelta?.index).toBe(0);
    expect(first.toolCallDelta?.name).toBe('get_weather');

    // Subsequent: incremental argument JSON
    const argText = toolDeltas
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');
    expect(argText).toBe('{"city":"London"}');

    // Final delta has usage
    const final = deltas[deltas.length - 1];
    expect(final.stopReason).toBe('tool_calls');
    expect(final.usage?.inputTokens).toBe(25);
  });

  it('handles multiple parallel tool calls at different indices', async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'tool_a', arguments: '' } },
                { index: 1, function: { name: 'tool_b', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
        usage: null,
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: '', arguments: '{"x":1}' } },
                { index: 1, function: { name: '', arguments: '{"y":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: null,
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'multi' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);

    // Should have start + args for both indices
    const idx0 = toolDeltas.filter((d) => d.toolCallDelta?.index === 0);
    const idx1 = toolDeltas.filter((d) => d.toolCallDelta?.index === 1);

    expect(idx0[0].toolCallDelta?.name).toBe('tool_a');
    expect(idx1[0].toolCallDelta?.name).toBe('tool_b');

    const args0 = idx0
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');
    const args1 = idx1
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');

    expect(JSON.parse(args0)).toEqual({ x: 1 });
    expect(JSON.parse(args1)).toEqual({ y: 2 });
  });

  it('existing text consumers (delta.text) still work unaffected by tool deltas', async () => {
    const chunks = [
      {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
        usage: null,
      },
      {
        choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
        usage: null,
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
        makeCtx(),
      ),
    );

    const textContent = deltas
      .filter((d) => d.text.length > 0)
      .map((d) => d.text)
      .join('');
    expect(textContent).toBe('Hello world');

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// OpenAITransport streaming tool-call tests (T9362 parity)
// ---------------------------------------------------------------------------

describe('OpenAITransport.stream() — tool-call deltas (T9362)', () => {
  let transport: OpenAITransport;

  beforeEach(() => {
    transport = new OpenAITransport({ apiKey: 'test-key' });
    vi.clearAllMocks();
  });

  it('yields start and incremental args deltas for a single tool call', async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: 'get_weather', arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: '', arguments: '{"city":' } }],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { name: '', arguments: '"Paris"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 20, completion_tokens: 10 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'weather?' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas.length).toBeGreaterThanOrEqual(2);

    // First delta: start marker with name
    const first = toolDeltas[0];
    expect(first.toolCallDelta?.index).toBe(0);
    expect(first.toolCallDelta?.name).toBe('get_weather');

    // Subsequent: incremental argument JSON
    const argText = toolDeltas
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');
    expect(argText).toBe('{"city":"Paris"}');

    // Final delta has usage and stop reason
    const final = deltas[deltas.length - 1];
    expect(final.stopReason).toBe('tool_calls');
    expect(final.usage?.inputTokens).toBe(20);
  });

  it('handles two parallel tool calls at different indices', async () => {
    const chunks = [
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'tool_a', arguments: '' } },
                { index: 1, function: { name: 'tool_b', arguments: '' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: '', arguments: '{"x":1}' } },
                { index: 1, function: { name: '', arguments: '{"y":2}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'multi' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    const idx0 = toolDeltas.filter((d) => d.toolCallDelta?.index === 0);
    const idx1 = toolDeltas.filter((d) => d.toolCallDelta?.index === 1);

    expect(idx0[0].toolCallDelta?.name).toBe('tool_a');
    expect(idx1[0].toolCallDelta?.name).toBe('tool_b');

    const args0 = idx0
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');
    const args1 = idx1
      .slice(1)
      .map((d) => d.toolCallDelta?.argumentsChunk ?? '')
      .join('');

    expect(JSON.parse(args0)).toEqual({ x: 1 });
    expect(JSON.parse(args1)).toEqual({ y: 2 });
  });

  it('text-only stream emits no toolCallDelta entries', async () => {
    const chunks = [
      {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
      },
      {
        choices: [{ delta: { content: ' world' }, finish_reason: 'stop' }],
      },
      {
        choices: [{ delta: {}, finish_reason: null }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      },
    ];

    mockChatCompletionsCreate.mockResolvedValue(
      (async function* () {
        for (const c of chunks) yield c;
      })(),
    );

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
        makeCtx(),
      ),
    );

    const textContent = deltas
      .filter((d) => d.text.length > 0)
      .map((d) => d.text)
      .join('');
    expect(textContent).toBe('Hello world');

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// GeminiTransport streaming tool-call tests (T9362 parity)
// ---------------------------------------------------------------------------

describe('GeminiTransport.stream() — tool-call deltas (T9362)', () => {
  let transport: GeminiTransport;

  beforeEach(() => {
    transport = new GeminiTransport({ apiKey: 'test-key' });
    vi.clearAllMocks();
  });

  it('yields start/args/end triple for a single functionCall part', async () => {
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: 'get_weather', args: { city: 'Tokyo' } },
                },
              ],
            },
            finish_reason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 8 },
      },
    ];

    mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        for (const c of chunks) yield c;
      })(),
    });

    const deltas = await collectDeltas(
      transport.stream(
        {
          model: 'gemini-1.5-pro',
          messages: [{ role: 'user', content: 'weather?' }],
          maxTokens: 100,
        },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    // Expect at least: start + args + end = 3 deltas
    expect(toolDeltas.length).toBeGreaterThanOrEqual(3);

    // Start marker — name present, empty argumentsChunk
    const start = toolDeltas[0];
    expect(start.toolCallDelta?.index).toBe(0);
    expect(start.toolCallDelta?.name).toBe('get_weather');
    expect(start.toolCallDelta?.argumentsChunk).toBe('');

    // Args delta — JSON-serialized args
    const argDeltas = toolDeltas.filter(
      (d) => d.toolCallDelta?.argumentsChunk !== '' && d.toolCallDelta?.name === undefined,
    );
    const accumulated = argDeltas.map((d) => d.toolCallDelta?.argumentsChunk ?? '').join('');
    expect(JSON.parse(accumulated)).toEqual({ city: 'Tokyo' });

    // End marker — no name, empty argumentsChunk
    const end = toolDeltas[toolDeltas.length - 1];
    expect(end.toolCallDelta?.name).toBeUndefined();
    expect(end.toolCallDelta?.argumentsChunk).toBe('');
  });

  it('emits consecutive indices for multiple functionCall parts', async () => {
    const chunks = [
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'tool_a', args: { x: 1 } } },
                { functionCall: { name: 'tool_b', args: { y: 2 } } },
              ],
            },
            finish_reason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 6 },
      },
    ];

    mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        for (const c of chunks) yield c;
      })(),
    });

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'multi' }], maxTokens: 100 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    const idx0Starts = toolDeltas.filter(
      (d) => d.toolCallDelta?.index === 0 && d.toolCallDelta?.name !== undefined,
    );
    const idx1Starts = toolDeltas.filter(
      (d) => d.toolCallDelta?.index === 1 && d.toolCallDelta?.name !== undefined,
    );

    expect(idx0Starts[0].toolCallDelta?.name).toBe('tool_a');
    expect(idx1Starts[0].toolCallDelta?.name).toBe('tool_b');

    // Verify args are properly serialized for index 0
    const idx0Args = toolDeltas.filter(
      (d) =>
        d.toolCallDelta?.index === 0 &&
        d.toolCallDelta?.name === undefined &&
        d.toolCallDelta?.argumentsChunk !== '',
    );
    const args0 = idx0Args.map((d) => d.toolCallDelta?.argumentsChunk ?? '').join('');
    expect(JSON.parse(args0)).toEqual({ x: 1 });
  });

  it('text-only stream emits no toolCallDelta entries', async () => {
    const chunks = [
      {
        text: 'Hello world',
        candidates: [
          {
            content: { parts: [{ text: 'Hello world' }] },
            finish_reason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
      },
    ];

    mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        for (const c of chunks) yield c;
      })(),
    });

    const deltas = await collectDeltas(
      transport.stream(
        { model: 'gemini-1.5-pro', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50 },
        makeCtx(),
      ),
    );

    const toolDeltas = deltas.filter((d) => d.toolCallDelta !== undefined);
    expect(toolDeltas).toHaveLength(0);
  });
});
