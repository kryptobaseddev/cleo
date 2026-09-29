/**
 * System One phase 3 (T12664): provider capabilities, layahost extensions,
 * error kinds, the monthly spend cap and `cleo decide status`.
 *
 * Every provider call goes through a stub `fetch` or a fake provider; no test
 * reaches a live API.
 *
 * @task T12664
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type DecisionAnswer,
  type DecisionBatchItem,
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
  DEFAULT_BATCH_DECISION_TIMEOUT_MS,
  DEFAULT_DECISION_TIMEOUT_MS,
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
import { probeDecideProvider, resetDecideBudget, SPEND_LEDGER_REPAIR_HINT } from '../operations.js';
import { type DecisionProvider, DecisionProviderError } from '../provider.js';
import {
  _resetProviderStateMemoForTest,
  cachedCapabilities,
  providerKeyHash,
  readProviderState,
  refreshProviderState,
  TRANSIENT_DETECTION_RETRY_MS,
  USAGE_REFRESH_MS,
  writeProviderState,
} from '../provider-state.js';
import { DECISION_SITES } from '../sites/registry.js';
import {
  createFileSpendLedger,
  createMemorySpendLedger,
  inspectSpendLedger,
  RESERVATION_TTL_MS,
  SpendResetRefusedError,
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

/** The provider's own OpenAPI, trimmed (`fixtures/layahost-openapi.trimmed.json`). */
const SPEC: SpecNode = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'layahost-openapi.trimmed.json'),
    'utf-8',
  ),
);

/** A JSON-schema node as far as these checks read it. */
type SpecNode = { readonly [key: string]: unknown };

function node(value: unknown): SpecNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Follow `$ref`s within the spec. */
function deref(schema: SpecNode): SpecNode {
  const ref = schema['$ref'];
  if (typeof ref !== 'string') return schema;
  return deref(
    ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<SpecNode>((n, k) => node(n[k]), SPEC),
  );
}

/**
 * Problems with `value` against a spec schema: type, required, properties,
 * items and enum — enough to catch a wire shape the provider does not speak.
 */
function conforms(schemaIn: SpecNode, value: unknown, path = '$'): string[] {
  const schema = deref(schemaIn);
  const type = schema['type'];
  const problems: string[] = [];
  const is = (t: string): boolean =>
    t === 'integer'
      ? Number.isInteger(value)
      : t === 'array'
        ? Array.isArray(value)
        : t === 'object'
          ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : typeof value === t;
  if (typeof type === 'string' && !is(type)) return [`${path}: expected ${type}`];
  const en = schema['enum'];
  if (Array.isArray(en) && !en.includes(value)) problems.push(`${path}: not in enum`);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const obj = node(value);
    const req = schema['required'];
    if (Array.isArray(req))
      for (const k of req) if (!(String(k) in obj)) problems.push(`${path}.${String(k)}: required`);
    const props = node(schema['properties']);
    for (const [k, v] of Object.entries(obj)) {
      if (k in props) problems.push(...conforms(node(props[k]), v, `${path}.${k}`));
      else if (
        schema['additionalProperties'] &&
        typeof schema['additionalProperties'] === 'object'
      ) {
        problems.push(...conforms(node(schema['additionalProperties']), v, `${path}.${k}`));
      }
    }
  }
  if (Array.isArray(value) && schema['items']) {
    for (const [i, v] of value.entries()) {
      problems.push(...conforms(node(schema['items']), v, `${path}[${i}]`));
    }
  }
  return problems;
}

/** The spec schema of an operation's JSON request or response. */
function specSchema(path: string, method: string, part: 'request' | string): SpecNode {
  const op = node(node(node(SPEC['paths'])[path])[method]);
  const holder = part === 'request' ? node(op['requestBody']) : node(node(op['responses'])[part]);
  return node(node(node(holder['content'])['application/json'])['schema']);
}

/** A spec-conformant SystemOneResponse body. */
const SPEC_OK_BODY = {
  model: 'laya-auto',
  answers: { dup: { type: 'noul', noul: 0.9, confidence: 0.8 } },
  usage: { input_tokens: 12, output_tokens: 0 },
  meta: {
    request_id: 'req_1',
    checkpoint: 'laya-en-0926',
    cost_micros: 15,
    decisions: 1,
    cached: false,
  },
};

