/**
 * `renderEnvelopeForHuman` — the single public entry point for converting a
 * typed {@link RenderableEnvelope} into a human-readable string.
 *
 * Routes by `(command, envelope.kind)` to a registered renderer; falls back to
 * the generic kind-based fallback when no specific renderer is registered.
 * Pure function — no I/O, no DB access, no animations module imports.
 *
 * @epic T10114
 * @task T10130
 */

import type { RenderableEnvelope } from '@cleocode/contracts';
import { renderFallback } from './fallback.js';
import { lookupRenderer } from './registry.js';
import type { RenderOptions } from './types.js';

/**
 * Render a typed {@link RenderableEnvelope} as a human-readable string.
 *
 * Routing rules:
 *   1. When `opts.format === 'json'`, return `''` immediately — the JSON
 *      path is the caller's responsibility.
 *   2. Look up a renderer registered for exactly `(command, envelope.kind)`.
 *      If present, delegate.
 *   3. Otherwise delegate to {@link renderFallback}, which handles every
 *      envelope kind via inline string concatenation + B4 helpers.
 *
 * @typeParam T — envelope payload shape.
 * @param envelope The typed envelope produced by an operation.
 * @param command  The command that produced the envelope (e.g. `'tasks.list'`).
 * @param opts     Per-call render options. Defaults to an empty object.
 * @returns The string to write to stdout. Empty string suppresses output.
 */
export function renderEnvelopeForHuman<T>(
  envelope: RenderableEnvelope<T>,
  command: string,
  opts: RenderOptions = {},
): string {
  if (opts.format === 'json') return '';
  const specific = lookupRenderer<T>(command, envelope.kind);
  if (specific) return specific(envelope, opts);
  return renderFallback(envelope, opts);
}
