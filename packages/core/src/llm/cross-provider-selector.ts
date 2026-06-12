/**
 * Cross-provider provisioning-aware LLM selection (DHQ-081 · T11978).
 *
 * ## Problem
 *
 * `selectProviderModel` in `role-resolver.ts` (tier 8) falls back to
 * `IMPLICIT_FALLBACK_PROVIDER = 'anthropic'` unconditionally when all 7
 * config tiers miss. This means a machine with only `OPENAI_API_KEY` set
 * still resolves to `anthropic` and returns `credential: null`, causing a
 * silent 401 / graceful-degradation miss.
 *
 * ## Fix
 *
 * When all config tiers miss, instead of immediately returning the hardcoded
 * `anthropic` fallback, `selectBestProvisioned` is called. It:
 *
 *   1. Enumerates all {@link BUILTIN_PROVIDER_IDS} (11 providers).
 *   2. **Refresh-on-use (T11986 · DHQ-087)**: for any provider with an
 *      expired-but-refreshable OAuth credential, attempts a refresh BEFORE
 *      the provisioning probe so the selector sees a valid token instead of
 *      silently filtering the provider as "not-provisioned".
 *   3. Probes which are provisioned (have a non-exhausted, non-expired
 *      credential in the cred store OR a non-empty env var).
 *   4. Ranks provisioned providers by `scoreProvider(provider, taskTier)`.
 *   5. Returns the winner's `SelectedProviderModel`, or `null` if nothing
 *      is provisioned (caller falls through to the anthropic implicit fallback,
 *      preserving backward compat).
 *
 * ## Gate-13 compliance
 *
 * This module:
 * - MUST NOT construct any transport or SDK client.
 * - MUST NOT read `process.env.*_API_KEY` directly — delegates to the
 *   credential layer (`resolveCredentials`, `pickCredentialForProviderSync`).
 * - MUST NOT define a new exported `resolveLLMFor*` function.
 * - MUST NOT hardcode model-id literals outside the provider-registry SSoT.
 *
 * @module llm/cross-provider-selector
 * @task T11978
 * @task T11986
 * @epic T11679
 */

import { totalmem } from 'node:os';
import type { ResolutionSource } from '@cleocode/contracts';
import type { ProviderTier } from '@cleocode/contracts/llm/provider-profile.js';
import { getLogger } from '../logger.js';
import { refreshExpiredOAuthForProvider } from './credential-pool.js';
import { resolveCredentials } from './credentials.js';
import { listCredentials, pickCredentialForProviderSync } from './credentials-store.js';
import type { ModelTransport } from './types-config.js';

const logger = getLogger('llm-cross-provider-selector');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The canonical set of builtin provider IDs that the cross-provider selector
 * enumerates. Mirrors `BuiltinProviderId` (contracts/src/llm/provider-id.ts).
 * Defined here as a runtime array so we can iterate without importing the
 * union type.
 *
 * @task T11978
 */
export const BUILTIN_PROVIDER_IDS: ReadonlyArray<ModelTransport> = [
  'anthropic',
  'openai',
  'gemini',
  'moonshot',
  'openrouter',
  'bedrock',
  'deepseek',
  'xai',
  'groq',
  'kimi-code',
  'ollama',
] as const;

/**
 * Tier base scores for the scoring function.
 * Local gets a relatively high base so a running ollama beats a missing cloud
 * provider, but PROVISIONED_CLOUD_BIAS pushes provisioned cloud above running local.
 *
 * @task T11978
 */
const TIER_BASE: Record<ProviderTier, number> = {
  frontier: 100,
  standard: 70,
  fast: 50,
  local: 120,
};

/**
 * Bias added for frontier/standard cloud providers that hold a valid credential.
 * This ensures a provisioned frontier cloud provider (anthropic, openai) outranks
 * a merely-running local ollama for frontier-tier tasks.
 *
 * Rationale (Q1 ratification): +60 on top of frontier's TIER_BASE=100 → score
 * 160 ≥ local's TIER_BASE=120 + LOCALITY_BONUS=30 = 150.
 *
 * @task T11978
 */
export const PROVISIONED_CLOUD_BIAS = 60;

