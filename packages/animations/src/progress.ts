/**
 * Progress bar primitives — fixed-width segmented bars rendered as Unicode
 * block / braille characters.
 *
 * @remarks
 * Three canon-themed styles:
 *   - `tapestry` — Unicode block characters (`░▒▓█`); evokes a woven cloth
 *     filling cell-by-cell.
 *   - `cascade`  — gradient block characters (`▏▎▍▌▋▊▉█`); the bar fills
 *     by 1/8 increments per character, producing a smooth waterfall edge.
 *   - `refinery` — braille block fill (`⠀⡀⡄⡆⡇⣇⣧⣷⣿`); evokes the BRAIN
 *     memory promotion pipeline being filled stage-by-stage.
 *
 * Every style receives the same input — a value in `[0, 1]` and a width in
 * characters — and emits a fixed-width string. Callers compose this with
 * label / percentage / colour separately.
 */

/**
 * Canon progress-bar style identifier.
 */
export type ProgressBarStyle = 'tapestry' | 'cascade' | 'refinery';

/**
 * One rendered progress-bar style.
 */
export interface ProgressBarRenderer {
  /** Style identifier. */
  readonly style: ProgressBarStyle;
  /** Render a bar at the given fill ratio. */
  readonly render: (ratio: number, width: number) => string;
}

/* -------------------------------------------
   Style: tapestry — coarse Unicode blocks
   ------------------------------------------- */

const TAPESTRY_EMPTY = '░';
const TAPESTRY_QUARTER = '▒';
const TAPESTRY_THREE_QUARTER = '▓';
const TAPESTRY_FULL = '█';

function renderTapestry(ratio: number, width: number): string {
  const r = clampRatio(ratio);
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const exactCells = r * w;
  const fullCells = Math.floor(exactCells);
  const fractional = exactCells - fullCells;
  let edge = '';
  if (fullCells < w) {
    if (fractional >= 0.75) edge = TAPESTRY_THREE_QUARTER;
    else if (fractional >= 0.25) edge = TAPESTRY_QUARTER;
    else edge = TAPESTRY_EMPTY;
  }
  const remaining = Math.max(0, w - fullCells - (edge ? 1 : 0));
  return TAPESTRY_FULL.repeat(fullCells) + edge + TAPESTRY_EMPTY.repeat(remaining);
}

/* -------------------------------------------
   Style: cascade — gradient block (1/8 steps)
   ------------------------------------------- */

const CASCADE_GRADIENT = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const;
const CASCADE_EMPTY = ' ';

function renderCascade(ratio: number, width: number): string {
  const r = clampRatio(ratio);
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  // Each cell is divided into 8 sub-steps; total resolution is w*8.
  const totalSteps = w * 8;
  const filledSteps = Math.round(r * totalSteps);
  const fullCells = Math.floor(filledSteps / 8);
  const partial = filledSteps - fullCells * 8;
  const edge = partial === 0 ? '' : CASCADE_GRADIENT[partial];
  const remaining = Math.max(0, w - fullCells - (edge ? 1 : 0));
  return CASCADE_GRADIENT[8].repeat(fullCells) + edge + CASCADE_EMPTY.repeat(remaining);
}

/* -------------------------------------------
   Style: refinery — braille block fill (4-row x 2-col per cell)
   ------------------------------------------- */

// Eight fill stages within one braille cell, raising rows bottom-to-top.
const REFINERY_STAGES = ['⠀', '⡀', '⡄', '⡆', '⡇', '⣇', '⣧', '⣷', '⣿'] as const;
const REFINERY_EMPTY = '⠀';
const REFINERY_FULL = '⣿';

function renderRefinery(ratio: number, width: number): string {
  const r = clampRatio(ratio);
  const w = Math.max(0, Math.floor(width));
  if (w === 0) return '';
  const totalStages = w * 8;
  const filledStages = Math.round(r * totalStages);
  const fullCells = Math.floor(filledStages / 8);
  const partial = filledStages - fullCells * 8;
  const edge = partial === 0 ? '' : REFINERY_STAGES[partial];
  const remaining = Math.max(0, w - fullCells - (edge ? 1 : 0));
  return REFINERY_FULL.repeat(fullCells) + edge + REFINERY_EMPTY.repeat(remaining);
}

/* -------------------------------------------
   Helpers
   ------------------------------------------- */

function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0;
  if (ratio < 0) return 0;
  if (ratio > 1) return 1;
  return ratio;
}

/**
 * Registry of progress-bar styles keyed by canon name.
 */
export const progressBars: Record<ProgressBarStyle, ProgressBarRenderer> = {
  tapestry: { style: 'tapestry', render: renderTapestry },
  cascade: { style: 'cascade', render: renderCascade },
  refinery: { style: 'refinery', render: renderRefinery },
};

/**
 * Render a progress bar of the chosen style at the given fill ratio + width.
 *
 * @param style - Canon style name (`tapestry`, `cascade`, or `refinery`)
 * @param ratio - Fill ratio in `[0, 1]`. Values outside the range are clamped.
 * @param width - Bar width in terminal columns. Negative or zero yields `''`.
 * @returns The rendered bar as a fixed-width string.
 *
 * @example
 * ```ts
 * renderProgressBar('cascade', 0.42, 20);
 * // → "████████▍           "
 * ```
 */
export function renderProgressBar(style: ProgressBarStyle, ratio: number, width: number): string {
  return progressBars[style].render(ratio, width);
}
