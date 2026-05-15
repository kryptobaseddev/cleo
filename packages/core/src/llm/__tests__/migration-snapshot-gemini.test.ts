/**
 * Migration snapshot test — GeminiBackend vs GeminiTransport parity.
 *
 * Constructs an identical TransportRequest (prompt + 1 tool with
 * `additionalProperties: false`), calls OLD `GeminiBackend.complete` and NEW
 * `GeminiTransport.complete`, and asserts that `content`, `toolCalls[*].name`,
 * and `usage.inputTokens` match.
 *
 * Both backends are mocked against the same `@google/generative-ai` fake
 * response to ensure the comparison is apples-to-apples.
 *
 * @task T9283 (W1a migration snapshot)
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google/generative-ai for both backends
// ---------------------------------------------------------------------------

const { mockGenerateContentFn, MockGoogleGenerativeAI } = vi.hoisted(() => {
  const mockGenerateContentFn = vi.fn();
  const mockGetGenerativeModel = vi.fn(() => ({
    generateContent: mockGenerateContentFn,
  }));
  function MockGoogleGenerativeAI(_apiKey: string) {
    return { getGenerativeModel: mockGetGenerativeModel };
  }
  return { mockGenerateContentFn, MockGoogleGenerativeAI };
});

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

// ---------------------------------------------------------------------------
// Imports (after mock declarations)
// ---------------------------------------------------------------------------

import { GoogleGenerativeAI } from '@google/generative-ai';
import { GeminiBackend } from '../backends/gemini.js';
import { GeminiTransport } from '../transports/gemini.js';

// ---------------------------------------------------------------------------
// Shared fake response
// ---------------------------------------------------------------------------

/** Inner response body used by both old and new implementations. */
const FAKE_RESPONSE_BODY = {
  candidates: [
    {
      content: {
        parts: [
          { text: 'I will call the tool.' },
          { functionCall: { name: 'get_weather', args: { location: 'Berlin' } } },
        ],
        role: 'model',
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    candidatesTokenCount: 15,
    cachedContentTokenCount: 0,
  },
  text: () => 'I will call the tool.',
};

/** Wrapped in SDK result shape { response: ... } as generateContent returns. */
const FAKE_RESPONSE = { response: FAKE_RESPONSE_BODY };

// ---------------------------------------------------------------------------
// Snapshot test
// ---------------------------------------------------------------------------

describe('GeminiBackend → GeminiTransport migration snapshot', () => {
  it('produces matching content, toolCalls[*].name, and usage.inputTokens', async () => {
    mockGenerateContentFn.mockResolvedValue(FAKE_RESPONSE);

    // -----------------------------------------------------------------------
    // OLD path: GeminiBackend.complete (BackendCallParams shape)
    // -----------------------------------------------------------------------
    const fakeClient = new GoogleGenerativeAI('fake-key');
    const oldBackend = new GeminiBackend(fakeClient);

    const oldResult = await oldBackend.complete({
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'What is the weather in Berlin?' }],
      maxTokens: 512,
      temperature: 0.7,
      tools: [
        {
          name: 'get_weather',
          description: 'Returns current weather for a location',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string', description: 'City name' } },
            required: ['location'],
            additionalProperties: false,
          },
        },
      ],
    });

    mockGenerateContentFn.mockClear();
    mockGenerateContentFn.mockResolvedValue(FAKE_RESPONSE);

    // -----------------------------------------------------------------------
    // NEW path: GeminiTransport.complete (TransportRequest shape)
    // -----------------------------------------------------------------------
    const newTransport = new GeminiTransport({ apiKey: 'fake-key' });

    const newResult = await newTransport.complete({
      model: 'gemini-1.5-pro',
      messages: [{ role: 'user', content: 'What is the weather in Berlin?' }],
      maxTokens: 512,
      temperature: 0.7,
      tools: [
        {
          name: 'get_weather',
          description: 'Returns current weather for a location',
          inputSchema: {
            type: 'object',
            properties: { location: { type: 'string', description: 'City name' } },
            required: ['location'],
            additionalProperties: false,
          },
        },
      ],
    });

    // -----------------------------------------------------------------------
    // Assertions
    // -----------------------------------------------------------------------

    // content field
    const oldContent =
      typeof oldResult.content === 'string' ? oldResult.content : String(oldResult.content);
    expect(newResult.content).toBe(oldContent);

    // toolCalls[*].name
    expect(newResult.toolCalls).not.toBeNull();
    expect(newResult.toolCalls![0].name).toBe(oldResult.toolCalls[0]!.name);

    // usage.inputTokens
    expect(newResult.usage.inputTokens).toBe(oldResult.inputTokens);
  });
});
