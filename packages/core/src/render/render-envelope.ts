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
import type { RenderEmptyReason, RenderEnvelopeResult, RenderOptions } from './types.js';

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
  const result = renderEnvelopeResultForHuman(envelope, command, opts);
  return result.text;
}

/**
 * Render a typed {@link RenderableEnvelope} while preserving machine-readable
 * empty-state and renderer-contract metadata for compact/quiet callers.
 *
 * Unlike the legacy string-only API, successful renders never return blank text
 * unless the caller explicitly requested `format: 'json'`. Empty collections
 * therefore get a compact, deterministic placeholder plus a typed
 * `emptyReason` that programmatic presenters can inspect.
 */
export function renderEnvelopeResultForHuman<T>(
  envelope: RenderableEnvelope<T>,
  command: string,
  opts: RenderOptions = {},
): RenderEnvelopeResult {
  if (opts.format === 'json') return { ok: true, text: '', emptyReason: 'json-format' };

  if (!isSupportedEnvelopeKind(envelope.kind)) {
    return {
      ok: false,
      code: 'E_RENDERER_UNSUPPORTED',
      text: '',
      emptyReason: 'renderer-unsupported',
      message: `Unsupported renderer envelope kind: ${String(envelope.kind)}`,
    };
  }

  const specific = lookupRenderer<T>(command, envelope.kind);
  const rendered = specific ? specific(envelope, opts) : renderFallback(envelope, opts);
  if (rendered.trim().length > 0) return { ok: true, text: rendered };

  const emptyReason = emptyReasonForEnvelope(envelope) ?? 'renderer-returned-empty';
  return { ok: true, text: compactEmptyText(emptyReason), emptyReason };
}

function isSupportedEnvelopeKind(kind: string): kind is RenderableEnvelope<unknown>['kind'] {
  return (
    kind === 'tree' ||
    kind === 'table' ||
    kind === 'list' ||
    kind === 'grouped-list' ||
    kind === 'section' ||
    kind === 'single' ||
    kind === 'generic'
  );
}

function emptyReasonForEnvelope<T>(envelope: RenderableEnvelope<T>): RenderEmptyReason | undefined {
  switch (envelope.kind) {
    case 'tree':
      return envelope.data.tree.length === 0 ? 'empty-tree' : undefined;
    case 'table':
      return envelope.data.rows.length === 0 || envelope.data.schema.columns.length === 0
        ? 'empty-table'
        : undefined;
    case 'list':
      return envelope.data.items.length === 0 ? 'empty-list' : undefined;
    case 'grouped-list':
      return envelope.data.groups.length === 0 ? 'empty-grouped-list' : undefined;
    case 'section':
      return envelope.data.header.trim().length === 0 && envelope.data.items.length === 0
        ? 'empty-section'
        : undefined;
    case 'single':
      return envelope.data === '' || envelope.data === null || typeof envelope.data === 'undefined'
        ? 'empty-single'
        : undefined;
    case 'generic':
      return Object.keys(envelope.data).length === 0 ? 'empty-generic' : undefined;
  }
}

function compactEmptyText(reason: RenderEmptyReason): string {
  switch (reason) {
    case 'empty-tree':
      return 'No tree nodes.';
    case 'empty-table':
      return 'No table rows.';
    case 'empty-list':
      return 'No list items.';
    case 'empty-grouped-list':
      return 'No groups.';
    case 'empty-section':
      return 'No section items.';
    case 'empty-single':
      return 'No value.';
    case 'empty-generic':
      return 'No fields.';
    case 'renderer-returned-empty':
      return 'No output.';
    case 'json-format':
    case 'renderer-unsupported':
      return '';
  }
}
