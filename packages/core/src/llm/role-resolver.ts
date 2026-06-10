/**
 * Role-based LLM resolution for CLEO (Phase 4 — T9306).
 *
 * Each call-site declares its semantic role (`extraction`, `consolidation`,
 * `derivation`, `hygiene`, `judgement`); the resolver walks the config to
 * find the configured provider/model/credential for that role and returns a
 * fully-wired SDK client plus its `CredentialResult`.
 *
 * ## Resolution chain (first match wins)
 *
 * Provider/model:
 *   1. `config.llm.roles[role]`        — explicit per-role override
 *   2. `config.llm.default`            — canonical default
 *   3. Implicit fallback               — `anthropic` + {@link IMPLICIT_FALLBACK_MODEL}
 *
 * Credential:
 *   1. When `roles[role].credentialLabel` is set → `getCredentialByLabel(provider, label)`
 *   2. Else → `pickCredentialForProvider(provider, { strategy: 'priorityWithFallback' })`
 *      (T-LLM-CRED Phase 2 multi-credential pool)
 *   3. Fallback → `resolveCredentials(provider, { projectRoot })` 6-tier chain
 *
 * The resolver never throws on missing credentials: it returns `credential: null`
 * so callers can preserve their existing graceful-degradation paths.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 4 (T9306)
 * @module llm/role-resolver
 */

import type { Anthropic } from '@anthropic-ai/sdk';
import type {
  ApiMode,
  CleoConfig,
  CredentialMetadataWire,
  LlmConfig,
  LlmDefaultConfig,
  LlmProfileConfig,
  LlmRoleConfig,
  ModelCaps,
  ResolutionSource,
  ResolveLLMForRoleOptions,
  RoleName,
  SealedCredential,
  SystemBinding,
} from '@cleocode/contracts';
import type { OpenAI } from 'openai';
import { resolveOrCwd } from '../paths.js';
import { deriveApiWire } from './api-mode.js';
import { CredentialPool } from './credential-pool.js';
import { type CredentialResult, resolveCredentials } from './credentials.js';
import { getCredentialByLabel, pickCredentialForProvider } from './credentials-store.js';
import { IMPLICIT_FALLBACK_MODEL } from './fallback-model.js';
import { makeSealedCredential, tokenPreview } from './sealed-credential.js';
import { getRegisteredSystemDefault } from './system-of-use-registry.js';
import { buildAnthropicClient } from './transports/anthropic-client-factory.js';
import type { ModelTransport } from './types-config.js';

/**
 * Implicit fallback model used when no role-specific and no `default` entry is
 * present in config. Mirrors the historical hardcoded `claude-haiku-4-5-20251001`
 * that the 7 call-sites previously embedded.
 *
 * The literal is defined in the dependency-free leaf `./fallback-model.ts` (so
 * `config.ts` can read it without entering this module's circular import chain —
 * see that file's docs) and re-exported here so existing
 * `from './role-resolver.js'` consumers are unaffected. It still lives ONLY
 * under `packages/core/src/llm/`, keeping the T9255 grep guard clean.
 *
 * @task T9255
 */
export { IMPLICIT_FALLBACK_MODEL };

/**
 * Implicit fallback provider matching {@link IMPLICIT_FALLBACK_MODEL}.
 *
 * @task T9255
 */
export const IMPLICIT_FALLBACK_PROVIDER: ModelTransport = 'anthropic';

/**
 * Implicit fallback model for the `hygiene` role.
 *
 * Hygiene escalation runs longer reasoning prompts than the
 * consolidation/extraction tiers; the historical default has been
 * `claude-sonnet-4-6` (one tier up from {@link IMPLICIT_FALLBACK_MODEL}).
 * Centralised here so the grep guard catches any drift outside
 * `packages/core/src/llm/`.
 *
 * Only consulted when `resolveLLMForRole('hygiene')` returns
 * `source === 'implicit-fallback'` AND `model === IMPLICIT_FALLBACK_MODEL`
 * — i.e. no project/global config and no role pin supplied a model.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — DRY review P2-2
 */
export const HYGIENE_FALLBACK_MODEL = 'claude-sonnet-4-6';

