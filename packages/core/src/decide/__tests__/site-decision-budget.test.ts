/**
 * `askSiteDecision` budgets from the SITE's start (`startedAt`), so a site's
 * own setup — settings resolution, credentials and config reads — counts
 * against its 300 ms (T12494 review, LOW).
 *
 * @task T12494
 */

import type { DecisionAnswer } from '@cleocode/contracts';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DecisionProvider } from '../provider.js';
import { askSiteDecision } from '../site.js';

/** A provider that never answers. */
const hanging: DecisionProvider = { decide: () => new Promise(() => undefined) };

const heuristic: DecisionAnswer = { type: 'noul', value: false, probability: 0, confidence: 0.5 };

function ask(startedAt?: number) {
  return askSiteDecision({
    siteId: 'test.site-budget',
    budgetMs: 300,
    ...(startedAt !== undefined ? { startedAt } : {}),
    minConfidence: 0.6,
    mode: 'on',
    heuristicVerdict: 'none',
    buildRequest: () => ({
      state: { text: 'x' },
      questions: { q: { type: 'noul', criteria: 'The thing holds' } },
    }),
    heuristicAnswers: { q: heuristic },
    agree: () => true,
    wiring: { provider: hanging, budget: null, cache: null, audit: null },
  });
}

describe('askSiteDecision — budget start', () => {
  // Load the lazily imported client modules once: vitest's cold transform of
  // them (hundreds of ms) is not what these cases measure.
  beforeAll(async () => {
    await ask(performance.now() - 300);
  });

  it('counts time the site already spent: 250 ms of setup leaves ~50 ms', async () => {
    const started = performance.now();
    const decision = await ask(performance.now() - 250);
    expect(decision).toBeNull();
    expect(performance.now() - started).toBeLessThan(150);
  });

  it('without startedAt the full budget applies (the hanging provider is really waited on)', async () => {
    const started = performance.now();
    const decision = await ask();
    expect(decision).toBeNull();
    expect(performance.now() - started).toBeGreaterThanOrEqual(250);
  });
});
