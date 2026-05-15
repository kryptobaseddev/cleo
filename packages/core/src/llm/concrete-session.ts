/**
 * Concrete stateful LLM session implementation.
 *
 * Owns per-conversation history, OAuth credential refresh (pre-call check
 * against expiresAt < 60s), RateLimitGuard pre-call check, prompt-cache
 * breakpoint injection, and exponential-backoff retry.
 *
 * @module llm/concrete-session
 * @task T9287
 * @task T9293 (W4a — wire classifyError into retry path)
 * @task T9297 (W4e — wire CredentialPool + RateLimitGuard into retry)
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
import type { ProviderProfile } from '@cleocode/contracts/llm/provider-profile.js';
import type { ResolvedCredential } from '@cleocode/contracts/llm/resolved-credential.js';
import type { CredentialPool } from './credential-pool.js';
import type { StoredCredential } from './credentials-store.js';
import { classifyError } from './error-classifier.js';
import { estimateTransportMessageTokens } from './message-utils.js';
import { getModelContextLengthSync } from './model-metadata.js';
import { rateLimitRemaining, recordRateLimit } from './rate-limit-guard.js';
import { computeThinkingBudget } from './thinking-budget.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Credential adapter (StoredCredential → ResolvedCredential)
// ---------------------------------------------------------------------------

/**
 * Convert a {@link StoredCredential} from the pool to the {@link ResolvedCredential}
 * contract used by transports and session.
 *
 * Maps `accessToken` → `token` and fills optional fields with safe defaults.
 *
 * @param stored - Pool entry from CredentialPool.pick().
 * @returns A fully-typed ResolvedCredential ready for transport construction.
 *
 * @task T9297
 */
