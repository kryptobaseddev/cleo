/**
 * Centralised credential resolution for the CLEO LLM layer (T1677).
 *
 * ONE canonical entry point: `resolveCredentials(provider, options)`.
 * Every LLM consumer — extraction, dream-cycle, hygiene-scan, dup-detect,
 * observer-reflector, deriver, adapters — MUST use this function.
 *
 * ## 6-tier resolution chain (first match wins)
 *
 * 1. **explicit**       — `options.apiKey` passed by the caller
 * 2. **env**            — provider-specific environment variable
 *                         (`ANTHROPIC_API_KEY` | `OPENAI_API_KEY` |
 *                          `GEMINI_API_KEY` | `MOONSHOT_API_KEY`)
 * 3. **cred-file**      — `~/.cleo/llm-credentials.json` (multi-credential
 *                         pool, file-locked, 0600). T-LLM-CRED Phase 2.
 * 4. **claude-creds**   — `~/.claude/.credentials.json` OAuth token
 *                         (only for `anthropic` provider; Claude Code zero-config)
 * 5. **global-config**  — `~/.config/cleo/config.json` (XDG config dir, post-T9405)
 *                         → `llm.providers.<provider>.apiKey`. The legacy
 *                         `~/.local/share/cleo/config.json` location is still
 *                         read as a fallback during the transition window.
 * 6. **project-config** — `.cleo/config.json`  → `llm.providers.<provider>.apiKey`
 *
 * Returns `null` when no key is found in any tier.
 *
 * @module llm/credentials
 * @task T1677
 * @epic T1676
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SealedCredential } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { getCredentialPool } from './credential-pool.js';
import { pickCredentialForProviderSync } from './credentials-store.js';
import {
  configDirGlobalConfigPath,
  ensureGlobalConfigMigrated,
  legacyGlobalConfigPath,
} from './global-config-migration.js';
import { ensureLegacyFlatAnthropicKeyImported } from './legacy-flat-key-import.js';
import type { ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The resolution source that yielded the API key.
 *
 * - `explicit`       — caller provided `options.apiKey` directly
 * - `env`            — provider-specific environment variable
 * - `cred-file`      — `~/.cleo/llm-credentials.json` multi-credential pool
 *                      (T-LLM-CRED-CENTRALIZATION Phase 2)
 * - `claude-creds`   — `~/.claude/.credentials.json` OAuth token (anthropic only)
 * - `global-config`  — `~/.cleo/config.json` `llm.providers[p].apiKey`
 * - `project-config` — `.cleo/config.json`   `llm.providers[p].apiKey`
 */
export type CredentialSource =
  | 'explicit'
  | 'env'
  | 'cred-file'
  | 'claude-creds'
  | 'global-config'
  | 'project-config';

/**
 * Authentication scheme used to send the credential to the provider.
 *
 * - `api_key` — provider-issued long-lived key sent as `x-api-key` (Anthropic)
 *               or `Authorization: Bearer …` (OpenAI, Gemini, Moonshot).
 * - `oauth`   — short-lived OAuth bearer token (Anthropic Claude Code) sent as
 *               `Authorization: Bearer …` with the matching beta header.
 *
 * The set is intentionally small in Phase 1. Phase 3 widens it to add SDK-based
 * auth (`aws_sdk`, `gcp_sdk`) alongside the Bedrock / Vertex transports.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 */
export type AuthType = 'api_key' | 'oauth';

/**
 * Result returned by `resolveCredentials()`.
 *
 * `apiKey` is null only when all 5 tiers are exhausted without a match.
 * `authType` indicates the scheme to use when sending the credential — callers
 * should pass the result through `authHeaders(cred)` rather than hard-coding
 * `x-api-key` or `Authorization` themselves.
 */
export interface CredentialResult {
  /** Provider transport that was resolved for. */
  provider: ModelTransport;
  /** API key or OAuth bearer token string, or null when no credential is available. */
  apiKey: string | null;
  /** Which resolution tier produced the credential (undefined when apiKey is null). */
  source: CredentialSource | undefined;
  /**
   * Scheme used to present this credential to the provider. Defaults to `'api_key'`
   * for every source except `claude-creds`, and for tokens whose prefix marks
   * them as Anthropic OAuth (`sk-ant-oat-*` access / `sk-ant-ort-*` refresh).
   */
  authType: AuthType;
}

