/**
 * Static section rendering — header (optional icon + subtitle) over indented items.
 *
 * @remarks
 * Part of the Human Render Contract (Epic T10114, ADR-077). Sections are the
 * canonical "labelled block" presenter — used for `cleo saga show` deviation
 * lists, doctor reports, and similar ad-hoc human output. Items are
 * pre-formatted; this primitive only owns the header + indentation.
 *
 * Section bodies are indented by 2 spaces. An empty `items` array renders only
 * the header line.
 *
 * @epic T10114
 * @task T10128
 * @subtask T10144
 */

import type { AnimateContext } from '../animate-context.js';

/** Inputs to {@link renderSection}. */
export interface RenderSectionInput {
  /**
   * Optional leading glyph (emoji or ASCII). Caller picks the right form for
   * the active terminal — this primitive renders it verbatim.
   */
  readonly icon?: string;
  /** Section heading rendered on the first line. */
  readonly header: string;
  /** Optional subtitle appended after the header with an em-dash separator. */
  readonly subtitle?: string;
  /** Pre-formatted item strings rendered as an indented block. */
  readonly items: ReadonlyArray<string>;
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
}

/** Two-space indent applied to every item line. */
const ITEM_INDENT = '  ';

/** Em-dash separator between header and subtitle. */
const SUBTITLE_SEPARATOR = ' — ';

/**
 * Render a section block — header line plus indented items.
 *
 * @param input - Header text, optional icon/subtitle, items, and gate context.
 * @returns A multi-line string. Empty when `input.ctx.enabled` is `false`.
 *
 * @example
 * ```ts
 * renderSection({
 *   ctx,
 *   icon: '✅',
 *   header: 'DONE',
 *   subtitle: '3 epics shipped',
 *   items: ['T9832 contracts foundation', 'T9836 test helpers', 'T9837 SSoT enforcement'],
 * });
 * // ✅ DONE — 3 epics shipped
 * //   T9832 contracts foundation
 * //   T9836 test helpers
 * //   T9837 SSoT enforcement
 * ```
 */
export function renderSection(input: RenderSectionInput): string {
  if (!input.ctx.enabled) return '';

  const iconPart = input.icon !== undefined && input.icon.length > 0 ? `${input.icon} ` : '';
  const subtitlePart =
    input.subtitle !== undefined && input.subtitle.length > 0
      ? `${SUBTITLE_SEPARATOR}${input.subtitle}`
      : '';
  const headerLine = `${iconPart}${input.header}${subtitlePart}`;

  if (input.items.length === 0) {
    return headerLine;
  }

  const itemLines = input.items.map((item) => `${ITEM_INDENT}${item}`);
  return [headerLine, ...itemLines].join('\n');
}
