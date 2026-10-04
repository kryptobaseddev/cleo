/**
 * Resolve "the rows" from any CLEO operation payload (T12077).
 *
 * The key list itself lives in `@cleocode/contracts` as const data
 * ({@link COLLECTION_KEYS}); this module holds the runtime helper, because
 * `packages/contracts` is types-only (architectural Gate 10).
 *
 * See the contracts module for the three separate outages that motivated a
 * shared SSoT — most severely the sentient loop, which read `data.tasks` from
 * an SDK call returning bare `{results, total}` and therefore picked zero
 * tasks on every tick for three months while reporting "no unblocked tasks
 * available".
 *
 * @task T12077
 */

import { COLLECTION_KEYS } from '@cleocode/contracts/collection-keys.js';

/**
 * Resolve the first list-shaped collection on a payload.
 *
 * Accepts BOTH the enveloped shape (`{data: {results: […]}}`) and the bare
 * shape the SDK returns (`{results: […]}`). Confusing those two is precisely
 * what made the sentient loop inert, so this helper deliberately handles both
 * rather than making each caller guess which surface it is holding.
 *
 * @param payload - an operation response, enveloped or bare.
 * @returns the matching array, or `undefined` when the payload carries none.
 *
 * @example
 * ```ts
 * pickCollection({ results: [{ id: 'T1' }], total: 1 }); // → [{ id: 'T1' }]
 * pickCollection({ data: { tasks: [{ id: 'T2' }] } });   // → [{ id: 'T2' }]
 * pickCollection({ total: 0 });                          // → undefined
 * ```
 *
 * @task T12077
 */
export function pickCollection(payload: unknown): unknown[] | undefined {
  const direct = firstArrayIn(payload);
  if (direct !== undefined) return direct;

  // Enveloped form — recurse ONCE into `data` so a caller holding a dispatch
  // envelope gets the same answer as one holding the bare payload.
  if (payload !== null && typeof payload === 'object') {
    return firstArrayIn((payload as Record<string, unknown>)['data']);
  }
  return undefined;
}

/**
 * Typed convenience wrapper over {@link pickCollection}.
 *
 * @param payload - an operation response, enveloped or bare.
 * @returns the rows cast to `T[]`, or an empty array when absent.
 *
 * @example
 * ```ts
 * const tasks = collectionOf<Task>(await cleo.tasks.find({ status: 'pending' }));
 * ```
 *
 * @task T12077
 */
export function collectionOf<T>(payload: unknown): T[] {
  return (pickCollection(payload) ?? []) as T[];
}

/**
 * First value under a known collection key that is an array.
 *
 * @param value - candidate object.
 * @returns the array, or `undefined`.
 */
function firstArrayIn(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const rec = value as Record<string, unknown>;
  for (const key of COLLECTION_KEYS) {
    const found = rec[key];
    if (Array.isArray(found)) return found;
  }
  return undefined;
}
