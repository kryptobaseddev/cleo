/**
 * `attachSuggestedNext` — envelope-construction helper for the
 * envelope-wide `meta.suggestedNext` field promoted in T9920.
 *
 * Before T9920, only the nexus domain stamped a structured
 * `meta._nexus.suggestedNext: ReadonlyArray<SuggestedNextOp>` block on
 * dispatch responses. T9920 promotes a flat `ReadonlyArray<string>`
 * projection to {@link CliMeta.suggestedNext} so every operation
 * (mutate, query, decorator) can attach chained-reasoning hints
 * without leaking the richer nexus-internal shape across domain
 * boundaries.
 *
 * This helper is intentionally tiny — it deep-clones `envelope.meta`
 * and overwrites `suggestedNext`. The original envelope is never
 * mutated (immutability is a stronger guarantee than the type
 * system's `Readonly` markers, which only prevent direct assignment).
 *
 * @module @cleocode/core/dispatch/suggested-next
 *
 * @epic T9919
 * @task T9920
 * @saga T9855
 */

import type { CliEnvelope } from '@cleocode/lafs';

/**
 * Attach a list of suggested follow-up CLI commands to an envelope's
 * canonical {@link CliMeta.suggestedNext} field.
 *
 * The returned envelope is a shallow copy with a fresh `meta` object —
 * the input envelope is never mutated. Existing meta fields (including
 * `_nexus.suggestedNext` if present) are preserved verbatim; only the
 * top-level `meta.suggestedNext` array is replaced.
 *
 * Empty arrays are preserved (not dropped) so callers can explicitly
 * signal "I considered this and there are no follow-ups" — renderers
 * are responsible for hiding the field from human output when empty.
 *
 * @typeParam T - The envelope's `data` payload type.
 * @param envelope - The envelope to enrich. Not mutated.
 * @param suggestions - Copy-pasteable CLI command strings the agent may run next.
 * @returns A new envelope with `meta.suggestedNext` populated.
 *
 * @example
 * ```ts
 * import { attachSuggestedNext } from '@cleocode/core/dispatch/suggested-next';
 *
 * const enriched = attachSuggestedNext(envelope, [
 *   'cleo focus T1234',
 *   'cleo verify T1234 --gate implemented --evidence "commit:abc123"',
 * ]);
 * ```
 *
 * @public
 */
export function attachSuggestedNext<T>(
  envelope: CliEnvelope<T>,
  suggestions: ReadonlyArray<string>,
): CliEnvelope<T> {
  return {
    ...envelope,
    meta: {
      ...envelope.meta,
      suggestedNext: [...suggestions],
    },
  };
}
