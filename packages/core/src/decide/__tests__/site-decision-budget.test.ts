/**
 * `askSiteDecision`'s budget bounds WAITING on the provider, not module
 * loading (T12494, CI regression on #1630).
 *
 * The decide client is mocked to take {@link SLOW_LOAD_MS} to load, longer
 * than the whole 300 ms budget — what a cold CI runner (or a cold CLI process)
 * can pay. A budget that includes module load would expire before the
 * provider is even called, so a fast provider would never answer.
 *
 * @task T12494
 */

import type { DecisionAnswer, DecisionOutcome } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { DecisionProvider } from '../provider.js';

/** Simulated cold load of the decide client, in ms. */
const SLOW_LOAD_MS = 400;
const BUDGET_MS = 300;

vi.mock('../client.js', async (importOriginal) => {
  await new Promise((r) => setTimeout(r, SLOW_LOAD_MS));
  return importOriginal();
});

const { askSiteDecision } = await import('../site.js');

const heuristic: DecisionAnswer = { type: 'noul', value: false, probability: 0, confidence: 0.5 };

/** Answers at once. */
const fast: DecisionProvider = {
  decide: async (): Promise<DecisionOutcome> => ({
    answers: { q: { type: 'noul', value: true, probability: 0.9, confidence: 0.9 } },
    source: 'provider',
    latencyMs: 1,
  }),
};

/** Never answers. */
const hanging: DecisionProvider = { decide: () => new Promise(() => undefined) };

function ask(provider: DecisionProvider) {
  return askSiteDecision({
    siteId: 'test.site-budget',
    budgetMs: BUDGET_MS,
    minConfidence: 0.6,
    mode: 'on',
    heuristicVerdict: 'none',
    buildRequest: () => ({
      state: { text: 'x' },
      questions: { q: { type: 'noul', criteria: 'The thing holds' } },
    }),
    heuristicAnswers: { q: heuristic },
    agree: () => true,
    wiring: { provider, budget: null, cache: null, audit: null },
  });
}

describe('askSiteDecision — budget bounds provider wait, not module load', () => {
  // Runs first: the only case that pays the slow load.
  it('a fast provider still answers after a module load longer than the budget', async () => {
    const started = performance.now();
    const decision = await ask(fast);
    expect(performance.now() - started).toBeGreaterThanOrEqual(SLOW_LOAD_MS - 10);
    expect(decision?.answers['q']).toMatchObject({ type: 'noul', value: true });
  });

  it('a hanging provider is waited on for about the budget, no more', async () => {
    const started = performance.now();
    const decision = await ask(hanging);
    const ms = performance.now() - started;
    expect(decision).toBeNull();
    expect(ms).toBeGreaterThanOrEqual(BUDGET_MS - 50);
    expect(ms).toBeLessThan(BUDGET_MS + 150);
  });
});
