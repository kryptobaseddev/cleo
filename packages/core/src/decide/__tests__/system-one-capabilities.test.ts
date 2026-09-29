/**
 * System One phase 3 (T12664): provider capabilities, layahost extensions,
 * error kinds, the monthly spend cap and `cleo decide status`.
 *
 * Every provider call goes through a stub `fetch` or a fake provider; no test
 * reaches a live API.
 *
 * @task T12664
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DecisionAnswer,
  type DecisionOutcome,
  type DecisionRequest,
  JEV_MINIMUM_CAPABILITIES,
} from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionAuditEntry, DecisionAuditSink } from '../audit.js';
import { createMemoryTokenBucket, type DecisionBudget } from '../budget.js';
import { createDecisionCache } from '../cache.js';
import {
  _resetDecideDefaultsForTest,
  type DecideOptions,
  decide,
  decideBatch,
  OVERLOADED_COOLDOWN_MS,
} from '../client.js';
import { saveDecideCredentials } from '../credentials.js';
import {
  createJevProvider,
  detectJevCapabilities,
  JEV_ADAPTER_VERSION,
  LAYAHOST_EXTENSION_CAPABILITIES,
  toJevSystemOneBody,
} from '../jev-wire.js';
import { probeDecideProvider } from '../operations.js';
import { type DecisionProvider, DecisionProviderError } from '../provider.js';
import { _resetProviderStateMemoForTest, USAGE_REFRESH_MS } from '../provider-state.js';
import { DECISION_SITES } from '../sites/registry.js';
import {
  createFileSpendLedger,
  createMemorySpendLedger,
  startOfNextUtcMonth,
  utcMonth,
} from '../spend.js';

const REQUEST: DecisionRequest = {
  state: 'Fix the flaky auth test',
  questions: { dup: { type: 'noul', criteria: 'Both tasks describe the same work' } },
};
const OK_BODY = {
  answers: { dup: { type: 'noul', noul: 0.9, confidence: 0.8 } },
  meta: { request_id: 'req_1' },
};
const connection = { baseUrl: 'https://decide.test', apiKey: 'lh_secret' };

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** Route stub: URL (path, query stripped) → response factory. */
function routes(map: Record<string, () => Response>): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async (input) => {
    const path = new URL(String(input)).pathname;
    const make = map[path];
    return make ? make() : jsonResponse(404, { detail: { error_type: 'not_found' } });
  });
}

async function rejected(promise: Promise<unknown>): Promise<DecisionProviderError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DecisionProviderError);
  if (!(err instanceof DecisionProviderError)) throw new Error('not a provider error');
  return err;
}

const signal = (): AbortSignal => new AbortController().signal;

describe('jev-wire/2 — errors, cost and extensions', () => {
  it('is adapter version jev-wire/2', () => {
    expect(JEV_ADAPTER_VERSION).toBe('jev-wire/2');
  });

  it('maps 403 key_limit_exceeded to its own kind, never unauthorized', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(403, { detail: { error_type: 'key_limit_exceeded', message: 'limit' } }),
      }),
    });
    const err = await rejected(provider.decide(REQUEST, signal()));
    expect(err.kind).toBe('key_limit_exceeded');
    expect(err.status).toBe(403);
    expect(err.message).not.toContain('lh_secret');
  });

  it.each([503, 529])('maps %i to overloaded with its retry-after', async (status) => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(
            status,
            { detail: { error_type: 'overloaded_error' } },
            { 'retry-after': '4' },
          ),
      }),
    });
    const err = await rejected(provider.decide(REQUEST, signal()));
    expect(err.kind).toBe('overloaded');
    expect(err.retryAfterMs).toBe(4000);
  });

  it('reads cost from meta.cost_micros, balance from the header, and the checkpoint', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(
            200,
            { ...OK_BODY, meta: { request_id: 'r', cost_micros: 15, checkpoint: 'laya-en-0926' } },
            { 'x-layahost-balance-micros': '4999985' },
          ),
      }),
    });
    const outcome = await provider.decide(REQUEST, signal());
    expect(outcome).toMatchObject({
      costMicros: 15,
      costUsd: 15 / 1e6,
      balanceMicros: 4999985,
      checkpoint: 'laya-en-0926',
    });
  });

  it('falls back to the cost header when meta has no cost_micros', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () => jsonResponse(200, OK_BODY, { 'x-layahost-cost-micros': '5' }),
      }),
    });
    expect((await provider.decide(REQUEST, signal())).costMicros).toBe(5);
  });

  it('keeps a plain Jev host on the Jev body and the one-method shape', async () => {
    const fetchStub = routes({ '/v1/systemone': () => jsonResponse(200, OK_BODY) });
    const provider = createJevProvider(connection, { fetch: fetchStub });
    expect(provider.capabilities?.()).toEqual(JEV_MINIMUM_CAPABILITIES);
    expect(provider.decideBatch).toBeUndefined();
    expect(provider.usage).toBeUndefined();
    const outcome = await provider.decide({ ...REQUEST, lang: 'en', cache: false }, signal());
    expect(outcome.costMicros).toBeUndefined();
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.lang).toBeUndefined();
    expect(body.cache).toBeUndefined();
  });

  it('sends lang and cache only with the capabilities', () => {
    const req = { ...REQUEST, lang: 'en', cache: false };
    expect(toJevSystemOneBody(req)).not.toHaveProperty('lang');
    expect(toJevSystemOneBody(req, LAYAHOST_EXTENSION_CAPABILITIES)).toMatchObject({
      lang: 'en',
      cache: false,
    });
  });
});

