/**
 * Concrete stateful LLM session implementation.
 *
 * Owns per-conversation history, OAuth credential refresh (pre-call check
 * against expiresAt < 60s), RateLimitGuard pre-call check, prompt-cache
 * breakpoint injection, and exponential-backoff retry.
 *
 * @module llm/concrete-session
 * @task T9287
 * @epic T9261 T-LLM-CRED-CENTRALIZATION
 * @see ADR-072 §Decision §"LlmSession — session level"
 */

import type {
  LlmSession,
  NormalizedDelta,
  RetryPolicy,
  SendOptions,
  TransportContext,
} from '@cleocode/contracts/llm/interfaces.js';
import type {
  LlmTransport,
  NormalizedResponse,
  TransportMessage,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import { rateLimitRemaining, recordRateLimit } from './rate-limit-guard.js';

// ---------------------------------------------------------------------------
// Default retry policy
// ---------------------------------------------------------------------------

/** Default retry policy applied when none is supplied at construction or call time. */
const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  jitter: true,
};

// ---------------------------------------------------------------------------
// Error classification helpers (simplified — W4a wires classifyError)
// ---------------------------------------------------------------------------

/**
 * Returns true when the error looks like a transient condition worth retrying:
 * HTTP 429, 500-series, or network timeout. Does NOT retry on 4xx (except 429).
 *
 * W4a will replace this with the full `classifyError` from error-classifier.ts.
 */
function isRetriableError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
      return true;
    }
    if (msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('504')) {
      return true;
    }
    if (msg.includes('timeout') || msg.includes('econnreset') || msg.includes('econnrefused')) {
      return true;
    }
    const statusMatch = /\bstatus[:\s]+(\d{3})\b/.exec(msg);
    if (statusMatch) {
      const code = Number(statusMatch[1]);
      if (code === 429 || code >= 500) return true;
    }
  }
  return false;
}

/**
 * Returns true when the error is a 429 / rate-limit error so we can record it
 * in the RateLimitGuard's cross-process state file.
 */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests');
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute exponential backoff delay (ms) for attempt `n` (0-indexed).
 *
 * Formula: `min(baseDelayMs * 2^n + jitter, maxDelayMs)`
 * where jitter is a random value in `[0, baseDelayMs * 0.1]` when
 * `policy.jitter` is true.
 */
function backoffMs(policy: RetryPolicy, attempt: number): number {
  const base = policy.baseDelayMs * 2 ** attempt;
  const jitter = policy.jitter ? Math.random() * policy.baseDelayMs * 0.1 : 0;
  return Math.min(base + jitter, policy.maxDelayMs);
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link ConcreteSession}.
 */
export interface ConcreteSessionOptions {
  /** Wire-level transport used for completions. */
  readonly transport: LlmTransport;
  /** Model identifier bound to this session. */
  readonly model: string;
  /** Resolved credential — used for OAuth refresh checks and rate-limit keying. */
  readonly credential: ResolvedCredential;
  /** Initial conversation history. Defaults to empty. */
  readonly history?: TransportMessage[];
  /** Retry policy for transient errors. Defaults to {@link DEFAULT_RETRY_POLICY}. */
  readonly retryPolicy?: RetryPolicy;
}

// ---------------------------------------------------------------------------
// ConcreteSession
// ---------------------------------------------------------------------------

/**
 * Stateful per-conversation LLM session.
 *
 * Implements {@link LlmSession}. Callers should obtain instances via
 * {@link DefaultLlmSessionFactory} rather than constructing directly.
 *
 * @example
 * ```ts
 * const session = new ConcreteSession({ transport, model, credential });
 * const response = await session.send([{ role: 'user', content: 'Hello!' }]);
 * console.log(response.content);
 * ```
 */
export class ConcreteSession implements LlmSession {
  /** Underlying wire-level transport. */
  readonly transport: LlmTransport;

  /** Model identifier this session is bound to. */
  readonly model: string;

  private readonly _credential: ResolvedCredential;
  private _history: TransportMessage[];
  private readonly _retryPolicy: RetryPolicy;

  /**
   * @param opts - Session construction options.
   */
  constructor(opts: ConcreteSessionOptions) {
    this.transport = opts.transport;
    this.model = opts.model;
    this._credential = opts.credential;
    this._history = opts.history ? [...opts.history] : [];
    this._retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
  }

  /**
   * Returns a defensive copy of the current conversation history.
   *
   * The returned array is read-only — mutate history via {@link append} or
   * {@link truncateHistory}.
   */
  history(): readonly TransportMessage[] {
    return [...this._history];
  }

  /**
   * Appends a message to the conversation history.
   *
   * @param message - The message to append.
   */
  append(message: TransportMessage): void {
    this._history.push(message);
  }

