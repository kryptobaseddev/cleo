/**
 * Bounded-concurrency map: run an async worker over a list with at most
 * `limit` calls in flight, preserving input order in the result.
 *
 * Dependency-free; safe to import from any layer.
 *
 * @module lib/concurrency
 */

/**
 * Run `worker` over `items` with at most `limit` calls in flight.
 *
 * A worker that rejects rejects the whole call, as with `Promise.all`; callers
 * that must record per-item failures catch inside the worker.
 *
 * @param items - Inputs, processed in order of dispatch.
 * @param limit - Maximum concurrent workers (clamped to `1..items.length`).
 * @param worker - Async function applied to each item.
 * @returns Results in the same order as `items`.
 * @example
 * ```ts
 * const sizes = await runWithConcurrency(paths, 8, async (p) => (await stat(p)).size);
 * ```
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const lanes: Promise<void>[] = [];
  const effectiveLimit = Math.max(1, Math.min(limit, items.length || 1));
  for (let i = 0; i < effectiveLimit; i++) {
    lanes.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= items.length) return;
          const item = items[idx] as T;
          results[idx] = await worker(item, idx);
        }
      })(),
    );
  }
  await Promise.all(lanes);
  return results;
}
