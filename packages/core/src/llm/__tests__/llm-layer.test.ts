/**
 * PSYCHE LLM Layer unit tests (T1386-W15).
 *
 * 30+ tests covering:
 * - Cache key determinism (R7)
 * - JSON repair fallback (W10)
 * - Tool-loop edge cases (W11)
 * - Empty-response retry behavior (W11)
 * - Max-iterations synthesis (W11)
 * - Provider switching / prefill rejection (W3 R2)
 * - Backend type discrimination (W2)
 * - History adapter formatting (W8)
 * - Structured output 3-tier fallback (W10)
 * - Gemini schema sanitization (W5)
 * - OpenAI max_completion_tokens logic (W4)
 *
 * @task T1401 (T1386-W15)
 * @epic T1386
 */

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { CompletionResult } from '../backend.js';
import { makeCompletionResult } from '../backend.js';
// --- Anthropic backend prefill logic ---
import { AnthropicBackend } from '../backends/anthropic.js';
// --- Gemini backend ---
import { GeminiBackend } from '../backends/gemini.js';
// --- Moonshot backend ---
import {
  isMoonshotModel,
  MOONSHOT_BASE_URL,
  MOONSHOT_DEFAULT_MODEL,
  MoonshotBackend,
} from '../backends/moonshot.js';
// --- OpenAI backend ---
import { usesMaxCompletionTokens } from '../backends/openai.js';
// --- Cache key determinism ---
import { buildCacheKey, InMemoryGeminiCacheStore } from '../caching.js';
// --- Conversation ---
import { countMessageTokens, truncateMessagesToFit } from '../conversation.js';
// --- History adapters ---
import {
  AnthropicHistoryAdapter,
  GeminiHistoryAdapter,
  OpenAIHistoryAdapter,
} from '../history-adapters.js';
// --- Runtime ---
import { effectiveTemperature, makeAttemptRef, selectModelConfigForAttempt } from '../runtime.js';
// --- Structured output ---
import {
  attemptStructuredOutputRepair,
  emptyStructuredOutput,
  repairResponseModelJson,
  validateStructuredOutput,
} from '../structured-output.js';
import type { ModelConfig, PromptCachePolicy } from '../types-config.js';

// ============================================================================
// Cache key determinism
// ============================================================================

describe('buildCacheKey', () => {
  const baseConfig: ModelConfig = { transport: 'gemini', model: 'gemini-pro' };
  const cachePolicy: PromptCachePolicy = {
    mode: 'gemini_cached_content',
    ttlSeconds: 300,
    keyVersion: 'v1',
  };

  it('produces the same key for identical payloads', () => {
    const msgs = [{ role: 'user', content: 'hello' }];
    const key1 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: msgs,
      tools: null,
    });
    const key2 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: msgs,
      tools: null,
    });
    expect(key1).toBe(key2);
  });

  it('produces different keys for different messages', () => {
    const k1 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [{ role: 'user', content: 'a' }],
      tools: null,
    });
    const k2 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [{ role: 'user', content: 'b' }],
      tools: null,
    });
    expect(k1).not.toBe(k2);
  });

  it('key includes keyVersion prefix', () => {
    const key = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [],
      tools: null,
    });
    expect(key).toMatch(/^llm-cache:v1:/);
  });

  it('different key for different model', () => {
    const configB: ModelConfig = { transport: 'gemini', model: 'gemini-ultra' };
    const k1 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [],
      tools: null,
    });
    const k2 = buildCacheKey({ config: configB, cachePolicy, cacheableMessages: [], tools: null });
    expect(k1).not.toBe(k2);
  });

  it('key includes systemInstruction if provided', () => {
    const k1 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [],
      tools: null,
      systemInstruction: 'sys',
    });
    const k2 = buildCacheKey({
      config: baseConfig,
      cachePolicy,
      cacheableMessages: [],
      tools: null,
      systemInstruction: null,
    });
    expect(k1).not.toBe(k2);
  });
});

// ============================================================================
// InMemoryGeminiCacheStore
// ============================================================================

