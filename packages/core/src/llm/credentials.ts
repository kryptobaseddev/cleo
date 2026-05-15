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
 * 5. **global-config**  — `~/.cleo/config.json` → `llm.providers.<provider>.apiKey`
 * 6. **project-config** — `.cleo/config.json`  → `llm.providers.<provider>.apiKey`
 *
 * Returns `null` when no key is found in any tier.
 *
 * ## Backward compatibility
 *
 * `resolveAnthropicApiKey()`, `resolveAnthropicApiKeySource()`,
 * `storeAnthropicApiKey()`, and `clearAnthropicKeyCache()` from the deleted
 * `anthropic-key-resolver.ts` are re-implemented here as thin shims over the
 * unified resolver so existing callers in internal.ts / CLI tests continue to
 * work. They are NOT deprecated — they remain valid public helpers for the
 * Anthropic-specific fast path that many callers need.
 *
 * @module llm/credentials
 * @task T1677
 * @epic T1676
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeCodeCredentials } from '@cleocode/contracts';
import { pickCredentialForProviderSync } from './credentials-store.js';
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
 */
const ENV_VARS: Record<ModelTransport, string> = {
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
};

// ---------------------------------------------------------------------------
// Path helpers (mirrors anthropic-key-resolver.ts logic, now centralised)
// ---------------------------------------------------------------------------

/**
 * XDG-aware global CLEO data directory.
 *
 * Resolution: `$XDG_DATA_HOME/cleo` when set, else `~/.local/share/cleo`.
 *
 * Exported so sibling modules (notably `credentials-store.ts`) can resolve
 * `~/.cleo/llm-credentials.json` against the SAME XDG-aware home that every
 * other CLEO global file uses — including this module's tier 4/4b lookups.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2
 * @task T9257
 */
export function cleoHomeDir(): string {
  const xdg = process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share');
  return join(xdg, 'cleo');
}

/** Path to the global CLEO config file. */
function globalConfigPath(): string {
  return join(cleoHomeDir(), 'config.json');
}

/** Path to the project-level CLEO config file. */
function projectConfigPath(projectRoot: string): string {
  const cleoDir = process.env['CLEO_DIR'] ?? '.cleo';
  return join(projectRoot, cleoDir, 'config.json');
}

// ---------------------------------------------------------------------------
// Tier helpers
// ---------------------------------------------------------------------------

/**
 * Tier 3: read the Anthropic OAuth token from Claude Code credentials.
 *
 * Only applicable for the `anthropic` provider. Checks token expiry and
 * returns null if the token is present but expired.
 *
 * Delegates parsing to `parseClaudeCodeCredentials` from @cleocode/contracts
 * so the pure parsing logic has a single canonical home.
 */
function readClaudeCredsToken(): string | null {
  try {
    const credPath = join(homedir(), '.claude', '.credentials.json');
    if (!existsSync(credPath)) return null;
    const raw = readFileSync(credPath, 'utf-8');
    const cred = parseClaudeCodeCredentials(raw);
    return cred?.accessToken ?? null;
  } catch {
    return null;
  }
}

/**
 * Tier 4b backward compat: read the legacy flat key file written by
 * `storeAnthropicApiKey()` before T1677 migrated storage to config.json.
 *
 * File: `~/.local/share/cleo/anthropic-key` (plain text, one line).
 * Returns null when the file does not exist or is empty.
 */