/**
 * Concrete tagged union over the raw SDK client types used by this module.
 * This is the runtime-precise version of the opaque `unknown` carried by
 * `ResolvedLLM.client` in `@cleocode/contracts` — SDK classes are kept off
 * the contracts surface to preserve its zero-dependency footprint, but
 * tightened here where the SDK packages are real dependencies.
 *
 * NOTE (T9370): GoogleGenerativeAI removed from the union — `resolveLLMForRole`
 * is Anthropic-only in practice (the implicit fallback is always anthropic, and
 * non-Anthropic providers use the transport layer directly). The `Record` fallback
 * covers any future provider shape that doesn't use a typed SDK class here.
 *
 * @task T9255
 * @task T9370 (D-ph4-01 factory retirement)
 */
export type LLMClient = Anthropic | OpenAI | Record<string, unknown>; // OpenAI fallback shape for non-Anthropic providers

// Re-export the wire types so existing imports from
// `@cleocode/core/llm/role-resolver` keep working alongside the canonical
// home in `@cleocode/contracts`.
export type { ResolutionSource, ResolveLLMForRoleOptions };

/**
 * Result of {@link resolveLLMForRole} — runtime-precise envelope.
 *
 * The contracts-level `ResolvedLLM` (from `@cleocode/contracts`) carries
 * `client: unknown` to stay SDK-free. This core variant tightens the same
 * envelope with the concrete SDK union (`LLMClient`) — same shape, narrower
 * `client` type.
 *
 * `client` is `null` only when {@link sealedCredential} is also null — in which
 * case the caller MUST fall back to its graceful-degradation path
 * (return null / skip / log warn).
 *
 * ## E10 — no inline plaintext (T11753)
 *
 * The secret-bearing `credential.apiKey` field is **gone**. `credential` is now
 * non-secret {@link CredentialMetadataWire} metadata (provider / source /
 * authType) so callers can still branch on auth scheme and surface diagnostics.
 * The plaintext token is reachable ONLY via {@link sealedCredential}'s `fetch()`
 * at the wire (`transportForProvider` / `session-factory.ts`) or daemon
 * worker-injection — it never crosses this envelope.
 *
 * @task T9255
 * @task T11753
 */
export interface ResolvedLLM {
  /** LLM provider transport that was resolved. */
  provider: ModelTransport;
  /** Full model identifier. */
  model: string;
  /**
   * Fully-wired SDK client. `null` when no credential is available.
   * For Anthropic: constructed via `new Anthropic(...)` honoring OAuth/api_key.
   * For other providers: `null` (use the transport layer directly via `getLlmExecutor`).
   */
  client: LLMClient | null;
  /**
   * Resolved credential **metadata** (provider / source / authType) — NO
   * plaintext. `null` when none of the 6 credential tiers produced a token
   * (paired with `sealedCredential === null`). Callers MUST handle this case
   * and obtain the secret via {@link sealedCredential}.
   *
   * @task T11753
   */
  credential: CredentialMetadataWire | null;
  /**
   * Sealed credential handle — the canonical, on-demand credential surface
   * (E10 · T11752 · T11753). `null` exactly when `credential` is `null`.
   *
   * The plaintext is materialized ONLY by `sealedCredential.fetch()` at the
   * wire / daemon worker-injection — never returned up this envelope.
   *
   * @task T11753
   */
  sealedCredential: SealedCredential | null;
  /** Which config path produced this resolution. */
  source: ResolutionSource;
  /** When `roles[role].credentialLabel` was set, the label that was used. */
  credentialLabel?: string;
  /**
   * Wire protocol spoken by the resolved provider/credential pair (E9 · T11745).
   *
   * The load-bearing SSoT addition: the single {@link import('./model-runner.js').ModelRunner}
   * branches on this to construct the correct transport — `'codex_responses'`
   * routes a ChatGPT OAuth token through the Responses API; everything else
   * follows {@link deriveApiWire}. Derived in {@link resolveLLMForRole} from the
   * resolved `provider` + `credential.authType`.
   */
  apiMode: ApiMode;
  /**
   * Per-provider API endpoint override implied by the resolution. `null` when
   * the transport's own default (or the credential's `baseUrl`) should win.
   * Currently carries the codex ChatGPT-backend URL for OAuth openai resolution.
   */
  baseUrl: string | null;
  /**
   * Scheme used to present the credential. Mirrors `credential.authType`,
   * surfaced at the top level so the runner does not have to reach into the
   * credential. `null` when no credential was resolved.
   */
  authType: 'api_key' | 'oauth' | 'aws_sdk' | null;
  /**
   * Coarse capability hints (tools/json/vision/thinking) so a runner can pick
   * the right call shape. Optional — absent means "unknown".
   */
  capabilities?: ModelCaps;
}

