/**
 * Typed-decision client — fallback, timeout, error, budget, cache, redaction
 * and audit behaviour, driven by an injected fake provider. Global `fetch` is
 * replaced by a spy that fails the test if anything tries to reach the network.
 *
 * @task T12490
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DecisionAnswer, DecisionOutcome, DecisionRequest } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../audit.js';
import { createMemoryTokenBucket, type DecisionBudget } from '../budget.js';
import { createDecisionCache } from '../cache.js';
import { _resetDecideDefaultsForTest, type DecideOptions, decide } from '../client.js';
import { type DecisionProvider, DecisionProviderError } from '../provider.js';

const REQUEST: DecisionRequest = {
  state: 'deploy failed',
  questions: { retry: { type: 'noul', criteria: 'Retrying will help' } },
};

const HEURISTIC_ANSWERS: Record<string, DecisionAnswer> = {
  retry: { type: 'noul', value: false, probability: 0.3, confidence: 0.4 },
};
const heuristic = vi.fn(() => HEURISTIC_ANSWERS);

const PROVIDER_OUTCOME: DecisionOutcome = {
  answers: { retry: { type: 'noul', value: true, probability: 0.9, confidence: 0.95 } },
  source: 'provider',
  requestId: 'req_42',
  latencyMs: 5,
  costUsd: 0.00001,
};

function fakeProvider(
  impl: (req: DecisionRequest, signal: AbortSignal) => Promise<DecisionOutcome>,
): DecisionProvider & { decide: ReturnType<typeof vi.fn> } {
  return { decide: vi.fn(impl) };
}

function memoryAudit(): DecisionAuditSink & { entries: DecisionAuditEntry[] } {
  const entries: DecisionAuditEntry[] = [];
  return { entries, write: (e) => entries.push(e) };
}

/** Fresh, isolated wiring per call: no shared cache, generous budget, in-memory audit. */
function isolated(
  extra: DecideOptions = {},
): DecideOptions & { audit: ReturnType<typeof memoryAudit> } {
  return {
    cache: createDecisionCache(),
    budget: createMemoryTokenBucket(),
    ...extra,
    audit: memoryAudit(),
  };
}

let networkSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  heuristic.mockClear();
  _resetDecideDefaultsForTest();
  networkSpy = vi.fn(async () => {
    throw new Error('network access is forbidden in this test');
  });
  vi.stubGlobal('fetch', networkSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('decide — unconfigured', () => {
  it.each([
    ['no connection', {}],
    ['null connection', { connection: null }],
    ['blank key', { connection: { baseUrl: 'https://decide.test', apiKey: '  ' } }],
    ['invalid base URL', { connection: { baseUrl: 'not a url', apiKey: 'k' } }],
  ] as const)('%s → heuristic fallback, no network', async (_label, extra) => {
    const opts = isolated(extra);
    const outcome = await decide('site.a', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(outcome.answers).toEqual(HEURISTIC_ANSWERS);
    expect(heuristic).toHaveBeenCalledWith(REQUEST);
    expect(opts.audit.entries[0]).toMatchObject({
      site: 'site.a',
      source: 'fallback',
      fallbackReason: 'unconfigured',
    });
    expect(networkSpy).not.toHaveBeenCalled();
  });

  it('works with every default (process cache, file budget, project audit) when unconfigured', async () => {
    const outcome = await decide('site.defaults', REQUEST, heuristic, { audit: null });
    expect(outcome.source).toBe('fallback');
    expect(networkSpy).not.toHaveBeenCalled();
  });
});

describe('decide — provider path', () => {
  it('returns the provider answer, then serves the repeat from cache', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const opts = isolated({ provider });
    const first = await decide('site.b', REQUEST, heuristic, opts);
    expect(first.source).toBe('provider');
    expect(first.answers).toEqual(PROVIDER_OUTCOME.answers);
    const second = await decide('site.b', REQUEST, heuristic, opts);
    expect(second.source).toBe('cache');
    expect(second.answers).toEqual(PROVIDER_OUTCOME.answers);
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect(heuristic).not.toHaveBeenCalled();
    expect(opts.audit.entries.map((e) => e.source)).toEqual(['provider', 'cache']);
    expect(opts.audit.entries[0]).toMatchObject({
      requestId: 'req_42',
      costUsd: 0.00001,
      answers: { retry: { type: 'noul', value: true, probability: 0.9, confidence: 0.95 } },
    });
    expect(opts.audit.entries[0]?.questionsHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('redacts secrets from the state before the provider sees it', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    await decide(
      'site.c',
      {
        state: { log: `token ${secret}`, nested: [`Bearer ${secret}`] },
        questions: REQUEST.questions,
      },
      heuristic,
      isolated({ provider }),
    );
    const sent = JSON.stringify(provider.decide.mock.calls[0]?.[0]);
    expect(sent).not.toContain(secret);
    expect(sent).toContain('[REDACTED]');
  });

  it('rejects an invalid request locally (33 questions) without calling the provider', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const questions = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [`q${i}`, { type: 'noul' as const, criteria: 'x' }]),
    );
    const opts = isolated({ provider });
    const outcome = await decide('site.d', { state: 's', questions }, () => ({}), opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('invalid_request');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('falls back when the provider omits an answer', async () => {
    const provider = fakeProvider(async () => ({ ...PROVIDER_OUTCOME, answers: {} }));
    const opts = isolated({ provider });
    const outcome = await decide('site.e', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('invalid_response');
  });
});

describe('decide — failures never throw and stay within the site budget', () => {
  it('times out a hung provider at the site deadline and aborts its signal', async () => {
    let seenSignal: AbortSignal | undefined;
    const provider = fakeProvider(
      (_req, signal) =>
        new Promise<DecisionOutcome>(() => {
          seenSignal = signal;
        }),
    );
    const opts = isolated({ provider, timeoutMs: 50 });
    const started = performance.now();
    const outcome = await decide('site.f', REQUEST, heuristic, opts);
    const took = performance.now() - started;
    expect(outcome.source).toBe('fallback');
    expect(outcome.answers).toEqual(HEURISTIC_ANSWERS);
    expect(opts.audit.entries[0]?.fallbackReason).toBe('timeout');
    expect(seenSignal?.aborted).toBe(true);
    expect(took).toBeLessThan(250);
  });

  it('uses the 300 ms default deadline', async () => {
    const provider = fakeProvider(() => new Promise<DecisionOutcome>(() => undefined));
    const started = performance.now();
    const outcome = await decide('site.g', REQUEST, heuristic, isolated({ provider }));
    const took = performance.now() - started;
    expect(outcome.source).toBe('fallback');
    expect(took).toBeGreaterThanOrEqual(290);
    expect(took).toBeLessThan(600);
  });

  it.each([
    [
      'unauthorized',
      new DecisionProviderError('unauthorized', 'HTTP 401', { status: 401 }),
      'unauthorized',
    ],
    [
      'insufficient_credits',
      new DecisionProviderError('insufficient_credits', 'HTTP 402', { status: 402 }),
      'insufficient_credits',
    ],
    [
      'server_error',
      new DecisionProviderError('server_error', 'HTTP 503', { status: 503 }),
      'server_error',
    ],
    ['network', new DecisionProviderError('network', 'refused'), 'network'],
    ['unknown error', new Error('boom'), 'provider_error'],
  ] as const)('%s → fallback', async (_label, error, reason) => {
    const provider = fakeProvider(async () => {
      throw error;
    });
    const opts = isolated({ provider });
    const outcome = await decide('site.h', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(outcome.answers).toEqual(HEURISTIC_ANSWERS);
    expect(opts.audit.entries[0]?.fallbackReason).toBe(reason);
  });

  it('429 → fallback and a shared cool-down that stops further provider calls', async () => {
    const provider = fakeProvider(async () => {
      throw new DecisionProviderError('rate_limited', 'HTTP 429', {
        status: 429,
        retryAfterMs: 60_000,
      });
    });
    const budget = createMemoryTokenBucket();
    const penalize = vi.spyOn(budget, 'penalize');
    const opts = isolated({ provider, budget, cache: null });
    const first = await decide('site.i', REQUEST, heuristic, opts);
    expect(first.source).toBe('fallback');
    expect(penalize).toHaveBeenCalledWith(60_000);
    const second = await decide('site.i', REQUEST, heuristic, opts);
    expect(second.source).toBe('fallback');
    expect(provider.decide).toHaveBeenCalledTimes(1);
    expect(opts.audit.entries.map((e) => e.fallbackReason)).toEqual([
      'rate_limited',
      'budget_cooling_down',
    ]);
  });

  it('an exhausted budget falls back without calling the provider', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const budget: DecisionBudget = {
      tryAcquire: async () => ({ granted: false, reason: 'exhausted' }),
      penalize: async () => undefined,
    };
    const opts = isolated({ provider, budget });
    const outcome = await decide('site.j', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('budget_exhausted');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('a hung budget is bounded by the same site deadline', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const budget: DecisionBudget = {
      tryAcquire: () => new Promise(() => undefined),
      penalize: async () => undefined,
    };
    const started = performance.now();
    const outcome = await decide(
      'site.k',
      REQUEST,
      heuristic,
      isolated({ provider, budget, timeoutMs: 40 }),
    );
    expect(outcome.source).toBe('fallback');
    expect(performance.now() - started).toBeLessThan(250);
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('an already-aborted caller signal falls back immediately', async () => {
    const provider = fakeProvider(async () => PROVIDER_OUTCOME);
    const controller = new AbortController();
    controller.abort();
    const opts = isolated({ provider, signal: controller.signal });
    const outcome = await decide('site.l', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('timeout');
  });
});

describe('decide — real Jev provider over a stubbed fetch, JSONL audit', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cleo-decide-audit-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('402 from the wire → fallback, and the audit file never contains the key', async () => {
    const apiKey = 'lh_supersecretkey_0123456789';
    networkSpy.mockImplementation(async () => new Response('{"detail":{}}', { status: 402 }));
    const outcome = await decide('site.m', REQUEST, heuristic, {
      connection: { baseUrl: 'https://decide.test', apiKey },
      cache: null,
      budget: createMemoryTokenBucket(),
      projectRoot: dir,
    });
    expect(outcome.source).toBe('fallback');
    expect(networkSpy).toHaveBeenCalledTimes(1);
    const audit = readFileSync(join(dir, '.cleo', 'audit', 'decisions.jsonl'), 'utf-8');
    const lines = audit.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      site: 'site.m',
      source: 'fallback',
      fallbackReason: 'insufficient_credits',
    });
    expect(audit).not.toContain(apiKey);
    expect(audit).not.toContain('deploy failed');
  });
});