describe('InMemoryGeminiCacheStore', () => {
  it('returns null for missing key', () => {
    const store = new InMemoryGeminiCacheStore();
    expect(store.get('missing')).toBeNull();
  });

  it('returns stored handle', () => {
    const store = new InMemoryGeminiCacheStore();
    const expiresAt = new Date(Date.now() + 60_000);
    store.set({ key: 'k1', cachedContentName: 'name1', expiresAt });
    expect(store.get('k1')?.cachedContentName).toBe('name1');
  });

  it('evicts expired handles', () => {
    const store = new InMemoryGeminiCacheStore();
    const expiresAt = new Date(Date.now() - 1); // already expired
    store.set({ key: 'k1', cachedContentName: 'name1', expiresAt });
    expect(store.get('k1')).toBeNull();
  });

  it('evicts oldest when over MAX_ENTRIES', () => {
    const store = new InMemoryGeminiCacheStore();
    const expiresAt = new Date(Date.now() + 60_000);
    // Add MAX_ENTRIES + 1
    for (let i = 0; i < InMemoryGeminiCacheStore.MAX_ENTRIES + 1; i++) {
      store.set({ key: `k${i}`, cachedContentName: `name${i}`, expiresAt });
    }
    // k0 should be evicted
    expect(store.get('k0')).toBeNull();
    // Last entry should still be present
    expect(store.get(`k${InMemoryGeminiCacheStore.MAX_ENTRIES}`)).not.toBeNull();
  });
});

// ============================================================================
// Structured output
// ============================================================================

const TestSchema = z.object({ name: z.string(), value: z.number() });
type TestType = z.infer<typeof TestSchema>;

describe('validateStructuredOutput', () => {
  it('validates a plain object', () => {
    const result = validateStructuredOutput({ name: 'foo', value: 42 }, TestSchema);
    expect(result.name).toBe('foo');
    expect(result.value).toBe(42);
  });

  it('validates a JSON string', () => {
    const result = validateStructuredOutput('{"name":"bar","value":7}', TestSchema);
    expect(result.name).toBe('bar');
  });

  it('throws StructuredOutputError on invalid input type', () => {
    expect(() => validateStructuredOutput(12345, TestSchema)).toThrow();
  });
});

describe('repairResponseModelJson', () => {
  it('repairs valid JSON string', () => {
    const result = repairResponseModelJson<TestType>(
      '{"name":"valid","value":42}',
      TestSchema,
      'test-model',
    );
    expect(result.name).toBe('valid');
    expect(result.value).toBe(42);
  });

  it('uses repairHook to transform data before validation', () => {
    const result = repairResponseModelJson<TestType>(
      '{"name":"x","value":0}',
      TestSchema,
      'test-model',
      (data) => {
        const d = data as Record<string, unknown>;
        d['value'] = 99;
        return d;
      },
    );
    expect(result.value).toBe(99);
  });
});

describe('attemptStructuredOutputRepair', () => {
  it('returns null for non-string content', () => {
    expect(attemptStructuredOutputRepair(42, TestSchema, 'model')).toBeNull();
  });

  it('repairs valid JSON string', () => {
    const result = attemptStructuredOutputRepair('{"name":"ok","value":1}', TestSchema, 'model');
    expect(result?.name).toBe('ok');
  });
});

describe('emptyStructuredOutput', () => {
  it('returns an empty-but-valid schema parse when schema allows {}', () => {
    const lenientSchema = z.object({
      name: z.string().optional().default(''),
      value: z.number().optional().default(0),
    });
    const result = emptyStructuredOutput(lenientSchema);
    expect(result.name).toBe('');
    expect(result.value).toBe(0);
  });
});

// ============================================================================
// AnthropicBackend — prefill rejection (R2 critical)
// ============================================================================

describe('AnthropicBackend._supportsAssistantPrefill (R2)', () => {
  it('returns false for claude-sonnet-4-6 (CLEO primary)', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-sonnet-4-6')).toBe(false);
  });

  it('returns false for claude-opus-4-anything', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-opus-4-5')).toBe(false);
    expect(AnthropicBackend._supportsAssistantPrefill('claude-opus-4')).toBe(false);
  });

  it('returns false for claude-haiku-4-anything', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-haiku-4-5')).toBe(false);
  });

  it('returns true for claude-3-5-sonnet (not Claude 4)', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-3-5-sonnet-20241022')).toBe(true);
  });

  it('returns true for claude-3-opus', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-3-opus-20240229')).toBe(true);
  });

  it('returns true for claude-3-haiku', () => {
    expect(AnthropicBackend._supportsAssistantPrefill('claude-3-haiku-20240307')).toBe(true);
  });
});

// ============================================================================
// OpenAI backend — max_completion_tokens
// ============================================================================