/**
 * Narrow `CleoConfig.llm` past the `Partial<CleoConfig>` cast used by
 * `loadConfig`. Returns `undefined` if the block is absent.
 */
function readLlmBlock(config: CleoConfig | undefined): LlmConfig | undefined {
  return config?.llm;
}

/** Internal shape returned by {@link selectProviderModel}. */
interface SelectedProviderModel {
  provider: ModelTransport;
  model: string;
  credentialLabel: string | undefined;
  source: ResolutionSource;
}

/**
 * Resolve a named profile from `llm.profiles[name]` into a
 * {@link SelectedProviderModel}, or `undefined` when the name is unknown or
 * the profile is structurally incomplete (missing provider/model).
 *
 * @param llm    - The LLM config block (may be undefined).
 * @param name   - Profile name to look up (may be undefined).
 * @param source - The {@link ResolutionSource} to stamp on a hit.
 * @task T11617
 */
function resolveNamedProfile(
  llm: LlmConfig | undefined,
  name: string | undefined,
  source: ResolutionSource,
): SelectedProviderModel | undefined {
  if (!name) return undefined;
  const profile: LlmProfileConfig | undefined = llm?.profiles?.[name];
  if (!profile?.provider || !profile.model) return undefined;
  return {
    provider: profile.provider as ModelTransport,
    model: profile.model,
    credentialLabel: profile.credentialLabel,
    source,
  };
}

/**
 * Resolve a `llm.systems[systemKey]` {@link SystemBinding} into a
 * {@link SelectedProviderModel}, or `undefined` when `systemKey` is unset, the
 * key is absent, or the entry is structurally incomplete (neither a resolvable
 * `profile` nor a complete inline `provider`+`model` tuple).
 *
 * A binding referencing a named profile wins over its inline tuple — mirroring
 * {@link LlmRoleConfig.profile} precedence. The resolved profile keeps
 * `source: 'system'` (not `'profile'`) so diagnostics attribute the resolution
 * to the per-system override tier, while the profile's `credentialLabel` is
 * preserved unless the binding pins its own.
 *
 * @param llm       - The LLM config block (may be undefined).
 * @param systemKey - Encoded system-of-use key (may be undefined).
 * @task T11748
 */
function resolveSystemBinding(
  llm: LlmConfig | undefined,
  systemKey: string | undefined,
): SelectedProviderModel | undefined {
  if (!systemKey) return undefined;
  const binding: SystemBinding | undefined = llm?.systems?.[systemKey];
  if (!binding) return undefined;

  // 1. Binding pinned to a named profile (wins over the inline tuple).
  const bindingProfile = resolveNamedProfile(llm, binding.profile, 'system');
  if (bindingProfile) {
    // The binding may override the profile's credential label.
    return {
      ...bindingProfile,
      credentialLabel: binding.credentialLabel ?? bindingProfile.credentialLabel,
    };
  }

  // 2. Inline provider/model tuple on the binding.
  if (binding.provider && binding.model) {
    return {
      provider: binding.provider as ModelTransport,
      model: binding.model,
      credentialLabel: binding.credentialLabel,
      source: 'system',
    };
  }

  // Structurally incomplete — fall through to the next tier.
  return undefined;
}

/**
 * Resolve the runtime-registered default for `systemKey` (registerSystemOfUse —
 * T11751) into a {@link SelectedProviderModel}, or `undefined` when no system is
 * registered under that key (or its default is structurally incomplete).
 *
 * Consulted ONLY after every user-config tier in {@link selectProviderModel} is
 * exhausted — so a `registerSystemOfUse` default can NEVER override user config
 * (`systems[key]` / `default` / `defaultProfile`). A registered binding that
 * names a `profile` resolves it against `llm.profiles` (the profile wins over an
 * inline tuple); the resolution is stamped `source: 'registered-default'` for
 * diagnostics.
 *
 * @param llm       - The LLM config block (may be undefined).
 * @param systemKey - Encoded system-of-use key (may be undefined).
 * @task T11751
 */
