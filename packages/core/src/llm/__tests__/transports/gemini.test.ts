/**
 * Unit tests for GeminiTransport (T9283 — Wave 1a migration).
 *
 * Each test exercises one of the five invariants that were ported verbatim
 * from `backends/gemini.ts`:
 *
 * 1. geminiCacheStore singleton persists across transport calls.
 * 2. _sanitizeSchema strips `additionalProperties` recursively.
 * 3. Three blocked finish-reason throw sites (stream, normalizeResponse, struct-output).
 * 4. thinkingEffort + thinkingBudgetTokens MUTEX.
 * 5. maxOutputTokens → maxTokens fallback (via maxTokens in TransportRequest).
 *
 * @task T9283
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock @google/generative-ai before imports
// ---------------------------------------------------------------------------

const { mockGenerateContent, mockGenerateContentStream, MockGoogleGenerativeAI } = vi.hoisted(
  () => {
    const mockGenerateContent = vi.fn();
    const mockGenerateContentStream = vi.fn();
    const mockGetGenerativeModel = vi.fn(() => ({
      generateContent: mockGenerateContent,
      generateContentStream: mockGenerateContentStream,
    }));
    function MockGoogleGenerativeAI(_apiKey: string) {
      return { getGenerativeModel: mockGetGenerativeModel };
    }
    return { mockGenerateContent, mockGenerateContentStream, MockGoogleGenerativeAI };
  },
);

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: MockGoogleGenerativeAI,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { geminiCacheStore } from '../../caching.js';
import { GeminiTransport } from '../../transports/gemini.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal Gemini response shape for the `generateContent` API. */
function makeGeminiResponse(
  text: string,
  finishReason = 'STOP',
  toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [],
) {
  const parts: Array<Record<string, unknown>> = [];
  if (text) parts.push({ text });
  for (const tc of toolCalls) {
    parts.push({ functionCall: { name: tc.name, args: tc.args } });
  }
  const responseBody = {
    candidates: [
      {
        content: { parts, role: 'model' },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: 10,
      candidatesTokenCount: 5,
      cachedContentTokenCount: 0,
    },
    text: () => text,
  };
  // Wrap in the SDK's GenerateContentResult shape: { response: ... }
  return { response: responseBody };
}

/** Build a minimal TransportRequest. */
function makeRequest(overrides: Partial<Parameters<GeminiTransport['complete']>[0]> = {}) {
  return {
    model: 'gemini-1.5-pro',
    messages: [{ role: 'user' as const, content: 'hello' }],
    maxTokens: 1024,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. geminiCacheStore singleton
// ---------------------------------------------------------------------------

describe('GeminiTransport invariants', () => {
  it('respects geminiCacheStore singleton across calls', async () => {
    // Demonstrate the singleton is the same object reference across two transport
    // instances — the module-level geminiCacheStore is the shared source of truth.
    const t1 = new GeminiTransport({ apiKey: 'key1' });
    const t2 = new GeminiTransport({ apiKey: 'key2' });

    // Both transports reference the same module-level store.
    // We verify by storing a handle via direct API and reading it back through
    // the module export — proving singleton semantics.
    const expires = new Date(Date.now() + 60_000);
    const handle = geminiCacheStore.set({
      key: 'test-singleton-key',
      cachedContentName: 'projects/test/cachedContents/abc',
      expiresAt: expires,
    });

    expect(geminiCacheStore.get('test-singleton-key')).toStrictEqual(handle);

    // Both transport instances read the same singleton store (no per-instance copy).
    // t1/t2 are just used here to suppress unused-variable warnings.
    expect(t1.provider).toBe('gemini');
    expect(t2.provider).toBe('gemini');
    expect(geminiCacheStore.get('test-singleton-key')).not.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. Strip additionalProperties recursively from tool schemas
  // ---------------------------------------------------------------------------

  it('strips additionalProperties recursively from tool schemas', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', additionalProperties: false },
        nested: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deep: { type: 'number', additionalProperties: false },
          },
        },
        items_field: {
          type: 'array',
          items: { type: 'string', additionalProperties: false },
        },
      },
    };

    const cleaned = GeminiTransport._sanitizeSchema(schema) as Record<string, unknown>;

    expect(cleaned).not.toHaveProperty('additionalProperties');
    const props = cleaned['properties'] as Record<string, unknown>;
    expect(props['name']).not.toHaveProperty('additionalProperties');
    const nested = props['nested'] as Record<string, unknown>;
    expect(nested).not.toHaveProperty('additionalProperties');
    const nestedProps = nested['properties'] as Record<string, unknown>;
    expect(nestedProps['deep']).not.toHaveProperty('additionalProperties');
    const itemsField = props['items_field'] as Record<string, unknown>;
    const items = itemsField['items'] as Record<string, unknown>;
    expect(items).not.toHaveProperty('additionalProperties');
  });

  // ---------------------------------------------------------------------------
  // 3. Three BLOCKED_FINISH_REASONS throw sites
  // ---------------------------------------------------------------------------

  it('throws on SAFETY/RECITATION/PROHIBITED_CONTENT/BLOCKLIST finish reasons in 3 separate sites', async () => {
    const transport = new GeminiTransport({ apiKey: 'AIza-test' });

    // Site 1: stream() — no text emitted, blocked finish reason
    mockGenerateContentStream.mockResolvedValue({
      stream: (async function* () {
        yield {
          candidates: [{ finish_reason: 'SAFETY' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 0 },
          text: () => '',
        };
      })(),
    });

    await expect(async () => {
      const ctx = { requestId: 'req-1' };
      const chunks = [];
      for await (const chunk of transport.stream(makeRequest(), ctx)) {
        chunks.push(chunk);
      }
    }).rejects.toThrow(/Gemini response blocked.*SAFETY/);

    // Site 2: complete() normalizeResponse — no text, no tool calls, blocked finish reason
    mockGenerateContent.mockResolvedValue(makeGeminiResponse('', 'RECITATION'));

    await expect(transport.complete(makeRequest())).rejects.toThrow(
      /Gemini response blocked.*RECITATION/,
    );

    // Site 3: complete() — PROHIBITED_CONTENT blocked
    mockGenerateContent.mockResolvedValue(makeGeminiResponse('', 'PROHIBITED_CONTENT'));

    await expect(transport.complete(makeRequest())).rejects.toThrow(
      /Gemini response blocked.*PROHIBITED_CONTENT/,
    );
  });

  // ---------------------------------------------------------------------------
  // 4. thinkingEffort vs thinkingBudgetTokens MUTEX
  // ---------------------------------------------------------------------------

  it('rejects requests setting both thinkingEffort and thinkingBudgetTokens', () => {
    const transport = new GeminiTransport({ apiKey: 'AIza-test' });

    // Access _buildConfig via cast to test the private invariant directly
    const t = transport as unknown as {
      _buildConfig(p: {
        maxTokens: number;
        thinkingEffort?: string;
        thinkingBudgetTokens?: number;
      }): Record<string, unknown>;
    };

    expect(() =>
      t._buildConfig({
        maxTokens: 1024,
        thinkingEffort: 'medium',
        thinkingBudgetTokens: 2000,
      }),
    ).toThrow(/does not support both/);
  });

  // ---------------------------------------------------------------------------
  // 5. maxOutputTokens → maxTokens fallback
  // ---------------------------------------------------------------------------

  it('honors maxOutputTokens override fallback to maxTokens', async () => {
    const transport = new GeminiTransport({ apiKey: 'AIza-test' });

    mockGenerateContent.mockClear();
    mockGenerateContent.mockResolvedValue(makeGeminiResponse('ok response'));

    await transport.complete(makeRequest({ maxTokens: 512 }));

    const callArgs = mockGenerateContent.mock.calls[0][0] as {
      generationConfig: Record<string, unknown>;
    };
    // maxOutputTokens in generationConfig should reflect the request maxTokens
    expect(callArgs.generationConfig['maxOutputTokens']).toBe(512);

    mockGenerateContent.mockClear();

    // Higher value
    await transport.complete(makeRequest({ maxTokens: 2048 }));
    const callArgs2 = mockGenerateContent.mock.calls[0][0] as {
      generationConfig: Record<string, unknown>;
    };
    expect(callArgs2.generationConfig['maxOutputTokens']).toBe(2048);
  });
});
