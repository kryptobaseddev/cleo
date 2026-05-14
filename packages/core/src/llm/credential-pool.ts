/**
 * CredentialPool — rotation + cooldown manager for the CLEO LLM credential
 * layer (T-LLM-CRED-CENTRALIZATION Phase 3 / T9265).
 *
 * Ports the Hermes `credential_pool.py` rotation strategies and cooldown
 * clocks to TypeScript, re-using the existing `credentials-store.ts` I/O
 * primitives (addCredential, listCredentials, getCredentialByLabel) for all
 * persistence so no new file-locking or write paths are introduced.
 *
 * ## Rotation strategies
 *
 * - `fill_first` (default): Iterate entries sorted by `priority` descending
 *   (higher = preferred); return the first that is not in active cooldown.
 * - `round_robin`: Advance a per-provider in-memory cursor; skip cooled-down
 *   entries until a healthy one is found.
 * - `least_used`: Pick the entry with the lowest `requestCount` that is not
 *   in active cooldown; tie-break by `priority` descending.
 *
 * ## Cooldown semantics (mirrored from Hermes)
 *
 * | HTTP code | Cooldown  |
 * |-----------|-----------|
 * | 401       | 5 minutes |
 * | 402       | 5 minutes |
 * | 429       | 1 hour    |
 * | 5xx       | 60 seconds|
 * | other     | 60 seconds|
 *
 * Reference: `hermes-agent/agent/credential_pool.py:92-1095`
 *
 * @module llm/credential-pool
 * @task T9265
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type { StoredCredential } from './credentials-store.js';
import { addCredential, getCredentialByLabel, listCredentials } from './credentials-store.js';
import { rateLimitRemaining } from './rate-limit-guard.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Constants (mirrored from Hermes credential_pool.py:71-76)
// ---------------------------------------------------------------------------

/** Cooldown applied to 401 (auth) and 402 (billing) errors: 5 minutes. */
const COOLDOWN_AUTH_MS = 5 * 60 * 1_000;

/** Cooldown applied to 429 (rate-limited) errors: 1 hour. */
const COOLDOWN_RATE_LIMIT_MS = 60 * 60 * 1_000;

/** Default cooldown for 5xx and all other error codes: 60 seconds. */
const COOLDOWN_DEFAULT_MS = 60 * 1_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Credential rotation strategy for `CredentialPool.pick()`.
 *
 * - `fill_first`  — highest priority entry first; falls back only on cooldown.
 * - `round_robin` — advance a per-provider cursor across healthy entries.
 * - `least_used`  — fewest `requestCount` that is not in cooldown.
 *
 * @task T9265
 */
export type PoolStrategy = 'fill_first' | 'round_robin' | 'least_used';

/**
 * Options accepted by `CredentialPool.pick()`.
 *
 * @task T9265
 */
export interface PoolPickOptions {
  /** Rotation strategy to apply. Defaults to `'fill_first'`. */
  strategy?: PoolStrategy;
}

/**
 * Result returned by `CredentialPool.pick()`.
 *
 * @task T9265
 */
export interface PoolPickResult {
  /** The selected credential entry. */
  credential: StoredCredential;
  /** Total pool size at pick time (for telemetry / logging). */
  poolSize: number;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Thrown by `CredentialPool.pick()` when every entry for the provider is
 * currently in active cooldown (i.e., the pool is fully exhausted).
 *
 * Callers should surface this as a retryable, time-bounded failure. The
 * earliest retry time can be derived from `minResetAt` (epoch ms).
 *
 * @task T9265
 */
export class PoolExhaustedError extends Error {
  /** Stable LAFS error code. */
  readonly code = 'E_LLM_POOL_EXHAUSTED';

