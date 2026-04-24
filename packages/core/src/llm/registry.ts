/**
 * Single owner of provider runtime objects: clients, backends, history adapters.
 *
 * Ported from PSYCHE src/llm/registry.py (185 LOC). Consolidates all provider
 * SDK wiring. Tests can patch CLIENTS for mock injection.
 *
 * @task T1392 (T1386-W6)
 * @epic T1386
 */

import { Anthropic } from '@anthropic-ai/sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { OpenAI } from 'openai';

import type { ProviderBackend } from './backend.js';
import { AnthropicBackend } from './backends/anthropic.js';
import { GeminiBackend } from './backends/gemini.js';
import { OpenAIBackend } from './backends/openai.js';
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

  if (anthropicKey) {
    CLIENTS['anthropic'] = new Anthropic({ apiKey: anthropicKey, timeout: 600_000 });
  }
  if (openaiKey) {
    CLIENTS['openai'] = new OpenAI({ apiKey: openaiKey });
  }
  if (geminiKey) {
    CLIENTS['gemini'] = new GoogleGenerativeAI(geminiKey);
  }
}

initDefaultClients();

// --- Cached override client factories ---
// In Python: @lru_cache. In TS: simple Map keyed by `baseUrl::apiKey`.

const _anthropicOverrideCache = new Map<string, Anthropic>();
const _openaiOverrideCache = new Map<string, OpenAI>();
const _geminiOverrideCache = new Map<string, GoogleGenerativeAI>();

function makeOverrideKey(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): string {
  return `${baseUrl ?? ''}::${apiKey ?? ''}`;
}

/** Get (or create) a cached Anthropic client for a specific (baseUrl, apiKey) pair. */
export function getAnthropicOverrideClient(
  baseUrl: string | null | undefined,
  apiKey: string | null | undefined,
): Anthropic {
  const key = makeOverrideKey(baseUrl, apiKey);
  const cached = _anthropicOverrideCache.get(key);
  if (cached) return cached;
  const client = new Anthropic({
    apiKey: apiKey ?? undefined,
    baseURL: baseUrl ?? undefined,
    timeout: 600_000,
  });
  _anthropicOverrideCache.set(key, client);
  return client;
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
 * Resolve the provider client for a ModelConfig.
 *
 * Fast path: no overrides → reuse the module-level default client from
 * CLIENTS. Otherwise route through the cached override factories.
 */
export function clientForModelConfig(
  provider: ModelTransport,
  modelConfig: ModelConfig,
): ProviderClient {
  if (!modelConfig.apiKey && !modelConfig.baseUrl) {
    const existing = CLIENTS[provider];
    if (existing !== undefined) return existing;
  }

  const apiKey = modelConfig.apiKey ?? defaultTransportApiKey(provider);
  const baseUrl = modelConfig.baseUrl;

  if (!apiKey) {
    throw new Error(`Missing API key for ${provider} model config`);
  }

  if (provider === 'anthropic') return getAnthropicOverrideClient(baseUrl, apiKey);
  if (provider === 'openai') return getOpenAIOverrideClient(baseUrl, apiKey);
  if (provider === 'gemini') return getGeminiOverrideClient(baseUrl, apiKey);

  throw new Error(`Unknown provider: ${provider as string}`);
}

/**
 * Wrap a raw provider SDK client in the matching ProviderBackend adapter.
 */
export function backendForProvider(
  provider: ModelTransport,
  client: ProviderClient,
  modelConfig?: ModelConfig,
): ProviderBackend {
  if (provider === 'anthropic') return new AnthropicBackend(client as Anthropic);
  if (provider === 'openai') return new OpenAIBackend(client as OpenAI);
  if (provider === 'gemini') return new GeminiBackend(client as GoogleGenerativeAI, modelConfig);

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
  return backendForProvider(config.transport, client, config);
}
