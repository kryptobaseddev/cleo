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

import { isSuppressed } from './credential-removal.js';
import {
  BUILTIN_SEEDERS,
  type CredentialSeeder,
  type SeederCredentialEntry,
} from './credential-seeders/index.js';
import type { CredentialsStoreStrategy, StoredCredential } from './credentials-store.js';
import {
  addCredential,
  getCredentialByLabel,
  listCredentials,
  pickCredentialForProviderSync,
} from './credentials-store.js';
import { getKimiCodeDeviceCodeConfig } from './oauth/device-code.js';
import { refreshPkceToken } from './oauth/pkce.js';
import { getProviderProfile } from './provider-registry/index.js';
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

/**
 * Proactive refresh threshold: at least 300 seconds (5 minutes) before expiry.
 *
 * The proactive window is `max(expiresIn * 0.5, PROACTIVE_REFRESH_FLOOR_MS)`.
 * For Kimi Code's ~15 min access tokens: 50% = 450s > 300s → uses 450s.
 * For very short tokens (< 600s): 50% < 300s → floor kicks in at 300s.
 *
 * @task T9323
 */
const PROACTIVE_REFRESH_FLOOR_MS = 300_000;

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
   * Proactively refresh an OAuth credential before it expires.
   *
   * Refresh is triggered when the remaining lifetime is less than
   * `max(expiresIn * 0.5, 300_000ms)`. For a credential without a known
   * `expiresIn`, only the 300s floor applies (requires `expiresAt`).
   *
   * For `api_key` and `aws_sdk` credentials this is a no-op.
   *
   * Supported refresh providers:
   * - `kimi-code` — posts to `auth.kimi.com/api/oauth/token` with
   *   `grant_type=refresh_token` and the stored `refreshToken`.
   *
   * On success, the new access token (and optional refreshed refresh token)
   * are persisted via `addCredential` upsert.
   *
   * @param label - Credential label (unique within provider).
   * @returns `true` when a refresh was attempted (regardless of success),
   *   `false` when no refresh was needed or the credential is not OAuth.
   * @task T9323
   */
  async proactiveRefresh(label: string): Promise<boolean> {
    const existing = await getCredentialByLabel(this.provider, label);
    if (!existing) return false;
    if (existing.authType !== 'oauth') return false;
    if (!existing.refreshToken) return false;
    if (existing.expiresAt == null) return false;

    const remaining = existing.expiresAt - Date.now();
    // Refresh when remaining lifetime is less than the floor (300s). A negative
    // `remaining` (already-expired token) also satisfies this, so an expired
    // OAuth credential that still has a refresh token is renewed rather than
    // dropped.
    // ConcreteSession handles the 50%-of-lifetime check using the original
    // expiresIn from the token response; CredentialPool covers the floor case.
    if (remaining >= PROACTIVE_REFRESH_FLOOR_MS) return false;

    await this._refreshOAuthCredential(existing);
    return true;
  }

  /**
   * Refresh every expired-but-refreshable OAuth credential for this provider
   * before a selection pass, so the role resolver renews a stale token instead
   * of silently filtering it out (which previously demoted resolution to a
   * lower-priority — or fake — credential).
   *
   * For each stored OAuth entry that is expired (or within the proactive-refresh
   * floor) AND carries a `refreshToken`, attempts a refresh via
   * {@link proactiveRefresh}. Entries without a refresh token, non-OAuth
   * entries, and still-valid tokens are left untouched. Errors are swallowed
   * per-entry — a failed refresh leaves the entry expired and the normal
   * eligible-filter still drops it.
   *
   * @returns The number of entries for which a refresh was attempted.
   * @task T11617
   */
  async refreshExpiredOAuth(): Promise<number> {
    const entries = await this.listEntries();
    let attempted = 0;
    for (const entry of entries) {
      if (entry.authType !== 'oauth') continue;
      if (!entry.refreshToken) continue;
      try {
        const didRefresh = await this.proactiveRefresh(entry.label);
        if (didRefresh) attempted += 1;
      } catch {
        // Non-fatal: a refresh failure leaves the entry expired; the
        // eligible-filter drops it and resolution falls through normally.
      }
    }
    return attempted;
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
  // Private OAuth refresh helpers
  // -------------------------------------------------------------------------

  /**
   * Perform the actual token refresh for a known OAuth credential.
   *
   * Dispatches based on `profile.oauth.mode`:
   * - `pkce` — uses `refreshPkceToken` (RFC 6749 §6 refresh via PKCE endpoint).
   * - `device-code` — uses the device-code token URL + clientId.
   * - No profile / unknown mode → no-op (caller's 401-retry handles it).
   *
   * Errors are silently swallowed — the caller's retry path will encounter a
   * 401 and trigger credential rotation if the token has actually expired.
   *
   * @param existing - The credential entry to refresh.
   * @task T9302 (generic PKCE dispatch, replaces anthropic-specific branch)
   * @task T9323 (device-code path)
   */
  private async _refreshOAuthCredential(existing: StoredCredential): Promise<void> {
    if (!existing.refreshToken) return;

    const profile = await getProviderProfile(this.provider);
    const oauthCfg = profile?.oauth;

    if (oauthCfg?.mode === 'pkce') {
      await this._refreshViaPkce(
        existing,
        oauthCfg.tokenEndpoint,
        oauthCfg.clientId,
        oauthCfg.tokenBodyFormat,
      );
    } else if (this.provider === 'kimi-code') {
      const cfg = getKimiCodeDeviceCodeConfig();
      await this._refreshTokenViaEndpoint(existing, cfg.tokenUrl, cfg.clientId);
    }
  }

  /**
   * Refresh via RFC 7636 PKCE `refresh_token` grant using `refreshPkceToken`.
   *
   * On success, upserts the new access token (and optional refresh token)
   * into the credential store. Errors are silently swallowed.
   *
   * @param existing      - Credential entry to refresh.
   * @param tokenEndpoint - Provider token endpoint URL.
   * @param clientId      - OAuth client ID.
   * @param bodyFormat    - Token request body encoding (`'json'` for Anthropic).
   * @task T9302
   * @task T11958
   */
  private async _refreshViaPkce(
    existing: StoredCredential,
    tokenEndpoint: string,
    clientId: string,
    bodyFormat?: 'form' | 'json',
  ): Promise<void> {
    if (!existing.refreshToken) return;

    let tokens: Awaited<ReturnType<typeof refreshPkceToken>>;
    try {
      tokens = await refreshPkceToken({
        provider: existing.provider,
        clientId,
        refreshToken: existing.refreshToken,
        tokenEndpoint,
        bodyFormat,
      });
    } catch {
      return;
    }

    await addCredential({
      ...existing,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? existing.refreshToken,
      expiresAt:
        tokens.expiresIn != null ? Date.now() + tokens.expiresIn * 1000 : existing.expiresAt,
      lastStatus: 'ok',
      lastErrorCode: undefined,
      lastErrorResetAt: undefined,
    });
  }

  /**
   * Shared OAuth `refresh_token` grant implementation.
   *
   * POSTs `grant_type=refresh_token` to `tokenUrl` with the credential's
   * stored refresh token. On success, upserts the new access token (and
   * updated refresh token if provided) into the credential store.
   *
   * @param existing      - Credential entry to refresh.
   * @param tokenUrl      - Provider's token endpoint.
   * @param clientId      - OAuth client ID.
   * @param extraHeaders  - Optional provider-specific headers (e.g. Anthropic beta flags).
   * @task T9323
   */
  private async _refreshTokenViaEndpoint(
    existing: StoredCredential,
    tokenUrl: string,
    clientId: string,
    extraHeaders?: Record<string, string>,
  ): Promise<void> {
    if (!existing.refreshToken) return;

    let resp: Response;
    try {
      resp = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          refresh_token: existing.refreshToken,
        }).toString(),
      });
    } catch {
      return;
    }

    if (!resp.ok) return;

    let data: Record<string, unknown>;
    try {
      data = (await resp.json()) as Record<string, unknown>;
    } catch {
      return;
    }

    const newAccessToken = typeof data['access_token'] === 'string' ? data['access_token'] : null;
    if (!newAccessToken) return;

    const newExpiresIn = typeof data['expires_in'] === 'number' ? data['expires_in'] : null;
    const newRefreshToken =
      typeof data['refresh_token'] === 'string' ? data['refresh_token'] : existing.refreshToken;

    await addCredential({
      ...existing,
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresAt: newExpiresIn != null ? Date.now() + newExpiresIn * 1000 : existing.expiresAt,
      lastStatus: 'ok',
      lastErrorCode: undefined,
      lastErrorResetAt: undefined,
    });
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