  /**
   * @param provider   - The provider whose pool is exhausted.
   * @param poolSize   - Total number of entries in the pool.
   * @param minResetAt - Epoch ms of the earliest cooldown expiry (may be 0 if
   *                     all entries lack a reset timestamp).
   */
  constructor(
    public readonly provider: ModelTransport,
    public readonly poolSize: number,
    public readonly minResetAt: number,
  ) {
    super(
      `E_LLM_POOL_EXHAUSTED: all ${poolSize} credential(s) for provider '${provider}' are in ` +
        `active cooldown. Earliest reset: ${minResetAt > 0 ? new Date(minResetAt).toISOString() : 'unknown'}.`,
    );
    this.name = 'PoolExhaustedError';
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Compute the cooldown duration in milliseconds for a given HTTP error code.
 *
 * Mirrors `hermes-agent/agent/credential_pool.py:_exhausted_ttl`.
 *
 * @param errorCode - HTTP status code that triggered the exhaustion.
 * @returns Cooldown duration in milliseconds.
 *
 * @task T9265
 */
function cooldownMs(errorCode: number): number {
  if (errorCode === 401 || errorCode === 402) return COOLDOWN_AUTH_MS;
  if (errorCode === 429) return COOLDOWN_RATE_LIMIT_MS;
  return COOLDOWN_DEFAULT_MS;
}

/**
 * Return `true` when the credential is currently in active cooldown.
 *
 * A credential is in cooldown when `lastErrorResetAt` is set AND its value is
 * strictly greater than `Date.now()`.
 *
 * @param credential - The entry to check.
 * @returns `true` if the entry should be skipped by the picker.
 *
 * @task T9265
 */
function isInCooldown(credential: StoredCredential): boolean {
  return (
    typeof credential.lastErrorResetAt === 'number' && Date.now() < credential.lastErrorResetAt
  );
}

/**
 * Sort entries by priority descending (higher priority = more preferred).
 *
 * `StoredCredential.priority` is stored ascending (lower = higher priority) in
 * the existing store convention. The pool inverts this so that the
 * highest-priority entry is first in the returned array.
 *
 * @param entries - Unsorted credential entries.
 * @returns New array sorted by priority descending.
 *
 * @task T9265
 */
function sortByPriorityDesc(entries: StoredCredential[]): StoredCredential[] {
  return [...entries].sort((a, b) => b.priority - a.priority);
}

// ---------------------------------------------------------------------------
// CredentialPool
// ---------------------------------------------------------------------------

/**
 * Pool manager that wraps the credential store for a single provider.
 *
 * Responsibilities:
 *   - Pick a non-cooldown credential using one of three rotation strategies.
 *   - Persist `lastStatus`, `lastErrorCode`, `lastErrorResetAt`, and
 *     `requestCount` back to the store via `addCredential` upsert on every
 *     state change.
 *   - Maintain an in-memory round-robin cursor (per instance) for `round_robin`
 *     strategy calls.
 *
 * Instantiate one `CredentialPool` per provider. The pool is stateless beyond
 * the RR cursor — all durable state lives in the credential store file.
 *
 * @example
 * ```ts
 * const pool = new CredentialPool('anthropic');
 * const { credential } = await pool.pick({ strategy: 'round_robin' });
 * try {
 *   await callApi(credential.accessToken);
 *   await pool.markOk(credential.label);
 * } catch (err) {
 *   await pool.markExhausted(credential.label, err.status ?? 500);
 * }
 * ```
 *
 * @task T9265
 */
export class CredentialPool {
  /**
   * In-memory round-robin cursor keyed on provider (one entry per instance
   * since each instance is scoped to one provider). Reset to 0 on construction.
   */
  private rrCursor = 0;

  /**
   * @param provider - The LLM transport this pool manages.
   */
  constructor(private readonly provider: ModelTransport) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Pick a non-cooldown credential for the provider using the requested
   * rotation strategy.
   *
   * Side-effect: increments `requestCount` on the picked entry and persists
   * the change via `addCredential` upsert.
   *
   * @param opts - Optional pick options (strategy). Defaults to `fill_first`.
   * @returns The selected credential plus pool metadata.
   * @throws {PoolExhaustedError} When all entries are in active cooldown.
   *
   * @task T9265
   */
  async pick(opts?: PoolPickOptions): Promise<PoolPickResult> {
    const all = await listCredentials(this.provider);
    const nonDisabled = all.filter((c) => !c.disabled);

    // Filter out entries blocked by the cross-session rate-limit guard (T9273).
    // The guard uses a shared state file so ALL CLEO processes see the same
    // cooldown — even in separate CLI invocations or daemon ticks.
    // We pre-check here (async) before handing off to the sync strategy pickers.
    const eligible: StoredCredential[] = [];
    for (const entry of nonDisabled) {
      const guardRemaining = await rateLimitRemaining(this.provider, entry.label);
      if (guardRemaining == null) {
        eligible.push(entry);
      }
      // If guardRemaining > 0, the entry is still inside a cross-session
      // rate-limit window — skip it so we don't amplify retries.
    }

    const poolSize = nonDisabled.length;

    if (nonDisabled.length === 0) {
      throw new PoolExhaustedError(this.provider, 0, 0);
    }

    if (eligible.length === 0) {
      // All non-disabled entries are blocked by the cross-session guard.
      const minResetAt = nonDisabled
        .map((c) => c.lastErrorResetAt ?? 0)
        .reduce((min, t) => (t > 0 && (min === 0 || t < min) ? t : min), 0);
      throw new PoolExhaustedError(this.provider, poolSize, minResetAt);
    }

    const strategy: PoolStrategy = opts?.strategy ?? 'fill_first';
    let picked: StoredCredential | undefined;

    switch (strategy) {
      case 'fill_first':
        picked = this._pickFillFirst(eligible);
        break;
      case 'round_robin':
        picked = this._pickRoundRobin(eligible);
        break;
      case 'least_used':
        picked = this._pickLeastUsed(eligible);
        break;
    }

    if (!picked) {
      const minResetAt = eligible
        .map((c) => c.lastErrorResetAt ?? 0)
        .reduce((min, t) => (t > 0 && (min === 0 || t < min) ? t : min), 0);
      throw new PoolExhaustedError(this.provider, poolSize, minResetAt);
    }

    // Increment request count and persist.
    const updated = await addCredential({
      ...picked,
      requestCount: (picked.requestCount ?? 0) + 1,
    });

    return { credential: updated, poolSize };
  }

  /**
   * Mark a credential as exhausted, applying a cooldown based on the HTTP
   * error code. Persists `lastStatus`, `lastErrorCode`, and `lastErrorResetAt`
   * to the store.
   *
   * Cooldown durations:
   *   - 401 (auth)        → 5 minutes
   *   - 402 (billing)     → 5 minutes
   *   - 429 (rate-limit)  → 1 hour
   *   - 5xx / other       → 60 seconds
   *
   * @param label     - Credential label (unique within provider).
   * @param errorCode - HTTP status code that triggered the exhaustion.
   *
   * @task T9265
   */
  async markExhausted(label: string, errorCode: number): Promise<void> {
    const existing = await getCredentialByLabel(this.provider, label);
    if (!existing) return;

    const resetAt = Date.now() + cooldownMs(errorCode);
    await addCredential({
      ...existing,
      lastStatus: 'exhausted',
      lastErrorCode: errorCode,
      lastErrorResetAt: resetAt,
    });
  }

  /**
   * Mark a credential as healthy. Clears `lastStatus`, `lastErrorCode`, and
   * `lastErrorResetAt` so the entry re-enters the eligible pool immediately.
   *
   * @param label - Credential label (unique within provider).
   *
   * @task T9265
   */
  async markOk(label: string): Promise<void> {
    const existing = await getCredentialByLabel(this.provider, label);
    if (!existing) return;

    await addCredential({
      ...existing,
      lastStatus: 'ok',
      lastErrorCode: undefined,
      lastErrorResetAt: undefined,
    });
  }

  /**
   * List all entries for the provider sorted by priority descending
   * (highest priority = index 0).
   *
   * Includes both healthy and cooled-down entries — callers can inspect
   * `lastErrorResetAt` to determine cooldown state.
   *
   * @returns Immutable sorted array of all stored credentials for this provider.
   *
   * @task T9265
   */
  async listEntries(): Promise<readonly StoredCredential[]> {
    const all = await listCredentials(this.provider);
    return sortByPriorityDesc(all);
  }

  // -------------------------------------------------------------------------
  // Private strategy implementations
  // -------------------------------------------------------------------------

  /**
   * Fill-first: return the highest-priority entry not in cooldown.
   *
   * Entries are sorted descending by `priority` (store convention: higher
   * numeric priority = more preferred in pool). The first healthy entry wins.
   *
   * @param eligible - Non-disabled entries for the provider.
   * @returns The selected entry, or `undefined` if all are in cooldown.
   *
   * @task T9265
   */
  private _pickFillFirst(eligible: StoredCredential[]): StoredCredential | undefined {
    const sorted = sortByPriorityDesc(eligible);
    return sorted.find((c) => !isInCooldown(c));
  }

  /**
   * Round-robin: advance the cursor across the priority-sorted list, skipping
   * cooled-down entries.
   *
   * The cursor is maintained in-memory per `CredentialPool` instance. It
   * advances even when an entry is skipped so a single cooled-down entry does
   * not permanently displace the rotation.
   *
   * @param eligible - Non-disabled entries for the provider.
   * @returns The selected entry, or `undefined` if all are in cooldown.
   *
   * @task T9265
   */
  private _pickRoundRobin(eligible: StoredCredential[]): StoredCredential | undefined {
    const sorted = sortByPriorityDesc(eligible);
    const n = sorted.length;

    // Try each position starting from cursor; stop after full rotation.
    for (let i = 0; i < n; i++) {
      const idx = this.rrCursor % n;
      this.rrCursor = idx + 1;
      const candidate = sorted[idx];
      if (candidate && !isInCooldown(candidate)) {
        return candidate;
      }
    }
    return undefined;
  }

  /**
   * Least-used: pick the entry with the lowest `requestCount` that is not in
   * cooldown. Ties are broken by `priority` descending (higher priority wins).
   *
   * @param eligible - Non-disabled entries for the provider.
   * @returns The selected entry, or `undefined` if all are in cooldown.
   *
   * @task T9265
   */
  private _pickLeastUsed(eligible: StoredCredential[]): StoredCredential | undefined {
    const healthy = eligible.filter((c) => !isInCooldown(c));
    if (healthy.length === 0) return undefined;

    // Sort by requestCount ascending (least used first), then priority desc for ties.
    return healthy.sort((a, b) => {
      const countDiff = (a.requestCount ?? 0) - (b.requestCount ?? 0);
      if (countDiff !== 0) return countDiff;
      return b.priority - a.priority;
    })[0];
  }
}