/**
 * Bonus applied when the ollama daemon is confirmed listening (TTL-cached probe).
 *
 * @task T11978
 */
const LOCALITY_BONUS = 30;

/**
 * Task-match bonus when the provider tier aligns with the requested task tier.
 *
 * @task T11978
 */
const TASK_MATCH_BONUS_FRONTIER = 20;
const TASK_MATCH_BONUS_FAST = 15;

/**
 * Maximum cost penalty (prevents dominated ranking on expensive providers).
 *
 * @task T11978
 */
const MAX_COST_PENALTY = 10;

/**
 * Ollama liveness probe timeout in milliseconds.
 *
 * @task T11978
 */
const OLLAMA_PROBE_TIMEOUT_MS = 200;

/**
 * Ollama liveness cache TTL in milliseconds (30 seconds).
 *
 * @task T11978
 */
const OLLAMA_PROBE_TTL_MS = 30_000;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Internal shape returned by {@link selectBestProvisioned}.
 * Mirrors the `SelectedProviderModel` interface in `role-resolver.ts`.
 * Kept internal — callers receive `SelectedProviderModel` via the role-resolver.
 *
 * @internal
 */
export interface SelectedProviderModel {
  provider: ModelTransport;
  model: string;
  credentialLabel: string | undefined;
  source: ResolutionSource;
}

/**
 * Provisioning state and score for a single provider.
 *
 * @task T11978
 */
export interface ProviderEnumeration {
  /** Provider canonical ID. */
  id: ModelTransport;
  /** Human-readable display name (from provider registry, or the id string). */
  displayName: string;
  /** Capability tier (from provider registry). */
  tier: ProviderTier;
  /** Whether the provider has at least one usable credential. */
  provisioningState: 'provisioned' | 'not-provisioned';
  /**
   * Credential reachability.
   * `'auth-reachable'` — has a non-expired, non-invalid, non-exhausted credential.
   * `'no-credential'` — no credential at all.
   * `'credential-expired'` — credential exists but is expired.
   * `'credential-invalid'` — credential exists but is marked invalid/exhausted.
   */
  reachabilityState:
    | 'auth-reachable'
    | 'no-credential'
    | 'credential-expired'
    | 'credential-invalid';
  /**
   * Whether the local ollama daemon is reachable.
   * `null` for non-local providers (tier !== 'local').
   */
  machineRunnable: boolean | null;
  /** Number of credentials in the store for this provider. */
  credentialCount: number;
  /** Score from the cross-provider scoring function (null if not provisioned). */
  resolverScore: number | null;
  /**
   * The model that would be selected by the catalog resolver for this provider.
   * `null` if no catalog is available.
   */
  wouldPickModel: string | null;
  /** Reason for selection. */
  wouldPickReason: 'cross-provider-best' | 'implicit-fallback' | 'not-selected';
}

// ---------------------------------------------------------------------------
// Ollama liveness cache
// ---------------------------------------------------------------------------

interface OllamaProbeEntry {
  alive: boolean;
  checkedAt: number;
}

const _ollamaProbeCache = new Map<string, OllamaProbeEntry>();

/**
 * Reset ollama probe cache for testing.
 * @internal
 */
export function _resetOllamaProbeCache(): void {
  _ollamaProbeCache.clear();
}

/**
 * Check whether the ollama daemon is listening at `baseUrl`.
 *
 * Uses a lightweight HTTP GET with a 200ms timeout. Result is cached in-process
 * for {@link OLLAMA_PROBE_TTL_MS} (30 seconds) to avoid hammering localhost on
 * every resolve call.
 *
 * Gate-13 note: this is a vanilla `fetch` call to probe localhost, NOT a
 * transport/SDK client construction — Gate-13 does not cover network utility calls.
 *
 * @param baseUrl - Ollama base URL (default: `http://localhost:11434`).
 * @returns `true` if the daemon responded with HTTP 200, `false` otherwise.
 *
 * @task T11978
 */
export async function probeOllamaAlive(baseUrl: string): Promise<boolean> {
  const cached = _ollamaProbeCache.get(baseUrl);
  if (cached && Date.now() - cached.checkedAt < OLLAMA_PROBE_TTL_MS) {
    return cached.alive;
  }

  let alive = false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OLLAMA_PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(baseUrl, { signal: controller.signal });
      alive = res.ok || res.status < 500;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    alive = false;
  }

  _ollamaProbeCache.set(baseUrl, { alive, checkedAt: Date.now() });
  return alive;
}

