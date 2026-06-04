/**
 * Load-bearing proof test for T11757 — "turn the sentient loop ON".
 *
 * Unlike `dialectic-evaluator.test.ts` (which mocks `resolveLlmBackend` wholesale),
 * this suite exercises the REAL `resolveLlmBackend` warm path so we prove the
 * end-to-end wiring: when a local Ollama daemon is reachable,
 * `evaluateDialectic(...)` resolves a non-`none` backend (`name: 'ollama'`),
 * runs `generateObject`, and does NOT emit the `dialectic.no_backend` warning.
 *
 * What is mocked:
 *  - `fetch` — emulates the Ollama daemon `/api/tags` probe returning a model.
 *  - `@ai-sdk/openai-compatible` — `createOpenAICompatible` is stubbed so no real
 *    network call is made when the warm path builds the Ollama provider.
 *  - `ai` — `generateObject` returns an empty (valid) insights object.
 *  - `../llm/role-resolver.js` — the unified resolver yields NO credential, so
 *    `tryUnifiedResolver` returns null and the call falls through to the warm
 *    Ollama path (the T11757 fall-through contract).
 *  - `../../logger.js` — captures telemetry calls.
 *
 * NOT mocked: `../llm-backend-resolver.js` — the unit under test.
 *
 * @task T11757
 * @epic T726
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Module mocks — hoisted before any dynamic imports
// ============================================================================

// Unified resolver returns an anthropic provider with NO credential, so
// `tryUnifiedResolver` returns null and the warm chain (Ollama) is taken.
const { mockResolveLLMForRole } = vi.hoisted(() => ({
  mockResolveLLMForRole: vi.fn(),
}));
vi.mock('../../llm/role-resolver.js', () => ({
  resolveLLMForRole: mockResolveLLMForRole,
}));

// Stub the OpenAI-compatible provider factory so building the Ollama LanguageModel
// never touches the network. `createOpenAICompatible(...)` returns a callable that
// produces a sentinel model object.
const { mockCreateOpenAICompatible } = vi.hoisted(() => ({
  mockCreateOpenAICompatible: vi.fn(),
}));
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mockCreateOpenAICompatible,
}));

// `generateObject` returns a valid empty insights object — we only care that the
// warm path reaches it, not about its output here.
const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));
vi.mock('ai', () => ({
  generateObject: mockGenerateObject,
}));

// Logger spies for telemetry assertions.
const { mockLogWarn, mockLogError, mockLogDebug } = vi.hoisted(() => ({
  mockLogWarn: vi.fn(),
  mockLogError: vi.fn(),
  mockLogDebug: vi.fn(),
}));
vi.mock('../../logger.js', () => ({
  getLogger: vi.fn(() => ({
    warn: mockLogWarn,
    error: mockLogError,
    debug: mockLogDebug,
  })),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import type { DialecticTurn } from '@cleocode/contracts';
import { evaluateDialectic } from '../dialectic-evaluator.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal valid DialecticTurn for tests. */
function makeTurn(overrides?: Partial<DialecticTurn>): DialecticTurn {
  return {
    userMessage: 'I always prefer zero-dependency solutions.',
    systemResponse: 'Understood — I will keep dependencies minimal.',
    activePeerId: 'cleo-prime',
    sessionId: 'ses_warm_ollama_proof',
    ...overrides,
  };
}

/**
 * Install a `fetch` mock that emulates a reachable Ollama daemon whose
 * `/api/tags` endpoint reports an installed model.
 */
function mockOllamaReachable(modelName: string): void {
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/tags')) {
      return {
        ok: true,
        json: async () => ({ models: [{ name: modelName }] }),
      } as unknown as Response;
    }
    return { ok: false, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
}

// ============================================================================
// Test suite
// ============================================================================

describe('evaluateDialectic — warm tier resolves local Ollama (T11757 proof)', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Unified resolver: anthropic provider but NO credential → tryUnifiedResolver
    // returns null and the warm Ollama path is taken (fall-through contract).
    mockResolveLLMForRole.mockResolvedValue({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      client: null,
      credential: null,
      source: 'implicit-fallback',
    });

    // The OpenAI-compatible provider factory returns a callable model builder.
    const sentinelModel = { __ollamaSentinel: true };
    mockCreateOpenAICompatible.mockReturnValue(() => sentinelModel);

    // generateObject succeeds with empty (valid) insights.
    mockGenerateObject.mockResolvedValue({
      object: { globalTraits: [], peerInsights: [], sessionNarrativeDelta: undefined },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resolves a non-"none" Ollama backend and does NOT log dialectic.no_backend', async () => {
    mockOllamaReachable('qwen2:0.5b');

    const result = await evaluateDialectic(makeTurn());

    // 1. The Ollama daemon probe was performed (warm path taken).
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalled();
    const probedTags = fetchMock.mock.calls.some(([input]) =>
      (typeof input === 'string' ? input : String(input)).includes('/api/tags'),
    );
    expect(probedTags).toBe(true);

    // 2. The Ollama OpenAI-compatible provider was constructed against /v1.
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'http://localhost:11434/v1', name: 'ollama' }),
    );

    // 3. generateObject ran (backend was non-none and usable).
    expect(mockGenerateObject).toHaveBeenCalledOnce();

    // 4. The no-backend telemetry must NOT have fired — the loop is ON.
    const noBackendWarn = mockLogWarn.mock.calls.find(
      ([fields]) => (fields as Record<string, unknown>)?.['event'] === 'dialectic.no_backend',
    );
    expect(noBackendWarn).toBeUndefined();

    // 5. The call completed and returned a valid (empty) insights envelope.
    expect(result.globalTraits).toEqual([]);
    expect(result.peerInsights).toEqual([]);
  });

  it('selects the installed Ollama model when none of the preferred models are present', async () => {
    // qwen2:0.5b is not in OLLAMA_MODEL_PRIORITY → falls back to first available.
    mockOllamaReachable('qwen2:0.5b');

    await evaluateDialectic(makeTurn());

    // generateObject was reached → backend resolved to a usable Ollama model.
    expect(mockGenerateObject).toHaveBeenCalledOnce();
    expect(mockCreateOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ollama' }),
    );
  });
});
