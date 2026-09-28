/**
 * Jev wire adapter — request/response mapping and HTTP error classification,
 * exercised through an injected `fetch` stub. Nothing here touches the network.
 *
 * @task T12490
 */

import type { DecisionRequest } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  createJevProvider,
  fromJevSystemOneResponse,
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
    [422, 'invalid_request'],
    [500, 'server_error'],
    [503, 'server_error'],
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
