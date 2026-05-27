/**
 * Static table rendering — column-aligned rows with terminal-width awareness.
 *
 * @remarks
 * Part of the Human Render Contract (Epic T10114, ADR-077). Consumes a typed
 * {@link TableResponse} (schema + rows + total) and emits an aligned monospace
 * table that fits within the active terminal width. Wide string columns shrink
 * proportionally when the total width exceeds the budget; narrow numeric
 * columns are preserved.
 *
 * @epic T10114
 * @task T10128
 * @subtask T10143
 */

import type { ColumnAlign, TableColumn, TableResponse } from '@cleocode/contracts/render/table.js';
import type { AnimateContext } from '../animate-context.js';

/** Options to {@link renderTable}. */
export interface RenderTableOptions {
  /** Render gate — primitive returns `''` when `enabled === false`. */
  readonly ctx: AnimateContext;
  /**
   * Maximum line width. Defaults to `process.stdout.columns` and falls back to
   * `80` when the column count is unavailable. The renderer never produces a
   * row longer than this.
   */
  readonly maxWidth?: number;
  /**
   * When `true`, force ASCII separator characters. When `false`, force the
   * Unicode form. When omitted, defer to `ctx.inputs.noColor`.
   */
  readonly asciiBoxDrawing?: boolean;
}

/** Unicode horizontal rule used between header and data. */
const HRULE_UNICODE = '─';
/** ASCII fallback horizontal rule. */
const HRULE_ASCII = '-';

/** Unicode ellipsis used for truncated cell values. */
const ELLIPSIS_UNICODE = '…';
/** ASCII fallback ellipsis. */
const ELLIPSIS_ASCII = '...';

/** Two-space column separator. */
const COLUMN_GAP = '  ';

/** Minimum width retained for any string column after proportional shrink. */
const MIN_COLUMN_WIDTH = 4;

/**
 * Render a {@link TableResponse} as an aligned columnar string.
 *
 * @param resp - Typed table response (schema + rows + total).
 * @param opts - Render gate + width / ASCII overrides.
 * @returns Multi-line aligned table. Empty when `opts.ctx.enabled` is `false`.
 *
 * @example
 * ```ts
 * renderTable(
 *   {
 *     rows: [{ id: 'T1', title: 'Implement', status: 'done' }],
 *     schema: {
 *       columns: [
 *         { key: 'id', header: 'ID' },
 *         { key: 'title', header: 'Title' },
 *         { key: 'status', header: 'Status' },
 *       ],
 *     },
 *     total: 1,
 *   },
 *   { ctx },
 * );
 * ```
 */
export function renderTable<T>(resp: TableResponse<T>, opts: RenderTableOptions): string {
  if (!opts.ctx.enabled) return '';

  const useAscii = opts.asciiBoxDrawing ?? opts.ctx.inputs.noColor;
  const hrule = useAscii ? HRULE_ASCII : HRULE_UNICODE;
  const ellipsis = useAscii ? ELLIPSIS_ASCII : ELLIPSIS_UNICODE;

  const columns: ReadonlyArray<TableColumn<T>> = resp.schema.columns;
  if (columns.length === 0) {
    return `(${resp.total} rows)`;
  }

  const formatted: string[][] = resp.rows.map((row: T): string[] =>
    columns.map((col: TableColumn<T>): string => formatCell(row, col)),
  );

  // 1. Natural widths — max(header, every-cell).
  const naturalWidths: number[] = columns.map((col: TableColumn<T>, idx: number): number => {
    let max = col.header.length;
    for (const fmtRow of formatted) {
      const cell = fmtRow[idx] ?? '';
      if (cell.length > max) max = cell.length;
    }
    if (typeof col.width === 'number' && col.width > 0) {
      return Math.min(max, col.width);
    }
    return max;
  });

  // 2. Apply max-width shrink if needed (string columns only).
  const maxWidth = opts.maxWidth ?? process.stdout.columns ?? 80;
  const finalWidths = applyMaxWidth(naturalWidths, columns, maxWidth);

  // 3. Render header.
  const headerRow = renderRow(
    columns.map((col: TableColumn<T>): string => col.header),
    columns,
    finalWidths,
    ellipsis,
  );

  // 4. Render separator.
  const separatorRow = finalWidths.map((w) => hrule.repeat(w)).join(COLUMN_GAP);

  // 5. Render data rows.
  const dataRows = formatted.map((row) => renderRow(row, columns, finalWidths, ellipsis));

  // 6. Footer.
  const footer = `(${resp.total} ${resp.total === 1 ? 'row' : 'rows'})`;

  return [headerRow, separatorRow, ...dataRows, footer].join('\n');
}