function resolveRegisteredSystemDefault(
  llm: LlmConfig | undefined,
  systemKey: string | undefined,
): SelectedProviderModel | undefined {
  const defaults = getRegisteredSystemDefault(systemKey);
  if (!defaults) return undefined;

  // 1. Default pinned to a named profile (wins over the inline tuple).
  const profile = resolveNamedProfile(llm, defaults.profile, 'registered-default');
  if (profile) {
    return {
      ...profile,
      credentialLabel: defaults.credentialLabel ?? profile.credentialLabel,
    };
  }

  // 2. Inline provider/model tuple on the default.
  if (defaults.provider && defaults.model) {
    return {
      provider: defaults.provider as ModelTransport,
      model: defaults.model,
      credentialLabel: defaults.credentialLabel,
      source: 'registered-default',
    };
  }

  // Structurally incomplete (getRegisteredSystemDefault already filters these,
  // but stay defensive) — fall through to implicit fallback.
  return undefined;
}

/**
 * Pick provider/model/credentialLabel from the highest-priority configured
 * tier. Always returns a value because the implicit fallback is unconditional.
 *
 * Resolution order:
 *   1. `roles[role].profile` → named profile (`source: 'profile'`)
 *   2. `roles[role]` inline `{provider, model}` (`source: 'role'`)
 *   3. `systems[systemKey]` → per-system override (`source: 'system'`) — only
 *      consulted when `systemKey` is set (threaded by `resolveLLMForSystem`).
 *   4. `default` (`source: 'default'`)
 *   5. `defaultProfile` → named profile (`source: 'default-profile'`)
 *   6. `registerSystemOfUse` default (`source: 'registered-default'`) — runtime
 *      registration, consulted strictly BELOW all user config (T11751).
 *   7. implicit fallback (`source: 'implicit-fallback'`)
 *
 * Tiers 1–2 are the *explicit-arg* lane (per-role config / role override);
 * tier 3 is the hermes *granular override* — consulted after the explicit
 * choice but before the global base (`default` / `defaultProfile`), matching
 * the E9 priority `explicit-arg → llm.systems[key] → llm.defaultProfile →
 * registered-default → implicit fallback` (T11748 · T11751). The configurable
 * `defaultProfile` is what lets background roles resolve to a user-selectable
 * provider WITHOUT hardcoding the provider in code.
 *
 * @param llm       - The LLM config block (may be undefined).
 * @param role      - The role used for `roles[role]` lookup.
 * @param systemKey - Optional encoded system-of-use key activating tiers 3 + 6.
 * @task T11748 (`systems[systemKey]` tier)
 * @task T11751 (`registered-default` tier)
 */
function selectProviderModel(
  llm: LlmConfig | undefined,
  role: RoleName,
  systemKey?: string,
  profileOverride?: string,
): SelectedProviderModel {
  const roleEntry: LlmRoleConfig | undefined = llm?.roles?.[role];

  // 0. Explicit profile pin (T11759 · M4) — HIGHEST priority. A caller that
  // pins a named profile (e.g. a `.cantbook` stage's `profile:`) cannot be
  // silently overridden by background role config. Falls through unchanged when
  // the name is unknown / structurally incomplete.
  const pinnedProfile = resolveNamedProfile(llm, profileOverride, 'profile');
  if (pinnedProfile) return pinnedProfile;

  // 1. Role pinned to a named profile (explicit-arg lane).
  const roleProfile = resolveNamedProfile(llm, roleEntry?.profile, 'profile');
  if (roleProfile) return roleProfile;

  // 2. Role with an inline provider/model tuple (explicit-arg lane).
  if (roleEntry?.provider && roleEntry.model) {
    return {
      provider: roleEntry.provider as ModelTransport,
      model: roleEntry.model,
      credentialLabel: roleEntry.credentialLabel,
      source: 'role',
    };
  }

  // 3. Per-system override (hermes granular override) — beats the global base.
  const systemBinding = resolveSystemBinding(llm, systemKey);
  if (systemBinding) return systemBinding;

  // 4. Canonical default tuple.
  const defaultEntry: LlmDefaultConfig | undefined = llm?.default;
  if (defaultEntry?.provider && defaultEntry.model) {
    return {
      provider: defaultEntry.provider as ModelTransport,
      model: defaultEntry.model,
      credentialLabel: undefined,
      source: 'default',
    };
  }

  // 5. Configurable default profile binding (user-selectable; not hardcoded).
  const defaultProfile = resolveNamedProfile(llm, llm?.defaultProfile, 'default-profile');
  if (defaultProfile) return defaultProfile;

  // 6. Runtime-registered default (registerSystemOfUse — T11751) — consulted
  // strictly BELOW every user-config tier above, so the user ALWAYS wins. A
  // plugin/extension default only binds when the user configured nothing.
  const registeredDefault = resolveRegisteredSystemDefault(llm, systemKey);
  if (registeredDefault) return registeredDefault;

  // 7. Implicit fallback (last resort).
  return {
    provider: IMPLICIT_FALLBACK_PROVIDER,
    model: IMPLICIT_FALLBACK_MODEL,
    credentialLabel: undefined,
    source: 'implicit-fallback',
  };
}

