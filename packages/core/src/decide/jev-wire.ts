/**
 * Jev wire adapter — the ONLY module that knows the Jev/"System One" endpoint
 * paths and wire JSON.
 *
 * Maps a provider-neutral {@link DecisionRequest} to a `POST {base}/v1/systemone`
 * body, maps the response back to a {@link DecisionOutcome}, and validates the
 * mapped answers with the contract zod schemas. Any service implementing the
 * Jev wire format (layahost today) is reachable with just a base URL and an
 * API key.
 *
 * Wire notes (from the provider's published OpenAPI document):
 * - Request: `{ model?, state, questions: { name: { type, instructions, criteria } } }`.
 *   `model` is sent only when the request names one; the server applies its
 *   default otherwise. No model identifier is hard-coded here (arch gate 13).
 * - A `noul` question's wire `criteria` is `{ "true": <description> }`; the
 *   contract's single criteria string becomes that description, and it also
 *   serves as the wire `instructions` (the question text) unless the request
 *   supplies its own instructions.
 * - Response answers: noul → `{ noul: <P(yes)>, confidence }`; choice →
 *   `{ choice, probabilities: { option: p }, confidence }`; score →
 *   `{ score: <expected level>, probabilities: { level: p }, confidence }`.
 *   Score probabilities are keyed by level text (or, defensively, by 0-based
 *   index) and re-aligned to the question's `criteria` order.
 * - Errors: 401, 402 (`insufficient_credits`), 422 (FastAPI validation list),
 *   429 (with `retry-after`), 5xx. All are thrown as {@link DecisionProviderError}.
 *
 * - Model: the provider's OpenAPI marks `SystemOneRequest.model` REQUIRED and
 *   documents no server-side default for `/v1/systemone` (the `laya-auto`
 *   default is documented for `/v1/decide` only). The body therefore carries
 *   `req.model ?? connection.model`; a request with neither is sent without a
 *   model and the provider may reject it (422 → heuristic fallback).
 * - `GET /v1/models` → `{ models: [{ name, description?, ... }] }`; used by
 *   {@link listJevModels} for the reachability probe.
 *
 * `/v1/decide` (single question, different body shape) is not used: every
 * single-question call is a one-question `/v1/systemone` call, so one mapping
 * covers every request.
 *
 * @task T12490
 * @epic T12486
 */

import {
  type DecisionAnswer,
  type DecisionOutcome,
  type DecisionQuestion,
  type DecisionRequest,
  decisionAnswerSchema,
} from '@cleocode/contracts';
import { z } from 'zod';
import { MAX_RATE_LIMIT_COOLDOWN_MS } from './budget.js';
import {
  type DecisionProvider,
  type DecisionProviderConnection,
  DecisionProviderError,
} from './provider.js';
import { type DecideFetch, decideFetch } from './transport.js';

/** Path of the multi-question endpoint, relative to the base URL. */
const SYSTEMONE_PATH = '/v1/systemone';

/** Path of the model-listing endpoint, relative to the base URL. */
const MODELS_PATH = '/v1/models';

/** Adapter identity + version; part of every cache key so a mapping change invalidates the cache. */
export const JEV_ADAPTER_VERSION = 'jev-wire/1';

/** One question as the Jev wire expects it. */
interface JevWireQuestion {
  readonly type: DecisionQuestion['type'];
  readonly instructions: DecisionQuestion['instructions'];
  readonly criteria: DecisionQuestion['criteria'] | { readonly true: string };
}

/** The `/v1/systemone` request body. */
export interface JevSystemOneBody {
  /** Model identifier; omitted to use the server default. */
  readonly model?: string;
  /** The state being judged. */
  readonly state: DecisionRequest['state'];
  /** Question name → wire question. */
  readonly questions: Readonly<Record<string, JevWireQuestion>>;
}

/** Loose schema for one wire answer; extra fields (e.g. `legend`) are tolerated. */
const jevAnswerSchema = z.looseObject({
  type: z.string().optional(),
  noul: z.number().optional(),
  choice: z.string().optional(),
  score: z.number().optional(),
  confidence: z.number(),
  probabilities: z.record(z.string(), z.number()).optional(),
});

