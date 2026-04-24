/**
 * In-memory Gemini cached-content handle store.
 *
 * Ported from Honcho src/llm/caching.py. Uses LRU eviction up to
 * MAX_ENTRIES. `build_cache_key` uses deterministic JSON + sha256.
 *
 * @task T1393 (T1386-W7)
 * @epic T1386
 */

import { createHash } from 'node:crypto';

import type { ModelConfig, PromptCachePolicy } from './types-config.js';

export type { PromptCachePolicy } from './types-config.js';

/** In-memory handle for a Gemini cached-content resource. */
export interface GeminiCacheHandle {
  key: string;
  cachedContentName: string;
  expiresAt: Date;
}

/**
 * Build a deterministic cache key for a Gemini cached-content request.
 *
 * Includes transport, model, cache policy, cacheable messages, tools,
 * system instruction, and tool_config — all of which affect the cached
 * content and must be part of the key.
 */
export function buildCacheKey(params: {
  config: ModelConfig;
  cachePolicy: PromptCachePolicy;
  cacheableMessages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>> | null | undefined;
  systemInstruction?: string | null;
  toolConfig?: Record<string, unknown> | null;
}): string {
  const payload = {
    transport: params.config.transport,
    model: params.config.model,
    cache_policy: params.cachePolicy,
    messages: params.cacheableMessages,
    tools: params.tools ?? null,
    system_instruction: params.systemInstruction ?? null,
    tool_config: params.toolConfig ?? null,
  };
  const encoded = JSON.stringify(payload, sortedReplacer);
  const digest = createHash('sha256').update(encoded, 'utf8').digest('hex');
  const keyVersion = params.cachePolicy.keyVersion ?? 'v1';
  return `llm-cache:${keyVersion}:${digest}`;
}

/** JSON.stringify replacer that sorts object keys for determinism. */
function sortedReplacer(_key: string, value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      sorted[k] = (value as Record<string, unknown>)[k];
    }
    return sorted;
  }
  return value;
}

/**
 * Best-effort local LRU cache for Gemini cached-content handles.
 *
 * Uses insertion-order Map with LRU eviction at MAX_ENTRIES limit.
 * Thread-safety: not needed in single-threaded Node.js (no threading).
 */
export class InMemoryGeminiCacheStore {
  static readonly MAX_ENTRIES = 1024;

  private readonly _handles: Map<string, GeminiCacheHandle> = new Map();

  /**
   * Get a cached handle by key.
   * Returns null if not found or if expired.
   */
  get(key: string): GeminiCacheHandle | null {
    const handle = this._handles.get(key);
    if (handle === undefined) return null;
    if (handle.expiresAt <= new Date()) {
      this._handles.delete(key);
      return null;
    }
    // LRU: move to end
    this._handles.delete(key);
    this._handles.set(key, handle);
    return handle;
  }

  /**
   * Store a handle. Evicts expired entries, then oldest if over limit.
   * Returns the stored handle.
   */
  set(handle: GeminiCacheHandle): GeminiCacheHandle {
    const now = new Date();
    // Evict expired
    for (const [k, h] of this._handles) {
      if (h.expiresAt <= now) this._handles.delete(k);
    }
    // LRU: if key exists move to end
    if (this._handles.has(handle.key)) {
      this._handles.delete(handle.key);
    }
    this._handles.set(handle.key, handle);
    // Evict oldest if over limit
    while (this._handles.size > InMemoryGeminiCacheStore.MAX_ENTRIES) {
      const firstKey = this._handles.keys().next().value;
      if (firstKey !== undefined) this._handles.delete(firstKey);
    }
    return handle;
  }
}

/** Module-level singleton cache store (test-patchable). */
export const geminiCacheStore = new InMemoryGeminiCacheStore();
