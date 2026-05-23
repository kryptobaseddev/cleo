/**
 * Adapter that wraps a legacy `(data, quiet) => string` renderer into the B5
 * {@link Renderer} signature so it can be registered with
 * {@link registerRenderer}.
 *
 * The legacy renderers migrated by T10131 (B6) and its sibling B7/B8 PRs all
 * have the historical `(data: Record<string, unknown>, quiet: boolean) =>
 * string` shape. The B5 registry expects `(envelope, opts) => string`. This
 * adapter bridges the gap so the registry can be populated incrementally
 * without forcing every consumer to migrate to {@link RenderableEnvelope}
 * payloads at once.
 *
 * **Mapping rules**:
 *   - The envelope's `data` payload is unwrapped and forwarded as the legacy
 *     `data` argument when the envelope kind is `'generic'`, `'single'`, or
 *     any other unwrappable variant. For collection variants (`tree`,
 *     `table`, `list`, `grouped-list`), the entire `data` object is passed
 *     through so the legacy renderer can read whatever keys it expects.
 *   - The quiet flag is derived from {@link RenderOptions} — `verbose === false`
 *     OR an explicit `(opts as { quiet?: boolean }).quiet === true` maps to
 *     legacy `quiet=true`. The default is `quiet=false` (full output).
 *
 * @task T10131
 */

import type { RenderableEnvelope } from '@cleocode/contracts';
import type { Renderer, RenderOptions } from './types.js';

/**
 * Legacy renderer signature shared by every renderer migrated from
 * `packages/cleo/src/cli/renderers/system.ts`.
 */
export type LegacyRenderer = (data: Record<string, unknown>, quiet: boolean) => string;

/**
 * Derive the legacy `quiet` flag from a {@link RenderOptions} object.
 *
 * Truth table:
 *   - `opts.quiet === true` → `true`
 *   - `opts.verbose === false` → `true` (explicit non-verbose request)
 *   - otherwise → `false` (default: full output)
 */
function deriveQuiet(opts: RenderOptions & { quiet?: boolean }): boolean {
  if (opts.quiet === true) return true;
  if (opts.verbose === false) return true;
  return false;
}

/**
 * Unwrap a {@link RenderableEnvelope} payload into the legacy `data` shape.
 *
 * Legacy renderers expect `Record<string, unknown>` because they were written
 * before the typed envelope contract existed. For `generic` envelopes the
 * unwrap is a no-op. For collection envelopes (`tree`, `table`, `list`,
 * `grouped-list`) the inner `data` object is forwarded unchanged so the
 * legacy renderer sees the same keys it always did. For `single`/`section`
 * the inner payload is wrapped in `{ data: <payload> }` so legacy renderers
 * that key off `data['…']` still see something — they were never called
 * with these shapes in practice but the fallback keeps the contract total.
 */
function unwrapEnvelope<T>(envelope: RenderableEnvelope<T>): Record<string, unknown> {
  switch (envelope.kind) {
    case 'generic':
      return envelope.data;
    case 'tree':
    case 'table':
    case 'list':
    case 'grouped-list':
      return envelope.data as unknown as Record<string, unknown>;
    case 'single':
      if (envelope.data !== null && typeof envelope.data === 'object') {
        return envelope.data as unknown as Record<string, unknown>;
      }
      return { data: envelope.data };
    case 'section':
      return envelope.data as unknown as Record<string, unknown>;
  }
}

/**
 * Wrap a legacy `(data, quiet) => string` renderer so it satisfies the
 * {@link Renderer} contract expected by {@link registerRenderer}.
 *
 * @param legacy The legacy renderer to wrap.
 * @returns A `Renderer<T>` that delegates to `legacy` after unwrapping the
 *          envelope and deriving the quiet flag.
 */
export function wrapLegacyRenderer<T>(legacy: LegacyRenderer): Renderer<T> {
  return (envelope, opts) => {
    const data = unwrapEnvelope(envelope);
    const quiet = deriveQuiet(opts as RenderOptions & { quiet?: boolean });
    return legacy(data, quiet);
  };
}
