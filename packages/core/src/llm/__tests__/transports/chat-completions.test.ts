/**
 * Invariant tests for ChatCompletionsTransport ProviderProfile hook dispatch (T9286 W1d).
 *
 * Tests that each of the 7 provider quirks is correctly wired through
 * ProviderProfile hooks rather than inline model-name pattern dispatch.
 * Each test uses the profile-based path (passes `profile` to constructor).
 *
 * Invariants covered:
 * 1. Moonshot thinkingBudgetTokens rejection (moonshot-no-thinking-budget)
 * 2. Moonshot shallow tool schema sanitization (moonshot-shallow-sanitize)
 * 3. Gemini thinking config via profile hook (gemini-thinking-config)
 * 4. Kimi reasoning_effort via profile hook (kimi-reasoning-effort)
 * 5. OpenRouter Pareto plugin block via profile hook (openrouter-pareto-plugin)
 * 6. xAI grok-conv-id header via profile hook (xai-grok-conv-id)
 * 7. Gemini deep sanitizer remains distinct from Moonshot shallow strip (gemini-deep-sanitizer-distinct)
 *
 * @task T9286 (W1d)
 * @epic T9261 (T-LLM-CRED-CENTRALIZATION Phase 3)
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock `openai` — must be declared before importing ChatCompletionsTransport.
// ---------------------------------------------------------------------------

const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('openai', () => {
  class MockOpenAI {
    chat = {
      completions: { create: mockCreate },
    };
  }
  return { default: MockOpenAI };
});

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { geminiProfile } from '../../provider-registry/builtin/gemini.js';
import { kimiCodeProfile } from '../../provider-registry/builtin/kimi-code.js';
import { moonshotProfile } from '../../provider-registry/builtin/moonshot.js';
import { openrouterProfile } from '../../provider-registry/builtin/openrouter.js';
import { xaiProfile } from '../../provider-registry/builtin/xai.js';
import {
  ChatCompletionsTransport,
  type ChatCompletionsTransportOptions,
} from '../../transports/chat-completions.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/** Base options without a profile (for non-profile tests). */
const BASE_OPTS: ChatCompletionsTransportOptions = {
  provider: 'openai',
  apiKey: 'sk-test-key',
};

/**
 * Build a minimal fake `ChatCompletion` response accepted by `_normalize`.
 */