export function storedToResolved(stored: StoredCredential): ResolvedCredential {
  return {
    provider: stored.provider as ModelTransport,
    label: stored.label,
    token: stored.accessToken,
    authType: stored.authType,
    expiresAt: stored.expiresAt ?? null,
    refreshToken: stored.refreshToken ?? null,
    extraHeaders: stored.extraHeaders ?? {},
    baseUrl: stored.baseUrl ?? null,
    awsProfile: (stored.metadata?.['awsProfile'] as string | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Typed error for context overflow (used to trigger compression upstream)
// ---------------------------------------------------------------------------

/**
 * Thrown when classifyError returns `reason === 'context_overflow'` so that
 * ConcreteExecutor can detect this case and trigger context compression.
 *
 * @task T9293
 */
export class ContextOverflowError extends Error {
  /** Stable error code for instanceof / code-based detection. */
  readonly code = 'E_LLM_CONTEXT_OVERFLOW';

  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Context overflow: ${msg}`);
    this.name = 'ContextOverflowError';
    if (cause instanceof Error && Error.captureStackTrace) {
      Error.captureStackTrace(this, ContextOverflowError);
    }
  }
}

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
  /**
   * Optional credential pool for automatic rotation on 401/429.
   *
   * When provided, `classifyError().shouldRotateCredential === true` triggers a
   * `pool.pick()` call, the session's active credential is replaced, and the
   * request is retried with the new credential.
   *
   * @task T9297
   */
  readonly credentialPool?: CredentialPool;
  /**
   * Provider profile resolved for this session.
   *
   * When present and `providerProfile.supportsThinkingBudget === true`, the
   * session automatically computes and injects a `thinkingBudgetTokens` value
   * into each `TransportRequest` via {@link computeThinkingBudget} — unless the
   * caller already set `thinkingBudgetTokens` explicitly.
   *
   * @task T9303
   */
  readonly providerProfile?: ProviderProfile;
  /**
   * Factory that rebuilds the transport from a new credential after pool rotation.
   *
   * Required when `credentialPool` is set. Called with the newly-picked
   * `ResolvedCredential`; should return a fresh `LlmTransport` instance
   * authenticated with the new credential.
   *
   * @task T9297
   */
  readonly transportFactory?: (credential: ResolvedCredential) => LlmTransport;
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
  transport: LlmTransport;

  /** Model identifier this session is bound to. */
  readonly model: string;

  private _credential: ResolvedCredential;
  private _history: TransportMessage[];
  private readonly _retryPolicy: RetryPolicy;
  private readonly _credentialPool: CredentialPool | undefined;
  private readonly _transportFactory:
    | ((credential: ResolvedCredential) => LlmTransport)
    | undefined;
  private readonly _providerProfile: ProviderProfile | undefined;

  /**
   * @param opts - Session construction options.
   */
  constructor(opts: ConcreteSessionOptions) {
    this.transport = opts.transport;
    this.model = opts.model;
    this._credential = opts.credential;
    this._history = opts.history ? [...opts.history] : [];
    this._retryPolicy = opts.retryPolicy ?? DEFAULT_RETRY_POLICY;
    this._credentialPool = opts.credentialPool;
    this._transportFactory = opts.transportFactory;
    this._providerProfile = opts.providerProfile;
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
        const classified = classifyError(err, {
          provider: this._credential.provider,
          model: this.model,
        });

        // Record rate-limit events in the cross-session guard.
        if (classified.reason === 'rate_limit') {
          await recordRateLimit(this._credential.provider, this._credential.label);
        }

        // Context overflow → throw a typed error so the executor can trigger compression.
        if (classified.reason === 'context_overflow') {
          throw new ContextOverflowError(err);
        }

        // shouldFallback errors should not be retried — let the caller decide.
        if (classified.shouldFallback) {
          throw err;
        }

        // shouldRotateCredential → attempt pool rotation before retrying.
        if (classified.shouldRotateCredential) {
          // T9297 will rotate via CredentialPool
          await this._tryRotateCredential(classified.statusCode ?? 401);
        }

        if (!classified.retryable || attempt === policy.maxAttempts - 1) {
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
   * Called by `_preCallChecks` when the proactive refresh window is entered.
   * Delegates to `CredentialPool.proactiveRefresh` when a pool is configured;
   * otherwise falls back to a direct pool-less no-op (callers without a pool
   * rely on 401-triggered rotation from the retry loop instead).
   *
   * No-op for `api_key` and `aws_sdk` credentials.
   *
   * @task T9323
   */
  async refreshCredential(): Promise<void> {
    if (this._credential.authType !== 'oauth') return;
    if (this._credentialPool) {
      await this._credentialPool.proactiveRefresh(this._credential.label);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Pre-call guard: OAuth proactive refresh + RateLimitGuard check.
   *
   * OAuth refresh is attempted when remaining lifetime falls below
   * `max(remaining * 0.5, 300s)`. Both `anthropic` and `kimi-code` refresh
   * via `CredentialPool.proactiveRefresh()` → `_refreshTokenViaEndpoint()`.
   *
   * @task T9297 (W4e): RateLimitGuard pre-call check is verified here.
   * @task T9323: Proactive refresh at 50% lifetime / 300s floor.
   */
  private async _preCallChecks(): Promise<void> {
    // Proactive OAuth refresh — attempt when within the proactive window.
    if (this._credential.authType === 'oauth' && this._credential.expiresAt !== null) {
      const remaining = this._credential.expiresAt - Date.now();
      // Compute proactive threshold: max(50% of total lifetime, 300s).
      // Total lifetime ≈ expiresIn (seconds) if available, else use remaining
      // as a lower-bound proxy (threshold = max(remaining*0.5, 300s)).
      const FLOOR_MS = 300_000;
      const threshold = Math.max(remaining * 0.5, FLOOR_MS);
      if (remaining < threshold) {
        if (this._credentialPool) {
          await this._credentialPool.proactiveRefresh(this._credential.label);
        } else {
          await this.refreshCredential();
        }
      }
    }

    // RateLimitGuard pre-call check (T9297 W4e: verified before each call).
    const remaining = await rateLimitRemaining(this._credential.provider, this._credential.label);
    if (remaining !== null && remaining > 0) {
      throw new Error(
        `Rate limit active for ${this._credential.provider}/${this._credential.label}: ` +
          `${remaining.toFixed(1)}s remaining`,
      );
    }
  }

  /**
   * Attempt to rotate the active credential via the pool when a
   * `shouldRotateCredential` error is received.
   *
   * No-op when no pool or transportFactory is configured.
   *
   * @param errorCode - HTTP status code that triggered the rotation.
   * @task T9297
   */
  private async _tryRotateCredential(errorCode: number): Promise<void> {
    if (!this._credentialPool || !this._transportFactory) return;

    // Mark the current credential as exhausted in the pool.
    await this._credentialPool.markExhausted(this._credential.label, errorCode);

    // Pick a new credential from the pool.
    let pickResult: Awaited<ReturnType<CredentialPool['pick']>>;
    try {
      pickResult = await this._credentialPool.pick();
    } catch {
      // Pool exhausted — nothing we can do; let the outer retry fail.
      return;
    }

    const newStored = pickResult.credential;
    const newResolved: ResolvedCredential = storedToResolved(newStored);

    // Swap credential and rebuild transport with new credentials.
    this._credential = newResolved;
    this.transport = this._transportFactory(newResolved);
  }

  /** Build a {@link TransportContext} for this call. */
  private _buildContext(): TransportContext {
    return {
      requestId: `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    };
  }

  /** Assemble a {@link TransportRequest} from messages and call-level opts. */
  private _buildRequest(messages: TransportMessage[], opts?: SendOptions): TransportRequest {
    const maxTokens = 4096;
    const base: TransportRequest = {
      model: this.model,
      messages,
      maxTokens,
      cacheStrategy: opts?.cacheStrategy ?? null,
      ...(opts?.systemSuffix != null ? { system: opts.systemSuffix } : {}),
    };

    // Auto-inject thinking budget when the provider supports it and the caller
    // has not already set thinkingBudgetTokens.
    if (
      this._providerProfile?.supportsThinkingBudget === true &&
      base.thinkingBudgetTokens == null
    ) {
      const promptTokens = estimateTransportMessageTokens(messages);
      const contextLength = getModelContextLengthSync(this.model);
      const budget = computeThinkingBudget({
        modelContextLength: contextLength,
        promptTokens,
        maxTokens,
      });
      return { ...base, thinkingBudgetTokens: budget };
    }

    return base;
  }
}
