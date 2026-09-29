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
 * - Errors: 401, 402 (`insufficient_credits`), 403 (`key_limit_exceeded` —
 *   the key's monthly decision limit, NOT a credential failure; any other 403
 *   is `unauthorized`), 422 (FastAPI validation list), 429 (with
 *   `retry-after`), 503/529 (`overloaded`, with `retry-after`), other 5xx.
 *   All are thrown as {@link DecisionProviderError}. The error body
 *   (`{detail:{error_type}}`) is read, size-capped, to tell a key limit from a
 *   bad key.
 * - Cost (T12664, `jev-wire/2`): `meta.cost_micros` or the
 *   `x-layahost-cost-micros` header (integer micro-dollars), the
 *   `x-layahost-balance-micros` header, and `meta.checkpoint` are read when
 *   present; `meta.cost_usd` is still read. A plain Jev host sends none of
 *   them and keeps working.
 * - Extensions, gated by {@link JevProviderOptions.capabilities} (detected by
 *   {@link detectJevCapabilities} from `/v1/usage` and `/v1/templates`
 *   responses, never from the host name): the `lang` and `cache` request
 *   fields, `POST /v1/systemone/batch` and `GET /v1/usage`.
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
  type DecisionBatchItem,
  type DecisionOutcome,
  type DecisionProviderCapabilities,
  type DecisionProviderUsage,
  type DecisionQuestion,
  type DecisionRequest,
  decisionAnswerSchema,
  JEV_MINIMUM_CAPABILITIES,
} from '@cleocode/contracts';
import { z } from 'zod';
import { MAX_RATE_LIMIT_COOLDOWN_MS } from './budget.js';
import {
  type DecisionProvider,
  type DecisionProviderConnection,
  DecisionProviderError,
  type DecisionProviderErrorKind,
} from './provider.js';
import { type DecideFetch, decideFetch } from './transport.js';

/** Path of the multi-question endpoint, relative to the base URL. */
const SYSTEMONE_PATH = '/v1/systemone';

/** Path of the model-listing endpoint, relative to the base URL. */
const MODELS_PATH = '/v1/models';

/** Path of the batch endpoint (layahost extension). */
const BATCH_PATH = '/v1/systemone/batch';

/** Path of the usage endpoint (layahost extension). */
const USAGE_PATH = '/v1/usage';

/** Path of the template listing (layahost extension). */
const TEMPLATES_PATH = '/v1/templates';

/** Header carrying the call's cost in integer micro-dollars. */
export const COST_MICROS_HEADER = 'x-layahost-cost-micros';

/** Header carrying the account balance in integer micro-dollars. */
export const BALANCE_MICROS_HEADER = 'x-layahost-balance-micros';

/** Byte cap on an error body read to classify a failure. */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/** Byte cap on a usage or template listing body. */
const MAX_EXTENSION_BODY_BYTES = 64 * 1024;

/**
 * Capabilities of a provider that answers `GET /v1/usage` (layahost): batch
 * of 64 requests / 256 questions, usage, cache control, lang hint, cost in
 * micros. Templates are added only when `/v1/templates` lists them.
 */
export const LAYAHOST_EXTENSION_CAPABILITIES: DecisionProviderCapabilities = {
  ...JEV_MINIMUM_CAPABILITIES,
  batch: { maxRequests: 64, maxQuestions: 256 },
  usage: true,
  cacheControl: true,
  langHint: true,
  reportsCost: 'micros',
};

/**
 * Adapter identity + version; part of every cache key so a mapping change
 * invalidates the cache. `/2`: cost micros, balance and checkpoint are read.
 */
export const JEV_ADAPTER_VERSION = 'jev-wire/2';

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
  /** Language hint (only with the `langHint` capability). */
  readonly lang?: string;
  /** Provider answer cache (only with the `cacheControl` capability). */
  readonly cache?: boolean;
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
      cost_micros: z.number().int().nonnegative().optional(),
      checkpoint: z.string().min(1).optional(),
      cached: z.boolean().optional(),
    })
    .optional(),
});

