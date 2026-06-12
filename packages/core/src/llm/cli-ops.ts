/**
 * `cleo llm` CLI engine operations (T9258 — T-LLM-CRED-CENTRALIZATION Phase 2).
 *
 * Thin engine-layer wrappers around the credentials-store, role-resolver and
 * config writer used by the `cleo llm` CLI surface and the matching dispatch
 * domain. Every function:
 *
 *   - takes a single typed `params` object (so `OpsFromCore` can infer the
 *     dispatch domain operation record),
 *   - returns a `Promise<EngineResult<T>>` for uniform wrapping by
 *     `wrapResult()`,
 *   - NEVER returns raw `accessToken` / `apiKey` values — only the last-4-char
 *     `tokenPreview` redaction surfaces in result envelopes.
 *
 * @module llm/cli-ops
 * @task T9258
 * @epic T-LLM-CRED-CENTRALIZATION
 */

import type {
  LlmAddParams,
  LlmAddResult,
  LlmAuxiliaryStatusParams,
  LlmAuxiliaryStatusResult,
  LlmListParams,
  LlmListResult,
  LlmProfileParams,
  LlmProfileResult,
  LlmRemoveParams,
  LlmRemoveResult,
  LlmStoredCredentialView,
  LlmSystemsOfUseParams,
  LlmSystemsOfUseResult,
  LlmTestParams,
  LlmTestResult,
  LlmUseParams,
  LlmUseResult,
  LlmWhoamiEntry,
  LlmWhoamiParams,
  LlmWhoamiResult,
  ModelTransport,
  StoredAuthTypeWire,
} from '@cleocode/contracts';
import {
  type EngineResult,
  engineError,
  engineSuccess,
  WHOAMI_ROLE_IDS,
} from '@cleocode/contracts';
import { setConfigValue } from '../config.js';
import { getLogger } from '../logger.js';
// S-13 (CWE-209): wrap any user-facing error string in the project-wide
// `redactContent` helper so a stack trace or fetch error that incidentally
// contains a credential substring is automatically scrubbed before it
// reaches the dispatch envelope or the audit log.
import { redactContent } from '../memory/redaction.js';
import {
  DEFAULT_AUXILIARY_FALLBACK_CHAIN,
  parseAuxiliaryFallbackChain,
  resolveAuxiliaryFallbackChain,
} from './auxiliary-fallback.js';
import { catalogKeyForProvider, validateModelForProvider } from './catalog-model-resolver.js';
import { authHeaders, resolveCredentialsAsync } from './credentials.js';
import {
  addCredential,
  getCredentialByLabel,
  listCredentials,
  removeCredential,
  type StoredCredential,
} from './credentials-store.js';
import { IMPLICIT_FALLBACK_MODEL, resolveLLMForRole } from './role-resolver.js';
import { tokenPreview } from './sealed-credential.js';
import { listSystemsOfUse } from './system-of-use-registry.js';

const logger = getLogger('llm-cli-ops');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Logical roles enumerated by `whoami` when no explicit `role` filter is
 * supplied (and the valid-role allowlist for `llm profile`).
 *
 * Sourced from the contracts SSoT {@link WHOAMI_ROLE_IDS} (T11750 · AC3) — the
 * one place the enumerable background-role set is defined and kept locked to
 * `RoleName` via a compile-time `satisfies`. The previous inline duplicate
 * `['extraction', …]` tuple is gone: there is now ONE source of truth, so the
 * whoami/profile role list can never silently drift from the config vocabulary.
 *
 * @task T9258
 * @task T11750
 */
const ALL_ROLES = WHOAMI_ROLE_IDS;

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Redact every occurrence of a secret in free text (S-11).
 *
 * Used before DEBUG-logging a provider error body: Anthropic 4xx payloads can
 * reflect request headers (including the bearer token) back in human-readable
 * form, so the body must never reach a log stream with the live secret in it.
 * Replaces each occurrence with the standard last-4 preview. Empty/short
 * secrets (< 8 chars) redact nothing — they cannot meaningfully leak and a
 * short needle would shred unrelated text.
 *
 * @param text   - Raw text that may contain the secret.
 * @param secret - The live credential to scrub.
 * @returns The text with every occurrence of the secret replaced.
 * @task T11968
 */
