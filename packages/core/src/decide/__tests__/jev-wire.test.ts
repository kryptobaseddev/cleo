/**
 * Jev wire adapter — request/response mapping and HTTP error classification,
 * exercised through an injected `fetch` stub. Nothing here touches the network.
 *
 * @task T12490
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type DecisionRequest, JEV_MINIMUM_CAPABILITIES } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createJevProvider,
  deriveJevConfidence,
  fromJevSystemOneResponse,
  JEV_ADAPTER_VERSION,
  parseRetryAfterMs,
  toJevSystemOneBody,
} from '../jev-wire.js';
import { DecisionProviderError } from '../provider.js';

const REQUEST: DecisionRequest = {
  state: 'The build failed on a flaky network test.',
  questions: {
    retry: { type: 'noul', criteria: 'Retrying is likely to succeed' },
    area: { type: 'choice', criteria: { infra: 'CI or network', code: 'A code defect' } },
    severity: { type: 'score', criteria: ['trivial', 'minor', 'major'] },
  },
};

const OK_BODY = {
  model: 'server-default',
  answers: {
    retry: { type: 'noul', noul: 0.8, confidence: 0.9 },
    area: {
      type: 'choice',
      choice: 'infra',
      probabilities: { infra: 0.7, code: 0.3 },
      confidence: 0.6,
    },
    severity: {
      type: 'score',
      score: 0.4,
      probabilities: { trivial: 0.6, minor: 0.3, major: 0.1 },
      confidence: 0.5,
    },
  },
  usage: { input_tokens: 42, output_tokens: 3 },
  meta: { request_id: 'req_1', latency_ms: 12, cost_usd: 0.000015, cached: false },
};

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

function stubFetch(response: Response | Error): ReturnType<typeof vi.fn<typeof fetch>> {
  return vi.fn<typeof fetch>(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
}

async function expectKind(
  promise: Promise<unknown>,
  kind: DecisionProviderError['kind'],
): Promise<DecisionProviderError> {
  const err = await promise.then(
    () => null,
    (e: Error) => e,
  );
  expect(err).toBeInstanceOf(DecisionProviderError);
  const typed = err as DecisionProviderError;
  expect(typed.kind).toBe(kind);
  return typed;
}

describe('toJevSystemOneBody', () => {
  it('maps each question type and omits model when unset', () => {
    const body = toJevSystemOneBody(REQUEST);
    expect(body).not.toHaveProperty('model');
    expect(body.state).toBe(REQUEST.state);
    expect(body.questions.retry).toEqual({
      type: 'noul',
      instructions: 'Retrying is likely to succeed',
      criteria: { true: 'Retrying is likely to succeed' },
    });
    expect(body.questions.area).toEqual({
      type: 'choice',
      instructions: undefined,
      criteria: { infra: 'CI or network', code: 'A code defect' },
    });
    expect(body.questions.severity?.criteria).toEqual(['trivial', 'minor', 'major']);
  });

  it('passes an explicit model and noul instructions through', () => {
    const body = toJevSystemOneBody({
      model: 'custom',
      state: { a: 1 },
      questions: { q: { type: 'noul', instructions: 'Is it on fire?', criteria: 'It is on fire' } },
    });
    expect(body.model).toBe('custom');
    expect(body.questions.q?.instructions).toBe('Is it on fire?');
  });
});

describe('fromJevSystemOneResponse', () => {
  it('maps noul, choice and score answers plus meta', () => {
    const outcome = fromJevSystemOneResponse(REQUEST, OK_BODY, 7);
    expect(outcome.source).toBe('provider');
    expect(outcome.latencyMs).toBe(7);
    expect(outcome.requestId).toBe('req_1');
    expect(outcome.costUsd).toBe(0.000015);
    expect(outcome.inputTokens).toBe(42);
    expect(outcome.answers.retry).toEqual({
      type: 'noul',
      value: true,
      probability: 0.8,
      confidence: 0.9,
    });
    expect(outcome.answers.area).toEqual({
      type: 'choice',
      value: 'infra',
      probabilities: { infra: 0.7, code: 0.3 },
      confidence: 0.6,
    });
    expect(outcome.answers.severity).toEqual({
      type: 'score',
      value: 0,
      probabilities: [0.6, 0.3, 0.1],
      confidence: 0.5,
    });
  });

  it('aligns score probabilities keyed by index', () => {
    const body = {
      answers: {
        ...OK_BODY.answers,
        severity: { score: 1.8, probabilities: { '0': 0.1, '1': 0.2, '2': 0.7 }, confidence: 0.9 },
      },
    };
    const outcome = fromJevSystemOneResponse(REQUEST, body, 1);
    expect(outcome.answers.severity).toMatchObject({ value: 2, probabilities: [0.1, 0.2, 0.7] });
    expect(outcome.requestId).toBeUndefined();
  });

  it('rejects a missing answer, a type mismatch and an out-of-range probability', () => {
    const { retry: _omit, ...rest } = OK_BODY.answers;
    expect(() => fromJevSystemOneResponse(REQUEST, { answers: rest }, 1)).toThrow(
      DecisionProviderError,
    );
    expect(() =>
      fromJevSystemOneResponse(
        REQUEST,
        { answers: { ...OK_BODY.answers, retry: { type: 'choice', noul: 0.5, confidence: 1 } } },
        1,
      ),
    ).toThrow(/expected noul/);
    expect(() =>
      fromJevSystemOneResponse(
        REQUEST,
        { answers: { ...OK_BODY.answers, retry: { noul: 1.5, confidence: 1 } } },
        1,
      ),
    ).toThrow(/contract validation/);
    expect(() => fromJevSystemOneResponse(REQUEST, { nope: true }, 1)).toThrow(/systemone shape/);
  });
});

/**
 * Golden body: the exact `/v1/systemone` answer of a live plain Jev host
 * (model `jev-latest` → `jev-1.13.0`, 2026-09-29). No `confidence`, no `meta`.
 */
