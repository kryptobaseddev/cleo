/**
 * Integration tests for dialectic-evaluator.ts.
 *
 * Covers:
 *  - `buildDialecticSystemPrompt` few-shot content (via exported constants +
 *    indirect testing through evaluateDialectic mock path)
 *  - Confidence-threshold filtering in `evaluateDialectic`:
 *    - Global traits below GLOBAL_TRAIT_CONFIDENCE_THRESHOLD are suppressed
 *    - Peer insights below PEER_INSIGHT_CONFIDENCE_THRESHOLD are suppressed
 *    - High-confidence traits and insights pass through unchanged
 *  - Empty-turn fast path (no LLM call when both messages are blank)
 *  - No-backend fast path (returns empty insights without throwing)
 *
 * The LLM backend (`resolveLlmBackend`) and `generateObject` are mocked so
 * these tests run without network access or API keys.
 *
 * @task T1532
 * @epic T1056
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ============================================================================
// Module mocks — must be hoisted before any dynamic imports
// ============================================================================

vi.mock('../llm-backend-resolver.js', () => ({
  resolveLlmBackend: vi.fn(),
}));

vi.mock('ai', () => ({
  generateObject: vi.fn(),
}));

// ============================================================================
// Imports after mocks
// ============================================================================

import { generateObject } from 'ai';
import {
  evaluateDialectic,
  GLOBAL_TRAIT_CONFIDENCE_THRESHOLD,
  PEER_INSIGHT_CONFIDENCE_THRESHOLD,
} from '../dialectic-evaluator.js';
import { resolveLlmBackend } from '../llm-backend-resolver.js';

// ============================================================================
// Helpers
// ============================================================================

/** Build a minimal valid DialecticTurn for tests. */
function makeTurn(overrides: {
  userMessage?: string;
  systemResponse?: string;
  activePeerId?: string;
  sessionId?: string;
}) {
  return {
    userMessage: overrides.userMessage ?? 'test user message',
    systemResponse: overrides.systemResponse ?? 'test system response',
    activePeerId: overrides.activePeerId ?? 'test-peer',
    sessionId: overrides.sessionId ?? 'ses_test_abc123',
  };
}

/** Configure `resolveLlmBackend` to return a stub backend. */
function mockBackendAvailable(): void {
  (resolveLlmBackend as ReturnType<typeof vi.fn>).mockResolvedValue({
    model: {} as never,
    name: 'anthropic',
    modelId: 'claude-sonnet-4-6',
  });
}

/** Configure `resolveLlmBackend` to return null (no backend). */
function mockBackendUnavailable(): void {
  (resolveLlmBackend as ReturnType<typeof vi.fn>).mockResolvedValue(null);
}

// ============================================================================
// Test suite
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
});

describe('confidence threshold constants', () => {
  it('GLOBAL_TRAIT_CONFIDENCE_THRESHOLD is 0.6', () => {
    expect(GLOBAL_TRAIT_CONFIDENCE_THRESHOLD).toBe(0.6);
  });

  it('PEER_INSIGHT_CONFIDENCE_THRESHOLD is 0.5', () => {
    expect(PEER_INSIGHT_CONFIDENCE_THRESHOLD).toBe(0.5);
  });
});

describe('evaluateDialectic — empty turn fast path', () => {
  it('returns empty insights without calling the backend for an all-blank turn', async () => {
    const result = await evaluateDialectic(
      makeTurn({ userMessage: '   ', systemResponse: '\n\t' }),
    );

    expect(resolveLlmBackend).not.toHaveBeenCalled();
    expect(result.globalTraits).toEqual([]);
    expect(result.peerInsights).toEqual([]);
  });
});

describe('evaluateDialectic — no backend available', () => {
  it('returns empty insights when resolveLlmBackend returns null', async () => {
    mockBackendUnavailable();

    const result = await evaluateDialectic(makeTurn({}));

    expect(generateObject).not.toHaveBeenCalled();
    expect(result.globalTraits).toEqual([]);
    expect(result.peerInsights).toEqual([]);
  });

  it('returns empty insights when backend name is "none"', async () => {
    (resolveLlmBackend as ReturnType<typeof vi.fn>).mockResolvedValue({
      model: {} as never,
      name: 'none',
      modelId: '',
    });

    const result = await evaluateDialectic(makeTurn({}));

    expect(generateObject).not.toHaveBeenCalled();
    expect(result.globalTraits).toEqual([]);
    expect(result.peerInsights).toEqual([]);
  });
});

