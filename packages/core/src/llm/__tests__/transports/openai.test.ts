/**
 * Unit tests for OpenAITransport (T9284 — Wave 1b migration).
 *
 * Exercises the three @invariant constraints ported verbatim from
 * `backends/openai.ts`:
 *
 * 1. usesMaxCompletionTokens o-series branching.
 * 2. extractReasoningContent intentional try/catch swallow.
 * 3. parse() vs json_schema streaming split.
 *
 * @task T9284
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock the openai SDK before imports
// ---------------------------------------------------------------------------

const { mockCreate, MockOpenAI } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  function MockOpenAI(_opts: Record<string, unknown>) {
    return {
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    };
  }
  return { mockCreate, MockOpenAI };
});

vi.mock('openai', () => ({
  OpenAI: MockOpenAI,
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { OpenAITransport, usesMaxCompletionTokens } from '../../transports/openai.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCompletion(
  content: string,
  model = 'gpt-4o',
  opts: { promptTokens?: number; completionTokens?: number; reasoningContent?: string } = {},
): Record<string, unknown> {
  const message: Record<string, unknown> = { role: 'assistant', content };
  if (opts.reasoningContent) {
    message['reasoning_content'] = opts.reasoningContent;
  }
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 10,
      completion_tokens: opts.completionTokens ?? 5,
      total_tokens: (opts.promptTokens ?? 10) + (opts.completionTokens ?? 5),
    },
  };
}

function makeRequest(model: string, content = 'Hello') {
  return {
    model,
    messages: [{ role: 'user' as const, content }],
    maxTokens: 128,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenAITransport', () => {
  it('sends max_completion_tokens for o3-mini and gpt-5', async () => {
    const transport = new OpenAITransport({ apiKey: 'sk-test' });

    for (const model of ['o3-mini', 'gpt-5', 'gpt-5-turbo', 'o1-preview', 'o4-mini']) {
      mockCreate.mockResolvedValueOnce(makeCompletion('ok', model));
      await transport.complete(makeRequest(model));

      const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
        string,
        unknown
      >;
      expect(callArgs['max_completion_tokens']).toBe(128);
      expect(callArgs['max_tokens']).toBeUndefined();
    }
  });

  it('sends max_tokens for gpt-4o non-o-series', async () => {
    const transport = new OpenAITransport({ apiKey: 'sk-test' });

    for (const model of ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo']) {
      mockCreate.mockResolvedValueOnce(makeCompletion('ok', model));
      await transport.complete(makeRequest(model));

      const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
        string,
        unknown
      >;
      expect(callArgs['max_tokens']).toBe(128);
      expect(callArgs['max_completion_tokens']).toBeUndefined();
    }
  });

  it('swallows reasoning extraction errors as null', async () => {
    const transport = new OpenAITransport({ apiKey: 'sk-test' });

    // Response where reasoning_details is a non-iterable value that would throw
    const badResponse = {
      id: 'chatcmpl-bad',
      model: 'gpt-4o',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'hello',
            // Accessing reasoning_details as Array.isArray passes, but iteration throws
            reasoning_details: null,
            reasoning_content: null,
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    };

    mockCreate.mockResolvedValueOnce(badResponse);
    const result = await transport.complete(makeRequest('gpt-4o'));

    // Should not throw — reasoning is absent but content is still returned
    expect(result.content).toBe('hello');
    expect(result.reasoning).toBeUndefined();
  });

  it('uses json_schema response_format in streaming path never .parse()', async () => {
    const transport = new OpenAITransport({ apiKey: 'sk-test' });

    // Async generator that yields a text chunk + usage chunk
    async function* fakeStream() {
      yield {
        choices: [{ delta: { content: 'hello' }, finish_reason: null, index: 0 }],
      };
      yield {
        choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      };
    }
    mockCreate.mockResolvedValueOnce(fakeStream());

    const { z } = await import('zod');
    const schema = z.object({ name: z.string() });
    // Attach the schema as a class-like object
    const responseFormat = Object.assign(() => {}, { schema });

    const chunks: Array<{ text: string }> = [];
    for await (const delta of transport.stream(
      { ...makeRequest('gpt-4o'), responseFormat } as Parameters<typeof transport.stream>[0],
      { requestId: 'test-1' },
    )) {
      chunks.push({ text: delta.text });
    }

    // Verify json_schema was used (not .parse) — the SDK call should have response_format
    const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
      string,
      unknown
    >;
    const rf = callArgs['response_format'] as Record<string, unknown> | undefined;
    expect(rf?.['type']).toBe('json_schema');
    expect(chunks[0]?.text).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// usesMaxCompletionTokens standalone
// ---------------------------------------------------------------------------

describe('usesMaxCompletionTokens', () => {
  it('returns true for o-series and gpt-5 models', () => {
    expect(usesMaxCompletionTokens('o1')).toBe(true);
    expect(usesMaxCompletionTokens('o1-preview')).toBe(true);
    expect(usesMaxCompletionTokens('o3-mini')).toBe(true);
    expect(usesMaxCompletionTokens('o4-mini')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5-turbo')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5.1')).toBe(true);
  });

  it('returns false for non-o-series models', () => {
    expect(usesMaxCompletionTokens('gpt-4o')).toBe(false);
    expect(usesMaxCompletionTokens('gpt-4-turbo')).toBe(false);
    expect(usesMaxCompletionTokens('gpt-3.5-turbo')).toBe(false);
  });
});