const JEV_NO_CONFIDENCE_BODY: unknown = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jev-systemone-no-confidence.json'),
    'utf-8',
  ),
);

const NOUL_Q: DecisionRequest = {
  state: 'x',
  questions: { q: { type: 'noul', criteria: 'It holds' } },
};

describe('answers without confidence (plain Jev hosts)', () => {
  it('bumps the adapter version so cached jev-wire/3 outcomes are not reused', () => {
    expect(JEV_ADAPTER_VERSION).toBe('jev-wire/4');
  });

  it('parses the golden plain-Jev body: value true, probability 0.99, derived confidence', () => {
    const outcome = fromJevSystemOneResponse(NOUL_Q, JEV_NO_CONFIDENCE_BODY, 5);
    expect(outcome.source).toBe('provider');
    expect(outcome.inputTokens).toBe(306);
    expect(outcome.answers.q).toMatchObject({ type: 'noul', value: true, probability: 0.99 });
    // |2p − 1| = 0.98
    expect(outcome.answers.q?.confidence).toBeCloseTo(0.98, 10);
    // No meta → no cost is invented.
    expect(outcome).not.toHaveProperty('costUsd');
    expect(outcome).not.toHaveProperty('costMicros');
  });

  it('derives noul confidence as the distance from a coin flip', () => {
    const at = (p: number) =>
      fromJevSystemOneResponse(NOUL_Q, { answers: { q: { type: 'noul', noul: p } } }, 1).answers.q;
    expect(at(0.5)).toMatchObject({ value: true, confidence: 0 });
    expect(at(0)).toMatchObject({ value: false, confidence: 1 });
    expect(at(0.2)?.confidence).toBeCloseTo(0.6, 10);
  });

  it('derives choice and score confidence as the chosen outcome margin over the others', () => {
    const outcome = fromJevSystemOneResponse(
      REQUEST,
      {
        answers: {
          retry: { type: 'noul', noul: 0.8 },
          area: { type: 'choice', choice: 'code', probabilities: { infra: 0.35, code: 0.65 } },
          severity: { type: 'score', probabilities: { trivial: 0.1, minor: 0.5, major: 0.4 } },
        },
      },
      1,
    );
    expect(outcome.answers.retry?.confidence).toBeCloseTo(0.6, 10);
    expect(outcome.answers.area).toMatchObject({ type: 'choice', value: 'code' });
    expect(outcome.answers.area?.confidence).toBeCloseTo(0.3, 10);
    expect(outcome.answers.severity).toMatchObject({ type: 'score', value: 1 });
    expect(outcome.answers.severity?.confidence).toBeCloseTo(0.1, 10);
  });

  it('derives choice confidence from the NAMED choice even when it is not the argmax', () => {
    const outcome = fromJevSystemOneResponse(
      REQUEST,
      {
        answers: {
          retry: { type: 'noul', noul: 0.3 },
          area: { type: 'choice', choice: 'infra', probabilities: { infra: 0.45, code: 0.55 } },
          severity: { type: 'score', probabilities: { trivial: 0.2, minor: 0.2, major: 0.6 } },
        },
      },
      1,
    );
    // Noul answered "no" at p = 0.3: |2p − 1| = 0.4.
    expect(outcome.answers.retry).toMatchObject({ value: false });
    expect(outcome.answers.retry?.confidence).toBeCloseTo(0.4, 10);
    // The host named infra (0.45) over code (0.55): margin −0.1 clamps to 0.
    expect(outcome.answers.area).toMatchObject({ type: 'choice', value: 'infra', confidence: 0 });
    // Score picks the argmax level (major 0.6) over the best other (0.2).
    expect(outcome.answers.severity).toMatchObject({ type: 'score', value: 2 });
    expect(outcome.answers.severity?.confidence).toBeCloseTo(0.4, 10);
  });

  it('prefers a reported confidence over the derivation', () => {
    const outcome = fromJevSystemOneResponse(
      NOUL_Q,
      { answers: { q: { type: 'noul', noul: 0.99, confidence: 0.4 } } },
      1,
    );
    expect(outcome.answers.q?.confidence).toBe(0.4);
  });

  it('still rejects a noul answer with no noul probability', () => {
    expect(() => fromJevSystemOneResponse(NOUL_Q, { answers: { q: { type: 'noul' } } }, 1)).toThrow(
      /no noul probability/,
    );
  });

  it('keeps the derived confidence inside [0, 1]', () => {
    expect(deriveJevConfidence([], 0)).toBe(0);
    expect(deriveJevConfidence([0.5, 0.5], 5)).toBe(0);
    expect(deriveJevConfidence([1], 0)).toBe(1);
    expect(deriveJevConfidence([0.4, 0.4, 0.2], 0)).toBe(0);
    expect(deriveJevConfidence([0.2, 0.7, 0.1], 0)).toBe(0);
    expect(deriveJevConfidence([0.2, 0.7, 0.1], 1)).toBeCloseTo(0.5, 10);
    expect(deriveJevConfidence([Number.NaN, 0.5], 0)).toBe(0);
    expect(deriveJevConfidence([2, 0], 0)).toBe(1);
  });

  it('answers through createJevProvider (single) and a batch item without confidence', async () => {
    const connection = { baseUrl: 'https://decide.test/', apiKey: 'k' };
    const single = createJevProvider(connection, {
      fetch: stubFetch(jsonResponse(200, JEV_NO_CONFIDENCE_BODY)),
    });
    const outcome = await single.decide(NOUL_Q, new AbortController().signal);
    expect(outcome.answers.q).toMatchObject({ value: true, probability: 0.99 });

    const batch = createJevProvider(connection, {
      fetch: stubFetch(
        jsonResponse(200, { responses: [{ index: 0, status: 200, body: JEV_NO_CONFIDENCE_BODY }] }),
      ),
      capabilities: { ...JEV_MINIMUM_CAPABILITIES, batch: { maxRequests: 4, maxQuestions: 4 } },
    });
    const items = (await batch.decideBatch?.([NOUL_Q], new AbortController().signal)) ?? [];
    expect(items[0]).toMatchObject({ ok: true, outcome: { answers: { q: { value: true } } } });
  });
});