/** Loose schema for the `/v1/systemone` response envelope. */
const jevResponseSchema = z.looseObject({
  model: z.string().optional(),
  answers: z.record(z.string(), jevAnswerSchema),
  usage: z.looseObject({ input_tokens: z.number().int().nonnegative().optional() }).optional(),
  meta: z
    .looseObject({
      request_id: z.string().optional(),
      latency_ms: z.number().optional(),
      cost_usd: z.number().nonnegative().optional(),
      cached: z.boolean().optional(),
    })
    .optional(),
});

type JevWireAnswer = z.infer<typeof jevAnswerSchema>;

/**
 * Map a contract request to the `/v1/systemone` wire body.
 *
 * @param req - Provider-neutral request.
 * @returns The JSON body to POST.
 */
export function toJevSystemOneBody(req: DecisionRequest): JevSystemOneBody {
  const questions: Record<string, JevWireQuestion> = {};
  for (const [name, q] of Object.entries(req.questions)) {
    if (q.type === 'noul') {
      questions[name] = {
        type: 'noul',
        instructions: q.instructions ?? q.criteria,
        criteria: { true: q.criteria },
      };
    } else {
      questions[name] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
    }
  }
  return {
    ...(req.model !== undefined ? { model: req.model } : {}),
    state: req.state,
    questions,
  };
}

/** Index of the largest value; ties resolve to the lowest index. */
function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) > (values[best] ?? 0)) best = i;
  }
  return best;
}

function invalid(message: string): DecisionProviderError {
  return new DecisionProviderError('invalid_response', message);
}

/** Map one wire answer onto the contract answer for its question. */
function mapAnswer(name: string, question: DecisionQuestion, wire: JevWireAnswer): DecisionAnswer {
  if (question.type === 'noul') {
    if (wire.noul === undefined) throw invalid(`answer "${name}" has no noul probability`);
    return {
      type: 'noul',
      value: wire.noul >= 0.5,
      probability: wire.noul,
      confidence: wire.confidence,
    };
  }
  if (question.type === 'choice') {
    const probabilities = wire.probabilities;
    if (!probabilities) throw invalid(`answer "${name}" has no probabilities`);
    const options = Object.keys(probabilities);
    const value =
      wire.choice !== undefined && wire.choice in probabilities
        ? wire.choice
        : options[argmax(options.map((o) => probabilities[o] ?? 0))];
    if (value === undefined) throw invalid(`answer "${name}" has no choice`);
    return { type: 'choice', value, probabilities, confidence: wire.confidence };
  }
  const probabilities = wire.probabilities;
  if (!probabilities) throw invalid(`answer "${name}" has no probabilities`);
  const levels = question.criteria.map((level, index) => {
    const p = probabilities[level] ?? probabilities[String(index)];
    if (p === undefined) throw invalid(`answer "${name}" is missing level ${index}`);
    return p;
  });
  return {
    type: 'score',
    value: argmax(levels),
    probabilities: levels,
    confidence: wire.confidence,
  };
}

/**
 * Map a `/v1/systemone` response body to a contract outcome.
 *
 * Every question in `req` must be answered with the matching type, and every
 * mapped answer must pass {@link decisionAnswerSchema}; otherwise this throws
 * `DecisionProviderError('invalid_response')`.
 *
 * @param req - The request that was sent (needed to align score levels).
 * @param body - Parsed JSON response body.
 * @param latencyMs - Measured wall-clock latency of the call.
 * @returns The outcome, with `source: 'provider'`.
 */
