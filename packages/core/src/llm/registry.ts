/**
 * Single owner of provider runtime objects: clients, backends, history adapters.
 *
 * Ported from PSYCHE src/llm/registry.py (185 LOC). Consolidates all provider
 * SDK wiring. Tests can patch CLIENTS for mock injection.
 *
 * @task T1392 (T1386-W6)
 * @epic T1386
 */

import { createHash } from 'node:crypto';
import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';

import type { ProviderBackend } from './backend.js';
import { AnthropicBackend } from './backends/anthropic.js';
import { MOONSHOT_BASE_URL, MoonshotBackend } from './backends/moonshot.js';
import { OpenAIBackend } from './backends/openai.js';
import type { CredentialResult } from './credentials.js';
import { defaultTransportApiKey } from './credentials.js';
import type { HistoryAdapter } from './history-adapters.js';
import {
  AnthropicHistoryAdapter,
  GeminiHistoryAdapter,
  OpenAIHistoryAdapter,
} from './history-adapters.js';
import type { ProviderClient } from './types.js';
import type { ModelConfig, ModelTransport } from './types-config.js';

/** Module-level default client registry. Tests can patch this map. */
export const CLIENTS: Partial<Record<ModelTransport, ProviderClient>> = {};

// Initialize default clients from environment at module load time
function initDefaultClients(): void {
  const anthropicKey = process.env['ANTHROPIC_API_KEY'];
  const openaiKey = process.env['OPENAI_API_KEY'];
  const geminiKey = process.env['GEMINI_API_KEY'];
  const moonshotKey = process.env['MOONSHOT_API_KEY'];

  if (anthropicKey) {
    CLIENTS['anthropic'] = new Anthropic({ apiKey: anthropicKey, timeout: 600_000 });
  }
  if (openaiKey) {
    CLIENTS['openai'] = new OpenAI({ apiKey: openaiKey });
  }
  if (geminiKey) {
    CLIENTS['gemini'] = new GoogleGenerativeAI(geminiKey);
  }
  if (moonshotKey) {
    CLIENTS['moonshot'] = new OpenAI({ apiKey: moonshotKey, baseURL: MOONSHOT_BASE_URL });
  }
}

initDefaultClients();

// --- Cached override client factories ---
// In Python: @lru_cache. In TS: simple Map keyed by `baseUrl::apiKey`.

const _anthropicOverrideCache = new Map<string, Anthropic>();
const _openaiOverrideCache = new Map<string, OpenAI>();
const _geminiOverrideCache = new Map<string, GoogleGenerativeAI>();
const _moonshotOverrideCache = new Map<string, OpenAI>();

/**
 * Header names whose values are secret-bearing. Their values are hashed,
 * not embedded verbatim, into the cache key (S-05). Case-insensitive.
 */
const SECRET_HEADER_NAMES = new Set(['authorization', 'x-api-key', 'cookie']);

/**
 * Hash a string into a short stable token suitable for use in a cache key.
 *
 * S-05 (CWE-200 information exposure): the cache key has to be stable
 * across calls for the same `(baseUrl, apiKey, extraHeaders)` tuple, but
 * the previous implementation embedded the raw `apiKey` and any
 * `Authorization: Bearer <token>` header value directly into the key
 * string. Those strings then lived in module-global `Map<string, …>`
 * caches for the lifetime of the process, where any future heap-dump
 * tool / serializer / debug introspection hook would surface them.
 *
 * SHA-256 of the secret keeps the cache deterministic without retaining
 * the plaintext — 16 hex chars (64 bits) is collision-resistant enough
 * for an in-process LRU keyed on a small handful of tuples per worker.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 2 — security review S-05
 */
function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function makeOverrideKey(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
  extraHeaders?: Record<string, string> | null,
): string {
  // S-05: hash the apiKey and any secret-bearing headers rather than
  // embedding them in the key string. Non-secret headers (e.g.
  // `anthropic-beta`, `anthropic-version`) stay readable so the cache
  // still differentiates client configs correctly.
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

/**
 * Get (or create) a cached Anthropic client for a specific
 * (baseUrl, apiKey, extraHeaders) tuple.
 *
 * When `extraHeaders.Authorization` is present (set by `authHeaders(cred)` for
 * OAuth credentials), the SDK is constructed with `authToken` instead of
 * `apiKey` so requests carry `Authorization: Bearer …` and omit the default
 * `x-api-key`. The `anthropic-beta: oauth-2025-04-20` header is forwarded
 * through `defaultHeaders`.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 */
export function getAnthropicOverrideClient(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
  extraHeaders?: Record<string, string> | null,
): Anthropic {
  const key = makeOverrideKey(baseUrl, apiKey, extraHeaders);
  const cached = _anthropicOverrideCache.get(key);
  if (cached) return cached;

  const oauthMatch = extraHeaders ? extractBearerToken(extraHeaders) : null;
  if (oauthMatch) {
    // OAuth path: SDK uses authToken → `Authorization: Bearer …`.
    // Critical: do NOT also pass apiKey — the SDK sends both `x-api-key` and
    // `Authorization` when both are set, which Anthropic rejects with 401.
    const oauthHeaders: Record<string, string> = {};
    if (extraHeaders) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        if (k.toLowerCase() === 'authorization') continue;
        oauthHeaders[k] = v;
      }
    }
    const client = new Anthropic({
      authToken: oauthMatch,
      baseURL: baseUrl ?? undefined,
      timeout: 600_000,
      defaultHeaders: oauthHeaders,
    });
    _anthropicOverrideCache.set(key, client);
    return client;
  }

  const client = new Anthropic({
    apiKey: apiKey ?? undefined,
    baseURL: baseUrl ?? undefined,
    timeout: 600_000,
    defaultHeaders: extraHeaders ?? undefined,
  });
  _anthropicOverrideCache.set(key, client);
  return client;
}

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header value.
 * Header lookup is case-insensitive. Returns null when no Authorization header
 * is present or when it does not use the Bearer scheme.
 */
