/**
 * Auxiliary-router — side-task LLM caller with CredentialPool failover.
 *
 * Used by context-compression, dream cycles, and hygiene subsystems that
 * need an LLM call without occupying the main conversation transport. The
 * router chains:
 *
 *   resolveLLMForRole(role) → { provider, model }
 *   CredentialPool(provider).pick(strategy) → StoredCredential
 *   AnthropicTransport(credential) → NormalizedResponse
 *
 * On 401 / 429 / 5xx the picked credential is marked exhausted and the
 * loop retries with the next healthy pool entry up to `maxRetries` times.
 * Any other error is re-thrown immediately (non-retriable).
 *
 * @module llm/auxiliary-router
 * @task T9267
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type {
  NormalizedResponse,
  TransportRequest,
} from '@cleocode/contracts/llm/normalized-response.js';
import { CredentialPool, PoolExhaustedError } from './credential-pool.js';
import type { StoredCredential } from './credentials-store.js';
import { resolveLLMForRole } from './role-resolver.js';
import { AnthropicTransport } from './transports/anthropic.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Options accepted by {@link routeAuxiliaryCall}.
 *
 * @task T9267
 */
export interface RouteAuxiliaryCallOptions {
  /**
   * Maximum number of pick-and-complete attempts across pool entries.
   *
   * Each attempt may consume a different credential if the previous one
   * returned a retriable error code (401 / 429 / 5xx). Defaults to `3`.
   */
  maxRetries?: number;
  /**
   * Credential rotation strategy forwarded to {@link CredentialPool.pick}.
   *
   * Defaults to `'fill_first'`.
   */
  poolStrategy?: 'fill_first' | 'round_robin' | 'least_used';
  /**
   * Override the provider resolved from the role config.
   *
   * When set, this value takes precedence over the provider returned by
   * {@link resolveLLMForRole}.
   */
  provider?: ModelTransport;
  /**
   * Override the model resolved from the role config.
   *
   * When set, this value is spliced into the request before calling the
   * transport, replacing whatever model {@link resolveLLMForRole} returned.
   */
  model?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract an HTTP status code from an unknown thrown value.
 *
 * Anthropic SDK errors carry `status: number`. Plain `fetch` errors may
 * carry `statusCode: number` or nest a `cause` with a `status` field.
 * Returns `null` when no numeric status is detectable.
 *
 * @param err - The caught error value.
 * @returns HTTP status code, or `null` if not detectable.
 *
 * @task T9267
 */
function inferStatusCode(err: unknown): number | null {
  if (err !== null && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e['status'] === 'number') return e['status'];
    if (typeof e['statusCode'] === 'number') return e['statusCode'];
    if (
      e['cause'] !== null &&
      typeof e['cause'] === 'object' &&
      typeof (e['cause'] as Record<string, unknown>)['status'] === 'number'
    ) {
      return (e['cause'] as Record<string, unknown>)['status'] as number;
    }
  }
  return null;
}

/**
 * Return `true` when the error code should trigger a pool-entry cooldown
 * and a retry to the next healthy credential.
 *
 * Retriable codes mirror the Hermes `credential_pool.py` definition:
 *   - 401 / 402 — auth / billing errors (cooldown 5 min)
 *   - 429       — rate-limited (cooldown 1 hour)
 *   - 500–599   — server-side transient errors (cooldown 60 s)
 *
 * @param status - HTTP status code.
 * @returns `true` if the error is retriable via credential rotation.
 *
 * @task T9267
 */
function isRetriableStatus(status: number): boolean {
  return status === 401 || status === 402 || status === 429 || status >= 500;
}

/**
 * Build an {@link AnthropicTransport} from a {@link StoredCredential}.
 *
 * Passes `baseUrl` and `extraHeaders` from the credential entry so that
 * proxy / gateway overrides stored in the pool are honoured.
 *
 * @param credential - The pool entry to use for this call.
 * @returns A fully configured `AnthropicTransport` instance.
 *
 * @task T9267
 */
function buildAnthropicTransport(credential: StoredCredential): AnthropicTransport {
  return new AnthropicTransport({
    apiKey: credential.accessToken,
    baseUrl: credential.baseUrl ?? undefined,
    defaultHeaders: credential.extraHeaders,
  });
}

/**
 * Construct a LAFS-compatible error for unsupported providers.
 *
 * @param provider - The provider name that is not yet wired.
 * @returns An `Error` carrying `code` and `codeName` fields.
 *
 * @task T9267
 */