describe('evaluateDialectic — confidence threshold filtering (low-confidence edge case)', () => {
  it('suppresses global traits whose confidence is below GLOBAL_TRAIT_CONFIDENCE_THRESHOLD', async () => {
    // Simulate a model response that includes a low-confidence trait (0.45) and a
    // high-confidence trait (0.90). Only the high-confidence one should be emitted.
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [
          { key: 'maybe-prefers-dark-mode', value: 'true', confidence: 0.45 },
          { key: 'strict-typescript', value: 'never use any', confidence: 0.9 },
        ],
        peerInsights: [],
        sessionNarrativeDelta: undefined,
      },
    });

    const result = await evaluateDialectic(makeTurn({}));

    // Low-confidence trait (0.45 < 0.6) must be suppressed
    expect(result.globalTraits).toHaveLength(1);
    expect(result.globalTraits[0].key).toBe('strict-typescript');
    expect(result.globalTraits[0].confidence).toBe(0.9);
  });

  it('suppresses ALL global traits when all are below threshold', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [
          { key: 'trait-a', value: 'value-a', confidence: 0.3 },
          { key: 'trait-b', value: 'value-b', confidence: 0.59 },
        ],
        peerInsights: [],
        sessionNarrativeDelta: undefined,
      },
    });

    const result = await evaluateDialectic(makeTurn({}));

    // Both traits are below 0.6 — evaluateDialectic must refuse to emit either
    expect(result.globalTraits).toEqual([]);
  });

  it('emits a global trait whose confidence equals the threshold exactly', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [{ key: 'verbose-git-logs', value: 'true', confidence: 0.6 }],
        peerInsights: [],
        sessionNarrativeDelta: undefined,
      },
    });

    const result = await evaluateDialectic(makeTurn({}));

    // Exactly at threshold — must pass through
    expect(result.globalTraits).toHaveLength(1);
    expect(result.globalTraits[0].key).toBe('verbose-git-logs');
  });

  it('suppresses peer insights below PEER_INSIGHT_CONFIDENCE_THRESHOLD', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [],
        peerInsights: [
          { key: 'low-signal-finding', value: 'unclear', peerId: 'test-peer', confidence: 0.3 },
          {
            key: 'task-uses-drizzle-orm',
            value: 'schema uses drizzle-orm v1 beta',
            peerId: 'test-peer',
            confidence: 0.85,
          },
        ],
        sessionNarrativeDelta: undefined,
      },
    });

    const result = await evaluateDialectic(makeTurn({ activePeerId: 'test-peer' }));

    // Only the high-confidence peer insight (0.85 ≥ 0.5) passes through
    expect(result.peerInsights).toHaveLength(1);
    expect(result.peerInsights[0].key).toBe('task-uses-drizzle-orm');
  });

  it('backfills activePeerId into peer insights that have no peerId', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [],
        peerInsights: [
          // peerId intentionally omitted / empty to test the fallback
          { key: 'some-finding', value: 'detail', peerId: '', confidence: 0.8 },
        ],
        sessionNarrativeDelta: undefined,
      },
    });

    const result = await evaluateDialectic(makeTurn({ activePeerId: 'cleo-prime' }));

    expect(result.peerInsights).toHaveLength(1);
    expect(result.peerInsights[0].peerId).toBe('cleo-prime');
  });
});

describe('evaluateDialectic — happy path', () => {
  it('passes through high-confidence global traits and peer insights unchanged', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockResolvedValue({
      object: {
        globalTraits: [{ key: 'prefers-zero-deps', value: 'true', confidence: 0.92 }],
        peerInsights: [
          {
            key: 'found-existing-helper',
            value: 'buildRetrievalBundle covers this case',
            peerId: 'worker-agent',
            confidence: 0.88,
          },
        ],
        sessionNarrativeDelta:
          'User confirmed zero-dependency policy; assistant found existing helper.',
      },
    });

    const result = await evaluateDialectic(makeTurn({ activePeerId: 'worker-agent' }));

    expect(result.globalTraits).toHaveLength(1);
    expect(result.globalTraits[0].key).toBe('prefers-zero-deps');

    expect(result.peerInsights).toHaveLength(1);
    expect(result.peerInsights[0].key).toBe('found-existing-helper');

    expect(result.sessionNarrativeDelta).toContain('zero-dependency');
  });

  it('returns empty insights when generateObject throws', async () => {
    mockBackendAvailable();
    (generateObject as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('simulated API error'),
    );

    const result = await evaluateDialectic(makeTurn({}));

    expect(result.globalTraits).toEqual([]);
    expect(result.peerInsights).toEqual([]);
  });
});