export function fromJevSystemOneResponse(
  req: DecisionRequest,
  body: unknown,
  latencyMs: number,
): DecisionOutcome {
  const parsed = jevResponseSchema.safeParse(body);
  if (!parsed.success) throw invalid('response body does not match the systemone shape');
  const wire = parsed.data;

  const answers: Record<string, DecisionAnswer> = {};
  for (const [name, question] of Object.entries(req.questions)) {
    const wireAnswer = wire.answers[name];
    if (!wireAnswer) throw invalid(`question "${name}" was not answered`);
    if (wireAnswer.type !== undefined && wireAnswer.type !== question.type) {
      throw invalid(`answer "${name}" has type ${wireAnswer.type}, expected ${question.type}`);
    }
    const checked = decisionAnswerSchema.safeParse(mapAnswer(name, question, wireAnswer));
    if (!checked.success) throw invalid(`answer "${name}" failed contract validation`);
    answers[name] = checked.data;
  }

  const requestId = wire.meta?.request_id;
  const costUsd = wire.meta?.cost_usd;
  const inputTokens = wire.usage?.input_tokens;
  return {
    answers,
    source: 'provider',
    latencyMs,
    ...(requestId ? { requestId } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
  };
}

/**
 * Parse a `retry-after` header (delta seconds or HTTP date) into milliseconds,
 * capped at {@link MAX_RATE_LIMIT_COOLDOWN_MS}.
 *
 * Negative seconds, past dates and anything unparseable are ignored
 * (`undefined`, so the budget applies its default cool-down). A numeric-looking
 * value is never re-read as a date: `Date.parse('-5')` is a valid year.
 *
 * @param header - Raw header value, or null.
 * @param now - Current epoch ms (injectable for tests).
 * @returns Milliseconds to wait (≤ 60 000), or undefined when absent, negative or unparseable.
 */
export function parseRetryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | undefined {
  const value = header?.trim();
  if (!value) return undefined;
  let ms: number;
  if (/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)) {
    ms = Number(value) * 1000;
  } else {
    const date = Date.parse(value);
    if (!Number.isFinite(date)) return undefined;
    ms = date - now;
  }
  if (!Number.isFinite(ms) || ms < 0) return undefined;
  return Math.round(Math.min(ms, MAX_RATE_LIMIT_COOLDOWN_MS));
}

/** Classify a non-2xx HTTP status. */
function errorForStatus(status: number, retryAfterMs: number | undefined): DecisionProviderError {
  const message = `decision provider returned HTTP ${status}`;
  if (status === 401 || status === 403) {
    return new DecisionProviderError('unauthorized', message, { status });
  }
  if (status === 402) return new DecisionProviderError('insufficient_credits', message, { status });
  if (status === 429) {
    return new DecisionProviderError('rate_limited', message, {
      status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    });
  }
  if (status >= 500) return new DecisionProviderError('server_error', message, { status });
  return new DecisionProviderError('invalid_request', message, { status });
}

/** Join a base URL and an absolute endpoint path, tolerating a trailing slash on the base. */
function endpointUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/** Options for {@link createJevProvider}. */
export interface JevProviderOptions {
  /**
   * Transport; defaults to {@link decideFetch}, which releases every DNS,
   * socket and TLS handle on abort (the global `fetch` does not). Tests
   * inject a stub.
   */
  readonly fetch?: DecideFetch;
  /** Monotonic clock in ms; defaults to `performance.now`. */
  readonly now?: () => number;
}

/**
 * Create a {@link DecisionProvider} speaking the Jev wire format.
 *
 * @param connection - Base URL + API key. The key is only ever placed in the
 *   `Authorization` header.
 * @param opts - Injectable `fetch` and clock.
 * @returns A provider whose `decide` throws {@link DecisionProviderError} on any failure.
 *
 * @example
 * ```ts
 * const provider = createJevProvider({ baseUrl: 'https://decide.example', apiKey });
 * const outcome = await provider.decide(request, AbortSignal.timeout(300));
 * ```
 */