/**
 * Options accepted by `resolveCredentials()`.
 */
export interface CredentialResolveOptions {
  /**
   * Explicit API key override (tier 1 — highest priority).
   * Pass this when the caller already has a key and wants to skip all
   * filesystem / config reads.
   */
  apiKey?: string | null;
  /**
   * Absolute path to the project root used for tier 5 (project-config).
   * Omit to skip project-config resolution.
   */
  projectRoot?: string;
}

// ---------------------------------------------------------------------------
// Environment variable map
// ---------------------------------------------------------------------------

/**
 * Maps each provider transport to its canonical environment variable name.
 *
 * NOTE: `bedrock` is informational — AWS Bedrock uses the AWS SDK credential
 * chain (`AWS_PROFILE` / `~/.aws/credentials` / IAM role / SSO), not a single
 * API-key env var. The credential-pool resolves Bedrock via `authType: 'aws_sdk'`
 * and never reads the `accessToken` field from env.
 *
 * Exported so concrete seeders (e.g. the env seeder under
 * `./credential-seeders/env-seeder.ts`) reuse the same mapping instead of
 * inlining a duplicate. Treat this as the single source of truth for
 * `(provider → env var name)`.
 *
 * @task T9409
 */
export const ENV_VARS: Record<ModelTransport, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  bedrock: 'AWS_PROFILE',
  deepseek: 'DEEPSEEK_API_KEY',
  xai: 'XAI_API_KEY',
  groq: 'GROQ_API_KEY',
  // Kimi Code (kimi.com/code) — `sk-kimi-*` API keys route to
  // `https://api.kimi.com/coding` and speak Anthropic Messages protocol.
  // Device-code OAuth via auth.kimi.com is also supported (T9266 preset).
  'kimi-code': 'KIMI_CODE_API_KEY',
  // Ollama runs locally without an API key by default. OLLAMA_HOST overrides
  // the base URL (e.g. for remote ollama servers). Empty string allowed.
  ollama: 'OLLAMA_HOST',
};

// ---------------------------------------------------------------------------
// Path helpers — all CLEO-home resolution routes through `getCleoHome()` from
// `@cleocode/paths` so the `CLEO_HOME` env override and platform-aware XDG
// resolution apply uniformly across the LLM layer (T9403).
// ---------------------------------------------------------------------------

/**
 * Path to the global CLEO config file.
 *
 * Canonical location is the XDG **config** dir (`~/.config/cleo/config.json`
 * on Linux) — T9405 moved it here from the data dir to comply with XDG. The
 * data-dir copy is still consulted as a read-only fallback during the
 * transition window via {@link readGlobalProviderKey}; existing installs are
 * migrated in-place on first credentials read by
 * {@link ensureGlobalConfigMigrated}.
 */
function globalConfigPath(): string {
  return configDirGlobalConfigPath();
}

/** Path to the project-level CLEO config file. */
function projectConfigPath(projectRoot: string): string {
  const cleoDir = process.env['CLEO_DIR'] ?? '.cleo';
  return join(projectRoot, cleoDir, 'config.json');
}

/**
 * Tier 4a reader — finds the global provider key, preferring the config-dir
 * location and falling back to the legacy data-dir location during the
 * transition window (T9405).
 *
 * Migration runs at most once per process via {@link ensureGlobalConfigMigrated}
 * so the data-dir fallback is only reachable when the migration itself failed
 * (e.g. permission errors) or when a brand-new file lands in the data dir
 * after the marker was already stamped. Both situations resolve to the legacy
 * copy so users never get a "key disappeared" surprise.
 */