// ===========================================================================
// UnifiedCredentialPool — seed/pick/list over all registered seeders (T9412)
// ===========================================================================
//
// `UnifiedCredentialPool` is the unified credential pool described in
// E-CONFIG-AUTH-UNIFY E2a §5.2 T-E2-5. Where the per-provider `CredentialPool`
// above manages rotation/cooldown for an already-populated pool, the unified
// pool is the *seeding* layer: it walks `BUILTIN_SEEDERS`, applies consent +
// suppression gating, and upserts the discovered entries into the credential
// store via `addCredential` so a downstream resolver (T9413) can pick from a
// populated pool.
//
// The pool exposes:
//   - `seed({ force? })` — iterate every registered seeder, gate on consent
//     and suppression, swallow per-seeder errors (so one bad source can never
//     break the whole bootstrap), and upsert the returned entries.
//   - `pick(provider, opts)` — lazy-seed on first call, then read the store
//     synchronously via `pickCredentialForProviderSync`.
//   - `list()` — return every entry currently in the store without seeding.
//   - `getSeederStatus()` — snapshot of the last-result of every registered
//     seeder, suitable for `cleo status` / `cleo auth list` diagnostics.
//
// The pool is exposed as a process-wide singleton via `getCredentialPool()`.
// Tests requiring isolation MUST construct a fresh `new UnifiedCredentialPool()`
// (the registry argument allows pointing at an isolated `SeederRegistry`).