/** Read a JSON fixture from `./fixtures`. */
function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf-8'),
  );
}

describe('plain Jev choice and score answers carry a host confidence', () => {
  // A live plain Jev host (jev-1.13.0, 2026-09-29) reports `confidence` and
  // `probabilities` for choice and score, and omits `confidence` only for
  // noul. The host-reported value is used as is, never re-derived.
  it('uses the reported choice confidence (0.62), not the derived margin', () => {
    const req: DecisionRequest = {
      state: 'x',
      questions: {
        kind: {
          type: 'choice',
          criteria: { bugfix: 'Fixes a defect', feature: 'Adds behaviour', chore: 'Upkeep' },
        },
      },
    };
    const outcome = fromJevSystemOneResponse(
      req,
      fixture('jev-systemone-choice-confidence.json'),
      1,
    );
    expect(outcome.answers.kind).toMatchObject({
      type: 'choice',
      value: 'bugfix',
      confidence: 0.62,
    });
  });

  it('uses the reported score confidence (0.72) and tolerates the legend', () => {
    const req: DecisionRequest = {
      state: 'x',
      questions: { risk: { type: 'score', criteria: ['none', 'low', 'medium', 'high'] } },
    };
    const outcome = fromJevSystemOneResponse(
      req,
      fixture('jev-systemone-score-confidence.json'),
      1,
    );
    expect(outcome.answers.risk).toMatchObject({
      type: 'score',
      value: 2,
      confidence: 0.72,
      probabilities: [0.01, 0.12, 0.65, 0.22],
    });
  });
});