type JevWireAnswer = z.infer<typeof jevAnswerSchema>;

/**
 * Map a contract request to the `/v1/systemone` wire body.
 *
 * `lang` and `cache` are sent only when `capabilities` says the provider
 * honours them; the default (Jev minimum) sends neither, so a plain Jev host
 * sees exactly the Jev body.
 *
 * @param req - Provider-neutral request.
 * @param capabilities - The provider's capabilities. Default: the Jev minimum.
 * @returns The JSON body to POST.
 */
export function toJevSystemOneBody(
  req: DecisionRequest,
  capabilities: DecisionProviderCapabilities = JEV_MINIMUM_CAPABILITIES,
): JevSystemOneBody {
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
    ...(capabilities.langHint === true && req.lang !== undefined ? { lang: req.lang } : {}),
    ...(capabilities.cacheControl === true && req.cache !== undefined ? { cache: req.cache } : {}),
  };
}

/** Integer micro-dollars from a header value, or undefined when absent or malformed. */
function microsHeader(value: string | null | undefined): number | undefined {
  if (value === null || value === undefined || !/^-?\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

/** Cost and balance headers of one response. */
export interface JevResponseHeaders {
  /** `x-layahost-cost-micros`. */
  readonly costMicros?: string | null;
  /** `x-layahost-balance-micros`. */
  readonly balanceMicros?: string | null;
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
  headers: JevResponseHeaders = {},
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
  const costMicros = wire.meta?.cost_micros ?? nonNegative(microsHeader(headers.costMicros));
  const costUsd = wire.meta?.cost_usd ?? (costMicros !== undefined ? costMicros / 1e6 : undefined);
  const balanceMicros = microsHeader(headers.balanceMicros);
  const checkpoint = wire.meta?.checkpoint;
  const inputTokens = wire.usage?.input_tokens;
  return {
    answers,
    source: 'provider',
    latencyMs,
    ...(requestId ? { requestId } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(costMicros !== undefined ? { costMicros } : {}),
    ...(balanceMicros !== undefined ? { balanceMicros } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
  };
}

function nonNegative(n: number | undefined): number | undefined {
  return n !== undefined && n >= 0 ? n : undefined;
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

/** The provider's `error_type` from an error body (`{detail:{error_type}}` or `{error:{type}}`). */
export function errorTypeOf(body: unknown): string | undefined {
  const field = (o: unknown, key: string): unknown =>
    o !== null && typeof o === 'object' && key in o ? Reflect.get(o, key) : undefined;
  const pick = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return (
    pick(field(field(body, 'detail'), 'error_type')) ??
    pick(field(field(body, 'error'), 'type')) ??
    pick(field(body, 'error_type'))
  );
}

/**
 * Classify a non-2xx response.
 *
 * @param status - HTTP status.
 * @param retryAfterMs - Parsed `retry-after`, when present.
 * @param errorType - The body's `error_type`, when readable.
 * @returns The provider error.
 */
export function errorForStatus(
  status: number,
  retryAfterMs: number | undefined,
  errorType?: string,
): DecisionProviderError {
  const message = `decision provider returned HTTP ${status}${errorType ? ` (${errorType})` : ''}`;
  const withRetry = { status, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  if (status === 403 && errorType === 'key_limit_exceeded') {
    return new DecisionProviderError(
      'key_limit_exceeded',
      "the key's monthly decision limit is reached",
      { status },
    );
  }
  if (status === 401 || status === 403) {
    return new DecisionProviderError('unauthorized', message, { status });
  }
  if (status === 402) return new DecisionProviderError('insufficient_credits', message, { status });
  if (status === 429) return new DecisionProviderError('rate_limited', message, withRetry);
  if (status === 503 || status === 529) {
    return new DecisionProviderError('overloaded', message, withRetry);
  }
  if (status >= 500) return new DecisionProviderError('server_error', message, { status });
  return new DecisionProviderError('invalid_request', message, { status });
}

/** Read a failed response's body (size-capped) and classify it. Never throws a non-provider error. */
async function errorForResponse(response: Response): Promise<DecisionProviderError> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
  let errorType: string | undefined;
  try {
    errorType = errorTypeOf(JSON.parse(await readBoundedText(response, MAX_ERROR_BODY_BYTES)));
  } catch {
    await response.body?.cancel().catch(() => undefined);
  }
  return errorForStatus(response.status, retryAfterMs, errorType);
}

/** Map a provider `error_type` string (batch items) to an error kind. */
function kindForErrorType(
  status: number | undefined,
  errorType: string | undefined,
): DecisionProviderErrorKind {
  if (status !== undefined) return errorForStatus(status, undefined, errorType).kind;
  if (errorType === 'insufficient_credits') return 'insufficient_credits';
  if (errorType === 'key_limit_exceeded') return 'key_limit_exceeded';
  if (errorType === 'rate_limit_error') return 'rate_limited';
  if (errorType === 'overloaded_error') return 'overloaded';
  return 'invalid_response';
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
  /**
   * Detected capabilities (see {@link detectJevCapabilities}). Default: the
   * Jev minimum — no extension is used until detection says it exists.
   */
  readonly capabilities?: DecisionProviderCapabilities;
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
  const capabilities = opts.capabilities ?? JEV_MINIMUM_CAPABILITIES;
  const withModel = (req: DecisionRequest): DecisionRequest =>
    req.model === undefined && connection.model ? { ...req, model: connection.model } : req;

  /** POST/GET with auth; network failures become provider errors. */
  async function send(
    path: string,
    init: { readonly method: 'GET' | 'POST'; readonly body?: string },
    signal: AbortSignal,
  ): Promise<Response> {
    try {
      return await doFetch(endpointUrl(connection.baseUrl, path), {
        method: init.method,
        headers: {
          authorization: `Bearer ${connection.apiKey}`,
          accept: 'application/json',
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
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
  }

  /** Parse a 2xx JSON body; a non-JSON body is `invalid_response` (or `aborted`). */
  async function jsonBody(response: Response, signal: AbortSignal): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      if (signal.aborted) {
        throw new DecisionProviderError('aborted', 'decision request aborted', {
          cause: err instanceof Error ? err : undefined,
        });
      }
      throw invalid('response body is not JSON');
    }
  }

  const provider: DecisionProvider = {
    capabilities: () => capabilities,

    async decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionOutcome> {
      const started = now();
      const response = await send(
        SYSTEMONE_PATH,
        { method: 'POST', body: JSON.stringify(toJevSystemOneBody(withModel(req), capabilities)) },
        signal,
      );
      if (!response.ok) throw await errorForResponse(response);
      const body = await jsonBody(response, signal);
      return fromJevSystemOneResponse(req, body, Math.max(0, now() - started), {
        costMicros: response.headers.get(COST_MICROS_HEADER),
        balanceMicros: response.headers.get(BALANCE_MICROS_HEADER),
      });
    },
  };

  if (capabilities.batch) {
    const limits = capabilities.batch;
    provider.decideBatch = async (reqs, signal): Promise<readonly DecisionBatchItem[]> => {
      const questions = reqs.reduce((n, r) => n + Object.keys(r.questions).length, 0);
      if (reqs.length === 0) return [];
      if (reqs.length > limits.maxRequests || questions > limits.maxQuestions) {
        throw new DecisionProviderError(
          'invalid_request',
          `batch of ${reqs.length} requests / ${questions} questions exceeds ${limits.maxRequests} / ${limits.maxQuestions}`,
        );
      }
      const started = now();
      const response = await send(
        BATCH_PATH,
        {
          method: 'POST',
          body: JSON.stringify({
            requests: reqs.map((r) => toJevSystemOneBody(withModel(r), capabilities)),
          }),
        },
        signal,
      );
      if (!response.ok) throw await errorForResponse(response);
      const parsed = jevBatchSchema.safeParse(await jsonBody(response, signal));
      if (!parsed.success) throw invalid('batch response does not match the batch shape');
      const items = parsed.data.results ?? parsed.data.responses ?? [];
      if (items.length !== reqs.length) {
        throw invalid(`batch answered ${items.length} of ${reqs.length} requests`);
      }
      const latencyMs = Math.max(0, now() - started);
      return items.map((item, i): DecisionBatchItem => {
        const req = reqs[i];
        if (req === undefined) return { ok: false, errorKind: 'invalid_response' };
        const status = typeof item.status === 'number' ? item.status : undefined;
        if ((status !== undefined && status >= 400) || item.answers === undefined) {
          return {
            ok: false,
            ...(status !== undefined ? { status } : {}),
            errorKind: kindForErrorType(status, errorTypeOf(item)),
          };
        }
        try {
          return { ok: true, outcome: fromJevSystemOneResponse(req, item, latencyMs) };
        } catch (err) {
          return {
            ok: false,
            errorKind: err instanceof DecisionProviderError ? err.kind : 'invalid_response',
          };
        }
      });
    };
  }

  if (capabilities.usage) {
    provider.usage = async (signal): Promise<DecisionProviderUsage> => {
      const response = await send(`${USAGE_PATH}?days=30`, { method: 'GET' }, signal);
      if (!response.ok) throw await errorForResponse(response);
      let body: unknown;
      try {
        body = JSON.parse(await readBoundedText(response, MAX_EXTENSION_BODY_BYTES));
      } catch (err) {
        if (err instanceof DecisionProviderError) throw err;
        throw invalid('usage response is not JSON');
      }
      return parseJevUsage(body);
    };
  }

  return provider;
}

/** Loose schema for one batch result item: a systemone response plus a status. */
const jevBatchItemSchema = z.looseObject({
  status: z.number().int().optional(),
  answers: z.record(z.string(), z.unknown()).optional(),
});

/** Loose schema for the `/v1/systemone/batch` response. */
const jevBatchSchema = z.looseObject({
  results: z.array(jevBatchItemSchema).optional(),
  responses: z.array(jevBatchItemSchema).optional(),
});

/** Loose schema for `GET /v1/usage`. */
const jevUsageSchema = z.looseObject({
  balance: z
    .looseObject({
      micros: z.number().int().optional(),
      decisions_left: z.number().int().nonnegative().optional(),
    })
    .optional(),
  plan: z
    .union([
      z.string(),
      z.looseObject({ name: z.string().optional(), period_end: z.string().optional() }),
    ])
    .optional(),
  totals: z
    .looseObject({
      decisions: z.number().int().nonnegative().optional(),
      cost_micros: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

/**
 * Map a `GET /v1/usage` body onto {@link DecisionProviderUsage}. Unknown or
 * malformed fields are dropped, never guessed.
 *
 * @param body - Parsed JSON.
 * @returns The usage fields the body carried.
 */
export function parseJevUsage(body: unknown): DecisionProviderUsage {
  const parsed = jevUsageSchema.safeParse(body);
  if (!parsed.success) throw invalid('usage response does not match the usage shape');
  const u = parsed.data;
  const plan = typeof u.plan === 'string' ? u.plan : u.plan?.name;
  const periodEnd = typeof u.plan === 'object' ? u.plan?.period_end : undefined;
  const totals = u.totals
    ? {
        ...(u.totals.decisions !== undefined ? { decisions: u.totals.decisions } : {}),
        ...(u.totals.cost_micros !== undefined ? { costMicros: u.totals.cost_micros } : {}),
      }
    : undefined;
  return {
    ...(u.balance?.micros !== undefined ? { balanceMicros: u.balance.micros } : {}),
    ...(u.balance?.decisions_left !== undefined ? { decisionsLeft: u.balance.decisions_left } : {}),
    ...(plan ? { plan } : {}),
    ...(periodEnd ? { periodEnd } : {}),
    ...(totals && Object.keys(totals).length > 0 ? { totals } : {}),
  };
}

/** Loose schema for `GET /v1/templates`: a list of names or of `{name}` objects. */
const jevTemplatesSchema = z.union([
  z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
  z.looseObject({
    templates: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
  }),
]);

/**
 * Detect what a Jev-compatible host supports beyond the Jev minimum, from its
 * responses only (spec §2.2: never from the host name).
 *
 * - `GET /v1/usage` answers 2xx with at least one usage field → the layahost extensions
 *   ({@link LAYAHOST_EXTENSION_CAPABILITIES}).
 * - `GET /v1/templates` answers 2xx with names → `templates`.
 * - Anything else (404, error, timeout) → the Jev minimum. Never throws.
 *
 * Both endpoints count toward the provider's rate limit, so callers cache the
 * result (`cleo decide status` refreshes it at most every 10 minutes).
 *
 * @param connection - Base URL + API key.
 * @param signal - Aborts both probes.
 * @param opts - Injectable `fetch`.
 * @returns The detected capabilities and, when read, the usage.
 */
export async function detectJevCapabilities(
  connection: Pick<DecisionProviderConnection, 'baseUrl' | 'apiKey'>,
  signal: AbortSignal,
  opts: Pick<JevProviderOptions, 'fetch'> = {},
): Promise<{
  capabilities: DecisionProviderCapabilities;
  usage?: DecisionProviderUsage;
  error?: DecisionProviderError;
}> {
  const probe = createJevProvider(
    { ...connection },
    { ...opts, capabilities: LAYAHOST_EXTENSION_CAPABILITIES },
  );
  let usage: DecisionProviderUsage;
  try {
    if (!probe.usage) return { capabilities: JEV_MINIMUM_CAPABILITIES };
    usage = await probe.usage(signal);
    // A 2xx that carries no usage field (a catch-all proxy, a different API)
    // proves nothing: treat it as the Jev minimum.
    if (Object.keys(usage).length === 0) return { capabilities: JEV_MINIMUM_CAPABILITIES };
  } catch (err) {
    // A key limit or credit stop still proves the endpoint exists.
    if (
      err instanceof DecisionProviderError &&
      (err.kind === 'key_limit_exceeded' || err.kind === 'insufficient_credits')
    ) {
      return { capabilities: LAYAHOST_EXTENSION_CAPABILITIES, error: err };
    }
    return {
      capabilities: JEV_MINIMUM_CAPABILITIES,
      ...(err instanceof DecisionProviderError ? { error: err } : {}),
    };
  }
  let templates: string[] | undefined;
  try {
    const doFetch: DecideFetch = opts.fetch ?? decideFetch;
    const response = await doFetch(endpointUrl(connection.baseUrl, TEMPLATES_PATH), {
      method: 'GET',
      headers: { authorization: `Bearer ${connection.apiKey}`, accept: 'application/json' },
      signal,
    });
    if (response.ok) {
      const parsed = jevTemplatesSchema.safeParse(
        JSON.parse(await readBoundedText(response, MAX_EXTENSION_BODY_BYTES)),
      );
      if (parsed.success) {
        const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.templates;
        templates = list
          .map((x) => (typeof x === 'string' ? x : x.name))
          .filter((n) => isValidDecisionModelName(n))
          .slice(0, 64);
      }
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    templates = undefined;
  }
  return {
    capabilities: {
      ...LAYAHOST_EXTENSION_CAPABILITIES,
      ...(templates && templates.length > 0 ? { templates } : {}),
    },
    usage,
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
  if (!response.ok) throw await errorForResponse(response);
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