/**
 * Seed-attempt cache TTL — 60 seconds per E2a §5.2 T-E2-5 acceptance criterion.
 *
 * After a successful (non-`force`) seed pass, repeat calls to `seed()` are
 * short-circuited until this TTL elapses. `force: true` always bypasses the
 * cache. `lazy-seed` from `pick()` also honours the cache.
 *
 * @task T9412
 */
export const POOL_SEED_CACHE_TTL_MS = 60 * 1_000;

/**
 * Outcome of a single seeder's most-recent invocation.
 *
 * Returned in {@link UnifiedCredentialPool.getSeederStatus} for diagnostic
 * surfaces (`cleo status`, `cleo auth list --verbose`).
 *
 * @task T9412
 */
export interface SeederStatus {
  /** Source id (e.g. `'env'`, `'claude-code'`). */
  sourceId: string;
  /** Provider this seeder produces credentials for. */
  provider: string;
  /** Epoch ms of the most recent invocation; `undefined` if never invoked. */
  lastSeededAt?: number;
  /** Outcome of the most recent invocation. */
  lastResult: 'ok' | 'failed' | 'skipped-consent' | 'skipped-suppressed';
  /** Number of entries the seeder produced on `lastSeededAt`. */
  entriesProduced?: number;
  /** Error message when `lastResult === 'failed'`. */
  error?: string;
}

/**
 * Aggregate counts returned by {@link UnifiedCredentialPool.seed}.
 *
 * @task T9412
 */
export interface PoolSeedResult {
  /** Number of seeders whose entries were successfully upserted. */
  added: number;
  /** Number of seeders that threw or whose upsert failed. */
  failed: number;
  /** Number of seeders skipped due to consent / suppression / cache. */
  skipped: number;
}

/**
 * Options accepted by {@link UnifiedCredentialPool.pick}.
 *
 * Forwarded to `pickCredentialForProviderSync` so callers can request a
 * specific strategy or label; the pool itself only handles the lazy-seed
 * hook before delegating.
 *
 * @task T9412
 */