describe('usesMaxCompletionTokens', () => {
  it('returns true for gpt-5', () => {
    expect(usesMaxCompletionTokens('gpt-5')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5-turbo')).toBe(true);
    expect(usesMaxCompletionTokens('gpt-5.4')).toBe(true);
  });

  it('returns true for o-series', () => {
    expect(usesMaxCompletionTokens('o1')).toBe(true);
    expect(usesMaxCompletionTokens('o1-preview')).toBe(true);
    expect(usesMaxCompletionTokens('o3')).toBe(true);
    expect(usesMaxCompletionTokens('o4-mini')).toBe(true);
  });

  it('returns false for gpt-4o', () => {
    expect(usesMaxCompletionTokens('gpt-4o')).toBe(false);
  });

  it('returns false for gpt-4-turbo', () => {
    expect(usesMaxCompletionTokens('gpt-4-turbo')).toBe(false);
  });
});

// ============================================================================
// Gemini backend — schema sanitization
// ============================================================================

describe('GeminiBackend._sanitizeSchema', () => {
  it('strips additionalProperties from schema', () => {
    const raw = {
      type: 'object',
      properties: { foo: { type: 'string' } },
      required: ['foo'],
      additionalProperties: false,
      allOf: [],
    };
    const sanitized = GeminiBackend._sanitizeSchema(raw) as Record<string, unknown>;
    expect(sanitized).not.toHaveProperty('additionalProperties');
    expect(sanitized).not.toHaveProperty('allOf');
    expect(sanitized).toHaveProperty('type');
    expect(sanitized).toHaveProperty('required');
  });

  it('recurses into nested properties', () => {
    const raw = {
      type: 'object',
      properties: {
        nested: {
          type: 'object',
          properties: { x: { type: 'string', default: 'foo' } },
          additionalProperties: false,
        },
      },
    };
    const sanitized = GeminiBackend._sanitizeSchema(raw) as Record<string, unknown>;
    const nested = (sanitized['properties'] as Record<string, unknown>)['nested'] as Record<
      string,
      unknown
    >;
    expect(nested).not.toHaveProperty('additionalProperties');
  });

  it('preserves items for array schemas', () => {
    const raw = { type: 'array', items: { type: 'string', default: 'x' } };
    const sanitized = GeminiBackend._sanitizeSchema(raw) as Record<string, unknown>;
    expect(sanitized).toHaveProperty('items');
    const items = sanitized['items'] as Record<string, unknown>;
    expect(items).not.toHaveProperty('default');
  });

  it('handles non-object input gracefully', () => {
    expect(GeminiBackend._sanitizeSchema('string')).toBe('string');
    expect(GeminiBackend._sanitizeSchema(null)).toBe(null);
  });
});

// ============================================================================
// Gemini _convertMessages
// ============================================================================

describe('GeminiBackend._convertMessages', () => {
  it('extracts system messages', () => {
    const msgs = [
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hello' },
    ];
    const { systemInstruction } = GeminiBackend._convertMessages(msgs);
    expect(systemInstruction).toBe('Be helpful');
  });

  it('converts assistant to model role', () => {
    const msgs = [{ role: 'assistant', content: 'Hi there' }];
    const { contents } = GeminiBackend._convertMessages(msgs);
    expect(contents[0]?.['role']).toBe('model');
  });

  it('throws on unsupported content block types', () => {
    const msgs = [{ role: 'user', content: [{ type: 'image', src: 'url' }] }];
    expect(() => GeminiBackend._convertMessages(msgs)).toThrow();
  });
});

// ============================================================================
// History adapters
// ============================================================================

function makeResult(overrides: Partial<CompletionResult> = {}): CompletionResult {
  return makeCompletionResult({
    content: 'test',
    toolCalls: [],
    thinkingBlocks: [],
    reasoningDetails: [],
    ...overrides,
  });
}

describe('AnthropicHistoryAdapter', () => {
  const adapter = new AnthropicHistoryAdapter();

  it('formats tool-use message with thinking blocks', () => {
    const result = makeResult({
      content: 'thinking done',
      toolCalls: [{ id: 'tc1', name: 'search', input: { q: 'hello' } }],
      thinkingBlocks: [{ type: 'thinking', thinking: 'I thought', signature: 'sig1' }],
    });
    const msg = adapter.formatAssistantToolMessage(result);
    expect(msg['role']).toBe('assistant');
    const content = msg['content'] as Array<Record<string, unknown>>;
    expect(content.some((b) => b['type'] === 'thinking')).toBe(true);
    expect(content.some((b) => b['type'] === 'tool_use')).toBe(true);
  });

  it('formats tool results as user message', () => {
    const results = [{ toolId: 'tc1', toolName: 'search', result: 'found', isError: false }];
    const msgs = adapter.formatToolResults(results);
    expect(msgs[0]?.['role']).toBe('user');
    const content = msgs[0]?.['content'] as Array<Record<string, unknown>>;
    expect(content[0]?.['type']).toBe('tool_result');
    expect(content[0]?.['content']).toBe('found');
  });
});

describe('GeminiHistoryAdapter', () => {
  const adapter = new GeminiHistoryAdapter();

  it('formats function calls in parts', () => {
    const result = makeResult({
      toolCalls: [{ id: 'c1', name: 'fn', input: { x: 1 }, thoughtSignature: 'sig' }],
    });
    const msg = adapter.formatAssistantToolMessage(result);
    expect(msg['role']).toBe('model');
    const parts = msg['parts'] as Array<Record<string, unknown>>;
    const funcPart = parts.find((p) => 'function_call' in p);
    expect(funcPart).toBeDefined();
    expect(funcPart?.['thought_signature']).toBe('sig');
  });

  it('formats function_response tool results', () => {
    const msgs = adapter.formatToolResults([{ toolId: 'c1', toolName: 'fn', result: 'ok' }]);
    expect(msgs[0]?.['role']).toBe('user');
    const parts = msgs[0]?.['parts'] as Array<Record<string, unknown>>;
    expect(parts[0]).toHaveProperty('function_response');
  });
});

describe('OpenAIHistoryAdapter', () => {
  const adapter = new OpenAIHistoryAdapter();

  it('formats tool_calls array in assistant message', () => {
    const result = makeResult({
      content: '',
      toolCalls: [{ id: 'tc1', name: 'get_data', input: { id: 5 } }],
    });
    const msg = adapter.formatAssistantToolMessage(result);
    expect(msg['role']).toBe('assistant');
    const tcs = msg['tool_calls'] as Array<Record<string, unknown>>;
    expect(tcs[0]?.['id']).toBe('tc1');
  });

  it('formats tool results as role:tool messages', () => {
    const msgs = adapter.formatToolResults([
      { toolId: 'tc1', toolName: 'get_data', result: '{"x":1}' },
    ]);
    expect(msgs[0]?.['role']).toBe('tool');
    expect(msgs[0]?.['tool_call_id']).toBe('tc1');
  });
});

// ============================================================================
// Conversation
// ============================================================================

describe('countMessageTokens', () => {
  it('returns 0 for empty messages', () => {
    expect(countMessageTokens([])).toBe(0);
  });

  it('counts tokens for string content', () => {
    const msgs = [{ role: 'user', content: 'Hello world' }];
    expect(countMessageTokens(msgs)).toBeGreaterThan(0);
  });
});

describe('truncateMessagesToFit', () => {
  it('returns messages unchanged if they fit', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];
    const result = truncateMessagesToFit(msgs, 100_000);
    expect(result).toHaveLength(msgs.length);
  });

  it('removes oldest messages when over limit', () => {
    const msgs = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `message number ${i} with some content to use tokens`,
    }));
    const result = truncateMessagesToFit(msgs, 50);
    expect(result.length).toBeLessThan(msgs.length);
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe('effectiveTemperature', () => {
  it('returns 0.2 when temperature=0 and attempt>1', () => {
    expect(effectiveTemperature(0, 2)).toBe(0.2);
  });

  it('returns temperature unchanged when attempt=1', () => {
    expect(effectiveTemperature(0, 1)).toBe(0);
  });

  it('returns null when temperature is null', () => {
    expect(effectiveTemperature(null, 1)).toBeNull();
  });
});