/**
 * Try the credentials-store first (with `preferLabel` when pinned), then fall
 * back to the 6-tier `resolveCredentials()` chain. Returns `null` only when
 * both produce nothing.
 *
 * The store entry is converted into a {@link CredentialResult} so downstream
 * consumers (notably `authHeaders()`) treat both sources uniformly.
 */
async function resolveCredentialForRole(
  provider: ModelTransport,
  credentialLabel: string | undefined,
  projectRoot: string,
): Promise<{ credential: CredentialResult | null; usedLabel: string | undefined }> {
  // Self-heal (T11617): before any lookup/pick, renew expired-but-refreshable
  // OAuth credentials for this provider so a stale token is REFRESHED rather
  // than silently filtered out (which previously demoted resolution to a
  // lower-priority — or fake — credential, e.g. the consolidation 401). A
  // refresh failure leaves the entry expired and the eligible-filter drops it,
  // so this is purely additive: best-effort renewal, never throws.
  try {
    await new CredentialPool(provider).refreshExpiredOAuth();
  } catch {
    // Non-fatal — proceed with whatever credentials are currently usable.
  }

  // Pinned-label path: must match exactly OR fall through to the generic chain.
  if (credentialLabel) {
    const stored = await getCredentialByLabel(provider, credentialLabel);
    // Only return early when the stored entry has a usable token. An entry
    // with an empty `accessToken` (e.g. `aws_sdk` credentials where the SDK
    // owns auth) is treated as a cache miss so the 6-tier chain below can
    // surface an env-var or claude-creds token for the same provider.
    if (stored?.accessToken) {
      const wireAuthType = stored.authType === 'oauth' ? 'oauth' : 'api_key';
      return {
        credential: {
          provider,
          apiKey: stored.accessToken,
          source: 'cred-file',
          authType: wireAuthType,
        },
        usedLabel: stored.label,
      };
    }
    // Label was set but did not match (or matched with empty token) — fall
    // through; resolveCredentials exercises all tiers including tier 3
    // (cred-file picker without label preference), tier 2 (env), tier 4
    // (claude-creds), tier 4a (global-config), and tier 5 (project-config).
  } else {
    // No pinned label: ask the picker for the highest-priority eligible entry.
    // Only return when the entry carries a usable `accessToken`. Empty tokens
    // (e.g. `aws_sdk` entries where the SDK injects credentials out-of-band)
    // fall through so the 6-tier chain can surface a different credential.
    const picked = await pickCredentialForProvider(provider, {
      strategy: 'priorityWithFallback',
    });
    if (picked?.accessToken) {
      const wireAuthType = picked.authType === 'oauth' ? 'oauth' : 'api_key';
      return {
        credential: {
          provider,
          apiKey: picked.accessToken,
          source: 'cred-file',
          authType: wireAuthType,
        },
        usedLabel: picked.label,
      };
    }
  }

  // Fallback: full 6-tier resolver. `resolveCredentials()` itself calls
  // `pickCredentialForProviderSync` at tier 3 — for the no-label path we
  // have already consulted that tier, but re-running it is idempotent (same
  // store, same filters) and keeps env / claude-creds / config tiers reachable.
  const cred = resolveCredentials(provider, { projectRoot });
  if (cred.apiKey) {
    return { credential: cred, usedLabel: undefined };
  }
  return { credential: null, usedLabel: undefined };
}

