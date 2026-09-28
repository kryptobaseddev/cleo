/**
 * In-memory LRU cache of provider decision outcomes.
 *
 * Keyed by `sha256(adapterVersion, model, questions, state)` over a canonical
 * (key-sorted) JSON serialization, so logically identical requests hit the
 * same entry regardless of object key order. Only provider answers are
 * stored; fallbacks are never cached. The cache is per-process and holds no
 * secrets (the key is not part of any request).
 *
 * @task T12490
 * @epic T12486
 */

import { createHash } from 'node:crypto';
import type { DecisionOutcome, DecisionRequest } from '@cleocode/contracts';

/** Default number of entries kept by {@link createDecisionCache}. */
export const DEFAULT_DECISION_CACHE_SIZE = 512;

/** A bounded store of decision outcomes. */
export interface DecisionCache {
  /** Look up an outcome, marking it most-recently used. */
  get(key: string): DecisionOutcome | undefined;
  /** Store an outcome, evicting the least-recently used entry when full. */
  set(key: string, outcome: DecisionOutcome): void;
  /** Number of stored entries. */
  readonly size: number;
  /** Drop every entry. */
  clear(): void;
}

/** JSON serialization with object keys sorted at every depth. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * sha256 hex of the canonical serialization of `value`.
 *
 * @param value - Any JSON-compatible value.
 * @returns 64-char lowercase hex digest.
 */
export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Cache key for a request under a given adapter version.
 *
 * @param adapterVersion - Wire-adapter identity; bump it to invalidate entries.
 * @param req - The request as sent to the provider (post-redaction).
 * @returns sha256 hex key.
 */
export function decisionCacheKey(adapterVersion: string, req: DecisionRequest): string {
  return hashCanonical({
    adapterVersion,
    model: req.model ?? null,
    questions: req.questions,
    state: req.state,
  });
}

/**
 * Create an LRU {@link DecisionCache}.
 *
 * @param maxEntries - Capacity (minimum 1). Defaults to {@link DEFAULT_DECISION_CACHE_SIZE}.
 * @returns A new, empty cache.
 */
export function createDecisionCache(
  maxEntries: number = DEFAULT_DECISION_CACHE_SIZE,
): DecisionCache {
  const capacity = Math.max(1, Math.floor(maxEntries));
  const entries = new Map<string, DecisionOutcome>();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, outcome) {
      entries.delete(key);
      entries.set(key, outcome);
      while (entries.size > capacity) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
    },
    get size() {
      return entries.size;
    },
    clear() {
      entries.clear();
    },
  };
}