function fakeChatCompletion(model = 'test-model'): Record<string, unknown> {
  return {
    id: 'chatcmpl-invariant-test',
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'ok', tool_calls: null },
        finish_reason: 'stop',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

// ---------------------------------------------------------------------------
// Invariant tests
// ---------------------------------------------------------------------------

describe('ChatCompletionsTransport — ProviderProfile hook dispatch (T9286 W1d)', () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockCreate.mockResolvedValue(fakeChatCompletion());
  });

  // ── Invariant 1: Moonshot thinkingBudgetTokens rejection ─────────────────

  it('rejects thinkingBudgetTokens for Moonshot models', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      profile: moonshotProfile,
    });

    await expect(
      transport.complete({
        model: 'moonshot-v1-8k',
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 100,
        thinkingBudgetTokens: 1024,
      }),
    ).rejects.toThrow(/does not support thinkingBudgetTokens/);
  });

  // ── Invariant 2: Moonshot shallow tool schema sanitization ────────────────

  it('strips only root-level schema and additionalProperties for Moonshot tools shallow not recursive', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1',
      profile: moonshotProfile,
    });

    await transport.complete({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: 'call tool' }],
      maxTokens: 100,
      tools: [
        {
          name: 'search',
          description: 'Search',
          inputSchema: {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
            additionalProperties: false,
            properties: {
              query: {
                type: 'string',
                // Nested additionalProperties MUST be preserved (shallow-only strip)
                additionalProperties: true,
              },
            },
          },
        },
      ],
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const tools = callArgs['tools'] as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);

    const fn = tools[0]['function'] as Record<string, unknown>;
    const params = fn['parameters'] as Record<string, unknown>;

    // Root-level fields stripped
    expect(params['$schema']).toBeUndefined();
    expect(params['additionalProperties']).toBeUndefined();

    // Other root-level fields preserved
    expect(params['type']).toBe('object');
    expect(params['properties']).toBeDefined();

    // Nested additionalProperties MUST be preserved (shallow strip — not recursive)
    const nested = (params['properties'] as Record<string, unknown>)['query'] as Record<
      string,
      unknown
    >;
    expect(nested['additionalProperties']).toBe(true);
  });

  // ── Invariant 3: Gemini thinking config via profile hook ──────────────────

  it('applies Gemini thinking config via profile hook not inline quirk', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      profile: geminiProfile,
    });

    await transport.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'think' }],
      maxTokens: 256,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    expect(extraBody).toBeDefined();
    // Flash model → 'auto' budget via profile hook
    expect(extraBody['thinking_config']).toEqual({ thinking_budget: 'auto' });
  });

  // ── Invariant 4: Kimi reasoning_effort via profile hook ───────────────────

  it('applies Kimi reasoning_effort via profile hook', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'kimi-code',
      baseUrl: 'https://api.kimi.com/coding',
      profile: kimiCodeProfile,
    });

    await transport.complete({
      model: 'kimi-k2-coding',
      messages: [{ role: 'user', content: 'reason' }],
      maxTokens: 256,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    // reasoning_effort injected at top level by profile hook
    expect(callArgs['reasoning_effort']).toBe('high');
  });

  // ── Invariant 5: OpenRouter Pareto plugin block via profile hook ───────────

  it('injects OpenRouter Pareto plugin block via profile hook', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      profile: openrouterProfile,
    });

    await transport.complete({
      model: 'openrouter/anthropic/claude-sonnet-4',
      messages: [{ role: 'user', content: 'test' }],
      maxTokens: 256,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const extraBody = callArgs['extra_body'] as Record<string, unknown>;
    const plugins = extraBody['plugins'] as Array<Record<string, unknown>>;
    expect(Array.isArray(plugins)).toBe(true);
    expect(plugins[0]).toEqual({ id: 'pareto', min_coding_score: 0.85 });
  });

  // ── Invariant 6: xAI grok-conv-id header via profile hook ─────────────────

  it('adds x-grok-conv-id header for xAI via profile hook', async () => {
    const transport = new ChatCompletionsTransport({
      ...BASE_OPTS,
      provider: 'xai',
      baseUrl: 'https://api.x.ai/v1',
      profile: xaiProfile,
    });

    await transport.complete({
      model: 'grok-3',
      messages: [{ role: 'user', content: 'hello grok' }],
      maxTokens: 128,
    });

    const callArgs = mockCreate.mock.calls[0][0] as Record<string, unknown>;
    const headers = callArgs['extra_headers'] as Record<string, string>;
    expect(typeof headers['x-grok-conv-id']).toBe('string');
    expect(headers['x-grok-conv-id'].startsWith('cleo-')).toBe(true);
  });

  // ── Invariant 7: Gemini deep sanitizer preserved distinct from Moonshot shallow strip

  it('preserves Gemini deep sanitizer behavior distinct from Moonshot shallow strip', () => {
    // This invariant is structural — the two sanitizers live in different
    // files and are NOT the same function. Verify by checking that:
    // (a) moonshotProfile.buildExtraBody returns __sanitizedTransportTools (shallow strip of inputSchema)
    // (b) geminiProfile does NOT return __sanitizedTransportTools (only adds thinking_config)

    const toolWithNestedSchema = [
      {
        name: 'tool',
        description: 'test',
        inputSchema: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: {
            nested: {
              type: 'object',
              // nested additionalProperties MUST be preserved by moonshot (shallow-only strip)
              additionalProperties: false,
            },
          },
        },
      },
    ];

    // Moonshot buildExtraBody: shallow strip — only root $schema + root additionalProperties removed
    const moonshotExtra = moonshotProfile.buildExtraBody!(
      'moonshot-v1-8k',
      [],
      toolWithNestedSchema,
    );
    expect(moonshotExtra['__sanitizedTransportTools']).toBeDefined();
    const sanitized = (
      moonshotExtra['__sanitizedTransportTools'] as Array<{
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }>
    )[0];
    // Root-level inputSchema fields stripped
    expect(sanitized.inputSchema['$schema']).toBeUndefined();
    expect(sanitized.inputSchema['additionalProperties']).toBeUndefined();
    // Other root-level preserved
    expect(sanitized.inputSchema['type']).toBe('object');
    // Nested additionalProperties preserved (shallow strip only)
    const props = sanitized.inputSchema['properties'] as Record<string, unknown>;
    expect((props['nested'] as Record<string, unknown>)['additionalProperties']).toBe(false);

    // Gemini buildExtraBody: thinking config only — does NOT sanitize tools
    const geminiExtra = geminiProfile.buildExtraBody!('gemini-2.0-flash', [], toolWithNestedSchema);
    expect(geminiExtra['__sanitizedTransportTools']).toBeUndefined();
    expect(geminiExtra['thinking_config']).toBeDefined();
  });
});