function readFlatAnthropicKey(): string | null {
  try {
    const keyFile = join(cleoHomeDir(), 'anthropic-key');
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
 * Resolve the API key for a provider using the 5-tier priority chain.
 *
 * Resolution order (first non-empty match wins):
 * 1. `options.apiKey`  — explicit caller override
 * 2. `ENV_VARS[provider]` environment variable
 * 3. `~/.claude/.credentials.json` OAuth token (anthropic only)
 * 4. `~/.cleo/config.json` → `llm.providers[provider].apiKey`
 * 5. `<projectRoot>/.cleo/config.json` → `llm.providers[provider].apiKey`
 *
 * Never throws. All filesystem errors are caught and treated as "not found".
 *
 * @param provider - The LLM provider transport to resolve credentials for.
 * @param options  - Optional overrides and project root for tier 5.
 * @returns A `CredentialResult` with `provider`, `apiKey`, and `source`.
 *
 * @example
 * ```ts
 * const cred = resolveCredentials('anthropic', { projectRoot: cwd });
 * if (!cred.apiKey) throw new Error('No Anthropic key found');
 * ```
 */
export function resolveCredentials(
  provider: ModelTransport,
  options: CredentialResolveOptions = {},
): CredentialResult {
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
  // for `provider`. Returns null when the file is absent or has no eligible
  // entries — falls through to the legacy claude-creds tier below.
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

  // Tier 4 — ~/.claude/.credentials.json (anthropic only)
  if (provider === 'anthropic') {
    const oauthToken = readClaudeCredsToken();
    if (oauthToken) {
      return { provider, apiKey: oauthToken, source: 'claude-creds', authType: 'oauth' };
    }
  }

  // Tier 4a — global config (~/.local/share/cleo/config.json → llm.providers[p].apiKey)
  const globalKey = readProviderKeyFromConfig(globalConfigPath(), provider);
  if (globalKey) {
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

  // Tier 5 — project config (.cleo/config.json)
  if (options.projectRoot) {
    const projectKey = readProviderKeyFromConfig(projectConfigPath(options.projectRoot), provider);
    if (projectKey) {
      return {
        provider,
        apiKey: projectKey,
        source: 'project-config',
        authType: detectAuthType(provider, projectKey),
      };
    }
  }

  return { provider, apiKey: null, source: undefined, authType: 'api_key' };
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

// ---------------------------------------------------------------------------
// Backward-compatible Anthropic-specific helpers
// (previously in anthropic-key-resolver.ts — now implemented via the
//  unified resolver so there is ONE code path, no duplication)
// ---------------------------------------------------------------------------

/** Cached anthropic key — avoids repeated filesystem reads per process. */
let _cachedAnthropicKey: string | null | undefined;

/**
 * Resolve the Anthropic API key. Result is cached for the process lifetime.
 *
 * Uses the 5-tier chain (without project-root — callers that need tier 5
 * should call `resolveCredentials('anthropic', { projectRoot })` directly).
 *
 * @returns The API key/token string, or null if unavailable.
 */
export function resolveAnthropicApiKey(): string | null {
  if (_cachedAnthropicKey !== undefined) return _cachedAnthropicKey;
  const result = resolveCredentials('anthropic');
  _cachedAnthropicKey = result.apiKey;
  return _cachedAnthropicKey;
}

/**
 * Identify which source resolved the Anthropic API key.
 *
 * Unlike `resolveAnthropicApiKey()`, this function does NOT cache — every
 * call re-reads all sources so status checks are always fresh.
 *
 * @returns The resolution source, or `'none'` when no key is found.
 */
export function resolveAnthropicApiKeySource(): 'env' | 'config' | 'oauth' | 'none' {
  const result = resolveCredentials('anthropic');
  switch (result.source) {
    case 'env':
      return 'env';
    case 'claude-creds':
      return 'oauth';
    case 'global-config':
    case 'project-config':
      return 'config';
    default:
      return 'none';
  }
}

/**
 * Store an Anthropic API key in the CLEO global config directory.
 *
 * Writes to `~/.local/share/cleo/anthropic-key` with 0600 permissions.
 * Invalidates the process-level cache so the next `resolveAnthropicApiKey()`
 * call picks up the new key.
 *
 * @param apiKey - The API key to store.
 */
export function storeAnthropicApiKey(apiKey: string): void {
  const dir = cleoHomeDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const keyFile = join(dir, 'anthropic-key');
  writeFileSync(keyFile, apiKey.trim(), { mode: 0o600 });
  _cachedAnthropicKey = undefined;
}

/**
 * Clear the cached Anthropic API key (useful for testing or token refresh).
 */
export function clearAnthropicKeyCache(): void {
  _cachedAnthropicKey = undefined;
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
 * Fall back to the global LLM API key for the matching transport.
 * Reads from environment variables only (no config file cascade).
 *
 * @deprecated Use `resolveCredentials(transport)` for the full 5-tier chain.
 */
export function defaultTransportApiKey(transport: ModelTransport): string | null {
  const envVar = ENV_VARS[transport];
  return process.env[envVar] ?? null;
}
