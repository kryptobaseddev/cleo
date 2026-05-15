/**
 * Unit tests for the adaptive thinking-budget calculator (T9303 W6b).
 *
 * @task T9303
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 */

import { describe, expect, it } from 'vitest';
import { computeThinkingBudget, THINKING_BUDGET_CAP } from '../thinking-budget.js';

// Shared context lengths used across tests (mirrors curated-models.json).
const HAIKU_CTX = 200_000;
const SONNET_CTX = 200_000;
const OPUS_CTX = 200_000;

describe('computeThinkingBudget', () => {
  it('scales budget across haiku (200k) / sonnet (200k) / opus (200k) context windows', () => {
    const maxTokens = 8192;
    const promptTokens = 1000;

    const haiku = computeThinkingBudget({ modelContextLength: HAIKU_CTX, promptTokens, maxTokens });
    const sonnet = computeThinkingBudget({
      modelContextLength: SONNET_CTX,
      promptTokens,
      maxTokens,
    });
    const opus = computeThinkingBudget({ modelContextLength: OPUS_CTX, promptTokens, maxTokens });

    // All three 200k models should yield an identical result.
    expect(haiku).toBe(sonnet);
    expect(sonnet).toBe(opus);

    // Budget must be positive for these typical inputs.
    expect(haiku).toBeGreaterThan(0);
  });

  it('budget never exceeds maxTokens', () => {
    const maxTokens = 500;
    const budget = computeThinkingBudget({
      modelContextLength: HAIKU_CTX,
      promptTokens: 100,
      maxTokens,
    });
    // fromMaxTokens bound = 500 * 0.5 = 250 → budget ≤ maxTokens.
    expect(budget).toBeLessThanOrEqual(maxTokens);
  });

  it('budget never exceeds (contextLength - promptTokens) * 0.2', () => {
    const modelContextLength = 10_000;
    const promptTokens = 5_000;
    const maxTokens = 8192;

    const budget = computeThinkingBudget({ modelContextLength, promptTokens, maxTokens });
    const maxFromContext = (modelContextLength - promptTokens) * 0.2;

    expect(budget).toBeLessThanOrEqual(Math.floor(maxFromContext));
  });

  it('budget capped at 32000 ceiling', () => {
    // Large context + large maxTokens → the 32k cap is the binding constraint.
    const budget = computeThinkingBudget({
      modelContextLength: 1_000_000,
      promptTokens: 1_000,
      maxTokens: 200_000,
    });
    expect(budget).toBe(THINKING_BUDGET_CAP);
  });

  it('returns 0 when context is exhausted (promptTokens ≈ contextLength)', () => {
    const modelContextLength = 10_000;
    // promptTokens at or beyond the context limit.
    expect(
      computeThinkingBudget({
        modelContextLength,
        promptTokens: modelContextLength,
        maxTokens: 4096,
      }),
    ).toBe(0);
    expect(
      computeThinkingBudget({
        modelContextLength,
        promptTokens: modelContextLength + 1,
        maxTokens: 4096,
      }),
    ).toBe(0);
  });
});
