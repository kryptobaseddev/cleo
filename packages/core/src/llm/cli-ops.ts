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
import { type EngineResult, engineError, engineSuccess } from '@cleocode/contracts';
import { setConfigValue } from '../config.js';
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
import { authHeaders, resolveCredentials } from './credentials.js';
import {
  addCredential,
  getCredentialByLabel,
  listCredentials,
  removeCredential,
  type StoredCredential,
} from './credentials-store.js';
import { IMPLICIT_FALLBACK_MODEL, resolveLLMForRole } from './role-resolver.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Logical roles enumerated by `whoami` when no explicit `role` filter is
 * supplied. Mirrors `RoleName` in `@cleocode/contracts`; duplicated here as a
 * runtime tuple so the `for (const role of ALL_ROLES)` loop survives a
 * downstream rename of the type alias without losing the iteration set.
 *
 * @task T9258
 */
const ALL_ROLES = ['extraction', 'consolidation', 'derivation', 'hygiene', 'judgement'] as const;

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

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
 * @task T9258 (S-11)
 */
function tokenPreviewOf(token: string, authType: StoredAuthTypeWire): string {
  const prefix = authType === 'oauth' ? 'oat-…' : '…';
  if (!token) return prefix;
  if (token.length <= 4) return `${prefix}${token}`;
  return `${prefix}${token.slice(-4)}`;
}

/**
 * Build the redacted view used by every `cleo llm` result envelope.
 *
 * `hasRefreshToken` is hard-coded to `false` in Phase 2 — see
 * `StoredCredential` in `credentials-store.ts` for the S-07 rationale.
 * The contract field stays on `LlmStoredCredentialView` so Phase 3 can
 * resurrect it once a real refresh flow ships.
 */
function viewOf(c: StoredCredential): LlmStoredCredentialView {
  return {
    provider: c.provider,
    label: c.label,
    authType: c.authType,
    tokenPreview: tokenPreviewOf(c.accessToken, c.authType),
    hasRefreshToken: false,
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
 * Resolves a credential the same way the role-resolver would (preferring a
 * specific `label` when supplied), builds the minimal HTTP request via
 * `authHeaders()`, and pings the provider with a 1-token prompt. NEVER
 * returns the raw token in the result envelope.
 *
 * @task T9258
 */
export async function llmTest(params: LlmTestParams): Promise<EngineResult<LlmTestResult>> {
  const provider = params.provider;
  const model = params.model ?? IMPLICIT_FALLBACK_MODEL;

  // 1. Resolve credential — prefer explicit label, fall back to the 6-tier chain.
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
    const cred = resolveCredentials(provider);
    if (!cred.apiKey) {
      return engineError(
        'E_CREDENTIAL_NOT_FOUND',
        `No credential resolved for provider='${provider}' via env / cred-file / claude-creds / config`,
      );
    }
    token = cred.apiKey;
    credentialSource = cred.source ?? 'env';
    authType = cred.authType;
    credentialPreview = tokenPreviewOf(token, authType);
  }

  // 2. Build a 1-token probe request. We keep this provider-aware but minimal:
  //    Anthropic is the implicit-fallback target so we exercise its endpoint;
  //    other providers receive a structured error until Phase 3 widens the
  //    probe surface.
  if (provider !== 'anthropic') {
    return engineError(
      'E_NOT_IMPLEMENTED',
      `llm.test currently supports the 'anthropic' transport only. Got '${provider}'.`,
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...authHeaders({ provider, apiKey: token, source: credentialSource, authType }),
  };
  const url = `${baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  const body = JSON.stringify({
    model,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ping' }],
  });

  const start = Date.now();
  let providerResponseId: string | null = null;
  try {
    const response = await fetch(url, { method: 'POST', headers, body });
    if (!response.ok) {
      // S-11: NEVER echo the response body in the error envelope. Some
      // provider 4xx responses include reflected request headers (e.g.
      // Anthropic's error payload can carry `x-api-key` substring matches
      // back in human-readable form), and a sloppy log pipeline could
      // surface that to an audit log. Surface only the HTTP status —
      // operators who need the body can re-run with `CLEO_LOG_LEVEL=debug`
      // and inspect the underlying fetch trace.
      return engineError(
        'E_PROVIDER_PING_FAILED',
        `${provider} returned HTTP ${response.status} (body suppressed for credential safety; rerun with CLEO_LOG_LEVEL=debug to inspect via raw fetch trace)`,
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
        hasCredential: !!resolved.credential?.apiKey,
      });
    }
    return engineSuccess({ entries });
  } catch (err) {
    return engineError('E_WHOAMI_FAILED', safeErrMessage(err));
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