// ---------------------------------------------------------------------------
// Ollama RAM-gated model selection
// ---------------------------------------------------------------------------

/**
 * Select the appropriate ollama default model based on available RAM (DHQ-081 Q2).
 *
 * RAM gating uses `os.totalmem()` (Node.js built-in, no native addon required).
 * VRAM detection is out-of-scope (deferred to T11982 wizard task).
 *
 * Resolution:
 *   - RAM ≥ 8 GB → `gemma4:e4b` for frontier/standard; `gemma4:e2b` for fast/local.
 *   - 4 GB ≤ RAM < 8 GB → `gemma4:e2b` for all tiers.
 *   - RAM < 4 GB → `qwen2:0.5b` (proof-of-life only; logged as WARNING).
 *
 * Note: `qwen2:0.5b` MUST NOT be selected as a resolver default. It is a
 * last-resort proof-of-life floor for under-resourced machines.
 *
 * These string literals live here (the one allowed location outside
 * `ollama.ts`) because they are DEFAULTS within the selector logic. The
 * profile's `defaultModel`/`defaultAuxModel` fields are the primary SSoT;
 * the selector reads them via `getProviderProfile('ollama')` when available
 * and only falls back to these when the profile is unavailable (defensive).
 *
 * Tags live-verified 2026-06-11 on ollama.com/library/gemma4:
 *   - gemma4:e2b = 7.2 GB (Q4_K_M), edge 2B effective params, ≥ 4 GB RAM
 *   - gemma4:e4b = 9.6 GB (Q4_K_M), edge 4B effective params, ≥ 8 GB RAM
 * If the catalog does not yet have a `gemma4` family entry, the resolver
 * logs a hint to run `cleo llm refresh-catalog`.
 *
 * @param tier - The task tier for which a model is being selected.
 * @param ramBytesOverride - Override `os.totalmem()` for testing.
 * @returns The model ID string to use for ollama.
 *
 * @task T11978
 */
export function ollamaDefaultModelForTier(tier: ProviderTier, ramBytesOverride?: number): string {
  const ramBytes = ramBytesOverride ?? totalmem();
  const gb = ramBytes / 1024 ** 3;

  if (gb >= 8) {
    // High-RAM: use gemma4:e4b for standard/frontier, gemma4:e2b for fast/local
    return tier === 'fast' || tier === 'local' ? 'gemma4:e2b' : 'gemma4:e4b';
  }
  if (gb >= 4) {
    // Mid-RAM: gemma4:e2b for all tiers
    return 'gemma4:e2b';
  }
  // Low-RAM proof-of-life floor — NEVER a default for any task tier
  logger.warn(
    { ramGb: gb.toFixed(1), tier },
    'cross-provider-selector: RAM < 4 GB; selecting qwen2:0.5b (proof-of-life only — not suitable for production)',
  );
  return 'qwen2:0.5b';
}

// ---------------------------------------------------------------------------
// Provisioning probe
// ---------------------------------------------------------------------------

/**
 * Check whether a provider is provisioned (has at least one usable credential).
 *
 * A provider is provisioned if:
 * - It has a non-expired, non-disabled credential entry in the credentials store, OR
 * - Its canonical env var is set and non-empty in the process environment.
 *
 * Gate-13 compliance: this delegates to `resolveCredentials()` (inside the
 * credential layer) rather than reading `process.env.*_API_KEY` directly.
 *
 * Special case — ollama: ollama does not require a key. It is considered
 * provisioned when `OLLAMA_HOST` is set OR the default localhost URL is
 * reachable (checked by `probeOllamaAlive`). However, `probeOllamaAlive` is
 * async, so the sync provisioning check treats ollama as provisioned if
 * `OLLAMA_HOST` is set OR the store has an entry. Liveness is checked
 * separately during scoring.
 *
 * @param provider - The provider transport ID to check.
 * @returns `true` if the provider has at least one usable credential.
 *
 * @task T11978
 */