/**
 * Resolve the LLM client + credential for a logical role.
 *
 * See module docs for the full resolution algorithm. Never throws — when
 * no credential is reachable the caller receives
 * `{ credential: null, sealedCredential: null, client: null, ... }` and is
 * responsible for its own graceful-degradation path (the previous Phase 1
 * pattern was a `return null` shortcut at the call-site).
 *
 * E10 (T11753): the plaintext token never rides on the returned envelope.
 * Materialize it ONLY at the wire by calling `llm.sealedCredential.fetch()`.
 *
 * @example
 * ```ts
 * const llm = await resolveLLMForRole('consolidation', { projectRoot });
 * if (!llm.sealedCredential || !llm.client) {
 *   return null; // graceful no-op
 * }
 * // At the wire — the ONLY place the plaintext is materialized:
 * const token = (await llm.sealedCredential.fetch()).value;
 * const response = await fetch('https://api.anthropic.com/v1/messages', {
 *   headers: {
 *     'Content-Type': 'application/json',
 *     ...authHeaders({ provider: llm.provider, apiKey: token,
 *       source: llm.credential?.source, authType: llm.credential?.authType ?? 'api_key' }),
 *   },
 *   body: JSON.stringify({ model: llm.model, ...rest }),
 * });
 * ```
 *
 * @param role - Logical role name (see {@link RoleName}).
 * @param opts - Optional overrides (project root for config + tier-5 lookup).
 * @returns A {@link ResolvedLLM} envelope; never throws.
 *
 * @task T9255
 * @task T11753
 */
export async function resolveLLMForRole(
  role: RoleName,
  opts?: ResolveLLMForRoleOptions,
): Promise<ResolvedLLM> {
  const projectRoot = resolveOrCwd(opts?.projectRoot);

  // Step 1 — load config. `loadConfig` deep-merges defaults + global +
  // project + env vars and returns the full `CleoConfig` shape. Unknown keys
  // (including `llm.default` and `llm.roles` added in T9256) pass through
  // because deepMerge preserves all keys it does not explicitly strip.
  let config: CleoConfig | undefined;
  try {
    const { loadConfig } = await import('../config.js');
    config = await loadConfig(projectRoot);
  } catch {
    config = undefined;
  }

  // Step 2 — pick provider/model/credentialLabel from the highest-priority tier.
  // `opts.systemKey` (threaded by `resolveLLMForSystem`) activates the
  // `llm.systems[key]` granular-override tier; role callers leave it unset and
  // that tier is skipped — role resolution is unchanged (T11748).
  const llmBlock = readLlmBlock(config);
  const { provider, model, credentialLabel, source } = selectProviderModel(
    llmBlock,
    role,
    opts?.systemKey,
    opts?.profileOverride,
  );

  // Step 3 — resolve credential.
  const { credential, usedLabel } = await resolveCredentialForRole(
    provider,
    credentialLabel,
    projectRoot,
  );

  // Step 4 — construct SDK client if we have a credential.
  //
  // NOTE (T9370 — D-ph4-01 final close): previously delegated to
  // `clientForModelConfig` from registry.ts. That function is now retired.
  // We delegate to `buildAnthropicClient` from `transports/anthropic.ts`, which
  // owns all `new Anthropic(...)` construction (D-ph4-01 grep-guard invariant).
  // Non-Anthropic providers resolve to `null` — callers that need
  // OpenAI/Gemini/Moonshot clients MUST use the transport layer
  // (`getLlmExecutor` / `AnthropicTransport`).
  let client: LLMClient | null = null;
  if (credential?.apiKey) {
    try {
      if (provider === 'anthropic') {
        client = buildAnthropicClient(credential);
      }
      // For non-Anthropic providers (openai, gemini, moonshot, bedrock):
      // callers SHOULD use getLlmExecutor / transport layer instead of raw client.
      // client remains null — this matches the graceful-degradation contract.
    } catch {
      // Mirror the rest of the LLM layer's behaviour — never throw from
      // client construction; the caller treats a null client as
      // "graceful no-op" identically to a null credential.
      client = null;
    }
  }

  // Step 5 — derive the SSoT wire facts (E9 · T11745). `apiMode`/`baseUrl` let
  // the single ModelRunner construct the correct transport from descriptor data
  // alone (codex routes purely on `apiMode === 'codex_responses'`). `authType`
  // is surfaced from the resolved credential (or null when none).
  const authType: 'api_key' | 'oauth' | 'aws_sdk' | null = credential?.authType ?? null;
  const wire = deriveApiWire(provider, authType);

  // Step 6 — E10 (T11753): seal the credential. The plaintext token is captured
  // in the handle's `fetch()` closure but is NOT placed on the returned
  // envelope. `credential` becomes non-secret metadata; consumers reach the
  // secret ONLY via `sealedCredential.fetch()` at the wire. No-credential
  // resolution yields `{ credential: null, sealedCredential: null }`.
  let credentialMetadata: CredentialMetadataWire | null = null;
  let sealedCredential: SealedCredential | null = null;
  if (credential?.apiKey) {
    const token = credential.apiKey;
    const wireAuthType: 'api_key' | 'oauth' = credential.authType === 'oauth' ? 'oauth' : 'api_key';
    credentialMetadata = {
      provider: credential.provider,
      source: credential.source,
      authType: wireAuthType,
    };
    sealedCredential = makeSealedCredential({
      provider: credential.provider,
      account: usedLabel ?? 'default',
      // Non-secret redacted preview (≤ last 4 chars) computed ONCE at seal time
      // — the only token-derived string allowed on a log/envelope/diagnostic
      // (E10 · T11754 · AC3). The full plaintext is NOT retained for it.
      tokenPreview: tokenPreview(token, wireAuthType),
      // The already-resolved plaintext is captured in this closure and handed
      // out ONLY when a wire boundary invokes fetch(); it is never surfaced on
      // the envelope. T11754 swaps this thunk for an on-demand vault decrypt.
      resolveToken: () => token,
    });
  }

  return {
    provider,
    model,
    client,
    credential: credentialMetadata,
    sealedCredential,
    source,
    credentialLabel: usedLabel,
    apiMode: wire.apiMode,
    baseUrl: wire.baseUrl,
    authType,
  };
}