function makeNotImplementedError(provider: string): Error {
  const err = new Error(
    `E_NOT_IMPLEMENTED: provider '${provider}' is not yet wired for the auxiliary router. ` +
      `Supported providers: 'anthropic'.`,
  );
  Object.assign(err, { code: 'E_NOT_IMPLEMENTED', codeName: 'E_NOT_IMPLEMENTED' });
  return err;
}

// ---------------------------------------------------------------------------
// routeAuxiliaryCall
// ---------------------------------------------------------------------------

/**
 * Call an LLM for a side-task role with automatic credential failover.
 *
 * ## Algorithm
 *
 *  1. `resolveLLMForRole(role)` → `{ provider, model }` (provider/model only;
 *     the credential is bypassed in favour of the pool).
 *  2. `opts.provider` / `opts.model` override the resolved values when set.
 *  3. `new CredentialPool(provider).pick(strategy)` → `StoredCredential`.
 *  4. Build transport: `AnthropicTransport` for `'anthropic'`; other providers
 *     throw `E_NOT_IMPLEMENTED` immediately.
 *  5. `transport.complete({ ...request, model })` — splices the resolved model.
 *  6. On success: `pool.markOk(label)` and return the `NormalizedResponse`.
 *  7. On 401 / 402 / 429 / 5xx: `pool.markExhausted(label, code)`, advance
 *     attempt counter, retry from step 3.
 *  8. On any other error: re-throw immediately (non-retriable).
 *  9. When `maxRetries` is exhausted or `pool.pick()` throws
 *     `PoolExhaustedError`, that error propagates to the caller.
 *
 * @param role    - Semantic role for provider/model resolution.
 * @param request - Provider-neutral transport request (model field is
 *                  overridden by the resolved / option model).
 * @param opts    - Optional overrides for retry count, strategy, provider, model.
 * @returns Normalized response from the first successful credential attempt.
 * @throws {PoolExhaustedError} When all pool entries are exhausted or the
 *         retry budget is consumed.
 * @throws The original error when the transport raises a non-retriable code.
 *
 * @example
 * ```ts
 * const response = await routeAuxiliaryCall(
 *   'extraction',
 *   { model: '', messages: [{ role: 'user', content: prompt }], maxTokens: 512 },
 *   { poolStrategy: 'round_robin' },
 * );
 * console.log(response.content);
 * ```
 *
 * @task T9267
 */
export async function routeAuxiliaryCall(
  role: 'extraction' | 'consolidation' | 'derivation' | 'hygiene' | 'judgement',
  request: TransportRequest,
  opts: RouteAuxiliaryCallOptions = {},
): Promise<NormalizedResponse> {
  const maxRetries = opts.maxRetries ?? 3;

  // Step 1–2: resolve provider and model.
  const resolved = await resolveLLMForRole(role);
  const provider: ModelTransport = opts.provider ?? resolved.provider;
  const model: string = opts.model ?? resolved.model;

  // Only Anthropic is wired. Fail fast for other providers.
  if (provider !== 'anthropic') {
    throw makeNotImplementedError(provider);
  }

  const pool = new CredentialPool(provider);
  const strategy = opts.poolStrategy ?? 'fill_first';

  let lastError: unknown = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Step 3: pick a healthy credential.
    let picked: StoredCredential;
    try {
      const result = await pool.pick({ strategy });
      picked = result.credential;
    } catch (e) {
      // PoolExhaustedError (or unexpected) — propagate immediately.
      throw e;
    }

    // Step 4: build transport.
    const transport = buildAnthropicTransport(picked);

    // Step 5–8: call the transport.
    try {
      const response = await transport.complete({ ...request, model });
      // Step 6: mark credential healthy.
      await pool.markOk(picked.label);
      return response;
    } catch (err) {
      const status = inferStatusCode(err);

      if (status !== null && isRetriableStatus(status)) {
        // Step 7: mark exhausted and retry.
        await pool.markExhausted(picked.label, status);
        lastError = err;
        continue;
      }

      // Step 8: non-retriable — re-throw immediately.
      throw err;
    }
  }

  // Step 9: retry budget consumed. Throw a PoolExhaustedError.
  if (lastError instanceof PoolExhaustedError) {
    throw lastError;
  }
  throw new PoolExhaustedError(provider, 0, 0);
}