export interface UnifiedPoolPickOptions {
  /** Override the store's default strategy. */
  strategy?: CredentialsStoreStrategy;
  /** Prefer a specific label (collapses to that entry if present). */
  preferLabel?: string;
  /** Skip the lazy-seed step (e.g. for diagnostic reads). Default `false`. */
  noSeed?: boolean;
}

/**
 * Process-wide debug log channel — kept minimal so the pool does not pull in
 * the broader `cleo log` plumbing. Mirrors the pattern used by the per-provider
 * pool above.
 *
 * Reads `process.env.CLEO_DEBUG` at call time so tests can toggle without
 * module reload. Output goes to `console.debug` so it shows under `--verbose`
 * but stays out of clean CLI output by default.
 *
 * @internal
 */
function debugLog(msg: string, ...rest: unknown[]): void {
  if (process.env['CLEO_DEBUG']) {
    console.debug(`[cleo:credential-pool] ${msg}`, ...rest);
  }
}

/**
 * Unified credential pool — drives every registered seeder, upserts the
 * discovered entries, and exposes `pick`/`list` over the populated store.
 *
 * Lifecycle:
 *
 *   1. First `pick()` (or explicit `seed()`) walks `BUILTIN_SEEDERS`.
 *   2. For each seeder: consent gate → suppression gate → `seed()` →
 *      upsert each returned entry via `addCredential` (preserves the
 *      seeder's `priority` hint when provided, otherwise the store's
 *      `max + 10` rule applies).
 *   3. A successful sweep stamps the cache; subsequent calls within
 *      {@link POOL_SEED_CACHE_TTL_MS} short-circuit unless `force: true`.
 *   4. `list()` reads the store directly — never triggers seeding so
 *      diagnostic surfaces (`cleo auth list`) are pure-read.
 *
 * Error isolation: a single seeder that throws does NOT short-circuit the
 * sweep. The failure is counted, the error stashed in `getSeederStatus`,
 * and the next seeder runs.
 *
 * @example
 * ```ts
 * const pool = getCredentialPool();
 * const entry = await pool.pick('anthropic');
 * if (entry) {
 *   // use entry.accessToken
 * }
 * ```
 *
 * @task T9412
 */
export class UnifiedCredentialPool {
  /** Epoch ms of last successful seed pass (`0` = never seeded). */
  private lastSeededAt = 0;

  /** Per-seeder diagnostics keyed on `${sourceId}::${provider}`. */
  private readonly seederStatus = new Map<string, SeederStatus>();

  /**
   * Construct a pool wired to a specific seeder registry.
   *
   * Production code uses the {@link getCredentialPool} singleton which wires
   * to `BUILTIN_SEEDERS`. Tests pass a fresh `SeederRegistry` to isolate
   * registration semantics from the process-wide singleton.
   *
   * @param registryGetter - Getter that returns the active list of seeders.
   *   Defaults to `BUILTIN_SEEDERS.getAll()`. A getter (not the array
   *   directly) is used so the pool stays in sync with seeders registered
   *   after construction.
   */
  constructor(
    private readonly registryGetter: () => readonly CredentialSeeder[] = () =>
      BUILTIN_SEEDERS.getAll(),
  ) {}

