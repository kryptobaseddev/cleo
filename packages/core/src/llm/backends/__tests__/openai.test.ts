/**
 * OpenAIBackend mocked-client tests (T1735 — T1734 followup).
 *
 * Verifies the following code paths that were uncovered before this task:
 * - max_tokens vs max_completion_tokens param routing in _buildParams
 * - stream async-generator: content chunks yielded + isDone trigger from usage chunk
 * - tool-calling response normalization (_normalizeResponse tool_calls branch)
 * - json_schema structured-output branch (response_format set correctly)
 * - new OpenAI({ apiKey, baseURL }) constructor smoke test
 *
 * Mocking strategy: hand-rolled `{ chat: { completions: { create: vi.fn() } } }`
 * stubs — same approach as the existing MoonshotBackend tests. No network calls.
 *
 * @task T1735
 * @epic T1734
 */

import { OpenAI } from 'openai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import type { BackendCallParams } from '../../backend.js';
import { OpenAIBackend } from '../openai.js';

// ---------------------------------------------------------------------------
// Helper: minimal BackendCallParams with sensible defaults
// ---------------------------------------------------------------------------

/** Build minimal BackendCallParams with optional overrides. */
function makeParams(overrides: Partial<BackendCallParams> = {}): BackendCallParams {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 100,
    temperature: 0,
    stop: null,
    tools: null,
    toolChoice: null,
    responseFormat: null,
    thinkingBudgetTokens: null,
    thinkingEffort: null,
    maxOutputTokens: null,
    extraParams: null,
    ...overrides,
  };
}

/** Build a minimal mock OpenAI client whose create() resolves to the given response. */
function makeMockClient(response: Record<string, unknown>): {
  client: OpenAI;
  mockCreate: ReturnType<typeof vi.fn>;
} {
  const mockCreate = vi.fn().mockResolvedValue(response);
  const client = {
    chat: { completions: { create: mockCreate } },
  } as unknown as OpenAI;
  return { client, mockCreate };
}