export function redactSecret(text: string, secret: string | null): string {
  if (!secret || secret.length < 8 || !text) return text;
  return text.split(secret).join(`…${secret.slice(-4)}`);
}

/**
 * Return a redacted preview of a token tagged by auth scheme (S-11).
 *
 * - `api_key` / `aws_sdk` → `…<last4>` (e.g. `'…aB7q'`)
 * - `oauth`              → `oat-…<last4>` (e.g. `'oat-…7Y2k'`)
 *
 * Tokens shorter than 4 characters are surfaced as `…` / `oat-…` so the
 * caller can still distinguish "empty / aws_sdk" from "regular token"
 * without exposing the raw value.
 *
 * NEVER returns the full token. This is the only redaction code path
 * used by `cleo llm` result envelopes.
 *
 * Delegates to the SSoT redaction chokepoint {@link tokenPreview}
 * (`sealed-credential.ts`, shared with the E10 handle · T11754). `aws_sdk`
 * collapses to the non-OAuth `'…'` prefix, identical to the prior behaviour.
 *
 * @task T9258 (S-11)
 */
function tokenPreviewOf(token: string, authType: StoredAuthTypeWire): string {
  return tokenPreview(token, authType === 'oauth' ? 'oauth' : 'api_key');
}

/**
 * Build the redacted view used by every `cleo llm` result envelope.
 *
 * `hasRefreshToken` reflects whether a refresh token is actually stored —
 * the refresh flow consuming it shipped in `credential-pool.ts`
 * (`_refreshViaPkce` / `proactiveRefresh`), superseding the Phase-2 S-07
 * hardcode that reported `false` unconditionally (T11958).
 */
function viewOf(c: StoredCredential): LlmStoredCredentialView {
  return {
    provider: c.provider,
    label: c.label,
    authType: c.authType,
    tokenPreview: tokenPreviewOf(c.accessToken, c.authType),
    hasRefreshToken: typeof c.refreshToken === 'string' && c.refreshToken.length > 0,
    expiresAt: c.expiresAt ?? null,
    priority: c.priority,
    source: c.source,
    baseUrl: c.baseUrl ?? null,
    disabled: c.disabled === true,
  };
}

/**
 * Detect the storage auth type from a token prefix.
 *
 * Anthropic OAuth tokens start with `sk-ant-oat-` (per
 * `~/.claude/.credentials.json`). Everything else is treated as a regular
 * `api_key` until a future widening adds AWS / Vertex / GCP detection.
 *
 * @task T9258
 */
function detectAuthType(token: string): StoredAuthTypeWire {
  if (token.startsWith('sk-ant-oat-')) return 'oauth';
  return 'api_key';
}

/**
 * Pull a user-facing message from an unknown error value AND scrub any
 * substring that matches a credential pattern (S-13 / CWE-209).
 *
 * Stack traces from `fetch()` or the SQLite layer can transitively echo a
 * URL with a bearer token, a Postgres connection string with a password,
 * or a logged JSON body that contains an `apiKey` field — none of which
 * should ever reach an `engineError(...)` envelope. `redactContent`
 * scrubs every known pattern in one pass and is the canonical helper
 * used elsewhere in `@cleocode/core` (memory/log-redaction paths).
 *
 * @task T9258 (S-13)
 */
function safeErrMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactContent(raw).content;
}

// ---------------------------------------------------------------------------
// Engine ops
// ---------------------------------------------------------------------------

/**
 * `llm.add` — upsert a credential into the multi-credential pool.
 *
 * @task T9258
 */