function extractBearerToken(headers: Record<string, string>): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== 'authorization') continue;
    const match = /^Bearer\s+(.+)$/i.exec(v);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

/**
 * Build a fresh Anthropic SDK client for a resolved credential.
 *
 * Centralises the dynamic-import + constructor dance previously duplicated in
 * `memory/llm-extraction.ts`, `sentient/dream-cycle.ts`, and `deriver/deriver.ts`.
 * Honors `cred.authType` so OAuth tokens are passed via `authToken` (Bearer)
 * and api_key credentials via `apiKey` (`x-api-key`).
 *
 * Returns null when the credential has no resolvable token.
 *
 * @task T-LLM-CRED-CENTRALIZATION Phase 1
 */
export function buildAnthropicSdkClient(cred: CredentialResult): Anthropic | null {
  if (!cred.apiKey) return null;
  if (cred.authType === 'oauth') {
    return new Anthropic({
      authToken: cred.apiKey,
      timeout: 600_000,
      defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
    });
  }
  return new Anthropic({ apiKey: cred.apiKey, timeout: 600_000 });
}

/** Get (or create) a cached OpenAI client for a specific (baseUrl, apiKey) pair. */
export function getOpenAIOverrideClient(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): OpenAI {
  const key = makeOverrideKey(baseUrl, apiKey);
  const cached = _openaiOverrideCache.get(key);
  if (cached) return cached;
  const client = new OpenAI({
    apiKey: apiKey ?? undefined,
    baseURL: baseUrl ?? undefined,
  });
  _openaiOverrideCache.set(key, client);
  return client;
}

/** Get (or create) a cached Gemini client for a specific apiKey. */
export function getGeminiOverrideClient(
  _baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): GoogleGenerativeAI {
  const key = makeOverrideKey(_baseUrl, apiKey);
  const cached = _geminiOverrideCache.get(key);
  if (cached) return cached;
  const client = new GoogleGenerativeAI(apiKey ?? '');
  _geminiOverrideCache.set(key, client);
  return client;
}

/**
 * Get (or create) a cached Moonshot client for a specific (baseUrl, apiKey) pair.
 *
 * Moonshot uses an OpenAI-compatible API. When no baseUrl override is provided
 * the default {@link MOONSHOT_BASE_URL} is used so all traffic targets
 * `api.moonshot.ai/v1`.
 */
export function getMoonshotOverrideClient(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): OpenAI {
  const effectiveBaseUrl = baseUrl ?? MOONSHOT_BASE_URL;
  const key = makeOverrideKey(effectiveBaseUrl, apiKey);
  const cached = _moonshotOverrideCache.get(key);
  if (cached) return cached;
  const client = new OpenAI({
    apiKey: apiKey ?? undefined,
    baseURL: effectiveBaseUrl,
  });
  _moonshotOverrideCache.set(key, client);
  return client;
}

/**
 * Resolve the provider client for a ModelConfig.
 *
 * Fast path: no overrides → reuse the module-level default client from
 * CLIENTS. Otherwise route through the cached override factories.
 */
export function clientForModelConfig(
  provider: ModelTransport,
  modelConfig: ModelConfig,
): ProviderClient {
  // Fast path: no overrides at all → reuse the module-level default client.
  // extraHeaders forces the override path because the default client has no
  // OAuth-aware constructor wiring.
  if (!modelConfig.apiKey && !modelConfig.baseUrl && !modelConfig.extraHeaders) {
    const existing = CLIENTS[provider];
    if (existing !== undefined) return existing;
  }

  const apiKey = modelConfig.apiKey ?? defaultTransportApiKey(provider);
  const baseUrl = modelConfig.baseUrl;
  const extraHeaders = modelConfig.extraHeaders ?? null;

  if (!apiKey && !extractBearerToken(extraHeaders ?? {})) {
    throw new Error(`Missing API key for ${provider} model config`);
  }

  if (provider === 'anthropic') return getAnthropicOverrideClient(baseUrl, apiKey, extraHeaders);
  if (provider === 'openai') return getOpenAIOverrideClient(baseUrl, apiKey);
  if (provider === 'gemini') return getGeminiOverrideClient(baseUrl, apiKey);
  if (provider === 'moonshot') return getMoonshotOverrideClient(baseUrl, apiKey);

  throw new Error(`Unknown provider: ${provider as string}`);
}

/**
 * Wrap a raw provider SDK client in the matching ProviderBackend adapter.
 */
export function backendForProvider(
  provider: ModelTransport,
  client: ProviderClient,
): ProviderBackend {
  if (provider === 'anthropic') return new AnthropicBackend(client as Anthropic);
  if (provider === 'openai') return new OpenAIBackend(client as OpenAI);
  if (provider === 'moonshot') return new MoonshotBackend(client as OpenAI);

  throw new Error(`Unknown provider: ${provider as string}`);
}

/**
 * Provider-appropriate HistoryAdapter for assistant/tool message formatting.
 */
export function historyAdapterForProvider(provider: ModelTransport): HistoryAdapter {
  if (provider === 'anthropic') return new AnthropicHistoryAdapter();
  if (provider === 'gemini') return new GeminiHistoryAdapter();
  // openai and any unknown provider
  return new OpenAIHistoryAdapter();
}

/**
 * High-level one-shot backend factory: ModelConfig → ProviderBackend.
 */
export function getBackend(config: ModelConfig): ProviderBackend {
  const client = clientForModelConfig(config.transport, config);
  return backendForProvider(config.transport, client);
}