/** Minimal valid ChatCompletion response shape. */
function makeCompletionResponse(
  content: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1_700_000_000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// OpenAIBackend.complete — mocked client
// ---------------------------------------------------------------------------

describe('OpenAIBackend.complete — mocked client', () => {
  it('uses max_tokens for gpt-4o (non-o-series)', async () => {
    const { client, mockCreate } = makeMockClient(makeCompletionResponse('hi'));
    const backend = new OpenAIBackend(client);

    await backend.complete(makeParams({ model: 'gpt-4o', maxTokens: 200 }));

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['max_tokens']).toBe(200);
    expect(callArgs).not.toHaveProperty('max_completion_tokens');
  });

  it('uses max_completion_tokens for o1 (o-series)', async () => {
    const { client, mockCreate } = makeMockClient(makeCompletionResponse('answer'));
    const backend = new OpenAIBackend(client);

    await backend.complete(makeParams({ model: 'o1', maxTokens: 300 }));

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['max_completion_tokens']).toBe(300);
    expect(callArgs).not.toHaveProperty('max_tokens');
  });

  it('uses max_completion_tokens for gpt-5 (gpt-5 series)', async () => {
    const { client, mockCreate } = makeMockClient(makeCompletionResponse('answer'));
    const backend = new OpenAIBackend(client);

    await backend.complete(makeParams({ model: 'gpt-5', maxTokens: 150 }));

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs['max_completion_tokens']).toBe(150);
    expect(callArgs).not.toHaveProperty('max_tokens');
  });

  it('maps result.content from choices[0].message.content', async () => {
    const { client } = makeMockClient(makeCompletionResponse('The answer is 42'));
    const backend = new OpenAIBackend(client);

    const result = await backend.complete(makeParams());

    expect(result.content).toBe('The answer is 42');
    expect(result.finishReason).toBe('stop');
  });

  it('maps inputTokens / outputTokens from usage', async () => {
    const response = makeCompletionResponse('ok', {
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    });
    const { client } = makeMockClient(response);
    const backend = new OpenAIBackend(client);

    const result = await backend.complete(makeParams());

    expect(result.inputTokens).toBe(20);
    expect(result.outputTokens).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// OpenAIBackend.stream — mocked async-generator client
// ---------------------------------------------------------------------------

/**
 * Build an async-generator mock for chat.completions.create that yields the
 * provided chunks in order.
 */
function makeStreamClient(chunks: Array<Record<string, unknown>>): {
  client: OpenAI;
  mockCreate: ReturnType<typeof vi.fn>;
} {
  async function* fakeStream(): AsyncGenerator<Record<string, unknown>> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }
  const mockCreate = vi.fn().mockResolvedValue(fakeStream());
  const client = {
    chat: { completions: { create: mockCreate } },
  } as unknown as OpenAI;
  return { client, mockCreate };
}

describe('OpenAIBackend.stream — mocked async-generator client', () => {
  it('yields content chunks for delta.content chunks', async () => {
    const { client } = makeStreamClient([
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { completion_tokens: 2, prompt_tokens: 5, total_tokens: 7 },
      },
    ]);
    const backend = new OpenAIBackend(client);

    const collected: Array<{ content: string; isDone: boolean }> = [];
    for await (const chunk of backend.stream(makeParams())) {
      collected.push({ content: chunk.content, isDone: chunk.isDone });
    }

    const contentChunks = collected.filter((c) => !c.isDone);
    expect(contentChunks.map((c) => c.content).join('')).toBe('Hello world');
  });

  it('emits isDone:true chunk when usage chunk arrives', async () => {
    const { client } = makeStreamClient([
      { choices: [{ delta: { content: 'hi' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { completion_tokens: 3, prompt_tokens: 4, total_tokens: 7 },
      },
    ]);
    const backend = new OpenAIBackend(client);

    const chunks: Array<import('../../backend.js').StreamChunk> = [];
    for await (const chunk of backend.stream(makeParams())) {
      chunks.push(chunk);
    }

    const doneChunk = chunks.find((c) => c.isDone);
    expect(doneChunk).toBeDefined();
    expect(doneChunk?.isDone).toBe(true);
  });

  it('populates outputTokens from usage chunk', async () => {
    const { client } = makeStreamClient([
      { choices: [{ delta: { content: 'x' }, finish_reason: null }] },
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { completion_tokens: 7, prompt_tokens: 4, total_tokens: 11 },
      },
    ]);
    const backend = new OpenAIBackend(client);

    const chunks: Array<import('../../backend.js').StreamChunk> = [];
    for await (const chunk of backend.stream(makeParams())) {
      chunks.push(chunk);
    }

    const doneChunk = chunks.find((c) => c.isDone);
    expect(doneChunk?.outputTokens).toBe(7);
  });

  it('emits fallback isDone:true from finishReason when no usage chunk arrives', async () => {
    const { client } = makeStreamClient([
      { choices: [{ delta: { content: 'done' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      // no usage chunk
    ]);
    const backend = new OpenAIBackend(client);

    const chunks: Array<import('../../backend.js').StreamChunk> = [];
    for await (const chunk of backend.stream(makeParams())) {
      chunks.push(chunk);
    }

    const doneChunk = chunks.find((c) => c.isDone);
    expect(doneChunk).toBeDefined();
    expect(doneChunk?.finishReason).toBe('stop');
  });
});

// ---------------------------------------------------------------------------
// Tool-calling response normalization
// ---------------------------------------------------------------------------

describe('OpenAIBackend._normalizeResponse — tool_calls branch', () => {
  it('extracts toolCalls[0].name and parsed input from mock response', async () => {
    const responseWithTools = makeCompletionResponse('', {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc1',
                type: 'function',
                function: {
                  name: 'search',
                  arguments: '{"q":"hello"}',
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { client } = makeMockClient(responseWithTools);
    const backend = new OpenAIBackend(client);

    const result = await backend.complete(makeParams());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.name).toBe('search');
    expect((result.toolCalls[0]?.input as { q: string })['q']).toBe('hello');
  });

  it('skips non-function tool call types', async () => {
    const responseWithCustomTool = makeCompletionResponse('', {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc2',
                type: 'custom',
                function: { name: 'whatever', arguments: '{}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { client } = makeMockClient(responseWithCustomTool);
    const backend = new OpenAIBackend(client);

    const result = await backend.complete(makeParams());

    // custom type must be filtered out
    expect(result.toolCalls).toHaveLength(0);
  });

  it('returns empty toolInput when arguments are malformed JSON', async () => {
    const responseWithBadArgs = makeCompletionResponse('', {
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'tc3',
                type: 'function',
                function: { name: 'broken', arguments: 'NOT_JSON' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const { client } = makeMockClient(responseWithBadArgs);
    const backend = new OpenAIBackend(client);

    const result = await backend.complete(makeParams());

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.input).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// json_schema structured-output branch
// ---------------------------------------------------------------------------

describe('OpenAIBackend.complete — json_schema structured-output branch', () => {
  it('sets response_format.type to json_schema when responseFormat is a Zod schema', async () => {
    const ResponseSchema = z.object({ answer: z.string(), score: z.number() });

    const jsonPayload = JSON.stringify({ answer: 'yes', score: 42 });
    const { client, mockCreate } = makeMockClient(makeCompletionResponse(jsonPayload));
    const backend = new OpenAIBackend(client);

    // Attach the Zod schema as a property named `schema` on the constructor function
    // (the pattern OpenAIBackend._zodSchemaFrom checks).
    function ResponseFormat() {
      /* no-op constructor */
    }
    Object.assign(ResponseFormat, { schema: ResponseSchema });

    await backend.complete(
      makeParams({
        responseFormat: ResponseFormat as unknown as new (...args: unknown[]) => unknown,
      }),
    );

    const callArgs = mockCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    const rf = callArgs['response_format'] as Record<string, unknown>;
    expect(rf['type']).toBe('json_schema');
    expect(typeof rf['json_schema']).toBe('object');
  });

  it('returns parsed content matching the Zod schema shape', async () => {
    const ResponseSchema = z.object({ answer: z.string() });
    const jsonPayload = JSON.stringify({ answer: 'structured' });

    const { client } = makeMockClient(makeCompletionResponse(jsonPayload));
    const backend = new OpenAIBackend(client);

    function ResponseFormat() {
      /* no-op */
    }
    Object.assign(ResponseFormat, { schema: ResponseSchema });

    const result = await backend.complete(
      makeParams({
        responseFormat: ResponseFormat as unknown as new (...args: unknown[]) => unknown,
      }),
    );

    expect((result.content as { answer: string })['answer']).toBe('structured');
  });
});

// ---------------------------------------------------------------------------
// new OpenAI({ apiKey, baseURL }) constructor smoke test
// ---------------------------------------------------------------------------

describe('new OpenAI constructor smoke test', () => {
  it('constructs without error given apiKey and baseURL', () => {
    // Verifies the v6 constructor API is stable: if a breaking rename
    // occurred the import or instantiation would throw / fail typecheck.
    expect(() => {
      const client = new OpenAI({ apiKey: 'test-key', baseURL: 'http://localhost:1234' });
      // Verify the client has the expected interface surface
      expect(typeof client.chat.completions.create).toBe('function');
    }).not.toThrow();
  });

  it('constructs with apiKey only (no baseURL)', () => {
    expect(() => {
      const client = new OpenAI({ apiKey: 'sk-test' });
      expect(typeof client.chat.completions.create).toBe('function');
    }).not.toThrow();
  });
});
