/**
 * Migration snapshot tests — OpenAITransport vs OpenAIBackend parity (T9284 W1b).
 *
 * Verifies that the transport layer produces equivalent API calls and
 * response shapes compared to the old backend for two canonical fixtures:
 *
 * - `gpt-4o`  — standard model (uses `max_tokens`)
 * - `o3-mini` — o-series model (uses `max_completion_tokens`)
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

import { OpenAITransport } from '../transports/openai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFixture(
  model: string,
  content = 'Test response',
  opts: { promptTokens?: number; completionTokens?: number } = {},
) {
  return {
    id: `chatcmpl-${model}`,
    object: 'chat.completion',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: opts.promptTokens ?? 20,
      completion_tokens: opts.completionTokens ?? 10,
      total_tokens: (opts.promptTokens ?? 20) + (opts.completionTokens ?? 10),
    },
  };
}

// ---------------------------------------------------------------------------
// Snapshot tests
// ---------------------------------------------------------------------------

describe('OpenAITransport migration snapshot', () => {
  describe('gpt-4o fixture (standard — max_tokens)', () => {
    it('calls chat.completions.create with max_tokens', async () => {
      const transport = new OpenAITransport({ apiKey: 'sk-test' });
      mockCreate.mockResolvedValueOnce(makeFixture('gpt-4o'));

      const result = await transport.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'Hello gpt-4o' }],
        maxTokens: 256,
      });

      const callArgs = mockCreate.mock.calls[0]![0] as Record<string, unknown>;
      expect(callArgs['model']).toBe('gpt-4o');
      expect(callArgs['max_tokens']).toBe(256);
      expect(callArgs['max_completion_tokens']).toBeUndefined();

      expect(result.content).toBe('Test response');
      expect(result.stopReason).toBe('stop');
      expect(result.usage.inputTokens).toBe(20);
      expect(result.usage.outputTokens).toBe(10);
    });

    it('normalizes tool calls correctly', async () => {
      const transport = new OpenAITransport({ apiKey: 'sk-test' });
      const responseWithTools = {
        ...makeFixture('gpt-4o', null as unknown as string),
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
                  function: {
                    name: 'get_weather',
                    arguments: JSON.stringify({ location: 'San Francisco' }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };
      mockCreate.mockResolvedValueOnce(responseWithTools);

      const result = await transport.complete({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'What is the weather?' }],
        maxTokens: 256,
      });

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]!.id).toBe('call_abc123');
      expect(result.toolCalls![0]!.name).toBe('get_weather');
      expect(result.toolCalls![0]!.arguments).toBe(JSON.stringify({ location: 'San Francisco' }));
      expect(result.stopReason).toBe('tool_calls');
    });
  });

  describe('o3-mini fixture (o-series — max_completion_tokens)', () => {
    it('calls chat.completions.create with max_completion_tokens', async () => {
      const transport = new OpenAITransport({ apiKey: 'sk-test' });
      mockCreate.mockResolvedValueOnce(makeFixture('o3-mini'));

      const result = await transport.complete({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'Hello o3-mini' }],
        maxTokens: 512,
      });

      const callArgs = mockCreate.mock.calls[mockCreate.mock.calls.length - 1]![0] as Record<
        string,
        unknown
      >;
      expect(callArgs['model']).toBe('o3-mini');
      expect(callArgs['max_completion_tokens']).toBe(512);
      expect(callArgs['max_tokens']).toBeUndefined();

      expect(result.content).toBe('Test response');
      expect(result.stopReason).toBe('stop');
      expect(result.usage.inputTokens).toBe(20);
      expect(result.usage.outputTokens).toBe(10);
    });

    it('preserves reasoning content from o-series response', async () => {
      const transport = new OpenAITransport({ apiKey: 'sk-test' });
      const responseWithReasoning = {
        ...makeFixture('o3-mini'),
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'The answer is 42.',
              reasoning_content: 'Let me think step by step...',
            },
            finish_reason: 'stop',
          },
        ],
      };
      mockCreate.mockResolvedValueOnce(responseWithReasoning);

      const result = await transport.complete({
        model: 'o3-mini',
        messages: [{ role: 'user', content: 'What is the answer?' }],
        maxTokens: 512,
      });

      expect(result.content).toBe('The answer is 42.');
      expect(result.reasoning).toBe('Let me think step by step...');
    });
  });
});