  /**
   * Walk every registered seeder, gate on consent + suppression, and upsert
   * the returned entries into the store.
   *
   * Cache rules:
   * - If `force !== true` and the last successful seed pass was less than
   *   {@link POOL_SEED_CACHE_TTL_MS} ago, the sweep is skipped entirely
   *   and `{ added: 0, failed: 0, skipped: <total-seeders> }` is returned.
   * - `force: true` always re-runs every seeder.
   *
   * Per-seeder rules:
   * - `isConsentEstablished?` returning `false` → skip (status:
   *   `'skipped-consent'`).
   * - `isSuppressed(provider, sourceId)` returning `true` → skip (status:
   *   `'skipped-suppressed'`).
   * - `seed()` throwing → counted as `failed`; the error is logged
   *   and stashed in `getSeederStatus`; the next seeder still runs.
   * - Each returned entry is upserted via `addCredential`; an upsert
   *   failure counts the seeder as `failed`.
   *
   * @param options - `{ force }` — bypass the 60s cache when `true`.
   * @returns Aggregate counts across every seeder.
   * @task T9412
   */
  async seed(options: { force?: boolean } = {}): Promise<PoolSeedResult> {
    const seeders = this.registryGetter();
    const now = Date.now();

    // ----- Cache short-circuit ------------------------------------------------
    if (
      !options.force &&
      this.lastSeededAt > 0 &&
      now - this.lastSeededAt < POOL_SEED_CACHE_TTL_MS
    ) {
      debugLog('seed: cache hit, skipping sweep', {
        ageMs: now - this.lastSeededAt,
        ttlMs: POOL_SEED_CACHE_TTL_MS,
      });
      return { added: 0, failed: 0, skipped: seeders.length };
    }

    let added = 0;
    let failed = 0;
    let skipped = 0;

    for (const seeder of seeders) {
      const key = `${seeder.sourceId}::${seeder.provider}`;
      const stampedAt = Date.now();

      // -- Consent gate -------------------------------------------------------
      if (typeof seeder.isConsentEstablished === 'function') {
        let consented: boolean;
        try {
          consented = await seeder.isConsentEstablished(seeder.provider);
        } catch (err) {
          // Treat a consent-gate exception as a failure rather than a skip:
          // the operator should know that a gate is broken.
          failed++;
          this.seederStatus.set(key, {
            sourceId: seeder.sourceId,
            provider: seeder.provider,
            lastSeededAt: stampedAt,
            lastResult: 'failed',
            error: `consent gate threw: ${err instanceof Error ? err.message : String(err)}`,
          });
          debugLog('seed: consent gate threw', { seeder: key, err });
          continue;
        }
        if (!consented) {
          skipped++;
          this.seederStatus.set(key, {
            sourceId: seeder.sourceId,
            provider: seeder.provider,
            lastSeededAt: stampedAt,
            lastResult: 'skipped-consent',
          });
          continue;
        }
      }

      // -- Suppression gate ---------------------------------------------------
      // The suppression list is keyed on `(provider, SeederSourceId)`; since
      // `SeederSourceId` is the union the seeder's `sourceId` is constrained
      // to, the cast is sound.
      let suppressed: boolean;
      try {
        suppressed = isSuppressed(seeder.provider, seeder.sourceId);
      } catch (err) {
        // A broken suppression-file read should not block seeding — treat as
        // un-suppressed but log the failure for diagnostics.
        debugLog('seed: isSuppressed threw — treating as un-suppressed', {
          seeder: key,
          err,
        });
        suppressed = false;
      }
      if (suppressed) {
        skipped++;
        this.seederStatus.set(key, {
          sourceId: seeder.sourceId,
          provider: seeder.provider,
          lastSeededAt: stampedAt,
          lastResult: 'skipped-suppressed',
        });
        continue;
      }

      // -- Invoke seeder ------------------------------------------------------
      let entries: SeederCredentialEntry[];
      try {
        const result = await seeder.seed();
        entries = result.entries;
      } catch (err) {
        failed++;
        this.seederStatus.set(key, {
          sourceId: seeder.sourceId,
          provider: seeder.provider,
          lastSeededAt: stampedAt,
          lastResult: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
        debugLog('seed: seeder threw', { seeder: key, err });
        continue;
      }

      // -- Upsert entries -----------------------------------------------------
      let upsertFailed = false;
      for (const entry of entries) {
        try {
          await addCredential(entry);
        } catch (err) {
          upsertFailed = true;
          debugLog('seed: addCredential threw', { seeder: key, label: entry.label, err });
          // Stash the first upsert error so getSeederStatus surfaces something.
          this.seederStatus.set(key, {
            sourceId: seeder.sourceId,
            provider: seeder.provider,
            lastSeededAt: stampedAt,
            lastResult: 'failed',
            entriesProduced: entries.length,
            error: `addCredential threw for '${entry.label}': ${err instanceof Error ? err.message : String(err)}`,
          });
          break;
        }
      }
      if (upsertFailed) {
        failed++;
        continue;
      }

      added++;
      this.seederStatus.set(key, {
        sourceId: seeder.sourceId,
        provider: seeder.provider,
        lastSeededAt: stampedAt,
        lastResult: 'ok',
        entriesProduced: entries.length,
      });
    }

    // Only stamp the cache on a complete sweep — caller may still force-rerun.
    this.lastSeededAt = Date.now();

    return { added, failed, skipped };
  }

  /**
   * Pick a credential for the given provider, lazy-seeding on first call.
   *
   * Behaviour:
   * - First call (or after `resetForTests()`) triggers a `seed()` pass.
   * - Subsequent calls within {@link POOL_SEED_CACHE_TTL_MS} skip seeding.
   * - The actual pick delegates to `pickCredentialForProviderSync` so the
   *   strategy + label-preference semantics match the rest of the store.
   *
   * @param provider - LLM transport to pick for.
   * @param options - Optional strategy / label / no-seed flag.
   * @returns The selected `StoredCredential`, or `null` when the pool is
   *   empty (or every entry has expired / been disabled).
   * @task T9412
   */
  async pick(
    provider: ModelTransport,
    options: UnifiedPoolPickOptions = {},
  ): Promise<StoredCredential | null> {
    if (!options.noSeed) {
      await this.seed();
    }
    return pickCredentialForProviderSync(provider, {
      ...(options.strategy != null && { strategy: options.strategy }),
      ...(options.preferLabel != null && { preferLabel: options.preferLabel }),
    });
  }

  /**
   * List every entry currently in the credential store.
   *
   * Pure read — never triggers seeding. Intended for diagnostic surfaces
   * (`cleo auth list`, `cleo status`) where calling `seed()` would be
   * surprising side-effect.
   *
   * @returns Read-only snapshot sorted by file order (insertion).
   * @task T9412
   */
  async list(): Promise<readonly StoredCredential[]> {
    return listCredentials();
  }

  /**
   * Snapshot of the last-known outcome of every registered seeder.
   *
   * Seeders that have never been invoked do not appear in the snapshot.
   *
   * @returns Read-only array of {@link SeederStatus} entries.
   * @task T9412
   */
  getSeederStatus(): readonly SeederStatus[] {
    return Array.from(this.seederStatus.values());
  }

  /**
   * Test-only: invalidate the seed cache and clear status snapshots.
   *
   * Production code MUST NOT call this — it bypasses the 60s rate-limit
   * that exists specifically to prevent runaway seeding under tight retry
   * loops. The export is prefixed `_` to match the convention used by
   * `credentials-store.ts` for analogous helpers (`_resetRoundRobinForTests`).
   *
   * @internal
   */
  _resetForTests(): void {
    this.lastSeededAt = 0;
    this.seederStatus.clear();
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor
// ---------------------------------------------------------------------------

/**
 * Module-state singleton — `null` until the first {@link getCredentialPool}
 * call constructs the instance. Lazy construction keeps test runners that
 * import the module without ever calling `getCredentialPool` from paying the
 * seeder-registration cost.
 *
 * @internal
 */
let _singleton: UnifiedCredentialPool | null = null;

/**
 * Return the process-wide {@link UnifiedCredentialPool} singleton.
 *
 * Re-imports of this module yield the same instance under Node ESM's module
 * cache. Tests that need an isolated pool MUST construct one directly
 * (`new UnifiedCredentialPool(...)`) rather than mutating this singleton.
 *
 * @returns The shared pool instance.
 * @task T9412
 */
export function getCredentialPool(): UnifiedCredentialPool {
  if (_singleton === null) {
    _singleton = new UnifiedCredentialPool();
  }
  return _singleton;
}

/**
 * Test-only: drop the singleton so the next {@link getCredentialPool} call
 * constructs a fresh instance.
 *
 * Production callers MUST NOT use this — recreating the pool drops the seed
 * cache and forces a re-sweep on the next `pick()`.
 *
 * @internal
 */
export function _resetCredentialPoolSingletonForTests(): void {
  _singleton = null;
}