describe('decideBatch on the wire', () => {
  it('POSTs /v1/systemone/batch and maps each item, failed ones by kind', async () => {
    const fetchStub = routes({
      '/v1/systemone/batch': () =>
        jsonResponse(200, {
          results: [
            { status: 200, ...OK_BODY },
            { status: 402, detail: { error_type: 'insufficient_credits' } },
          ],
        }),
    });
    const provider = createJevProvider(connection, {
      fetch: fetchStub,
      capabilities: LAYAHOST_EXTENSION_CAPABILITIES,
    });
    const items = (await provider.decideBatch?.([REQUEST, REQUEST], signal())) ?? [];
    expect(items[0]).toMatchObject({ ok: true });
    expect(items[1]).toEqual({ ok: false, status: 402, errorKind: 'insufficient_credits' });
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body.requests).toHaveLength(2);
  });

  it('refuses a batch beyond the provider limits', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({}),
      capabilities: {
        ...LAYAHOST_EXTENSION_CAPABILITIES,
        batch: { maxRequests: 1, maxQuestions: 256 },
      },
    });
    const err = await rejected(
      provider.decideBatch?.([REQUEST, REQUEST], signal()) ?? Promise.resolve(),
    );
    expect(err.kind).toBe('invalid_request');
  });
});

describe('detectJevCapabilities — from responses, never the host name', () => {
  it('finds the layahost extensions and templates when /v1/usage answers', async () => {
    const result = await detectJevCapabilities(connection, signal(), {
      fetch: routes({
        '/v1/usage': () =>
          jsonResponse(200, { balance: { micros: 900, decisions_left: 60 }, plan: 'starter' }),
        '/v1/templates': () =>
          jsonResponse(200, { templates: [{ name: 'prompt_injection' }, 'spam'] }),
      }),
    });
    expect(result.capabilities).toMatchObject({
      batch: { maxRequests: 64, maxQuestions: 256 },
      usage: true,
      templates: ['prompt_injection', 'spam'],
    });
    expect(result.usage).toEqual({ balanceMicros: 900, decisionsLeft: 60, plan: 'starter' });
  });

  it('stays on the Jev minimum when /v1/usage is absent or empty', async () => {
    expect(
      (await detectJevCapabilities(connection, signal(), { fetch: routes({}) })).capabilities,
    ).toEqual(JEV_MINIMUM_CAPABILITIES);
    const empty = await detectJevCapabilities(connection, signal(), {
      fetch: routes({ '/v1/usage': () => jsonResponse(200, {}) }),
    });
    expect(empty.capabilities).toEqual(JEV_MINIMUM_CAPABILITIES);
  });
});