/** Extract the cell value for `column` from `row` and run it through `format`. */
function formatCell<T>(row: T, column: TableColumn<T>): string {
  const raw = (row as Record<string, unknown>)[column.key];
  if (column.format !== undefined) return column.format(raw);
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

/**
 * Compute the final per-column widths.
 *
 * @remarks
 * The total width budget is `maxWidth - (columns.length - 1) * COLUMN_GAP`.
 * If the naturally-required widths fit, return them unchanged. Otherwise
 * shrink columns whose `align` is unset or `'left'` (treated as string
 * columns) proportionally to their natural width. Numeric / right-aligned /
 * center-aligned columns and any column with an explicit `width` are not
 * shrunk.
 */
function applyMaxWidth<T>(
  naturalWidths: number[],
  columns: ReadonlyArray<TableColumn<T>>,
  maxWidth: number,
): number[] {
  const totalGap = (columns.length - 1) * COLUMN_GAP.length;
  const budget = Math.max(MIN_COLUMN_WIDTH * columns.length, maxWidth - totalGap);
  const natural = naturalWidths.reduce((a, b) => a + b, 0);
  if (natural <= budget) return [...naturalWidths];

  const isShrinkable = columns.map(
    (col) => (col.align === undefined || col.align === 'left') && col.width === undefined,
  );
  const fixedSum = naturalWidths.reduce((sum, w, idx) => sum + (isShrinkable[idx] ? 0 : w), 0);
  const shrinkableSum = naturalWidths.reduce((sum, w, idx) => sum + (isShrinkable[idx] ? w : 0), 0);

  const shrinkBudget = Math.max(0, budget - fixedSum);
  if (shrinkableSum === 0 || shrinkBudget === 0) return [...naturalWidths];

  return naturalWidths.map((w, idx) => {
    if (!isShrinkable[idx]) return w;
    const scaled = Math.floor((w * shrinkBudget) / shrinkableSum);
    return Math.max(MIN_COLUMN_WIDTH, scaled);
  });
}

/** Render one aligned row joined by {@link COLUMN_GAP}. */
function renderRow<T>(
  cells: ReadonlyArray<string>,
  columns: ReadonlyArray<TableColumn<T>>,
  widths: ReadonlyArray<number>,
  ellipsis: string,
): string {
  // The trailing column is rendered without padding — there is no neighbour
  // to align to, and pad-right whitespace makes snapshot diffs noisy.
  const lastIdx = cells.length - 1;
  return cells
    .map((cell, idx) => {
      const width = widths[idx] ?? cell.length;
      const align = columns[idx]?.align ?? 'left';
      const truncated = truncate(cell, width, ellipsis);
      if (idx === lastIdx && align === 'left') return truncated;
      return alignCell(truncated, width, align);
    })
    .join(COLUMN_GAP);
}

/**
 * Truncate `text` to `width` characters by replacing the tail with `ellipsis`.
 *
 * @remarks
 * No-op when `text.length <= width`. When `width <= ellipsis.length`, returns
 * the leading slice of `text` without an ellipsis to avoid producing output
 * wider than the budget.
 */
function truncate(text: string, width: number, ellipsis: string): string {
  if (text.length <= width) return text;
  if (width <= ellipsis.length) return text.slice(0, width);
  return text.slice(0, width - ellipsis.length) + ellipsis;
}

/** Pad `text` to `width` characters according to `align`. */
function alignCell(text: string, width: number, align: ColumnAlign): string {
  if (text.length >= width) return text;
  const padding = width - text.length;
  switch (align) {
    case 'right':
      return ' '.repeat(padding) + text;
    case 'center': {
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    }
    default:
      return text + ' '.repeat(padding);
  }
}