function isProvisioned(provider: ModelTransport): boolean {
  // For ollama: check if OLLAMA_HOST is set OR store has an entry.
  // Ollama can run without a key; the env var OLLAMA_HOST signals intent.
  if (provider === 'ollama') {
    if (process.env['OLLAMA_HOST']?.trim()) return true;
    // Check the credential store (may have a stored base URL / token).
    const stored = pickCredentialForProviderSync(provider, { strategy: 'priorityOnly' });
    return stored !== null;
  }

  // For all other providers: use the sync credential resolver (tier 2+3 only —
  // no project-config look-up needed for provisioning check).
  const cred = resolveCredentials(provider); // llm-resolve-allowed: provisioning probe only — checks if cred exists; never constructs a transport or client
  return (cred.apiKey?.trim().length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a provisioned provider for a given task tier.
 *
 * Higher score = preferred. Tie-break by credential priority (lower priority
 * value = higher user-assigned trust) is handled in {@link selectBestProvisioned}.
 *
 * Scoring formula:
 * ```
 * score = TIER_BASE[tier]
 *       + TASK_MATCH_BONUS (if tier aligns with taskTier)
 *       + LOCALITY_BONUS (local + daemon alive)
 *       + PROVISIONED_CLOUD_BIAS (frontier/standard cloud providers with valid cred)
 *       - COST_PENALTY (capped at MAX_COST_PENALTY)
 * ```
 *
 * @param provider - The provider transport ID.
 * @param providerTier - The capability tier of the provider.
 * @param taskTier - The capability tier required by the current task.
 * @param ollamaAlive - Whether the ollama daemon is currently reachable.
 * @param costInputPerMillion - Cost per 1M input tokens (from catalog), or 0.
 * @returns The numeric score (higher = preferred).
 *
 * @task T11978
 */
export function scoreProvider(
  provider: ModelTransport,
  providerTier: ProviderTier,
  taskTier: ProviderTier,
  ollamaAlive: boolean,
  costInputPerMillion: number,
): number {
  let score = TIER_BASE[providerTier];

  // Task-match bonus: reward providers whose tier aligns with what the task needs.
  if (taskTier === 'frontier' && providerTier === 'frontier') {
    score += TASK_MATCH_BONUS_FRONTIER;
  } else if (
    (taskTier === 'fast' || taskTier === 'local') &&
    (providerTier === 'fast' || providerTier === 'local')
  ) {
    score += TASK_MATCH_BONUS_FAST;
  }

  // Locality bonus: local provider + daemon confirmed up.
  if (providerTier === 'local' && ollamaAlive) {
    score += LOCALITY_BONUS;
  }

  // Provisioned cloud bias: frontier/standard cloud providers with a valid
  // credential beat a merely-running local ollama for frontier-tier tasks.
  // This implements Q1 ratification: provisioned cloud > running-only local.
  if ((providerTier === 'frontier' || providerTier === 'standard') && provider !== 'ollama') {
    score += PROVISIONED_CLOUD_BIAS;
  }

  // Cost penalty: slight preference for cheaper providers (capped).
  const penalty = Math.min(Math.floor(costInputPerMillion / 10), MAX_COST_PENALTY);
  score -= penalty;

  return score;
}

/**
 * Map a role name to a task tier for scoring purposes.
 *
 * @param role - The LLM role name.
 * @returns The task tier for the role.
 *
 * @task T11978
 */
export function roleTierFor(role: string): ProviderTier {
  switch (role) {
    case 'consolidation':
    case 'judgement':
    case 'hygiene':
      return 'frontier';
    case 'extraction':
    case 'derivation':
      return 'standard';
    default:
      return 'fast';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enumerate all builtin providers with their provisioning state and scores.
 *
 * Used by `cleo llm providers` and `cleo llm health` subcommands to display
 * the full provisioning landscape to the user.
 *
 * @param taskTier - The task tier to score against (defaults to `'frontier'`).
 * @returns Array of provider enumeration records.
 *
 * @task T11978
 */
export async function enumerateProvisionedProviders(
  taskTier: ProviderTier = 'frontier',
): Promise<ProviderEnumeration[]> {
  // Lazy import to avoid circular deps at module init time.
  const { getProviderProfile } = await import('./provider-registry/index.js');
  const { resolveProviderDefaultModel } = await import('./catalog-model-resolver.js');

  const ollamaDefaultBase = 'http://localhost:11434';
  let ollamaAlive = false;
  try {
    ollamaAlive = await probeOllamaAlive(ollamaDefaultBase);
  } catch {
    ollamaAlive = false;
  }

  // Refresh-on-use (T11986 · DHQ-087): before probing provisioning state,
  // attempt to refresh any expired-but-refreshable OAuth credential for each
  // provider. This ensures an expired OAT with a stored refresh token is
  // renewed in-place so `isProvisioned()` sees a valid access token and
  // correctly reports the provider as provisioned rather than filtering it.
  // Failures are soft-logged — a provider that cannot refresh still falls
  // through with `reachabilityState: 'credential-expired'` as before.
  for (const id of BUILTIN_PROVIDER_IDS) {
    const credsBefore = await listCredentials(id);
    const hasExpiredOAuth = credsBefore.some(
      (c) =>
        c.authType === 'oauth' &&
        c.refreshToken &&
        typeof c.expiresAt === 'number' &&
        c.expiresAt > 0 &&
        c.expiresAt <= Date.now(),
    );
    if (!hasExpiredOAuth) continue;

    try {
      const result = await refreshExpiredOAuthForProvider(id);
      if (result.actionableHint) {
        logger.info(
          { provider: id, hint: result.actionableHint },
          'cross-provider-selector: OAuth refresh failed during enumeration',
        );
      } else if (result.refreshed > 0) {
        logger.debug(
          { provider: id, refreshed: result.refreshed },
          'cross-provider-selector: refreshed expired OAuth credential before enumeration',
        );
      }
    } catch {
      // Non-fatal: provider is left in its pre-refresh state.
    }
  }

  const results: ProviderEnumeration[] = [];

  for (const id of BUILTIN_PROVIDER_IDS) {
    const profile = await getProviderProfile(id);
    const displayName = profile?.displayName ?? id;
    const tier: ProviderTier = (profile?.tier as ProviderTier | undefined) ?? 'standard';

    // Credential count
    const allCreds = await listCredentials(id);
    const credentialCount = allCreds.length;

    // Provisioning state (checked AFTER any refresh above).
    const provisioned = isProvisioned(id);
    const provisioningState: 'provisioned' | 'not-provisioned' = provisioned
      ? 'provisioned'
      : 'not-provisioned';

    // Reachability state
    let reachabilityState: ProviderEnumeration['reachabilityState'] = 'no-credential';
    if (provisioned) {
      const cred = resolveCredentials(id); // llm-resolve-allowed: enumeration surface only — never constructs transport or client
      if (cred.apiKey) {
        reachabilityState = 'auth-reachable';
      }
    } else if (credentialCount > 0) {
      // Has credentials in store but none are currently eligible
      // (all expired or invalid — we can't distinguish precisely from the public API,
      // so check expiry vs invalid status via store).
      reachabilityState = 'credential-expired';
    }

    // Machine-runnable (ollama only)
    const machineRunnable: boolean | null = tier === 'local' ? ollamaAlive : null;

    // Score
    const resolverScore = provisioned ? scoreProvider(id, tier, taskTier, ollamaAlive, 0) : null;

    // Would-pick model
    let wouldPickModel: string | null = null;
    try {
      const { catalogKeyForProvider } = await import('./catalog-model-resolver.js');
      wouldPickModel = resolveProviderDefaultModel(catalogKeyForProvider(id));
    } catch {
      wouldPickModel = profile?.defaultModel ?? null;
    }
    if (!wouldPickModel) {
      wouldPickModel = profile?.defaultModel ?? null;
    }

    results.push({
      id,
      displayName,
      tier,
      provisioningState,
      reachabilityState,
      machineRunnable,
      credentialCount,
      resolverScore,
      wouldPickModel,
      wouldPickReason: provisioned ? 'cross-provider-best' : 'not-selected',
    });
  }

  // Mark the actual winner
  const provisioned = results.filter((r) => r.resolverScore !== null);
  if (provisioned.length > 0) {
    const winner = provisioned.reduce((best, r) =>
      (r.resolverScore ?? -Infinity) > (best.resolverScore ?? -Infinity) ? r : best,
    );
    for (const r of results) {
      if (r.id === winner.id) {
        r.wouldPickReason = 'cross-provider-best';
      } else if (r.provisioningState === 'not-provisioned') {
        r.wouldPickReason = 'not-selected';
      } else {
        r.wouldPickReason = 'not-selected';
      }
    }
  }

  return results;
}

/**
 * Select the best provisioned provider for the given role.
 *
 * Called at tier 8 of `selectProviderModel` in `role-resolver.ts`, replacing
 * the unconditional `IMPLICIT_FALLBACK_PROVIDER = 'anthropic'` hardcode.
 *
 * ## Algorithm
 *
 *   1. Enumerate all {@link BUILTIN_PROVIDER_IDS}.
 *   2. Filter to those that are provisioned (cred store or env var).
 *   3. Score each provisioned provider.
 *   4. Pick the highest scorer. Tie-break: lowest credential priority value.
 *   5. Resolve the model via catalog (`resolveProviderDefaultModel`) or
 *      provider profile `defaultModel`.
 *   6. For ollama: gate model selection on `os.totalmem()`.
 *
 * ## When nothing is provisioned
 *
 * Returns `null`. The caller falls through to the hardcoded anthropic fallback,
 * preserving backward compatibility.
 *
 * ## Gate-13 compliance
 *
 * Does NOT construct any transport or SDK client. Does NOT read
 * `process.env.*_API_KEY` directly (delegates to credential layer).
 * Does NOT define a new `resolveLLMFor*` function.
 *
 * @param role - The LLM role name (used to derive `taskTier`).
 * @param opts - Options including `projectRoot`.
 * @returns The best {@link SelectedProviderModel}, or `null` if nothing is provisioned.
 *
 * @task T11978
 */
export async function selectBestProvisioned(
  role: string,
  opts: { projectRoot: string },
): Promise<SelectedProviderModel | null> {
  const taskTier = roleTierFor(role);

  // Refresh-on-use (T11986 · DHQ-087): attempt to refresh any expired-but-
  // refreshable OAuth credential for each provider BEFORE the provisioning
  // probe. This ensures an expired OAT with a valid refresh token is renewed
  // so `isProvisioned()` below sees an up-to-date access token. Only providers
  // with at least one expired OAuth entry trigger a refresh attempt. Failures
  // are logged but non-fatal — the provider is still filtered as
  // "not-provisioned" if the refresh could not succeed.
  for (const id of BUILTIN_PROVIDER_IDS) {
    const creds = await listCredentials(id);
    const hasExpiredOAuth = creds.some(
      (c) =>
        c.authType === 'oauth' &&
        c.refreshToken &&
        typeof c.expiresAt === 'number' &&
        c.expiresAt > 0 &&
        c.expiresAt <= Date.now(),
    );
    if (!hasExpiredOAuth) continue;

    try {
      const result = await refreshExpiredOAuthForProvider(id);
      if (result.actionableHint) {
        logger.warn(
          { provider: id, hint: result.actionableHint },
          'cross-provider-selector: OAuth refresh-on-use failed — credential will be excluded from resolution',
        );
      } else if (result.refreshed > 0) {
        logger.debug(
          { provider: id, refreshed: result.refreshed },
          'cross-provider-selector: renewed expired OAuth credential via refresh-on-use',
        );
      }
    } catch {
      // Non-fatal: provider remains in its pre-refresh state.
    }
  }

  // Collect provisioned providers (checked AFTER any refresh above so renewed
  // tokens are visible to the sync credential store reader).
  const provisionedIds: ModelTransport[] = [];
  for (const id of BUILTIN_PROVIDER_IDS) {
    if (isProvisioned(id)) {
      provisionedIds.push(id);
    }
  }

  if (provisionedIds.length === 0) {
    logger.warn(
      {
        providers_checked: BUILTIN_PROVIDER_IDS.slice(),
        reason: 'no-provisioned-provider',
        role,
        projectRoot: opts.projectRoot,
      },
      'resolveLLMForSystem: no provider has a usable credential; returning null-credential envelope',
    );
    return null;
  }

  // Lazy imports (avoid circular deps at module init time).
  const { getProviderProfile } = await import('./provider-registry/index.js');
  const { resolveProviderDefaultModel, catalogKeyForProvider } = await import(
    './catalog-model-resolver.js'
  );
  const { pickCredentialForProvider } = await import('./credentials-store.js');

  // Probe ollama liveness only when ollama is in the provisioned set.
  const ollamaProvisioned = provisionedIds.includes('ollama');
  let ollamaAlive = false;
  if (ollamaProvisioned) {
    const profile = await getProviderProfile('ollama');
    const ollamaBase = profile?.baseUrl ?? 'http://localhost:11434';
    ollamaAlive = await probeOllamaAlive(ollamaBase);
  }

  // Score all provisioned providers.
  type ScoredProvider = {
    id: ModelTransport;
    tier: ProviderTier;
    score: number;
    credentialPriority: number;
  };

  const scored: ScoredProvider[] = [];

  for (const id of provisionedIds) {
    const profile = await getProviderProfile(id);
    const tier: ProviderTier = (profile?.tier as ProviderTier | undefined) ?? 'standard';

    // Cost info (from catalog, best-effort; 0 if unavailable).
    const costInput = 0;
    // Cost penalty is not implemented here yet; catalog cost lookup is
    // non-trivial and deferred to T11982. Keeping the formula extension point.

    const score = scoreProvider(id, tier, taskTier, ollamaAlive, costInput);

    // Tie-break: get credential priority from the store.
    const storedCred = await pickCredentialForProvider(id, { strategy: 'priorityOnly' });
    const credentialPriority = storedCred?.priority ?? Number.MAX_SAFE_INTEGER;

    scored.push({ id, tier, score, credentialPriority });
  }

  // Sort by score DESC, then credentialPriority ASC (lower = higher trust).
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.credentialPriority - b.credentialPriority;
  });

  const winner = scored[0];
  if (!winner) return null;

  // Resolve model for the winning provider.
  let model: string;
  if (winner.id === 'ollama') {
    // For ollama: gate on RAM, falling back to profile.defaultModel (gemma3:4b/1b).
    const ollamaProfile = await getProviderProfile('ollama');
    const ramBytes = totalmem();
    const gb = ramBytes / 1024 ** 3;

    if (gb >= 8) {
      model =
        (winner.tier === 'fast' || taskTier === 'fast'
          ? ollamaProfile?.defaultAuxModel
          : ollamaProfile?.defaultModel) ?? ollamaDefaultModelForTier(winner.tier);
    } else if (gb >= 4) {
      model = ollamaProfile?.defaultAuxModel ?? 'gemma4:e2b';
    } else {
      // Proof-of-life floor — logged as warning by ollamaDefaultModelForTier.
      model = ollamaDefaultModelForTier(winner.tier, ramBytes);
    }

    // Log hint if gemma4 family is not in catalog
    const catalogKey = catalogKeyForProvider(winner.id);
    const catalogModel = resolveProviderDefaultModel(catalogKey);
    if (!catalogModel?.startsWith('gemma4')) {
      logger.info(
        { provider: 'ollama', selectedModel: model },
        'cross-provider-selector: gemma4 family not in catalog snapshot — run `cleo llm refresh-catalog` to pull latest',
      );
    }
  } else {
    // Non-ollama: use catalog default model (latest release_date), fallback to profile.
    try {
      const catalogKey = catalogKeyForProvider(winner.id);
      const catalogModel = resolveProviderDefaultModel(catalogKey);
      const profileModel = (await getProviderProfile(winner.id))?.defaultModel;
      model = catalogModel ?? profileModel ?? 'unknown';
    } catch {
      model = (await getProviderProfile(winner.id))?.defaultModel ?? 'unknown';
    }
  }

  logger.debug(
    {
      winner: winner.id,
      score: winner.score,
      taskTier,
      model,
      provisionedCount: provisionedIds.length,
    },
    'cross-provider-selector: selected best provisioned provider',
  );

  return {
    provider: winner.id,
    model,
    credentialLabel: undefined,
    source: 'cross-provider',
  };
}
