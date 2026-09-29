/**
 * Decision-provider port — the swap point for "System One" typed decisions.
 *
 * A {@link DecisionProvider} executes one {@link DecisionRequest} and returns a
 * {@link DecisionOutcome} with `source: 'provider'`. It knows nothing about
 * caching, budgets, fallbacks or audit — those belong to the client
 * (`./client.ts`). A provider SIGNALS failure by throwing a
 * {@link DecisionProviderError}; the client converts every failure into a
 * heuristic fallback, so callers of the client never see these errors.
 *
 * Swapping vendors means writing a new provider; the client, cache, budget and
 * audit layers stay unchanged.
 *
 * @task T12490
 * @epic T12486
 */

import type {
  DecisionBatchItem,
  DecisionOutcome,
  DecisionProviderCapabilities,
  DecisionProviderConfig,
  DecisionProviderUsage,
  DecisionRequest,
} from '@cleocode/contracts';

/**
 * Connection settings for a key-authenticated decision provider: the base URL
 * from the contract plus the API key. The key is sent as a bearer token and is
 * never logged, cached or audited.
 */
export interface DecisionProviderConnection extends DecisionProviderConfig {
  /** API key, sent as `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string;
  /**
   * Default model for requests that do not name one. Absent → the request is
   * sent without a model and the provider's own default (if any) applies.
   */
  readonly model?: string;
  /**
   * Profile id (`<provider>/<name>`, T12733) the connection was resolved
   * from, when known. Keys the cached provider state per profile; never sent.
   */
  readonly profile?: string;
}

/**
 * A typed-decision backend.
 *
 * Implementations MUST honour `signal` (abort the in-flight request when it
 * fires) and MUST throw a {@link DecisionProviderError} — never return a
 * partial outcome — when they cannot answer every question in the request.
 */
export interface DecisionProvider {
  /**
   * Execute one decision request.
   *
   * @param req - The (already redacted and validated) request.
   * @param signal - Aborts the call; fired by the client's per-site timeout.
   * @returns An outcome whose `answers` cover every question in `req`.
   */
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionOutcome>;
  /**
   * What the provider supports beyond the Jev minimum. Absent → the Jev
   * minimum (`JEV_MINIMUM_CAPABILITIES`). The client calls an optional method
   * below only when both the method and its capability exist (T12664).
   */
  capabilities?(): DecisionProviderCapabilities;
  /**
   * Execute several requests as one provider call (`capabilities().batch`).
   * Resolves with one item per request, in order; a failed item carries its
   * error kind instead of throwing. Throws a {@link DecisionProviderError}
   * only when the call as a whole failed.
   */
  decideBatch?(
    reqs: readonly DecisionRequest[],
    signal: AbortSignal,
  ): Promise<readonly DecisionBatchItem[]>;
  /** Account usage and balance (`capabilities().usage`). */
  usage?(signal: AbortSignal): Promise<DecisionProviderUsage>;
  /** A built-in template decision (`capabilities().templates`). Reserved; no site uses it yet. */
  decideTemplate?(template: string, text: string, signal: AbortSignal): Promise<DecisionOutcome>;
}

/**
 * Why a provider call failed. Drives the client's fallback reason and, for
 * `rate_limited`, the shared budget cool-down.
 *
 * - `unauthorized`        — 401, or a 403 that is not a key limit: bad or missing key.
 * - `insufficient_credits` — 402: the account is out of credit.
 * - `key_limit_exceeded`  — 403 `key_limit_exceeded`: the key's monthly decision
 *   limit is reached. The key is fine; decisions stop until the UTC month ends.
 * - `rate_limited`        — 429: slow down; see `retryAfterMs`.
 * - `overloaded`          — 529 or 503: the provider is overloaded or unavailable;
 *   a short circuit-breaker trip honouring `retryAfterMs`.
 * - `invalid_request`     — 422 or another 4xx: the provider rejected the request.
 * - `server_error`        — any other 5xx.
 * - `network`             — the request never produced an HTTP response.
 * - `aborted`             — the caller's signal fired (timeout).
 * - `invalid_response`    — a 2xx whose body did not match the expected shape.
 */
export type DecisionProviderErrorKind =
  | 'unauthorized'
  | 'insufficient_credits'
  | 'key_limit_exceeded'
  | 'rate_limited'
  | 'overloaded'
  | 'invalid_request'
  | 'server_error'
  | 'network'
  | 'aborted'
  | 'invalid_response';

/** Construction options for {@link DecisionProviderError}. */
export interface DecisionProviderErrorOptions {
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /** Server-requested back-off in milliseconds (`retry-after` on 429/503/529). */
  readonly retryAfterMs?: number;
  /** Underlying cause, for diagnostics. */
  readonly cause?: Error;
}

/**
 * The single error type a {@link DecisionProvider} throws. The message never
 * contains the API key or the request state.
 */
export class DecisionProviderError extends Error {
  /** Failure classification. */
  readonly kind: DecisionProviderErrorKind;
  /** HTTP status, when known. */
  readonly status?: number;
  /** Server-requested back-off in milliseconds, when known. */
  readonly retryAfterMs?: number;

  /**
   * @param kind - Failure classification.
   * @param message - Human-readable, secret-free description.
   * @param opts - Status, retry-after and cause.
   */
  constructor(
    kind: DecisionProviderErrorKind,
    message: string,
    opts: DecisionProviderErrorOptions = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'DecisionProviderError';
    this.kind = kind;
    if (opts.status !== undefined) this.status = opts.status;
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}