describe('parseRetryAfterMs', () => {
  it('parses delta seconds and HTTP dates', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
    expect(parseRetryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs('soon')).toBeUndefined();
  });

  it('caps a huge value at 60 s and ignores negative or past values', () => {
    expect(parseRetryAfterMs('999999999')).toBe(60_000);
    expect(parseRetryAfterMs('1e12')).toBe(60_000);
    expect(parseRetryAfterMs(new Date(10_000_000_000_000).toUTCString(), 0)).toBe(60_000);
    expect(parseRetryAfterMs('-5')).toBeUndefined();
    expect(parseRetryAfterMs('-1')).toBeUndefined();
    expect(parseRetryAfterMs('Infinity')).toBeUndefined();
    expect(parseRetryAfterMs(new Date(1_000).toUTCString(), 5_000)).toBeUndefined();
  });
});

describe('createJevProvider', () => {
  const connection = { baseUrl: 'https://decide.test/', apiKey: 'lh_secret' };

  it('POSTs the mapped body with a bearer key to {base}/v1/systemone', async () => {
    const fetchStub = stubFetch(jsonResponse(200, OK_BODY));
    const provider = createJevProvider(connection, { fetch: fetchStub });
    const outcome = await provider.decide(REQUEST, new AbortController().signal);
    expect(outcome.answers.retry?.value).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] ?? [];
    expect(url).toBe('https://decide.test/v1/systemone');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer lh_secret');
    expect(JSON.parse(String(init?.body))).toEqual(
      JSON.parse(JSON.stringify(toJevSystemOneBody(REQUEST))),
    );
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'insufficient_credits'],
    // A 403 that is not a key limit stays a credential failure (T12664).
    [403, 'unauthorized'],
    [422, 'invalid_request'],
    [500, 'server_error'],
    [502, 'server_error'],
    // T12664: 503 and 529 are the provider overloaded/unavailable — a short
    // circuit-breaker trip, not a generic server error.
    [503, 'overloaded'],
    [529, 'overloaded'],
  ] as const)('classifies HTTP %i as %s', async (status, kind) => {
    const provider = createJevProvider(connection, {
      fetch: stubFetch(jsonResponse(status, { detail: { error_type: 'x', message: 'y' } })),
    });
    const err = await expectKind(provider.decide(REQUEST, new AbortController().signal), kind);
    expect(err.status).toBe(status);
    expect(err.message).not.toContain('lh_secret');
  });

  it('classifies 429 with its retry-after', async () => {
    const provider = createJevProvider(connection, {
      fetch: stubFetch(jsonResponse(429, { detail: {} }, { 'retry-after': '3' })),
    });
    const err = await expectKind(
      provider.decide(REQUEST, new AbortController().signal),
      'rate_limited',
    );
    expect(err.retryAfterMs).toBe(3000);
  });

  it('classifies a network failure and an abort', async () => {
    const network = createJevProvider(connection, {
      fetch: stubFetch(new TypeError('fetch failed')),
    });
    await expectKind(network.decide(REQUEST, new AbortController().signal), 'network');

    const controller = new AbortController();
    controller.abort();
    const aborted = createJevProvider(connection, {
      fetch: stubFetch(new DOMException('aborted', 'AbortError')),
    });
    await expectKind(aborted.decide(REQUEST, controller.signal), 'aborted');
  });

  it('classifies a non-JSON 200 body as invalid_response', async () => {
    const provider = createJevProvider(connection, {
      fetch: stubFetch(new Response('<html>', { status: 200 })),
    });
    await expectKind(provider.decide(REQUEST, new AbortController().signal), 'invalid_response');
  });
});