export async function llmAdd(params: LlmAddParams): Promise<EngineResult<LlmAddResult>> {
  if (!params.apiKey) {
    return engineError('E_INVALID_INPUT', 'apiKey is required');
  }
  const authType = params.authType ?? detectAuthType(params.apiKey);
  const label = params.label?.trim() ? params.label.trim() : 'default';

  try {
    const stored = await addCredential({
      provider: params.provider,
      label,
      authType,
      accessToken: params.apiKey,
      ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
      ...(params.priority !== undefined ? { priority: params.priority } : {}),
      source: 'cli-input',
    });
    return engineSuccess({
      credential: viewOf(stored),
      detectedAuthType: authType,
    });
  } catch (err) {
    return engineError('E_CREDENTIAL_WRITE_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.list` — list redacted credentials, optionally filtered by provider.
 *
 * @task T9258
 */
export async function llmList(params: LlmListParams): Promise<EngineResult<LlmListResult>> {
  try {
    const stored = params.provider
      ? await listCredentials(params.provider)
      : await listCredentials();
    return engineSuccess({
      credentials: stored.map(viewOf),
    });
  } catch (err) {
    return engineError('E_CREDENTIAL_READ_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.remove` — delete a `(provider, label)` pair from the pool.
 *
 * @task T9258
 */
export async function llmRemove(params: LlmRemoveParams): Promise<EngineResult<LlmRemoveResult>> {
  if (!params.label) {
    return engineError('E_INVALID_INPUT', 'label is required');
  }
  try {
    const removed = await removeCredential(params.provider, params.label);
    return engineSuccess({
      removed,
      provider: params.provider,
      label: params.label,
    });
  } catch (err) {
    return engineError('E_CREDENTIAL_REMOVE_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.use` — set `llm.default.{provider,model}` in the global config.
 *
 * When `params.model` is supplied, it is validated against the live catalog
 * (disk snapshot from `cleo llm refresh-catalog`). Unknown model IDs are
 * rejected with `E_MODEL_NOT_IN_CATALOG`. When the catalog snapshot is absent
 * the model is accepted with a soft warning so users are not blocked on a
 * fresh install before they have run `cleo llm refresh-catalog`.
 *
 * @task T9258
 * @task T11773
 */
export async function llmUse(params: LlmUseParams): Promise<EngineResult<LlmUseResult>> {
  // Validate model against catalog when provided (T11773).
  if (params.model) {
    const catalogKey = catalogKeyForProvider(params.provider);
    const validation = validateModelForProvider(params.model, catalogKey);
    if (!validation.valid && validation.reason === 'not-found') {
      return engineError(
        'E_MODEL_NOT_IN_CATALOG',
        `Model '${params.model}' is not in the catalog for provider '${params.provider}'. ` +
          `Run \`cleo llm refresh-catalog\` to update the catalog, ` +
          `then \`cleo llm list-providers\` to see available models.`,
      );
    }
  }

  try {
    await setConfigValue('llm.default.provider', params.provider, undefined, { global: true });
    if (params.model) {
      await setConfigValue('llm.default.model', params.model, undefined, { global: true });
    }
    return engineSuccess({
      provider: params.provider,
      model: params.model ?? null,
      scope: 'global',
    });
  } catch (err) {
    return engineError('E_CONFIG_WRITE_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.profile` — set `llm.roles[role]` in the global config.
 *
 * When `params.model` is supplied, it is validated against the live catalog
 * (disk snapshot from `cleo llm refresh-catalog`). Unknown model IDs are
 * rejected with `E_MODEL_NOT_IN_CATALOG`. When the catalog snapshot is absent
 * the model is accepted with a soft warning so users are not blocked on a
 * fresh install before they have run `cleo llm refresh-catalog`.
 *
 * @task T9258
 * @task T11773
 */
export async function llmProfile(
  params: LlmProfileParams,
): Promise<EngineResult<LlmProfileResult>> {
  if (!params.role) {
    return engineError('E_INVALID_INPUT', 'role is required');
  }
  const validRoles: readonly string[] = ALL_ROLES;
  if (!validRoles.includes(params.role)) {
    return engineError(
      'E_INVALID_INPUT',
      `Invalid role '${params.role}'. Valid roles: ${ALL_ROLES.join(', ')}`,
    );
  }

  // Validate model against catalog when provided (T11773).
  if (params.model) {
    const catalogKey = catalogKeyForProvider(params.provider);
    const validation = validateModelForProvider(params.model, catalogKey);
    if (!validation.valid && validation.reason === 'not-found') {
      return engineError(
        'E_MODEL_NOT_IN_CATALOG',
        `Model '${params.model}' is not in the catalog for provider '${params.provider}'. ` +
          `Run \`cleo llm refresh-catalog\` to update the catalog, ` +
          `then \`cleo llm list-providers\` to see available models.`,
      );
    }
  }

  try {
    await setConfigValue(`llm.roles.${params.role}.provider`, params.provider, undefined, {
      global: true,
    });
    if (params.model) {
      await setConfigValue(`llm.roles.${params.role}.model`, params.model, undefined, {
        global: true,
      });
    }
    if (params.credentialLabel) {
      await setConfigValue(
        `llm.roles.${params.role}.credentialLabel`,
        params.credentialLabel,
        undefined,
        { global: true },
      );
    }
    return engineSuccess({
      role: params.role,
      provider: params.provider,
      model: params.model ?? null,
      credentialLabel: params.credentialLabel ?? null,
      scope: 'global',
    });
  } catch (err) {
    return engineError('E_CONFIG_WRITE_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.test` — round-trip ping against the resolved provider.
 *
 * Resolves a credential through the unified vault chokepoint (T11986 ·
 * DHQ-087): uses `resolveCredentialsAsync` (which delegates to the
 * {@link UnifiedCredentialPool}) so vault-stored credentials — including
 * OAuth tokens that may need refreshing — are always visible to diagnostic
 * probes. The legacy sync `resolveCredentials()` path was replaced here
 * because it skips the pool's lazy-seed and refresh-on-use steps.
 *
 * When a specific `label` is supplied, the credential is looked up directly
 * from the store (bypassing the pool picker). This path also benefits from
 * refresh-on-use: if the stored credential is an expired OAuth token with a
 * refresh token, `resolveCredentialsAsync` will renew it through the pool
 * before returning.
 *
 * NEVER returns the raw token in the result envelope (S-11).
 *
 * @task T9258
 * @task T11986
 */
export async function llmTest(params: LlmTestParams): Promise<EngineResult<LlmTestResult>> {
  const provider = params.provider;
  const model = params.model ?? IMPLICIT_FALLBACK_MODEL;

  // 1. Resolve credential — prefer explicit label, fall back to the vault
  //    chokepoint (resolveCredentialsAsync triggers lazy-seed + refresh-on-use).
  let token: string | null = null;
  let credentialSource: LlmTestResult['credentialSource'] = 'env';
  let credentialPreview = '…';
  let authType: 'api_key' | 'oauth' = 'api_key';
  let baseUrl: string | null = null;

  if (params.label) {
    const stored = await getCredentialByLabel(provider, params.label);
    if (!stored) {
      return engineError(
        'E_CREDENTIAL_NOT_FOUND',
        `No credential found for provider='${provider}' label='${params.label}'`,
      );
    }
    token = stored.accessToken;
    credentialSource = 'cred-file';
    authType = stored.authType === 'oauth' ? 'oauth' : 'api_key';
    credentialPreview = tokenPreviewOf(token, authType);
    baseUrl = stored.baseUrl ?? null;
  } else {
    // Use the async resolver (vault chokepoint) — picks through the pool after
    // triggering lazy-seed. The pool's proactiveRefresh handles expired OAuth.
    const cred = await resolveCredentialsAsync(provider);
    if (!cred.apiKey) {
      return engineError(
        'E_CREDENTIAL_NOT_FOUND',
        `No credential resolved for provider='${provider}' via the vault (cred store / env / seeder). ` +
          `Run \`cleo llm add ${provider} <key>\` or \`cleo login ${provider}\` to add one.`,
      );
    }
    token = cred.apiKey;
    credentialSource = cred.source ?? 'cred-file';
    authType = cred.authType;
    credentialPreview = tokenPreviewOf(token, authType);
  }

  // 2. Resolve the provider base URL for non-default endpoints.
  if (!baseUrl) {
    try {
      const { getProviderProfile } = await import('./provider-registry/index.js');
      const profile = await getProviderProfile(provider);
      baseUrl = profile?.baseUrl ?? null;
    } catch {
      baseUrl = null;
    }
  }

  // 3. Build a 1-token probe request. Currently supports Anthropic (Messages
  //    API) and OpenAI-compatible providers (Chat Completions API). Other
  //    providers fall back to the anthropic probe shape when their endpoint
  //    is compatible (e.g. ollama/openrouter with chat-completions).
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders({ provider, apiKey: token, source: credentialSource, authType }),
  };

  let url: string;
  let body: string;

  if (provider === 'anthropic') {
    url = `${baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  } else if (
    provider === 'openai' ||
    provider === 'openrouter' ||
    provider === 'deepseek' ||
    provider === 'xai' ||
    provider === 'groq' ||
    provider === 'moonshot' ||
    provider === 'ollama' ||
    provider === 'kimi-code'
  ) {
    // OpenAI-compatible Chat Completions endpoint.
    const defaultBase: Record<string, string> = {
      openai: 'https://api.openai.com',
      openrouter: 'https://openrouter.ai/api',
      deepseek: 'https://api.deepseek.com',
      xai: 'https://api.x.ai',
      groq: 'https://api.groq.com/openai',
      moonshot: 'https://api.moonshot.cn',
      ollama: 'http://localhost:11434',
      'kimi-code': 'https://api.kimi.com/coding',
    };
    url = `${baseUrl ?? defaultBase[provider] ?? 'https://api.openai.com'}/v1/chat/completions`;
    body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  } else {
    return engineError(
      'E_NOT_IMPLEMENTED',
      `llm.test does not yet support provider '${provider}'. ` +
        `Supported: anthropic, openai, openrouter, deepseek, xai, groq, moonshot, ollama, kimi-code.`,
    );
  }

  const start = Date.now();
  let providerResponseId: string | null = null;
  try {
    const response = await fetch(url, { method: 'POST', headers, body });
    if (!response.ok) {
      // S-11: NEVER echo the response body in the error ENVELOPE. Some
      // provider 4xx responses include reflected request headers (e.g.
      // Anthropic's error payload can carry `x-api-key` substring matches
      // back in human-readable form), and a sloppy log pipeline could
      // surface that to an audit log. Surface only the HTTP status in the
      // envelope — and emit the body to the DEBUG log with the in-scope
      // credential redacted, so the failure is actually diagnosable
      // (T11958/DHQ-075 repro follow-through: the previous message promised
      // a "raw fetch trace" that did not exist).
      const bodyText = await response.text().catch(() => '');
      logger.debug(
        { provider, status: response.status, body: redactSecret(bodyText, token).slice(0, 1024) },
        'llm.test provider ping failed',
      );
      return engineError(
        'E_PROVIDER_PING_FAILED',
        `${provider} returned HTTP ${response.status} (body suppressed for credential safety; ` +
          `rerun with CLEO_LOG_LEVEL=debug to log the redacted response body)`,
      );
    }
    const parsed = (await response.json()) as { id?: string };
    providerResponseId = typeof parsed.id === 'string' ? parsed.id : null;
  } catch (err) {
    return engineError('E_PROVIDER_PING_FAILED', safeErrMessage(err));
  }
  const latencyMs = Date.now() - start;

  return engineSuccess({
    provider,
    model,
    latencyMs,
    providerResponseId,
    credentialPreview,
    credentialSource,
  });
}

/**
 * `llm.whoami` — resolve every role (or a single `params.role`) and report
 * how each one would be wired today.
 *
 * @task T9258
 */
export async function llmWhoami(params: LlmWhoamiParams): Promise<EngineResult<LlmWhoamiResult>> {
  const roles: readonly string[] = params.role ? [params.role] : ALL_ROLES;

  if (params.role && !ALL_ROLES.includes(params.role as (typeof ALL_ROLES)[number])) {
    return engineError(
      'E_INVALID_INPUT',
      `Invalid role '${params.role}'. Valid roles: ${ALL_ROLES.join(', ')}`,
    );
  }

  try {
    const entries: LlmWhoamiEntry[] = [];
    for (const role of roles) {
      // `resolveLLMForRole` accepts any `RoleName`; validated above for the
      // single-role path. Loop variable is constrained to ALL_ROLES otherwise.
      const resolved = await resolveLLMForRole(role as (typeof ALL_ROLES)[number]);
      entries.push({
        role,
        provider: resolved.provider as ModelTransport,
        model: resolved.model,
        source: resolved.source,
        credentialLabel: resolved.credentialLabel,
        credentialSource: resolved.credential?.source,
        // E10 (T11753): `hasCredential` is now the sealed-handle presence — a
        // non-secret signal — so whoami never materializes the plaintext.
        hasCredential: !!resolved.sealedCredential,
      });
    }
    return engineSuccess({ entries });
  } catch (err) {
    return engineError('E_WHOAMI_FAILED', safeErrMessage(err));
  }
}

/**
 * `llm.systems-of-use` — enumerate every system-of-use for the TUI / Studio
 * profile picker (T11751 · AC2).
 *
 * Returns the merged surface: the static {@link BUILTIN_SYSTEMS_OF_USE} table
 * plus every runtime-registered system (`registerSystemOfUse`). This is the ONE
 * enumeration op the picker reads — it never re-derives the system list itself,
 * so a newly-registered system appears in the picker without a UI edit.
 *
 * @task T11751
 * @epic T11745
 */
export async function llmSystemsOfUse(
  params: LlmSystemsOfUseParams,
): Promise<EngineResult<LlmSystemsOfUseResult>> {
  try {
    const entries = listSystemsOfUse(params.kind);
    return engineSuccess({ entries });
  } catch (err) {
    return engineError('E_INTERNAL', safeErrMessage(err));
  }
}

/**
 * `llm.auxiliary-status` — report the active auxiliary fallback chain
 * and how to configure it.
 *
 * The chain determines which providers are tried (in order) when an auxiliary
 * LLM call fails due to pool exhaustion. Configured via:
 *
 * ```
 * cleo config set llm.auxiliaryFallback "anthropic,openrouter,groq"
 * ```
 *
 * Returns the resolved chain plus the config key and an example value so
 * users can copy-paste to customise.
 *
 * @task T9319
 */
export async function llmAuxiliaryStatus(
  params: LlmAuxiliaryStatusParams,
): Promise<EngineResult<LlmAuxiliaryStatusResult>> {
  try {
    const { loadConfig } = await import('../config.js');
    const config = await loadConfig(params.projectRoot);
    const rawValue = (config.llm as Record<string, unknown> | undefined)?.['auxiliaryFallback'];
    const hasConfig = typeof rawValue === 'string' && rawValue.trim().length > 0;

    const chain = hasConfig
      ? parseAuxiliaryFallbackChain(rawValue as string)
      : DEFAULT_AUXILIARY_FALLBACK_CHAIN;

    return engineSuccess({
      chain: chain.map((e) => ({ provider: e.provider, ...(e.model ? { model: e.model } : {}) })),
      source: hasConfig ? 'config' : 'default',
      configKey: 'llm.auxiliaryFallback',
      configExample: 'anthropic,openrouter,groq',
    });
  } catch (err) {
    return engineError('E_AUXILIARY_STATUS_FAILED', safeErrMessage(err));
  }
}

// Re-export for tree-shaking clarity (consumers import only what they use).
export { resolveAuxiliaryFallbackChain };
