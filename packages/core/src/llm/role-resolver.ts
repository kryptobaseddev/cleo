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
  CleoConfig,
  LlmConfig,
  LlmDefaultConfig,
  LlmRoleConfig,
  ResolutionSource,
  ResolveLLMForRoleOptions,
  RoleName,
} from '@cleocode/contracts';
import type { GoogleGenerativeAI } from '@google/generative-ai';
import type { OpenAI } from 'openai';
import { authHeaders, type CredentialResult, resolveCredentials } from './credentials.js';
import { getCredentialByLabel, pickCredentialForProvider } from './credentials-store.js';
import { clientForModelConfig } from './registry.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

/**
 * Implicit fallback model used when no role-specific and no `default` entry is
 * present in config. Mirrors the historical hardcoded `claude-haiku-4-5-20251001`
 * that the 7 call-sites previously embedded. Lives here (and ONLY here) so the
 * grep guard `grep -rn "claude-haiku-4-5-20251001" packages/` stays clean
 * outside `packages/core/src/llm/`.
 *
 * @task T9255
 */
export const IMPLICIT_FALLBACK_MODEL = 'claude-haiku-4-5-20251001';

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
 * Concrete tagged union over the raw SDK client types returned by
 * {@link clientForModelConfig}. This is the runtime-precise version of the
 * opaque `unknown` carried by `ResolvedLLM.client` in `@cleocode/contracts`
 * — SDK classes are kept off the contracts surface to preserve its
 * zero-dependency footprint, but tightened here where the SDK packages are
 * real dependencies.
 *
 * @task T9255
 */
export type LLMClient = Anthropic | OpenAI | GoogleGenerativeAI | Record<string, unknown>; // Gemini AIO fallback shape (matches ProviderClient in ./types.ts)

// Re-export the wire types so existing imports from
// `@cleocode/core/llm/role-resolver` keep working alongside the canonical
// home in `@cleocode/contracts`.
export type { ResolutionSource, ResolveLLMForRoleOptions };

/**
 * Result of {@link resolveLLMForRole} — runtime-precise envelope.
 *
 * The contracts-level `ResolvedLLM` (from `@cleocode/contracts`) carries
 * `client: unknown` to stay SDK-free. This core variant tightens the same
 * envelope with the concrete SDK union (`LLMClient`) and the local
 * {@link CredentialResult} — same shape, narrower types.
 *
 * `client` is `null` only when `credential.apiKey` is also null — in which
 * case the caller MUST fall back to its graceful-degradation path
 * (return null / skip / log warn).
 *
 * @task T9255
 */
export interface ResolvedLLM {
  /** LLM provider transport that was resolved. */
  provider: ModelTransport;
  /** Full model identifier. */
  model: string;
  /**
   * Fully-wired SDK client constructed via `clientForModelConfig`. `null`
   * when no credential is available.
   */
  client: LLMClient | null;
  /**
   * Resolved credential. `null` when none of the 6 credential tiers
   * produced a token. Callers MUST handle this case.
   */
  credential: CredentialResult | null;
  /** Which config path produced this resolution. */
  source: ResolutionSource;
  /** When `roles[role].credentialLabel` was set, the label that was used. */
  credentialLabel?: string;
}

/**
 * Narrow `CleoConfig.llm` past the `Partial<CleoConfig>` cast used by
 * `loadConfig`. Returns `undefined` if the block is absent.
 */
function readLlmBlock(config: CleoConfig | undefined): LlmConfig | undefined {
  return config?.llm;
}

/**
 * Pick provider/model/credentialLabel from the highest-priority configured
 * tier. Always returns a value because the implicit fallback is unconditional.
 *
 * Resolution order: `roles[role]` → `default` → implicit fallback.
 */