describe('spend ledger (D11159)', () => {
  it('degrades once month-to-date spend reaches the cap, and rolls over with the UTC month', async () => {
    let now = Date.UTC(2026, 8, 30, 23, 0);
    const ledger = createMemorySpendLedger({ now: () => now });
    expect(await ledger.check(100)).toBe('ok');
    await ledger.record(60);
    await ledger.record(40);
    expect(await ledger.check(100)).toBe('over_budget');
    now = Date.UTC(2026, 9, 1, 0, 1);
    expect(await ledger.check(100)).toBe('ok');
    expect((await ledger.status())?.month).toBe('2026-10');
  });

  it('holds a key-limit stop until the start of the next UTC month', async () => {
    let now = Date.UTC(2026, 8, 15);
    const ledger = createMemorySpendLedger({ now: () => now });
    await ledger.markKeyLimited();
    expect(await ledger.check(1_000_000)).toBe('key_limited');
    expect((await ledger.status())?.keyLimitedUntil).toBe(startOfNextUtcMonth(now));
    now = Date.UTC(2026, 9, 1);
    expect(await ledger.check(1_000_000)).toBe('ok');
  });

  it('shares state across ledgers on the same file (cross-process)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-'));
    try {
      const statePath = join(dir, 'spend.json');
      const a = createFileSpendLedger({ statePath });
      const b = createFileSpendLedger({ statePath });
      await a.record(700);
      await b.record(300);
      expect(await a.check(1000)).toBe('over_budget');
      expect((await b.status())?.spentMicros).toBe(1000);
      expect((await b.status())?.month).toBe(utcMonth(Date.now()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('client — spend cap, key limit, circuit breaker, batch', () => {
  const HEURISTIC: Record<string, DecisionAnswer> = {
    dup: { type: 'noul', value: false, probability: 0.1, confidence: 1 },
  };
  const heuristic = (): Record<string, DecisionAnswer> => HEURISTIC;
  const OUTCOME: DecisionOutcome = {
    answers: { dup: { type: 'noul', value: true, probability: 0.9, confidence: 0.8 } },
    source: 'provider',
    latencyMs: 5,
    costMicros: 15,
    balanceMicros: 1000,
    checkpoint: 'cp1',
  };

  function audit(): DecisionAuditSink & { entries: DecisionAuditEntry[] } {
    const entries: DecisionAuditEntry[] = [];
    return { entries, write: (e) => entries.push(e) };
  }

  function wiring(extra: DecideOptions = {}): DecideOptions & { audit: ReturnType<typeof audit> } {
    return {
      cache: createDecisionCache(),
      budget: createMemoryTokenBucket(),
      spend: createMemorySpendLedger(),
      spendCapMicros: 1_000_000,
      timeoutMs: 1_000,
      ...extra,
      audit: audit(),
    };
  }

  beforeEach(() => {
    _resetDecideDefaultsForTest();
  });

  it('records cost and audits cost, balance and checkpoint', async () => {
    const spend = createMemorySpendLedger();
    const opts = wiring({ spend, provider: { decide: vi.fn(async () => OUTCOME) } });
    const outcome = await decide('tasks.duplicate-detection', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('provider');
    expect((await spend.status())?.spentMicros).toBe(15);
    expect(opts.audit.entries[0]).toMatchObject({
      costMicros: 15,
      balanceMicros: 1000,
      checkpoint: 'cp1',
    });
  });

  it('falls back with reason budget, without calling the provider, once the cap is reached', async () => {
    const spend = createMemorySpendLedger();
    await spend.record(100);
    const provider = { decide: vi.fn(async () => OUTCOME) };
    const opts = wiring({ spend, spendCapMicros: 100, provider });
    const outcome = await decide('tasks.duplicate-detection', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('budget');
    expect(provider.decide).not.toHaveBeenCalled();
  });

  it('stops asking after a 403 key limit until the month ends', async () => {
    const spend = createMemorySpendLedger();
    const provider = {
      decide: vi.fn(async (): Promise<DecisionOutcome> => {
        throw new DecisionProviderError('key_limit_exceeded', 'limit', { status: 403 });
      }),
    };
    const first = wiring({ spend, provider });
    await decide('s', REQUEST, heuristic, first);
    expect(first.audit.entries[0]?.fallbackReason).toBe('key_limit_exceeded');
    const second = wiring({ spend, provider });
    await decide('s', REQUEST, heuristic, second);
    expect(second.audit.entries[0]?.fallbackReason).toBe('key_limit_exceeded');
    expect(provider.decide).toHaveBeenCalledTimes(1);
  });

  it('trips the request budget as a circuit breaker on overloaded, honouring retry-after', async () => {
    const penalize = vi.fn(async () => undefined);
    const budget: DecisionBudget = { tryAcquire: async () => ({ granted: true }), penalize };
    const overloaded = (retryAfterMs?: number): DecisionProvider => ({
      decide: async () => {
        throw new DecisionProviderError('overloaded', 'busy', {
          status: 529,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      },
    });
    await decide('s', REQUEST, heuristic, wiring({ budget, provider: overloaded(4000) }));
    await decide('s', REQUEST, heuristic, wiring({ budget, provider: overloaded() }));
    expect(penalize.mock.calls).toEqual([[4000], [OVERLOADED_COOLDOWN_MS]]);
  });

  it('never rejects: a spend ledger that cannot be read degrades to the heuristic', async () => {
    const spend = {
      ...createMemorySpendLedger(),
      check: async () => 'unavailable' as const,
    };
    const opts = wiring({ spend, provider: { decide: vi.fn(async () => OUTCOME) } });
    const outcome = await decide('s', REQUEST, heuristic, opts);
    expect(outcome.source).toBe('fallback');
    expect(opts.audit.entries[0]?.fallbackReason).toBe('budget_unavailable');
  });

  it('decideBatch sends one batch call when the provider has the capability', async () => {
    const acquire = vi.fn(async () => ({ granted: true as const }));
    const budget: DecisionBudget = { tryAcquire: acquire, penalize: async () => undefined };
    const decideBatchFn = vi.fn(async (reqs: readonly DecisionRequest[]) =>
      reqs.map((_, i) =>
        i === 0
          ? { ok: true as const, outcome: OUTCOME }
          : { ok: false as const, status: 402, errorKind: 'insufficient_credits' },
      ),
    );
    const provider: DecisionProvider = {
      decide: vi.fn(async () => OUTCOME),
      capabilities: () => LAYAHOST_EXTENSION_CAPABILITIES,
      decideBatch: decideBatchFn,
    };
    const second: DecisionRequest = { ...REQUEST, state: 'Another task' };
    const opts = wiring({ budget, provider });
    const out = await decideBatch(
      's',
      [
        { req: REQUEST, fallback: heuristic },
        { req: second, fallback: heuristic },
      ],
      opts,
    );
    expect(decideBatchFn).toHaveBeenCalledTimes(1);
    expect(provider.decide).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(out.map((o) => o.source)).toEqual(['provider', 'fallback']);
    expect(opts.audit.entries.map((e) => e.fallbackReason)).toEqual([
      undefined,
      'insufficient_credits',
    ]);
  });

  it('decideBatch degrades to sequential decides without the capability', async () => {
    const provider: DecisionProvider = { decide: vi.fn(async () => OUTCOME) };
    const out = await decideBatch(
      's',
      [
        { req: REQUEST, fallback: heuristic },
        { req: { ...REQUEST, state: 'Other' }, fallback: heuristic },
      ],
      wiring({ provider }),
    );
    expect(provider.decide).toHaveBeenCalledTimes(2);
    expect(out.map((o) => o.source)).toEqual(['provider', 'provider']);
  });
});

describe('cleo decide status — capabilities, usage, spend, sites', () => {
  let dir: string;
  const URL = 'https://decide.test';
  const models = () => jsonResponse(200, { models: [{ name: 'laya-auto' }] });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'decide-status-'));
    _resetProviderStateMemoForTest();
    await saveDecideCredentials({ baseUrl: URL, apiKey: 'lh_secret_4321', model: 'laya-auto' });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports capabilities, usage, spend against the cap and the sites count', async () => {
    const spend = createMemorySpendLedger();
    await spend.record(250);
    const result = await probeDecideProvider({
      fetch: routes({
        '/v1/models': models,
        '/v1/usage': () =>
          jsonResponse(200, { balance: { micros: 5_000_000, decisions_left: 333_333 } }),
      }),
      spend,
      capMicros: 1_000_000,
      providerStatePath: join(dir, 'state.json'),
    });
    expect(result.state).toBe('reachable');
    expect(result.sites).toBe(DECISION_SITES.length);
    expect(result.capabilities?.usage).toBe(true);
    expect(result.usage).toMatchObject({ balanceMicros: 5_000_000, decisionsLeft: 333_333 });
    expect(result.spend).toMatchObject({
      spentMicros: 250,
      capMicros: 1_000_000,
      capReached: false,
    });
    expect(JSON.stringify(result)).not.toContain('lh_secret_4321');
  });

  it('calls /v1/usage at most every 10 minutes', async () => {
    let now = 1_000_000;
    const fetchStub = routes({
      '/v1/models': models,
      '/v1/usage': () => jsonResponse(200, { balance: { micros: 1 } }),
    });
    const opts = {
      fetch: fetchStub,
      spend: null,
      providerStatePath: join(dir, 'state.json'),
      now: () => now,
    };
    const usageCalls = (): number =>
      fetchStub.mock.calls.filter(([u]) => String(u).includes('/v1/usage')).length;
    await probeDecideProvider(opts);
    now += USAGE_REFRESH_MS - 1;
    await probeDecideProvider(opts);
    expect(usageCalls()).toBe(1);
    now += 2;
    await probeDecideProvider(opts);
    expect(usageCalls()).toBe(2);
  });

  it('says the key monthly limit was reached on a 403 key_limit_exceeded', async () => {
    const result = await probeDecideProvider({
      fetch: routes({
        '/v1/models': () => jsonResponse(403, { detail: { error_type: 'key_limit_exceeded' } }),
      }),
      spend: null,
      providerStatePath: join(dir, 'state.json'),
    });
    expect(result.state).toBe('key_limit_reached');
    expect(result.detail).toMatch(/monthly decision limit/);
    expect(result.state).not.toBe('unauthorized');
  });
});