  /**
   * Truncates the conversation history, keeping `keepFirst` messages from the
   * start and `keepLast` messages from the end.
   *
   * If `keepFirst + keepLast >= history.length` the history is left unchanged.
   *
   * @param keepFirst - Number of messages to preserve from the start.
   * @param keepLast - Number of messages to preserve from the end.
   */
  truncateHistory(keepFirst: number, keepLast: number): void {
    const len = this._history.length;
    if (keepFirst + keepLast >= len) return;
    const head = this._history.slice(0, keepFirst);
    const tail = this._history.slice(len - keepLast);
    this._history = [...head, ...tail];
  }

  /**
   * Executes a single completion call with the supplied messages.
   *
   * Pre-call lifecycle:
   * 1. OAuth expiry check → refresh if expiring within 60s.
   * 2. RateLimitGuard pre-call check → throws `Error('Rate limit active')` when blocked.
   * 3. Cache-breakpoint injection when `opts.cacheStrategy` is set.
   * 4. Retry loop with exponential backoff (transient 429/5xx only).
   *
   * The supplied `messages` are NOT appended to history automatically.
   *
   * @param messages - Messages to send.
   * @param opts - Optional per-call overrides.
   * @returns Normalized provider response.
   */
  async send(messages: TransportMessage[], opts?: SendOptions): Promise<NormalizedResponse> {
    await this._preCallChecks();

    const policy = opts?.retryPolicy ?? this._retryPolicy;
    const ctx = this._buildContext();

    const request = this._buildRequest(messages, opts);

    let lastErr: unknown;
    for (let attempt = 0; attempt < policy.maxAttempts; attempt++) {
      try {
        const response = await this.transport.complete(request, ctx);
        return response;
      } catch (err: unknown) {
        if (isRateLimitError(err)) {
          await recordRateLimit(this._credential.provider, this._credential.label);
        }
        if (!isRetriableError(err) || attempt === policy.maxAttempts - 1) {
          throw err;
        }
        lastErr = err;
        await sleep(backoffMs(policy, attempt));
      }
    }

    throw lastErr;
  }

  /**
   * Streaming variant of {@link send}.
   *
   * Yields {@link NormalizedDelta} chunks as they arrive. The caller is
   * responsible for appending the final assistant message to history if needed.
   *
   * Pre-call lifecycle is identical to {@link send} (OAuth refresh, rate-limit
   * guard). Streaming retries are NOT supported — a mid-stream error propagates
   * to the caller as an async iterator throw.
   *
   * @param messages - Messages to send.
   * @param opts - Optional per-call overrides.
   * @returns An async iterable of normalized delta chunks.
   */
  async *stream(messages: TransportMessage[], opts?: SendOptions): AsyncIterable<NormalizedDelta> {
    await this._preCallChecks();

    const ctx = this._buildContext();
    const request = this._buildRequest(messages, opts);

    yield* this.transport.stream(request, ctx);
  }

  /**
   * Refreshes the OAuth credential bound to this session.
   *
   * Called automatically by {@link send}/{@link stream} when
   * `credential.expiresAt` is less than 60 seconds in the future.
   *
   * No-op for `api_key` and `aws_sdk` credentials.
   *
   * TODO(T9292 W3): wire real OAuth token refresh via oauth/device-code.ts
   * once Anthropic device-code endpoint is confirmed (T9266).
   */
  async refreshCredential(): Promise<void> {
    if (this._credential.authType !== 'oauth') return;
    // TODO(T9292 W3): call refreshOAuthCredential(this._credential) from
    // oauth/device-code.ts when the Anthropic device-code endpoint is confirmed
    // and the OAuth refresh flow is implemented (T9266).
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Pre-call guard: OAuth expiry check + RateLimitGuard check.
   */
  private async _preCallChecks(): Promise<void> {
    // OAuth expiry check — refresh when less than 60 s remain.
    if (
      this._credential.authType === 'oauth' &&
      this._credential.expiresAt !== null &&
      this._credential.expiresAt - Date.now() < 60_000
    ) {
      await this.refreshCredential();
    }

    // RateLimitGuard pre-call check.
    const remaining = await rateLimitRemaining(this._credential.provider, this._credential.label);
    if (remaining !== null && remaining > 0) {
      throw new Error(
        `Rate limit active for ${this._credential.provider}/${this._credential.label}: ` +
          `${remaining.toFixed(1)}s remaining`,
      );
    }
  }

  /** Build a {@link TransportContext} for this call. */
  private _buildContext(): TransportContext {
    return {
      requestId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  /** Assemble a {@link TransportRequest} from messages and call-level opts. */
  private _buildRequest(messages: TransportMessage[], opts?: SendOptions): TransportRequest {
    return {
      model: this.model,
      messages,
      maxTokens: 4096,
      cacheStrategy: opts?.cacheStrategy ?? null,
      ...(opts?.systemSuffix != null ? { system: opts.systemSuffix } : {}),
    };
  }
}