function readGlobalProviderKey(provider: ModelTransport): string | null {
  ensureGlobalConfigMigrated();
  const configDirKey = readProviderKeyFromConfig(globalConfigPath(), provider);
  if (configDirKey) return configDirKey;
  return readProviderKeyFromConfig(legacyGlobalConfigPath(), provider);
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

// NOTE — direct read of `~/.claude/.credentials.json` was removed in T9413
// (E-CONFIG-AUTH-UNIFY §5.2 T-E2-6). The claude-code seeder
// (`credential-seeders/claude-code-seeder.ts`) is now the sole owner of that
// file; its imported entries land in the unified credential pool and are
// served by tier 3 (`pickCredentialForProviderSync`) alongside every other
// seeded source.

/**
 * Tier 4b backward compat: read the legacy flat key file written by
 * `storeAnthropicApiKey()` before T1677 migrated storage to config.json.
 *
 * File: `~/.local/share/cleo/anthropic-key` (plain text, one line).
 * Returns null when the file does not exist or is empty.
 */
function readFlatAnthropicKey(): string | null {
  try {
    const keyFile = join(getCleoHome(), 'anthropic-key');
    if (!existsSync(keyFile)) return null;
    const stored = readFileSync(keyFile, 'utf-8').trim();
    return stored || null;
  } catch {
    return null;
  }
}

/**
 * Read `llm.providers[provider].apiKey` from a JSON config file.
 * Returns null on any error or missing key.
 */
function readProviderKeyFromConfig(configFile: string, provider: ModelTransport): string | null {
  try {
    if (!existsSync(configFile)) return null;
    const raw = readFileSync(configFile, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const llm = config['llm'];
    if (!llm || typeof llm !== 'object') return null;
    const providers = (llm as Record<string, unknown>)['providers'];
    if (!providers || typeof providers !== 'object') return null;
    const entry = (providers as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== 'object') return null;
    const apiKey = (entry as Record<string, unknown>)['apiKey'];
    if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim();
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API — unified resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the API key for a provider using the synchronous tier chain.
 *
 * Resolution order (first non-empty match wins):
 * 1. `options.apiKey`  — explicit caller override
 * 2. `ENV_VARS[provider]` environment variable
 * 3. `~/.cleo/llm-credentials.json` — unified credential pool (read-only;
 *    seeding is the unified pool's responsibility — the sync path does not
 *    re-seed)
 * 4a. `~/.cleo/config.json` → `llm.providers[provider].apiKey` — **deprecated**
 *     (emits stderr warning; still resolves during the transition window)
 * 5. `<projectRoot>/.cleo/config.json` → `llm.providers[provider].apiKey` —
 *    **rejected** (T-E2-6 footgun kill; emits stderr warning, never resolves)
 *
 * Direct reading of `~/.claude/.credentials.json` was removed in T9413; the
 * `claude-code` seeder is now the sole owner of that file and its imported
 * entries land in the pool, which the tier-3 read picks up.
 *
 * For new code prefer {@link resolveCredentialsAsync}, which delegates to the
 * {@link UnifiedCredentialPool} singleton (`getCredentialPool().pick()`) and
 * triggers a lazy seed pass on first call. The sync variant is retained for
 * call-sites that cannot move to async (e.g. `defaultTransportApiKey`,
 * `resolveModelCredentials`).
 *
 * Never throws. All filesystem errors are caught and treated as "not found".
 *
 * @param provider - The LLM provider transport to resolve credentials for.
 * @param options  - Optional overrides and project root for tier 5 warning.
 * @returns A `CredentialResult` with `provider`, `apiKey`, and `source`.
 *
 * @example
 * ```ts
 * const cred = resolveCredentials('anthropic', { projectRoot: cwd });
 * if (!cred.apiKey) throw new Error('No Anthropic key found');
 * ```
 *
 * @task T9413
 * @epic E-CONFIG-AUTH-UNIFY
 */
export function resolveCredentials(
  provider: ModelTransport,
  options: CredentialResolveOptions = {},
): CredentialResult {
  // T9407 — fire-and-forget bootstrap migrations. Both helpers are idempotent
  // (in-process latch + filesystem marker) so this is O(1) on warm calls and
  // never re-runs once the migration is complete. The flat-key import is
  // async; we never await it because the tier-4b fallback still picks up
  // the file even before the pool entry lands, so resolution stays correct
  // mid-import.
  ensureLegacyFlatAnthropicKeyImported();

  // Tier 1 — explicit caller-supplied key
  if (options.apiKey?.trim()) {
    const token = options.apiKey.trim();
    return {
      provider,
      apiKey: token,
      source: 'explicit',
      authType: detectAuthType(provider, token),
    };
  }

  // Tier 2 — environment variable
  const envVar = ENV_VARS[provider];
  const envKey = process.env[envVar];
  if (envKey?.trim()) {
    const token = envKey.trim();
    return { provider, apiKey: token, source: 'env', authType: detectAuthType(provider, token) };
  }

  // Tier 3 — ~/.cleo/llm-credentials.json (multi-credential pool).
  // T-LLM-CRED-CENTRALIZATION Phase 2 (T9257). Sync read of the file-locked,
  // 0600 store. Picks the highest-priority non-disabled, non-expired entry
  // for `provider`. The sync path NEVER re-seeds — seeding is the unified
  // pool's responsibility (T9412 / T9413). Returns null when the file is
  // absent or has no eligible entries — falls through to the legacy tiers.
  const stored = pickCredentialForProviderSync(provider);
  if (stored) {
    // Narrow stored.authType back to the on-wire AuthType. Phase 2 widens
    // stored auth to include `aws_sdk` (Bedrock); Phase 3 will widen the
    // resolver's AuthType. Until then, treat `aws_sdk` as `api_key` so
    // downstream callers fall back to existing header logic.
    const wireAuthType: AuthType = stored.authType === 'oauth' ? 'oauth' : 'api_key';
    return {
      provider,
      apiKey: stored.accessToken || null,
      source: 'cred-file',
      authType: wireAuthType,
    };
  }

  // Tier 4 (legacy direct claude-creds read) — REMOVED in T9413. The
  // `claude-code` seeder owns `~/.claude/.credentials.json`; its imported
  // entries surface via tier 3 above.

  // Tier 4a — global config. **DEPRECATED** (T9413). Emits a stderr warning
  // on every hit so operators discover the migration path; still resolves
  // for now so existing installs keep working. Canonical XDG config dir is
  // preferred; the data-dir copy is the transition-window fallback.
  const globalKey = readGlobalProviderKey(provider);
  if (globalKey) {
    warnGlobalConfigApiKeyDeprecated(provider);
    return {
      provider,
      apiKey: globalKey,
      source: 'global-config',
      authType: detectAuthType(provider, globalKey),
    };
  }

  // Tier 4b — legacy flat key file (~/.local/share/cleo/anthropic-key).
  // Backward compat for keys written by storeAnthropicApiKey() before T1677.
  // Only applicable to the anthropic provider.
  if (provider === 'anthropic') {
    const flatKey = readFlatAnthropicKey();
    if (flatKey) {
      return {
        provider,
        apiKey: flatKey,
        source: 'global-config',
        authType: detectAuthType(provider, flatKey),
      };
    }
  }

  // Tier 5 — project config (.cleo/config.json). **REJECTED** in T9413
  // (E-CONFIG-AUTH-UNIFY §5.2 T-E2-6 footgun kill). When a project config
  // still has `llm.providers.*.apiKey` set, emit a stderr warning with the
  // migration command and DO NOT resolve. The key MUST be migrated via
  // `cleo auth migrate-project-secrets` (T-E2-9).
  if (options.projectRoot) {
    const projectKey = readProviderKeyFromConfig(projectConfigPath(options.projectRoot), provider);
    if (projectKey) {
      warnProjectConfigApiKeyRejected(provider);
      // Intentionally fall through to the null return below.
    }
  }

  return { provider, apiKey: null, source: undefined, authType: 'api_key' };
}

/**
 * Async resolver that delegates to the unified credential pool (T9413).
 *
 * Resolution order:
 *
 * 1. `options.apiKey` — explicit caller override (identical to the sync
 *    behaviour; short-circuits before touching the pool).
 * 2. `await getCredentialPool().pick(provider, ...)` — the unified pool
 *    transparently runs a lazy seed pass on first call (60s cache; force
 *    via `force: true` on the pool directly). The returned entry's
 *    `authType` is narrowed to the on-wire {@link AuthType}: `'oauth'` for
 *    OAuth tokens, `'api_key'` for everything else (including `'aws_sdk'`).
 *
 * Returns `{ apiKey: null }` with `source: undefined` when the pool has no
 * eligible entry for the provider — callers should treat this as
 * "no credential available" and emit a setup hint.
 *
 * Unlike the sync resolver, the async path does NOT consult the legacy
 * tiers 4a/4b/5: any deprecated source must be seeded into the pool first
 * (via a seeder) to be picked up here. This is the steady-state code path
 * the rest of E-CONFIG-AUTH-UNIFY converges on.
 *
 * @param provider - The LLM provider transport to resolve credentials for.
 * @param options  - Optional explicit `apiKey` override.
 * @returns A `CredentialResult` shaped identically to the sync resolver.
 *
 * @example
 * ```ts
 * const cred = await resolveCredentialsAsync('anthropic');
 * if (!cred.apiKey) {
 *   throw new Error('No anthropic credential — run `cleo auth add anthropic`');
 * }
 * ```
 *
 * @task T9413
 * @epic E-CONFIG-AUTH-UNIFY
 */
export async function resolveCredentialsAsync(
  provider: ModelTransport,
  options: CredentialResolveOptions = {},
): Promise<CredentialResult> {
  // Tier 1 — explicit caller-supplied key (matches sync behaviour exactly).
  if (options.apiKey?.trim()) {
    const token = options.apiKey.trim();
    return {
      provider,
      apiKey: token,
      source: 'explicit',
      authType: detectAuthType(provider, token),
    };
  }

  // Tier 2+ — delegate to the unified pool. The pool seeds lazily on the
  // first call (and at most once every POOL_SEED_CACHE_TTL_MS), then picks
  // a non-disabled, non-expired entry using the store's default strategy.
  const entry = await getCredentialPool().pick(provider);
  if (entry) {
    const wireAuthType: AuthType = entry.authType === 'oauth' ? 'oauth' : 'api_key';
    return {
      provider,
      apiKey: entry.accessToken || null,
      source: 'cred-file',
      authType: wireAuthType,
    };
  }

  return { provider, apiKey: null, source: undefined, authType: 'api_key' };
}

// ---------------------------------------------------------------------------
// Deprecation warnings — T9413 (E-CONFIG-AUTH-UNIFY §5.2 T-E2-6)
// ---------------------------------------------------------------------------

/**
 * Latch the deprecation warning per (provider, message) so a hot loop does
 * not flood stderr. Keys are simple strings — small, opaque to the rest of
 * the module.
 *
 * @internal
 */
const WARNED_GLOBAL_CONFIG = new Set<string>();
const WARNED_PROJECT_CONFIG = new Set<string>();

/**
 * Emit a one-shot stderr warning that the global-config `apiKey` path is
 * deprecated. Re-emits only if the latch is cleared (test-only via
 * {@link _resetCredentialDeprecationLatchesForTests}).
 *
 * @internal
 * @task T9413
 */
function warnGlobalConfigApiKeyDeprecated(provider: ModelTransport): void {
  if (WARNED_GLOBAL_CONFIG.has(provider)) return;
  WARNED_GLOBAL_CONFIG.add(provider);
  process.stderr.write(
    `[cleo] DEPRECATED: \`llm.providers.${provider}.apiKey\` in the global ` +
      `config.json is deprecated and will be removed. Migrate with ` +
      `\`cleo auth add ${provider}\` or \`cleo llm add\`.\n`,
  );
}

/**
 * Emit a one-shot stderr warning that the project-config `apiKey` path is
 * rejected. The key is NOT resolved — operators must migrate.
 *
 * @internal
 * @task T9413
 */
function warnProjectConfigApiKeyRejected(provider: ModelTransport): void {
  if (WARNED_PROJECT_CONFIG.has(provider)) return;
  WARNED_PROJECT_CONFIG.add(provider);
  process.stderr.write(
    `[cleo] REJECTED: \`llm.providers.${provider}.apiKey\` in \`.cleo/config.json\` ` +
      `(project-scoped) is a security footgun and is no longer honoured. ` +
      `Run \`cleo auth migrate-project-secrets\` to move the key into the ` +
      `unified credential pool.\n`,
  );
}

/**
 * Test-only: clear the one-shot deprecation latches so a test asserting
 * the warning emission can run independently of sibling tests.
 *
 * Production code MUST NOT call this — re-emitting the warning on every
 * hit would flood stderr.
 *
 * @internal
 */
export function _resetCredentialDeprecationLatchesForTests(): void {
  WARNED_GLOBAL_CONFIG.clear();
  WARNED_PROJECT_CONFIG.clear();
}

/**
 * Detect whether a credential string is an Anthropic OAuth token by prefix.
 *
 * The Claude Code OAuth flow issues tokens with the prefixes:
 * - `sk-ant-oat-*` — access token (used for API calls)
 * - `sk-ant-ort-*` — refresh token (rare in direct calls, but recognized for safety)
 *
 * Every other provider in Phase 1 uses `api_key` authentication, so any
 * non-Anthropic credential is treated as `api_key`. Tokens loaded from
 * `claude-creds` are always `oauth` regardless of prefix (handled by the caller).
 */
function detectAuthType(provider: ModelTransport, token: string): AuthType {
  if (provider !== 'anthropic') return 'api_key';
  if (token.startsWith('sk-ant-oat-') || token.startsWith('sk-ant-ort-')) return 'oauth';
  return 'api_key';
}

/**
 * Build the authentication HTTP headers for a resolved credential.
 *
 * For raw-fetch call-sites (e.g. memory/sleep-consolidation, memory/observer-reflector)
 * this returns the full bag of provider-specific auth headers including the
 * `anthropic-version` or `anthropic-beta` markers that Anthropic requires.
 * The caller still owns `Content-Type` and the request body.
 *
 * Returns an empty object when `cred.apiKey` is null — callers should never
 * reach this helper without verifying they have a credential, but the no-op
 * fallback avoids accidental `undefined` header injection.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 */
export function authHeaders(cred: CredentialResult): Record<string, string> {
  if (!cred.apiKey) return {};

  if (cred.provider === 'anthropic') {
    if (cred.authType === 'oauth') {
      return {
        Authorization: `Bearer ${cred.apiKey}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
      };
    }
    return {
      'x-api-key': cred.apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  // openai / gemini / moonshot — all use Bearer auth for API keys.
  return { Authorization: `Bearer ${cred.apiKey}` };
}

/**
 * Build the provider auth headers AT THE WIRE directly from a sealed credential
 * handle — the E10 boundary primitive (T11754 · AC2).
 *
 * ## Why this exists
 *
 * The pre-E10 / interim pattern materialized the plaintext into a caller-visible
 * variable first — `const token = (await sealed.fetch()).value;` — and only then
 * called {@link authHeaders}. That intermediate `token` binding is a leak surface:
 * any code added between the `fetch()` and the header build could log, serialize,
 * or forward the bare secret.
 *
 * `authHeadersFromSealed` collapses those two steps into ONE chokepoint. It is
 * the SOLE place (alongside daemon worker-injection) that invokes
 * {@link SealedCredential.fetch} — the crypto decrypt happens inside the handle's
 * `fetch()`, the materialized {@link DecryptedToken} is consumed in-place to build
 * the `x-api-key` / `Authorization: Bearer` headers (per provider + scheme), and
 * the plaintext goes out of scope WITHOUT ever being returned, logged, or bound
 * to a caller variable. Callers receive ONLY the finished header bag.
 *
 * Invoke this ONLY at a wire boundary — `transportForProvider` /
 * `session-factory.ts:56`, the raw-fetch consumers (hygiene-scan,
 * duplicate-detector), or daemon worker-injection. Never to surface a key up the
 * resolver stack.
 *
 * @param sealed - The opaque credential handle returned by the resolver.
 * @param authType - The auth scheme to present the credential with (mirrors the
 *   resolved `credential.authType`). `'aws_sdk'` yields an empty bag — the AWS
 *   SDK injects credentials out-of-band, so there is no header to build.
 * @returns The provider-specific auth headers. The plaintext token is consumed
 *   internally and never escapes this function.
 * @task T11754
 */
export async function authHeadersFromSealed(
  sealed: SealedCredential,
  authType: 'api_key' | 'oauth' | 'aws_sdk',
): Promise<Record<string, string>> {
  // The AWS SDK owns Bedrock auth out-of-band — no wire header to materialize,
  // so we must NOT call fetch() (the token is empty for aws_sdk entries).
  if (authType === 'aws_sdk') return {};

  // The SOLE decrypt/materialize point at this boundary. The branded plaintext
  // lives only for the synchronous authHeaders() call below, then goes out of
  // scope. It is NEVER assigned to a caller-visible binding or returned.
  const decrypted = await sealed.fetch();
  return authHeaders({
    provider: sealed.provider as ModelTransport,
    apiKey: decrypted.value,
    source: undefined,
    authType: authType === 'oauth' ? 'oauth' : 'api_key',
  });
}

// ---------------------------------------------------------------------------
// Backward-compatible Anthropic-specific helpers
// (previously in anthropic-key-resolver.ts — now implemented via the
//  unified resolver so there is ONE code path, no duplication)
// ---------------------------------------------------------------------------

/**
 * Resolve the credential status for a single provider.
 *
 * Calls the 6-tier resolution chain and maps the result to a human-facing
 * `LlmProviderSourceWire` value. Does NOT cache — always re-reads.
 *
 * Used by `cleo memory llm-status` to build the `providers[]` array without
 * branching on provider names.
 *
 * @param provider - The provider transport to check.
 * @returns Status entry with `resolvedSource` and `hasCredential`.
 * @task T9323
 */
export function resolveProviderStatus(provider: ModelTransport): {
  provider: ModelTransport;
  resolvedSource: 'env' | 'cred-file' | 'claude-creds' | 'config' | 'none';
  hasCredential: boolean;
} {
  const result = resolveCredentials(provider);
  if (!result.apiKey) {
    return { provider, resolvedSource: 'none', hasCredential: false };
  }
  let resolvedSource: 'env' | 'cred-file' | 'claude-creds' | 'config' | 'none';
  switch (result.source) {
    case 'env':
      resolvedSource = 'env';
      break;
    case 'cred-file':
      resolvedSource = 'cred-file';
      break;
    case 'claude-creds':
      resolvedSource = 'claude-creds';
      break;
    case 'global-config':
    case 'project-config':
      resolvedSource = 'config';
      break;
    default:
      resolvedSource = 'none';
  }
  return { provider, resolvedSource, hasCredential: true };
}

/**
 * The set of OAuth-capable provider transports that surface in `llm-status`.
 *
 * Extend this tuple when adding new OAuth-capable providers. The order is
 * preserved in the `providers[]` array of `cleo memory llm-status` output.
 *
 * @task T9323
 */
export const OAUTH_STATUS_PROVIDERS: readonly ModelTransport[] = [
  'anthropic',
  'kimi-code',
] as const;

/**
 * Store an Anthropic API key in the CLEO global config directory.
 *
 * Writes to `~/.local/share/cleo/anthropic-key` with 0600 permissions.
 *
 * @param apiKey - The API key to store.
 */
export function storeAnthropicApiKey(apiKey: string): void {
  const dir = getCleoHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const keyFile = join(dir, 'anthropic-key');
  writeFileSync(keyFile, apiKey.trim(), { mode: 0o600 });
}

/**
 * No-op retained for test call-site compatibility.
 *
 * `resolveCredentials` does not maintain an internal cache, so there is
 * nothing to invalidate. Tests that call this function between assertions
 * continue to work correctly — they simply rely on the file-system / env-var
 * isolation they already set up.
 */
export function clearAnthropicKeyCache(): void {
  // no-op — resolveCredentials() reads the filesystem directly; no cache to clear.
}

// ---------------------------------------------------------------------------
// Backward-compatible shim for the existing resolveCredentials() signature
// (ModelConfig → { apiKey, apiBase }) that the llm/registry.ts uses.
// We keep the old name by adding an overload. The new signature is the
// canonical one; the old one is delegated to.
// ---------------------------------------------------------------------------

import type { ModelConfig } from './types-config.js';

/**
 * Resolve API key and base URL for a fully-specified `ModelConfig`.
 *
 * This is the lower-level variant used by the LLM layer internals.
 * Prefer `resolveCredentials(provider, options)` for new callers.
 *
 * @param config - ModelConfig with transport and optional apiKey/baseUrl.
 * @returns `{ apiKey, apiBase }` pair where null means "use SDK default".
 */
export function resolveModelCredentials(config: ModelConfig): {
  apiKey: string | null;
  apiBase: string | null;
} {
  const result = resolveCredentials(config.transport, { apiKey: config.apiKey ?? undefined });
  return {
    apiKey: result.apiKey,
    apiBase: config.baseUrl ?? null,
  };
}

/**
 * Resolve the global LLM API key for the matching transport from environment
 * variables only (no config file cascade).
 *
 * Used internally by `clientForModelConfig` as a last-resort key source when
 * the ModelConfig carries no explicit key. New callers should prefer
 * `resolveCredentials(transport)` for the full 5-tier resolution chain.
 *
 * @param transport - The provider transport to look up.
 * @returns The environment variable value, or null.
 */
export function defaultTransportApiKey(transport: ModelTransport): string | null {
  const envVar = ENV_VARS[transport];
  return process.env[envVar] ?? null;
}