/**
 * Convenience wrapper over {@link resolveLLMForRole} that narrows the client
 * union to the Anthropic Messages API surface.
 *
 * Returns `null` when:
 *   - no Anthropic credential is reachable for the role, OR
 *   - the resolved provider is not `'anthropic'`, OR
 *   - the SDK client could not be constructed.
 *
 * Eliminates the `as unknown as Pick<Anthropic, 'messages'>` cast that the
 * three Anthropic-only call-sites (memory/llm-extraction, deriver/deriver,
 * sentient/dream-cycle) previously required. AGENTS.md explicitly forbids
 * `as unknown as X` casts — this helper is the supported alternative.
 *
 * @example
 * ```ts
 * const llm = await resolveAnthropicForRole('extraction', { projectRoot });
 * if (!llm) return null; // graceful no-op — no credential or wrong provider
 * const response = await llm.client.messages.create({
 *   model: llm.model,
 *   max_tokens: 256,
 *   messages: [{ role: 'user', content: prompt }],
 * });
 * ```
 *
 * @param role - Logical role name (see `RoleName`).
 * @param opts - Optional overrides (project root for config + tier-5 lookup).
 * @returns Typed envelope, or `null` when graceful no-op is required.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — DRY review P2-1
 */
export async function resolveAnthropicForRole(
  role: RoleName,
  opts?: ResolveLLMForRoleOptions,
): Promise<{
  client: Pick<Anthropic, 'messages'>;
  model: string;
} | null> {
  let llm: ResolvedLLM;
  try {
    llm = await resolveLLMForRole(role, opts);
  } catch {
    return null;
  }
  if (llm.provider !== 'anthropic') return null;
  // E10 (T11753): gate on the sealed handle's presence — its existence is the
  // post-resolution "a usable credential was found" signal, replacing the
  // removed inline `credential.apiKey` truthiness check. The Anthropic SDK
  // `client` was already wired from the plaintext inside `resolveLLMForRole`
  // (the one allowed `new Anthropic(...)` chokepoint), so the secret does not
  // need to cross this boundary again.
  if (!llm.sealedCredential || !llm.client) return null;
  // Safe narrowing: provider === 'anthropic' and direct Anthropic construction
  // in resolveLLMForRole guarantees the client is an Anthropic SDK instance.
  // Pick<Anthropic, 'messages'> exposes only the surface needed by all 3
  // call-sites today; future widening can expand the Pick set without changing
  // the helper's contract.
  return {
    client: llm.client as Anthropic,
    model: llm.model,
  };
}