describe('jev-wire/3 — errors, cost and extensions', () => {
  it('is adapter version jev-wire/3', () => {
    expect(JEV_ADAPTER_VERSION).toBe('jev-wire/3');
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

  it('reads cost from meta.cost_micros and the checkpoint (OpenAPI SystemOneResponse.meta)', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(200, {
            ...OK_BODY,
            meta: { request_id: 'r', cost_micros: 15, checkpoint: 'laya-en-0926' },
          }),
      }),
    });
    const outcome = await provider.decide(REQUEST, signal());
    expect(outcome).toMatchObject({
      costMicros: 15,
      costUsd: 15 / 1e6,
      checkpoint: 'laya-en-0926',
    });
    expect(outcome.balanceMicros).toBeUndefined();
  });

  it('derives micros from meta.cost_usd when meta has no cost_micros', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () => jsonResponse(200, { ...OK_BODY, meta: { cost_usd: 0.000005 } }),
      }),
    });
    const outcome = await provider.decide(REQUEST, signal());
    expect(outcome).toMatchObject({ costMicros: 5, costUsd: 0.000005 });
  });

  it('ignores the undocumented x-layahost-* cost and balance headers (T12715)', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(200, OK_BODY, {
            'x-layahost-cost-micros': '5',
            'x-layahost-balance-micros': '4999985',
          }),
      }),
    });
    const outcome = await provider.decide(REQUEST, signal());
    expect(outcome.costMicros).toBeUndefined();
    expect(outcome.balanceMicros).toBeUndefined();
  });

  it('the pinned OpenAPI declares cost only in SystemOneResponse.meta, never as a header', () => {
    expect(JSON.stringify(SPEC)).not.toMatch(/x-layahost|"headers"/i);
    const meta = node(
      node(node(node(node(SPEC.components).schemas).SystemOneResponse).properties).meta,
    );
    expect(Object.keys(node(meta.properties))).toEqual(
      expect.arrayContaining(['cost_micros', 'cost_usd', 'checkpoint']),
    );
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
  it('reads the spec shape {responses:[{index,status,body}]}, placing items by index (review of #1685)', async () => {
    // Out of order on purpose: index, not array position, places an item.
    const response = {
      responses: [
        {
          index: 1,
          status: 402,
          body: { detail: { error_type: 'insufficient_credits', message: 'x' } },
        },
        { index: 0, status: 200, body: SPEC_OK_BODY },
      ],
      request_id: 'batch_1',
    };
    expect(conforms(specSchema('/v1/systemone/batch', 'post', '200'), response)).toEqual([]);
    const fetchStub = routes({ '/v1/systemone/batch': () => jsonResponse(200, response) });
    const provider = createJevProvider(
      { ...connection, model: 'laya-auto' },
      { fetch: fetchStub, capabilities: LAYAHOST_EXTENSION_CAPABILITIES },
    );
    const items = (await provider.decideBatch?.([REQUEST, REQUEST], signal())) ?? [];
    expect(items[0]).toMatchObject({
      ok: true,
      outcome: { costMicros: 15, checkpoint: 'laya-en-0926', requestId: 'req_1' },
    });
    expect(items[1]).toEqual({ ok: false, status: 402, errorKind: 'insufficient_credits' });
    const sent = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(conforms(specSchema('/v1/systemone/batch', 'post', 'request'), sent)).toEqual([]);
    expect(sent.requests).toHaveLength(2);
  });

  it('rejects a batch response whose index is out of range or repeated', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone/batch': () =>
          jsonResponse(200, {
            responses: [
              { index: 0, status: 200, body: SPEC_OK_BODY },
              { index: 0, status: 200, body: SPEC_OK_BODY },
            ],
          }),
      }),
      capabilities: LAYAHOST_EXTENSION_CAPABILITIES,
    });
    const err = await rejected(
      provider.decideBatch?.([REQUEST, REQUEST], signal()) ?? Promise.resolve(),
    );
    expect(err.kind).toBe('invalid_response');
  });

  it('sends a /v1/systemone body the spec accepts, and reads a spec response', async () => {
    const fetchStub = routes({ '/v1/systemone': () => jsonResponse(200, SPEC_OK_BODY) });
    expect(conforms(specSchema('/v1/systemone', 'post', '200'), SPEC_OK_BODY)).toEqual([]);
    const provider = createJevProvider(
      { ...connection, model: 'laya-auto' },
      { fetch: fetchStub, capabilities: LAYAHOST_EXTENSION_CAPABILITIES },
    );
    const outcome = await provider.decide({ ...REQUEST, lang: 'en', cache: false }, signal());
    expect(outcome).toMatchObject({ costMicros: 15, checkpoint: 'laya-en-0926' });
    const sent = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(conforms(specSchema('/v1/systemone', 'post', 'request'), sent)).toEqual([]);
    expect(sent).toMatchObject({ model: 'laya-auto', lang: 'en', cache: false });
  });

  it('treats a 429 insufficient_quota (empty balance) as credit exhaustion, not a rate limit', async () => {
    const provider = createJevProvider(connection, {
      fetch: routes({
        '/v1/systemone': () =>
          jsonResponse(429, { detail: { error_type: 'insufficient_quota', message: 'empty' } }),
      }),
    });
    const err = await rejected(provider.decide(REQUEST, signal()));
    expect(err.kind).toBe('insufficient_credits');
    expect(err.kind).not.toBe('unauthorized');
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
    expect(
      conforms(specSchema('/v1/templates', 'get', '200'), {
        templates: [{ template: 'spam', name: 'Spam', type: 'yes_no' }],
      }),
    ).toEqual([]);
    const result = await detectJevCapabilities(connection, signal(), {
      fetch: routes({
        '/v1/usage': () =>
          jsonResponse(200, { balance: { micros: 900, decisions_left: 60 }, plan: 'starter' }),
        // Spec shape: `template` is the id, `name` a display label.
        '/v1/templates': () =>
          jsonResponse(200, {
            templates: [
              { template: 'prompt_injection', name: 'Prompt injection', type: 'yes_no' },
              { template: 'spam', name: 'Spam', type: 'yes_no' },
            ],
          }),
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
    expect((await ledger.reserve(100, 0)).verdict).toBe('ok');
    await ledger.record(60);
    await ledger.record(40);
    expect((await ledger.reserve(100, 0)).verdict).toBe('over_budget');
    now = Date.UTC(2026, 9, 1, 0, 1);
    expect((await ledger.reserve(100, 0)).verdict).toBe('ok');
    expect((await ledger.status())?.month).toBe('2026-10');
  });

  it('holds a key-limit stop until the start of the next UTC month', async () => {
    let now = Date.UTC(2026, 8, 15);
    const ledger = createMemorySpendLedger({ now: () => now });
    await ledger.markKeyLimited();
    expect((await ledger.reserve(1_000_000, 0)).verdict).toBe('key_limited');
    expect((await ledger.status())?.keyLimitedUntil).toBe(startOfNextUtcMonth(now));
    now = Date.UTC(2026, 9, 1);
    expect((await ledger.reserve(1_000_000, 0)).verdict).toBe('ok');
  });

  it('shares state across ledgers on the same file (cross-process)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spend-'));
    try {
      const statePath = join(dir, 'spend.json');
      const a = createFileSpendLedger({ statePath });
      const b = createFileSpendLedger({ statePath });
      await a.record(700);
      await b.record(300);
      expect((await a.reserve(1000, 0)).verdict).toBe('over_budget');
      expect((await b.status())?.spentMicros).toBe(1000);
      expect((await b.status())?.month).toBe(utcMonth(Date.now()));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('spend ledger under concurrency and corruption (review of #1685)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'spend-race-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loses no cost when 40 records race on one file', async () => {
    const statePath = join(dir, 'spend.json');
    const ledgers = Array.from({ length: 40 }, () => createFileSpendLedger({ statePath }));
    await Promise.all(ledgers.map((l) => l.record(1000)));
    expect((await createFileSpendLedger({ statePath }).status())?.spentMicros).toBe(40_000);
  });

  it('reserves under the cap check, so 40 racing callers cannot overshoot it', async () => {
    const statePath = join(dir, 'spend.json');
    const ledgers = Array.from({ length: 40 }, () => createFileSpendLedger({ statePath }));
    const verdicts = await Promise.all(ledgers.map((l) => l.reserve(100, 10)));
    expect(verdicts.filter((v) => v.verdict === 'unavailable')).toEqual([]);
    expect(verdicts.filter((v) => v.verdict === 'ok')).toHaveLength(10);
    expect(verdicts.filter((v) => v.verdict === 'over_budget')).toHaveLength(30);
  });

  it('commits the reported cost in place of the reservation; release frees it', async () => {
    const ledger = createMemorySpendLedger();
    const a = await ledger.reserve(100, 40);
    const b = await ledger.reserve(100, 40);
    expect((await ledger.reserve(100, 40)).verdict).toBe('over_budget');
    await ledger.commit(a.id ?? '', 15);
    await ledger.release(b.id ?? '');
    expect(await ledger.status()).toMatchObject({ spentMicros: 15, reservedMicros: 0 });
  });

  it('a corrupt ledger fails closed, status names the repair, and budget reset repairs it', async () => {
    const statePath = join(dir, 'spend.json');
    writeFileSync(statePath, '{not json');
    const ledger = createFileSpendLedger({ statePath });
    expect((await ledger.reserve(1_000_000, 15)).verdict).toBe('unavailable');
    expect(inspectSpendLedger(statePath)).toBe('corrupt');
    const status = await probeDecideProvider({
      connection: null,
      spendStatePath: statePath,
      spend: ledger,
    });
    expect(status.spendLedger).toBe('corrupt');
    expect(status.detail).toContain(SPEND_LEDGER_REPAIR_HINT);
    expect(status.detail).toContain('cleo decide budget reset');
    const receipt = await resetDecideBudget(statePath);
    expect(receipt.before).toBe('corrupt');
    expect(receipt.backupPath && existsSync(receipt.backupPath)).toBe(true);
    expect(readFileSync(receipt.backupPath ?? '', 'utf-8')).toBe('{not json');
    expect((await ledger.reserve(1_000_000, 15)).verdict).toBe('ok');
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
      reserve: async () => ({ verdict: 'unavailable' as const }),
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

  it('decideBatch defaults to a >= 30 s deadline, not the 300 ms single-decision one (T12715)', async () => {
    expect(DEFAULT_BATCH_DECISION_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    vi.useFakeTimers();
    try {
      const decideBatchFn = vi.fn(
        (reqs: readonly DecisionRequest[]) =>
          new Promise<readonly DecisionBatchItem[]>((resolve) => {
            // A realistic batch: 64 serial items take seconds, far past 300 ms.
            setTimeout(
              () => resolve(reqs.map(() => ({ ok: true as const, outcome: OUTCOME }))),
              5_000,
            );
          }),
      );
      const provider: DecisionProvider = {
        decide: vi.fn(async () => OUTCOME),
        capabilities: () => LAYAHOST_EXTENSION_CAPABILITIES,
        decideBatch: decideBatchFn,
      };
      const { timeoutMs: _omitted, ...opts } = wiring({ provider });
      const pending = decideBatch(
        's',
        [
          { req: REQUEST, fallback: heuristic },
          { req: { ...REQUEST, state: 'Other' }, fallback: heuristic },
        ],
        opts,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_DECISION_TIMEOUT_MS + 1);
      await vi.advanceTimersByTimeAsync(5_000);
      const out = await pending;
      expect(decideBatchFn).toHaveBeenCalledTimes(1);
      expect(out.map((o) => o.source)).toEqual(['provider', 'provider']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decideBatch still times out at the batch default', async () => {
    vi.useFakeTimers();
    try {
      const provider: DecisionProvider = {
        decide: vi.fn(async () => OUTCOME),
        capabilities: () => LAYAHOST_EXTENSION_CAPABILITIES,
        decideBatch: vi.fn(() => new Promise<readonly DecisionBatchItem[]>(() => undefined)),
      };
      const { timeoutMs: _omitted, ...opts } = wiring({ provider });
      const pending = decideBatch(
        's',
        [
          { req: REQUEST, fallback: heuristic },
          { req: { ...REQUEST, state: 'Other' }, fallback: heuristic },
        ],
        opts,
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_BATCH_DECISION_TIMEOUT_MS + 1);
      const out = await pending;
      expect(out.map((o) => o.source)).toEqual(['fallback', 'fallback']);
      expect(opts.audit.entries.map((e) => e.fallbackReason)).toEqual(['timeout', 'timeout']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('decideBatch sequential degradation caps each call at the single-decision default', async () => {
    vi.useFakeTimers();
    try {
      // No batch capability: every entry is a single decide that never answers.
      const provider: DecisionProvider = {
        decide: vi.fn(() => new Promise<DecisionOutcome>(() => undefined)),
      };
      const { timeoutMs: _omitted, ...opts } = wiring({ provider });
      const pending = decideBatch(
        's',
        [
          { req: REQUEST, fallback: heuristic },
          { req: { ...REQUEST, state: 'Other' }, fallback: heuristic },
        ],
        opts,
      );
      await vi.advanceTimersByTimeAsync(2 * DEFAULT_DECISION_TIMEOUT_MS + 10);
      const out = await pending;
      expect(provider.decide).toHaveBeenCalledTimes(2);
      expect(out.map((o) => o.source)).toEqual(['fallback', 'fallback']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('lazy capability detection (T12715)', () => {
  const HEURISTIC: Record<string, DecisionAnswer> = {
    dup: { type: 'noul', value: false, probability: 0.1, confidence: 1 },
  };
  const heuristic = (): Record<string, DecisionAnswer> => HEURISTIC;
  const sink: DecisionAuditSink = { write: () => undefined };
  let dir: string;
  const TWO = [
    { req: REQUEST, fallback: heuristic },
    { req: { ...REQUEST, state: 'Another task' }, fallback: heuristic },
  ];
  const batchBody = () =>
    jsonResponse(200, {
      responses: [
        { index: 0, status: 200, body: OK_BODY },
        { index: 1, status: 200, body: OK_BODY },
      ],
    });
  const layahost = () =>
    routes({
      '/v1/usage': () => jsonResponse(200, { balance: { micros: 5_000_000 } }),
      '/v1/systemone': () => jsonResponse(200, OK_BODY),
      '/v1/systemone/batch': batchBody,
    });
  const calls = (stub: ReturnType<typeof routes>, path: string): number =>
    stub.mock.calls.filter(([u]) => new URL(String(u)).pathname === path).length;

  beforeEach(() => {
    _resetDecideDefaultsForTest();
    _resetProviderStateMemoForTest();
    dir = mkdtempSync(join(tmpdir(), 'decide-lazy-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function opts(fetchStub: ReturnType<typeof routes>): DecideOptions {
    return {
      connection,
      fetch: fetchStub,
      providerStatePath: join(dir, 'state.json'),
      budget: null,
      spend: null,
      cache: null,
      audit: sink,
    };
  }

  it('decideBatch detects on first use, then sends ONE batch call', async () => {
    const stub = layahost();
    const out = await decideBatch('s', TWO, opts(stub));
    expect(out.map((o) => o.source)).toEqual(['provider', 'provider']);
    expect(calls(stub, '/v1/usage')).toBe(1);
    expect(calls(stub, '/v1/systemone/batch')).toBe(1);
    expect(calls(stub, '/v1/systemone')).toBe(0);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'));
    expect(state.capabilities.batch).toEqual({ maxRequests: 64, maxQuestions: 256 });
    expect(JSON.stringify(state)).not.toContain(connection.apiKey);
  });

  it('detects at most once per refresh interval', async () => {
    const stub = layahost();
    await decideBatch('s', TWO, opts(stub));
    _resetProviderStateMemoForTest(); // even a fresh process reuses the file
    await decideBatch('s', TWO, opts(stub));
    expect(calls(stub, '/v1/usage')).toBe(1);
    expect(calls(stub, '/v1/systemone/batch')).toBe(2);
  });

  it('a single decide never detects: it uses the Jev minimum until a detection is cached', async () => {
    const stub = layahost();
    const outcome = await decide('s', REQUEST, heuristic, { ...opts(stub), timeoutMs: 1_000 });
    expect(outcome.source).toBe('provider');
    expect(calls(stub, '/v1/usage')).toBe(0);
    expect(calls(stub, '/v1/templates')).toBe(0);
    expect(existsSync(join(dir, 'state.json'))).toBe(false);
  });

  it('a failed detection is not retried within the interval, even when the state cannot be written', async () => {
    writeFileSync(join(dir, 'blocker'), 'x');
    const stub = routes({ '/v1/systemone': () => jsonResponse(200, OK_BODY) });
    // `blocker` is a file, so `<blocker>/state.json` can never be written.
    const o = { ...opts(stub), providerStatePath: join(dir, 'blocker', 'state.json') };
    const first = await decideBatch('s', TWO, o);
    const second = await decideBatch('s', TWO, o);
    expect([...first, ...second].map((x) => x.source)).toEqual([
      'provider',
      'provider',
      'provider',
      'provider',
    ]);
    expect(calls(stub, '/v1/usage')).toBe(1);
    expect(calls(stub, '/v1/systemone')).toBe(4);
  });

  it('a transient detection failure keeps the previous capabilities', async () => {
    let now = 1_000_000;
    const path = join(dir, 'state.json');
    await refreshProviderState(connection, signal(), { fetch: layahost(), path, now: () => now });
    now += USAGE_REFRESH_MS;
    _resetProviderStateMemoForTest();
    const down = routes({ '/v1/usage': () => jsonResponse(503, { detail: {} }) });
    const state = await refreshProviderState(connection, signal(), {
      fetch: down,
      path,
      now: () => now,
    });
    expect(state?.capabilities.batch).toEqual({ maxRequests: 64, maxQuestions: 256 });
    expect(state?.detectedAt).toBe(now);
  });

  it('a definitive "no extension" answer downgrades to the Jev minimum', async () => {
    let now = 1_000_000;
    const path = join(dir, 'state.json');
    await refreshProviderState(connection, signal(), { fetch: layahost(), path, now: () => now });
    now += USAGE_REFRESH_MS;
    _resetProviderStateMemoForTest();
    const plainJev = routes({});
    const state = await refreshProviderState(connection, signal(), {
      fetch: plainJev,
      path,
      now: () => now,
    });
    expect(state?.capabilities).toEqual(JEV_MINIMUM_CAPABILITIES);
  });

  it('a transient failure with nothing cached is not written, and is retried after a short wait', async () => {
    let now = 1_000_000;
    const path = join(dir, 'state.json');
    const down = routes({ '/v1/usage': () => jsonResponse(503, { detail: {} }) });
    const o = { fetch: down, path, now: () => now };
    const state = await refreshProviderState(connection, signal(), o);
    expect(state?.capabilities).toEqual(JEV_MINIMUM_CAPABILITIES);
    expect(existsSync(path)).toBe(false);
    // The in-process memo serves the result meanwhile.
    expect(cachedCapabilities(connection, now, path)).toEqual(JEV_MINIMUM_CAPABILITIES);

    now += TRANSIENT_DETECTION_RETRY_MS - 1;
    await refreshProviderState(connection, signal(), o);
    expect(calls(down, '/v1/usage')).toBe(1);
    now += 1;
    await refreshProviderState(connection, signal(), o);
    expect(calls(down, '/v1/usage')).toBe(2);
  });

  it('a partial detection (/v1/usage ok, /v1/templates timed out) is transient, not "no templates"', async () => {
    const templatesDown = (): ReturnType<typeof routes> =>
      vi.fn<typeof fetch>(async (input) => {
        const p = new URL(String(input)).pathname;
        if (p === '/v1/usage') return jsonResponse(200, { balance: { micros: 5 } });
        throw new TypeError('fetch failed');
      });
    const partial = await detectJevCapabilities(connection, signal(), { fetch: templatesDown() });
    expect(partial.error?.kind).toBe('network');

    // Nothing cached: the partial result is not pinned for 10 minutes.
    let now = 1_000_000;
    const path = join(dir, 'state.json');
    await refreshProviderState(connection, signal(), {
      fetch: templatesDown(),
      path,
      now: () => now,
    });
    expect(existsSync(path)).toBe(false);

    // Cached with templates: a templates timeout keeps them.
    const full = routes({
      '/v1/usage': () => jsonResponse(200, { balance: { micros: 5 } }),
      '/v1/templates': () => jsonResponse(200, { templates: [{ template: 'spam' }] }),
    });
    await refreshProviderState(connection, signal(), {
      fetch: full,
      path,
      now: () => now,
      force: true,
    });
    expect(readProviderState(connection, path)?.capabilities.templates).toEqual(['spam']);
    now += USAGE_REFRESH_MS;
    const state = await refreshProviderState(connection, signal(), {
      fetch: templatesDown(),
      path,
      now: () => now,
    });
    expect(state?.capabilities.templates).toEqual(['spam']);
    expect(readProviderState(connection, path)?.capabilities.templates).toEqual(['spam']);
  });

  it('decideBatch answered entirely from the cache never detects', async () => {
    const cache = createDecisionCache();
    const stub = layahost();
    const first = await decideBatch('s', TWO, { ...opts(stub), cache });
    expect(first.map((o) => o.source)).toEqual(['provider', 'provider']);
    expect(calls(stub, '/v1/usage')).toBe(1);
    // A fresh process with no state file would detect — unless nothing is pending.
    _resetProviderStateMemoForTest();
    rmSync(join(dir, 'state.json'), { force: true });
    const second = await decideBatch('s', TWO, { ...opts(stub), cache });
    expect(second.map((o) => o.source)).toEqual(['cache', 'cache']);
    expect(calls(stub, '/v1/usage')).toBe(1);
  });

  it('detection uses at most 40% of the remaining batch deadline', async () => {
    const hanging = vi.fn<typeof fetch>(async (input, init) => {
      const p = new URL(String(input)).pathname;
      if (p === '/v1/systemone') return jsonResponse(200, OK_BODY);
      if (p === '/v1/usage') {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        });
      }
      return jsonResponse(404, { detail: { error_type: 'not_found' } });
    });
    const started = performance.now();
    const out = await decideBatch('s', TWO, { ...opts(hanging), timeoutMs: 1_000 });
    const detectedFor = performance.now() - started;
    // Detection gave up at ~400 ms, leaving the batch time to answer.
    expect(out.map((o) => o.source)).toEqual(['provider', 'provider']);
    expect(detectedFor).toBeLessThan(900);
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

describe('review of #1685, round 2: billed aborts, reset guard, batch item errors, keyed state', () => {
  const HEURISTIC: Record<string, DecisionAnswer> = {
    dup: { type: 'noul', value: false, probability: 0.1, confidence: 1 },
  };
  const heuristic = (): Record<string, DecisionAnswer> => HEURISTIC;
  const sink: DecisionAuditSink = { write: () => undefined };
  let dir: string;

  beforeEach(() => {
    _resetDecideDefaultsForTest();
    _resetProviderStateMemoForTest();
    dir = mkdtempSync(join(tmpdir(), 'decide-review2-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A provider call that was sent and only ends when its signal aborts. */
  const hangsUntilAborted = <T>(signal: AbortSignal): Promise<T> =>
    new Promise<T>((_, reject) => {
      signal.addEventListener('abort', () =>
        reject(new DecisionProviderError('aborted', 'aborted by deadline')),
      );
    });

  const settled = async (spend: ReturnType<typeof createMemorySpendLedger>): Promise<void> => {
    await vi.waitFor(async () => expect((await spend.status())?.reservedMicros).toBe(0));
  };

  it('commits the estimate for a call aborted by the deadline after it was sent', async () => {
    const spend = createMemorySpendLedger();
    const provider: DecisionProvider = { decide: (_req, signal) => hangsUntilAborted(signal) };
    const outcome = await decide('s', REQUEST, heuristic, {
      provider,
      spend,
      spendCapMicros: 1_000_000,
      budget: null,
      cache: null,
      audit: sink,
      timeoutMs: 20,
    });
    expect(outcome.source).toBe('fallback');
    await settled(spend);
    expect((await spend.status())?.spentMicros).toBe(15);
  });

  it('commits the estimate for a call the caller aborts after send', async () => {
    const spend = createMemorySpendLedger();
    const controller = new AbortController();
    const provider: DecisionProvider = {
      decide: (_req, signal) => {
        setTimeout(() => controller.abort(), 5);
        return hangsUntilAborted(signal);
      },
    };
    await decide('s', REQUEST, heuristic, {
      provider,
      spend,
      spendCapMicros: 1_000_000,
      budget: null,
      cache: null,
      audit: sink,
      timeoutMs: 5_000,
      signal: controller.signal,
    });
    await settled(spend);
    expect((await spend.status())?.spentMicros).toBe(15);
  });

  it('still releases the reservation for an error response (not billed)', async () => {
    const spend = createMemorySpendLedger();
    const provider: DecisionProvider = {
      decide: async () => {
        throw new DecisionProviderError('unauthorized', 'no', { status: 401 });
      },
    };
    await decide('s', REQUEST, heuristic, {
      provider,
      spend,
      spendCapMicros: 1_000_000,
      budget: null,
      cache: null,
      audit: sink,
    });
    expect(await spend.status()).toMatchObject({ spentMicros: 0, reservedMicros: 0 });
  });

  it('commits the batch estimate when a sent batch is aborted by the deadline', async () => {
    const spend = createMemorySpendLedger();
    const provider: DecisionProvider = {
      decide: async () => {
        throw new Error('unused');
      },
      capabilities: () => LAYAHOST_EXTENSION_CAPABILITIES,
      decideBatch: (_reqs, signal) => hangsUntilAborted(signal),
    };
    await decideBatch(
      's',
      [
        { req: REQUEST, fallback: heuristic },
        { req: { ...REQUEST, state: 'Another task' }, fallback: heuristic },
      ],
      {
        provider,
        spend,
        spendCapMicros: 1_000_000,
        budget: null,
        cache: null,
        audit: sink,
        timeoutMs: 20,
      },
    );
    await settled(spend);
    expect((await spend.status())?.spentMicros).toBe(30);
  });

  it('charges a reservation still pending after the TTL at its estimate', async () => {
    let now = Date.UTC(2026, 8, 10);
    const spend = createMemorySpendLedger({ now: () => now });
    expect((await spend.reserve(1_000_000, 40)).verdict).toBe('ok');
    now += RESERVATION_TTL_MS;
    expect(await spend.status()).toMatchObject({ spentMicros: 40, reservedMicros: 0 });
  });

  it('budget reset refuses a healthy ledger; --force keeps month-to-date spend', async () => {
    const statePath = join(dir, 'spend.json');
    const ledger = createFileSpendLedger({ statePath });
    await ledger.record(500);
    await ledger.markKeyLimited();
    const refused = resetDecideBudget(statePath);
    await expect(refused).rejects.toBeInstanceOf(SpendResetRefusedError);
    await expect(refused).rejects.toThrow(/only repairs a corrupt ledger/);
    expect((await ledger.status())?.spentMicros).toBe(500);
    expect((await ledger.reserve(1_000_000, 15)).verdict).toBe('key_limited');

    const receipt = await resetDecideBudget(statePath, { force: true });
    expect(receipt).toMatchObject({ before: 'ok', forced: true, spentMicros: 500 });
    expect(await ledger.status()).toMatchObject({ spentMicros: 500 });
    // A reset never lifts a reached cap.
    expect((await ledger.reserve(500, 15)).verdict).toBe('over_budget');
  });

  it('routes batch item errors through the gates: key limit stops, rate limit penalizes once', async () => {
    const spend = createMemorySpendLedger();
    const penalize = vi.fn(async () => undefined);
    const budget: DecisionBudget = { tryAcquire: async () => ({ granted: true }), penalize };
    const provider: DecisionProvider = {
      decide: async () => {
        throw new Error('unused');
      },
      capabilities: () => LAYAHOST_EXTENSION_CAPABILITIES,
      decideBatch: async (reqs) =>
        reqs.map((_, i) => ({
          ok: false as const,
          status: i === 0 ? 403 : 429,
          errorKind: i === 0 ? 'key_limit_exceeded' : 'rate_limited',
        })),
    };
    await decideBatch(
      's',
      [
        { req: REQUEST, fallback: heuristic },
        { req: { ...REQUEST, state: 'b' }, fallback: heuristic },
        { req: { ...REQUEST, state: 'c' }, fallback: heuristic },
      ],
      { provider, spend, spendCapMicros: 1_000_000, budget, cache: null, audit: sink },
    );
    expect(penalize).toHaveBeenCalledTimes(1);
    expect((await spend.reserve(1_000_000, 15)).verdict).toBe('key_limited');
  });

  it('keys cached provider state by base URL and a short key hash, never the key', () => {
    const path = join(dir, 'provider-state.json');
    const keyA = 'lh_key_alpha_0123456789';
    writeProviderState(
      {
        baseUrl: connection.baseUrl,
        keyHash: providerKeyHash(keyA),
        detectedAt: 1,
        capabilities: LAYAHOST_EXTENSION_CAPABILITIES,
      },
      path,
    );
    expect(readFileSync(path, 'utf-8')).not.toContain(keyA);
    expect(providerKeyHash(keyA)).toMatch(/^[0-9a-f]{16}$/);
    expect(readProviderState({ baseUrl: connection.baseUrl, apiKey: keyA }, path)).not.toBeNull();
    expect(
      readProviderState({ baseUrl: connection.baseUrl, apiKey: 'lh_key_beta' }, path),
    ).toBeNull();
    expect(
      cachedCapabilities({ baseUrl: connection.baseUrl, apiKey: 'lh_key_beta' }, 0, path),
    ).toBeNull();
    expect(cachedCapabilities({ baseUrl: connection.baseUrl, apiKey: keyA }, 0, path)).toEqual(
      LAYAHOST_EXTENSION_CAPABILITIES,
    );
  });
});