export function createJevProvider(
  connection: DecisionProviderConnection,
  opts: JevProviderOptions = {},
): DecisionProvider {
  const doFetch: DecideFetch = opts.fetch ?? decideFetch;
  const now = opts.now ?? (() => performance.now());
  return {
    async decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionOutcome> {
      const started = now();
      let response: Response;
      try {
        response = await doFetch(endpointUrl(connection.baseUrl, SYSTEMONE_PATH), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${connection.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(
            toJevSystemOneBody(
              req.model === undefined && connection.model
                ? { ...req, model: connection.model }
                : req,
            ),
          ),
          signal,
        });
      } catch (err) {
        const cause = err instanceof Error ? err : undefined;
        if (signal.aborted) {
          throw new DecisionProviderError('aborted', 'decision request aborted', { cause });
        }
        throw new DecisionProviderError('network', 'decision request failed before a response', {
          cause,
        });
      }

      if (!response.ok) {
        // Drain the body so the connection can be reused; its content is not needed.
        await response.body?.cancel().catch(() => undefined);
        throw errorForStatus(
          response.status,
          parseRetryAfterMs(response.headers.get('retry-after')),
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch (err) {
        if (signal.aborted) {
          throw new DecisionProviderError('aborted', 'decision request aborted', {
            cause: err instanceof Error ? err : undefined,
          });
        }
        throw invalid('response body is not JSON');
      }
      return fromJevSystemOneResponse(req, body, Math.max(0, now() - started));
    },
  };
}

/**
 * Allowed shape of a model name: word characters plus `. : / @ -`, 1-128
 * characters. Anything else (ANSI escapes, control characters, spaces) is
 * never stored, sent or printed.
 */
export const DECISION_MODEL_NAME_PATTERN = /^[\w.:/@-]{1,128}$/;

/** Byte cap on a `GET /v1/models` response body. */
export const MAX_MODELS_RESPONSE_BYTES = 256 * 1024;

/** Cap on the number of model names kept from a listing. */
export const MAX_MODELS_LISTED = 500;

/**
 * Whether `name` is a safe model identifier (see {@link DECISION_MODEL_NAME_PATTERN}).
 *
 * @param name - Candidate model name.
 * @returns True when it may be stored, sent and printed.
 */
export function isValidDecisionModelName(name: string): boolean {
  return DECISION_MODEL_NAME_PATTERN.test(name);
}

/** Loose schema for the `GET /v1/models` response; names are filtered after parsing. */
const jevModelsSchema = z.looseObject({
  models: z.array(z.looseObject({ name: z.unknown() })),
});

/**
 * Read a response body as text, failing once it exceeds `maxBytes`.
 *
 * @throws {DecisionProviderError} `invalid_response` when the body is too large.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw invalid('model listing exceeds the size limit');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw invalid('model listing exceeds the size limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * List the models the key may use (`GET {base}/v1/models`).
 *
 * The body is capped at {@link MAX_MODELS_RESPONSE_BYTES}; names failing
 * {@link DECISION_MODEL_NAME_PATTERN} are skipped and at most
 * {@link MAX_MODELS_LISTED} names are returned.
 *
 * @param connection - Base URL + API key (only ever placed in the `Authorization` header).
 * @param signal - Aborts the request.
 * @param opts - Injectable `fetch`.
 * @returns Safe model names in the order the provider lists them.
 * @throws {DecisionProviderError} On any HTTP, network, abort, size or shape failure.
 */
export async function listJevModels(
  connection: Pick<DecisionProviderConnection, 'baseUrl' | 'apiKey'>,
  signal: AbortSignal,
  opts: Pick<JevProviderOptions, 'fetch'> = {},
): Promise<string[]> {
  const doFetch: DecideFetch = opts.fetch ?? decideFetch;
  let response: Response;
  try {
    response = await doFetch(endpointUrl(connection.baseUrl, MODELS_PATH), {
      method: 'GET',
      headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
      signal,
    });
  } catch (err) {
    const cause = err instanceof Error ? err : undefined;
    const kind = signal.aborted ? 'aborted' : 'network';
    throw new DecisionProviderError(kind, `model listing failed (${kind})`, { cause });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw errorForStatus(response.status, parseRetryAfterMs(response.headers.get('retry-after')));
  }
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedText(response, MAX_MODELS_RESPONSE_BYTES));
  } catch (err) {
    if (err instanceof DecisionProviderError) throw err;
    if (signal.aborted) throw new DecisionProviderError('aborted', 'model listing aborted');
    throw invalid('model listing is not JSON');
  }
  const parsed = jevModelsSchema.safeParse(body);
  if (!parsed.success) throw invalid('model listing does not match the models shape');
  const names: string[] = [];
  for (const m of parsed.data.models) {
    if (typeof m.name === 'string' && isValidDecisionModelName(m.name)) names.push(m.name);
    if (names.length >= MAX_MODELS_LISTED) break;
  }
  return names;
}
