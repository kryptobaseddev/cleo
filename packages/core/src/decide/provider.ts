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

import type { DecisionOutcome, DecisionProviderConfig, DecisionRequest } from '@cleocode/contracts';

/**
 * Connection settings for a key-authenticated decision provider: the base URL
 * from the contract plus the API key. The key is sent as a bearer token and is
 * never logged, cached or audited.
 */
export interface DecisionProviderConnection extends DecisionProviderConfig {
  /** API key, sent as `Authorization: Bearer <apiKey>`. */
  readonly apiKey: string;
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
}

/**
 * Why a provider call failed. Drives the client's fallback reason and, for
 * `rate_limited`, the shared budget cool-down.
 *
 * - `unauthorized`        — 401: bad or missing key.
 * - `insufficient_credits` — 402: the account is out of credit.
 * - `rate_limited`        — 429: slow down; see `retryAfterMs`.
 * - `invalid_request`     — 422 or another 4xx: the provider rejected the request.
 * - `server_error`        — 5xx.
 * - `network`             — the request never produced an HTTP response.
 * - `aborted`             — the caller's signal fired (timeout).
 * - `invalid_response`    — a 2xx whose body did not match the expected shape.
 */
export type DecisionProviderErrorKind =
  | 'unauthorized'
  | 'insufficient_credits'
  | 'rate_limited'
  | 'invalid_request'
  | 'server_error'
  | 'network'
  | 'aborted'
  | 'invalid_response';

/** Construction options for {@link DecisionProviderError}. */
export interface DecisionProviderErrorOptions {
  /** HTTP status, when the failure came from an HTTP response. */
  readonly status?: number;
  /** Server-requested back-off in milliseconds (429 `retry-after`). */
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
