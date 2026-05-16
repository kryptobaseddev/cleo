/**
 * Provider SDK client factory — credential-aware construction with per-tuple caching.
 *
 * Exposes `clientForModelConfig` as the single entry point for building SDK
 * clients from a resolved `ModelConfig`. The legacy module-load `CLIENTS` map,
 * `buildAnthropicSdkClient`, and `historyAdapterForProvider` have been removed
 * (D-ph4-01, T9356): transports construct their own SDK clients in their
 * constructors. `clientForModelConfig` is retained for the legacy
 * `role-resolver.ts` code path (to be removed in T9370).
 *
 * @task T1392 (T1386-W6)
 * @task T9356 (D-ph4-01 factory retirement — T9369)
 * @epic T1386
 */

import { createHash } from 'node:crypto';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';

import { defaultTransportApiKey } from './credentials.js';
import { MOONSHOT_BASE_URL } from './provider-registry/builtin/moonshot.js';
import type { ProviderClient } from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

// ---------------------------------------------------------------------------
// Cache key helpers (S-05 — never embed raw API keys in Map keys)
// ---------------------------------------------------------------------------

/**
 * Hash a string into a short stable token suitable for use in a cache key.
 *
 * S-05 (CWE-200 information exposure): hashing secrets keeps cache keys
 * deterministic without retaining plaintext in the module-global Map.
 * SHA-256 of the secret, 16 hex chars (64 bits) — collision-resistant for
 * an in-process LRU keyed on a small number of tuples per worker.
 *
 * @param value - Secret string to hash.
 * @returns 16-char hex prefix of SHA-256 digest.
 */
function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** Header names whose values are secret-bearing (hashed, not embedded). Case-insensitive. */
const SECRET_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'cookie']);

/**
 * Build a cache key from (baseUrl, apiKey, extraHeaders) without leaking secrets.
 *
 * @param baseUrl - Provider base URL override, or null/undefined.
 * @param apiKey - API key or bearer token, or null/undefined.
 * @param extraHeaders - Extra request headers, or null/undefined.
 * @returns Stable, secret-safe cache key string.
 */
function makeOverrideKey(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
  extraHeaders?: Record<string, string> | null,
): string {
  const apiKeyKey = apiKey ? `sha256:${hashSecret(apiKey)}` : '';
  let headerKey = '';
  if (extraHeaders) {
    const entries = Object.entries(extraHeaders).sort(([a], [b]) => a.localeCompare(b));
    headerKey = entries
      .map(([k, v]) =>
        SECRET_HEADER_NAMES.has(k.toLowerCase()) ? `${k}=sha256:${hashSecret(v)}` : `${k}=${v}`,
      )
      .join('|');
  }
  return `${baseUrl ?? ''}::${apiKeyKey}::${headerKey}`;
}

// ---------------------------------------------------------------------------
// Per-provider client caches (module-private)
// ---------------------------------------------------------------------------

const _anthropicCache = new Map<string, Anthropic>();
const _openaiCache = new Map<string, OpenAI>();
const _geminiCache = new Map<string, GoogleGenerativeAI>();
const _moonshotCache = new Map<string, OpenAI>();

// ---------------------------------------------------------------------------
// Bearer-token extraction
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header.
 * Header lookup is case-insensitive. Returns null when absent or non-Bearer.
 *
 * @param headers - Header map to search.
 * @returns Bearer token string, or null.
 */
function extractBearerToken(headers: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'authorization') continue;
    const match = /^Bearer\s+(.+)$/i.exec(v);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// clientForModelConfig — canonical SDK client factory
// ---------------------------------------------------------------------------

/**
 * Resolve the provider SDK client for a `ModelConfig`.
 *
 * Constructs (or returns from cache) an Anthropic / OpenAI / GoogleGenerativeAI
 * client for the given (provider, baseUrl, apiKey, extraHeaders) tuple.
 * The OAuth Bearer path is honoured for Anthropic: when `extraHeaders.Authorization`
 * is present the SDK uses `authToken` so requests carry `Authorization: Bearer …`
 * without also sending `x-api-key`.
 *
 * @param provider - Target transport identifier.
 * @param modelConfig - Resolved model configuration with optional overrides.
 * @returns Wired SDK client matching the provider type.
 * @throws {Error} When no API key is available and no Bearer token is set.
 * @throws {Error} When the provider is unrecognised.
 */
export function clientForModelConfig(
  provider: ModelTransport,
  modelConfig: ModelConfig,
): ProviderClient {
  const apiKey = modelConfig.apiKey ?? defaultTransportApiKey(provider);
  const baseUrl = modelConfig.baseUrl;
  const extraHeaders = modelConfig.extraHeaders ?? null;

  if (!apiKey && !extractBearerToken(extraHeaders ?? {})) {
    throw new Error(`Missing API key for ${provider} model config`);
  }

  if (provider === 'anthropic') {
    const key = makeOverrideKey(baseUrl, apiKey, extraHeaders);
    const cached = _anthropicCache.get(key);
    if (cached) return cached;

    const oauthToken = extraHeaders ? extractBearerToken(extraHeaders) : null;
    let client: Anthropic;
    if (oauthToken) {
      const oauthHeaders: Record<string, string> = {};
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
          if (k.toLowerCase() === 'authorization') continue;
          oauthHeaders[k] = v;
        }
      }
      client = new Anthropic({
        authToken: oauthToken,
        baseURL: baseUrl ?? undefined,
        timeout: 600_000,
        defaultHeaders: oauthHeaders,
      });
    } else {
      client = new Anthropic({
        apiKey: apiKey ?? undefined,
        baseURL: baseUrl ?? undefined,
        timeout: 600_000,
        defaultHeaders: extraHeaders ?? undefined,
      });
    }
    _anthropicCache.set(key, client);
    return client;
  }

  if (provider === 'openai') {
    const key = makeOverrideKey(baseUrl, apiKey);
    const cached = _openaiCache.get(key);
    if (cached) return cached;
    const client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: baseUrl ?? undefined });
    _openaiCache.set(key, client);
    return client;
  }

  if (provider === 'gemini') {
    const key = makeOverrideKey(baseUrl, apiKey);
    const cached = _geminiCache.get(key);
    if (cached) return cached;
    const client = new GoogleGenerativeAI(apiKey ?? '');
    _geminiCache.set(key, client);
    return client;
  }

  if (provider === 'moonshot') {
    const effectiveBaseUrl = baseUrl ?? MOONSHOT_BASE_URL;
    const key = makeOverrideKey(effectiveBaseUrl, apiKey);
    const cached = _moonshotCache.get(key);
    if (cached) return cached;
    const client = new OpenAI({ apiKey: apiKey ?? undefined, baseURL: effectiveBaseUrl });
    _moonshotCache.set(key, client);
    return client;
  }

  throw new Error(`Unknown provider: ${provider as string}`);
}