function selectProviderModel(
  llm: LlmConfig | undefined,
  role: RoleName,
): {
  provider: ModelTransport;
  model: string;
  credentialLabel: string | undefined;
  source: ResolutionSource;
} {
  const roleEntry: LlmRoleConfig | undefined = llm?.roles?.[role];
  if (roleEntry?.provider && roleEntry.model) {
    return {
      provider: roleEntry.provider as ModelTransport,
      model: roleEntry.model,
      credentialLabel: roleEntry.credentialLabel,
      source: 'role',
    };
  }

  const defaultEntry: LlmDefaultConfig | undefined = llm?.default;
  if (defaultEntry?.provider && defaultEntry.model) {
    return {
      provider: defaultEntry.provider as ModelTransport,
      model: defaultEntry.model,
      credentialLabel: undefined,
      source: 'default',
    };
  }

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
  // Pinned-label path: must match exactly OR fall through to the generic chain.
  if (credentialLabel) {
    const stored = await getCredentialByLabel(provider, credentialLabel);
    if (stored) {
      const wireAuthType = stored.authType === 'oauth' ? 'oauth' : 'api_key';
      return {
        credential: {
          provider,
          apiKey: stored.accessToken || null,
          source: 'cred-file',
          authType: wireAuthType,
        },
        usedLabel: stored.label,
      };
    }
    // Label was set but did not match — fall through; resolveCredentials still
    // exercises tiers 1, 2, 4, 4a, 4b, 5 and may surface a usable credential.
  } else {
    // No pinned label: ask the picker for the highest-priority eligible entry.
    const picked = await pickCredentialForProvider(provider, {
      strategy: 'priorityWithFallback',
    });
    if (picked) {
      const wireAuthType = picked.authType === 'oauth' ? 'oauth' : 'api_key';
      return {
        credential: {
          provider,
          apiKey: picked.accessToken || null,
          source: 'cred-file',
          authType: wireAuthType,
        },
        usedLabel: picked.label,
      };
    }
  }

  // Fallback: full 6-tier resolver. Note that resolveCredentials() itself ALSO
  // calls pickCredentialForProviderSync as its tier 3 — for the no-label
  // path we have already consulted that tier, but re-running it here is
  // idempotent (same store, same filters) and keeps the env / claude-creds /
  // config tiers reachable.
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
 * `{ credential: null, client: null, ... }` and is responsible for its own
 * graceful-degradation path (the previous Phase 1 pattern was a `return null`
 * shortcut at the call-site).
 *
 * @example
 * ```ts
 * const llm = await resolveLLMForRole('consolidation', { projectRoot });
 * if (!llm.credential?.apiKey || !llm.client) {
 *   return null; // graceful no-op
 * }
 * const response = await fetch('https://api.anthropic.com/v1/messages', {
 *   headers: { 'Content-Type': 'application/json', ...authHeaders(llm.credential) },
 *   body: JSON.stringify({ model: llm.model, ...rest }),
 * });
 * ```
 *
 * @param role - Logical role name (see {@link RoleName}).
 * @param opts - Optional overrides (project root for config + tier-5 lookup).
 * @returns A {@link ResolvedLLM} envelope; never throws.
 *
 * @task T9255
 */
export async function resolveLLMForRole(
  role: RoleName,
  opts?: ResolveLLMForRoleOptions,
): Promise<ResolvedLLM> {
  const projectRoot = opts?.projectRoot ?? process.cwd();

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
  const llmBlock = readLlmBlock(config);
  const { provider, model, credentialLabel, source } = selectProviderModel(llmBlock, role);

  // Step 3 — resolve credential.
  const { credential, usedLabel } = await resolveCredentialForRole(
    provider,
    credentialLabel,
    projectRoot,
  );

  // Step 4 — construct SDK client if we have a credential. Pass OAuth Bearer
  // headers through `extraHeaders` so the registry constructs the Anthropic
  // SDK with `authToken` (avoids the 401 from sending both `x-api-key` AND
  // `Authorization`).
  let client: LLMClient | null = null;
  if (credential?.apiKey) {
    const modelConfig: ModelConfig = {
      transport: provider,
      model,
      apiKey: credential.apiKey,
      extraHeaders: credential.authType === 'oauth' ? authHeaders(credential) : undefined,
    };
    try {
      client = clientForModelConfig(provider, modelConfig) as LLMClient;
    } catch {
      // Mirror the rest of the LLM layer's behaviour — never throw from
      // client construction; the caller treats a null client as
      // "graceful no-op" identically to a null credential.
      client = null;
    }
  }

  return {
    provider,
    model,
    client,
    credential,
    source,
    credentialLabel: usedLabel,
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
  credential: CredentialResult;
} | null> {
  let llm: ResolvedLLM;
  try {
    llm = await resolveLLMForRole(role, opts);
  } catch {
    return null;
  }
  if (llm.provider !== 'anthropic') return null;
  if (!llm.credential?.apiKey || !llm.client) return null;
  // Safe narrowing: provider === 'anthropic' guarantees clientForModelConfig
  // returned an Anthropic SDK client. Pick<Anthropic, 'messages'> exposes
  // only the surface needed by all 3 call-sites today; future widening can
  // expand the Pick set without changing the helper's contract.
  return {
    client: llm.client as Anthropic,
    model: llm.model,
    credential: llm.credential,
  };
}
