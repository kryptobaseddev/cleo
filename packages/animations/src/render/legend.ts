/**
 * Legend and summary footer rendering.
 *
 * @remarks
 * `renderLegend` produces a compact glossary mapping icons to labels — e.g.
 * `✅ done  🚧 active  ⏳ pending` — that complements a tree, table, or list.
 * `renderSummary` produces a one-line aggregate footer such as
 * `15 Sagas · 89 member Epics · 1 orphan`.
 *
 * Both helpers honor the {@link AnimateContext} gate and emit the empty string
 * when rendering is disabled.
 *
 * @epic T10114
 * @task T10128
 * @subtask T10146
 */

import type { AnimateContext } from '../animate-context.js';

/** Default item count above which {@link renderLegend} emits multi-line output. */
const DEFAULT_MULTILINE_THRESHOLD = 8;

/** Middle-dot separator used in summaries (U+00B7). */
const SUMMARY_SEPARATOR = ' · ';

/** ASCII fallback separator used when the context is in `no-color` mode. */
const SUMMARY_SEPARATOR_ASCII = ' | ';

/** One legend entry — icon glyph + plain-text label. */
export interface LegendItem {
  /** Pre-resolved icon glyph (caller is responsible for ASCII selection). */
  readonly icon: string;
  /** Plain-text label rendered after the icon. */
  readonly label: string;
}

/** Inputs to {@link renderLegend}. */
export interface RenderLegendInput {
  /** Icon → label pairs rendered in order. */
  readonly items: ReadonlyArray<LegendItem>;
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
  /**
   * When the item count is `<=` this threshold the legend renders as a single
   * line; above it the legend renders one item per line. Defaults to `8`.
   */
  readonly multiLineThreshold?: number;
}

/**
 * Render an icon legend — one-line for small counts, multi-line otherwise.
 *
 * @param input - Legend items, render gate, and optional threshold.
 * @returns The formatted legend string. Empty when `input.ctx.enabled` is `false`
 *   or `input.items` is empty.
 *
 * @example
 * ```ts
 * renderLegend({
 *   ctx,
 *   items: [
 *     { icon: '✅', label: 'done' },
 *     { icon: '🚧', label: 'active' },
 *     { icon: '⏳', label: 'pending' },
 *   ],
 * });
 * // → '✅ done  🚧 active  ⏳ pending'
 * ```
 */
export function renderLegend(input: RenderLegendInput): string {
  if (!input.ctx.enabled) return '';
  if (input.items.length === 0) return '';

  const threshold = input.multiLineThreshold ?? DEFAULT_MULTILINE_THRESHOLD;
  const formatted = input.items.map((item) => `${item.icon} ${item.label}`);

  if (input.items.length <= threshold) {
    return formatted.join('  ');
  }
  return formatted.join('\n');
}

/** One aggregate count cell in {@link renderSummary}. */
export interface SummaryCount {
  /** Human-readable label (e.g. `'Sagas'`, `'member Epics'`). */
  readonly label: string;
  /** Numeric count rendered before the label. */
  readonly n: number;
}

/** Inputs to {@link renderSummary}. */
export interface RenderSummaryInput {
  /** Counts rendered left-to-right, separated by middle dots. */
  readonly counts: ReadonlyArray<SummaryCount>;
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
}

/**
 * Render a one-line aggregate summary footer.
 *
 * @param input - Counts to render and the gate context.
 * @returns The formatted summary string. Empty when `input.ctx.enabled` is `false`
 *   or `input.counts` is empty.
 *
 * @example
 * ```ts
 * renderSummary({
 *   ctx,
 *   counts: [
 *     { label: 'Sagas', n: 15 },
 *     { label: 'member Epics', n: 89 },
 *     { label: 'orphan', n: 1 },
 *   ],
 * });
 * // → '15 Sagas · 89 member Epics · 1 orphan'
 * ```
 */
export function renderSummary(input: RenderSummaryInput): string {
  if (!input.ctx.enabled) return '';
  if (input.counts.length === 0) return '';

  const separator = input.ctx.inputs.noColor ? SUMMARY_SEPARATOR_ASCII : SUMMARY_SEPARATOR;
  return input.counts.map((c) => `${c.n} ${c.label}`).join(separator);
}