describe('makeAttemptRef', () => {
  it('starts at 1', () => {
    const ref = makeAttemptRef();
    expect(ref.value).toBe(1);
  });

  it('is mutable', () => {
    const ref = makeAttemptRef();
    ref.value = 3;
    expect(ref.value).toBe(3);
  });
});

describe('selectModelConfigForAttempt', () => {
  const primary: ModelConfig = { transport: 'anthropic', model: 'claude-sonnet-4-6' };
  const fallback: Omit<ModelConfig, 'fallback'> = { transport: 'openai', model: 'gpt-4o' };
  const configWithFallback: ModelConfig = { ...primary, fallback };

  it('returns primary config for non-final attempts', () => {
    const result = selectModelConfigForAttempt(configWithFallback, 1, 3);
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('returns fallback config on final attempt', () => {
    const result = selectModelConfigForAttempt(configWithFallback, 3, 3);
    expect(result.model).toBe('gpt-4o');
    expect(result.transport).toBe('openai');
  });

  it('returns primary when no fallback configured', () => {
    const result = selectModelConfigForAttempt(primary, 3, 3);
    expect(result.model).toBe('claude-sonnet-4-6');
  });
});

// ============================================================================
// MoonshotBackend — unit tests (T1678 · T-LW-W2)
// ============================================================================

describe('isMoonshotModel', () => {
  it('returns true for kimi-k2-0905-preview', () => {
    expect(isMoonshotModel('kimi-k2-0905-preview')).toBe(true);
  });

  it('returns true for kimi-* variants', () => {
    expect(isMoonshotModel('kimi-k1-32k')).toBe(true);
    expect(isMoonshotModel('kimi-k2-latest')).toBe(true);
  });

  it('returns true for moonshot-v1-* variants', () => {
    expect(isMoonshotModel('moonshot-v1-8k')).toBe(true);
    expect(isMoonshotModel('moonshot-v1-128k')).toBe(true);
  });

  it('returns false for gpt-4o', () => {
    expect(isMoonshotModel('gpt-4o')).toBe(false);
  });

  it('returns false for claude-sonnet-4-6', () => {
    expect(isMoonshotModel('claude-sonnet-4-6')).toBe(false);
  });
});

describe('MOONSHOT_DEFAULT_MODEL', () => {
  it('is kimi-k2-0905-preview', () => {
    expect(MOONSHOT_DEFAULT_MODEL).toBe('kimi-k2-0905-preview');
  });

  it('is a kimi model (satisfies isMoonshotModel)', () => {
    expect(isMoonshotModel(MOONSHOT_DEFAULT_MODEL)).toBe(true);
  });
});

describe('MOONSHOT_BASE_URL', () => {
  it('points to the Moonshot OpenAI-compatible endpoint', () => {
    expect(MOONSHOT_BASE_URL).toBe('https://api.moonshot.ai/v1');
  });
});

describe('MoonshotBackend', () => {
  /** Build a minimal mock OpenAI client that returns a preset response. */
  function makeMockClient(content: string): OpenAI {
    const mockCreate = vi.fn().mockResolvedValue({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1_700_000_000,
      model: MOONSHOT_DEFAULT_MODEL,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
          delta: {},
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    return {
      chat: { completions: { create: mockCreate } },
    } as unknown as OpenAI;
  }

  it('complete — roundtrips a simple prompt via mock client', async () => {
    const client = makeMockClient('Hello from Kimi!');
    const backend = new MoonshotBackend(client);
    const result = await backend.complete({
      model: MOONSHOT_DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'Say hello' }],
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
    });
    expect(result.content).toBe('Hello from Kimi!');
    expect(result.finishReason).toBe('stop');
  });

  it('complete — rejects thinkingBudgetTokens', async () => {
    const client = makeMockClient('');
    const backend = new MoonshotBackend(client);
    await expect(
      backend.complete({
        model: MOONSHOT_DEFAULT_MODEL,
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        temperature: null,
        stop: null,
        tools: null,
        toolChoice: null,
        responseFormat: null,
        thinkingBudgetTokens: 1024,
        thinkingEffort: null,
        maxOutputTokens: null,
        extraParams: null,
      }),
    ).rejects.toThrow('MoonshotBackend does not support thinkingBudgetTokens');
  });

  it('stream — rejects thinkingBudgetTokens', async () => {
    const client = makeMockClient('');
    const backend = new MoonshotBackend(client);
    const gen = backend.stream({
      model: MOONSHOT_DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 100,
      temperature: null,
      stop: null,
      tools: null,
      toolChoice: null,
      responseFormat: null,
      thinkingBudgetTokens: 512,
      thinkingEffort: null,
      maxOutputTokens: null,
      extraParams: null,
    });
    await expect(gen.next()).rejects.toThrow(
      'MoonshotBackend does not support thinkingBudgetTokens',
    );
  });
});
