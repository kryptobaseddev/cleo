/**
 * Shared formatting primitives for `--human` CLI renderers.
 *
 * Replaces the hand-rolled `padEnd` columns and Markdown-pipe pseudo-tables
 * that the renderer audit (T9393-followup) flagged as misaligned, lossy, and
 * inconsistent across the 65-renderer surface.
 *
 * Design goals:
 *   - Terminal-width aware (truncate cells instead of overflowing)
 *   - Zero new runtime dependencies (no `cli-table` etc.) — uses only ANSI
 *     escapes from {@link ./ansi.ts}.
 *   - Pure: every helper returns a string; no stdout writes.
 *   - LAFS-aware: {@link metaFooter} surfaces decorator-stamped
 *     `meta._nexus`, `meta.deprecated`, and `meta.duration_ms` chrome that
 *     would otherwise vanish in human mode.
 *   - Pagination-aware: {@link pagerFooter} formats the `page.{limit,offset,
 *     hasMore,total}` block so users know a list is windowed.
 *
 * Originally lived under `packages/cleo/src/cli/renderers/format-helpers.ts`.
 * Migrated to `@cleocode/core/render` per AGENTS.md Package-Boundary Check —
 * rendering logic belongs in core, not the CLI thin shell.
 *
 * @task T9393
 * @task T10129
 */

import { BOLD, DIM, NC } from './ansi.js';

// ---------------------------------------------------------------------------
// Terminal width detection
// ---------------------------------------------------------------------------

/**
 * Best-effort terminal width. Falls back to 100 columns when stdout is not a
 * TTY (CI logs, pipes) so output remains readable. Never returns < 40.
 */
export function terminalWidth(): number {
  const cols = process.stdout.columns ?? 100;
  return Math.max(40, cols);
}

// ---------------------------------------------------------------------------
// String-width handling (ANSI-aware)
// ---------------------------------------------------------------------------

const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

/** Length of a string ignoring ANSI escape codes. */
export function visibleLength(s: string): number {
  return s.replace(ANSI_REGEX, '').length;
}

/** Right-pad a string to `width` visible columns, ignoring embedded ANSI. */
export function padVisible(s: string, width: number): string {
  const visible = visibleLength(s);
  if (visible >= width) return s;
  return s + ' '.repeat(width - visible);
}

/**
 * Truncate a string to at most `max` visible columns, appending `…` when
 * truncation occurs. ANSI escape codes are preserved (no mid-escape splits).
 */
export function truncateVisible(s: string, max: number): string {
  if (max <= 0) return '';
  if (visibleLength(s) <= max) return s;
  // Walk the string, copying characters and skipping over ANSI escape
  // sequences entirely, until we've collected `max - 1` visible chars.
  const ellipsis = '…';
  const target = max - 1;
  let out = '';
  let visible = 0;
  let i = 0;
  while (i < s.length && visible < target) {
    const ch = s[i] as string;
    if (ch === '\x1b' && s[i + 1] === '[') {
      const end = s.indexOf('m', i + 2);
      if (end === -1) break;
      out += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    out += ch;
    visible++;
    i++;
  }
  return `${out}${ellipsis}`;
}

// ---------------------------------------------------------------------------
// kvBlock — colon-aligned key/value list
// ---------------------------------------------------------------------------

/**
 * Render a key/value list with colons aligned to the longest key.
 *
 * @example
 * kvBlock([['Status', 'pending'], ['Priority', 'high']])
 * //   Status:    pending
 * //   Priority:  high
 */
export function kvBlock(rows: Array<[string, string]>, indent = 2): string {
  if (rows.length === 0) return '';
  // Pad the label to the widest, THEN append the colon so colons line up
  // visually across rows (previously the colon was inside the padded label
  // and so its position drifted with each row's label length).
  const labelWidth = Math.max(...rows.map(([k]) => visibleLength(k)));
  const pad = ' '.repeat(indent);
  return rows.map(([k, v]) => `${pad}${DIM}${padVisible(k, labelWidth)}:${NC} ${v}`).join('\n');
}

// ---------------------------------------------------------------------------
// sectionHeader — bold label with optional count
// ---------------------------------------------------------------------------

/**
 * Render a section header line like `Acceptance Criteria (4)`.
 * Used to break up long task-show / nexus-context blocks.
 */
export function sectionHeader(label: string, count?: number): string {
  const c = typeof count === 'number' ? ` ${DIM}(${count})${NC}` : '';
  return `${BOLD}${label}${NC}${c}`;
}

// ---------------------------------------------------------------------------
// dataTable — width-aware aligned table
// ---------------------------------------------------------------------------

export interface DataTableColumn<T = Record<string, unknown>> {
  /** Column header label. */
  header: string;
  /** Accessor: row -> cell string (already formatted; may contain ANSI). */
  get: (row: T, index: number) => string;
  /** Optional max width for this column (cell + header). Defaults to no cap. */
  maxWidth?: number;
  /** Optional minimum width (header is always at least its own length). */
  minWidth?: number;
}

export interface DataTableOptions {
  /** Top-line indent in spaces. Defaults to 2. */
  indent?: number;
  /** Maximum total table width. Defaults to terminal width. */
  totalWidth?: number;
  /** Column separator. Defaults to two spaces. */
  separator?: string;
  /** Show header row. Defaults to true. */
  showHeader?: boolean;
}

/**
 * Render an aligned ASCII table. Each column auto-sizes to its widest cell,
 * capped by `maxWidth` and the overall terminal width. Cells too wide for
 * their column are truncated with an ellipsis.
 *
 * @example
 * dataTable(tasks, [
 *   { header: 'ID',     get: (t) => String(t.id),     maxWidth: 12 },
 *   { header: 'Status', get: (t) => String(t.status), maxWidth: 10 },
 *   { header: 'Title',  get: (t) => String(t.title)               },
 * ])
 */
export function dataTable<T>(
  rows: ReadonlyArray<T>,
  columns: ReadonlyArray<DataTableColumn<T>>,
  opts: DataTableOptions = {},
): string {
  if (rows.length === 0 || columns.length === 0) return '';
  const indent = opts.indent ?? 2;
  const sep = opts.separator ?? '  ';
  const totalWidth = opts.totalWidth ?? terminalWidth();
  const showHeader = opts.showHeader !== false;

  // Pre-compute every cell as string so we can measure widths once.
  const cells: string[][] = rows.map((row, i) => columns.map((col) => col.get(row, i)));

  // Natural width per column: max(header, maxCell).
  const natWidths = columns.map((col, c) => {
    const headerW = visibleLength(col.header);
    const cellW = Math.max(...cells.map((r) => visibleLength(r[c] ?? '')));
    return Math.max(headerW, cellW);
  });

  // Cap each column by its declared maxWidth.
  const capped = natWidths.map((w, c) => {
    const cap = columns[c]?.maxWidth ?? Number.MAX_SAFE_INTEGER;
    const min = columns[c]?.minWidth ?? 0;
    return Math.max(min, Math.min(w, cap));
  });

  // If the total still exceeds terminalWidth, shrink the widest column(s).
  const sepW = sep.length * (columns.length - 1) + indent;
  let totalUsed = capped.reduce((a, b) => a + b, 0) + sepW;
  const widths = [...capped];
  while (totalUsed > totalWidth) {
    // Find the widest column with no minWidth pinning it.
    let widest = 0;
    for (let c = 1; c < widths.length; c++) {
      if ((widths[c] ?? 0) > (widths[widest] ?? 0)) widest = c;
    }
    const wCur = widths[widest] ?? 0;
    const minAllowed = columns[widest]?.minWidth ?? 6;
    if (wCur <= minAllowed) break;
    widths[widest] = wCur - 1;
    totalUsed--;
  }

  const pad = ' '.repeat(indent);
  const lines: string[] = [];
  if (showHeader) {
    const header = columns
      .map(
        (c, i) =>
          `${BOLD}${padVisible(truncateVisible(c.header, widths[i] ?? 0), widths[i] ?? 0)}${NC}`,
      )
      .join(sep);
    lines.push(`${pad}${header}`);
  }
  for (const row of cells) {
    const formatted = row
      .map((cell, i) => padVisible(truncateVisible(cell ?? '', widths[i] ?? 0), widths[i] ?? 0))
      .join(sep);
    lines.push(`${pad}${formatted}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// pagerFooter — render LAFS `page` block + total count
// ---------------------------------------------------------------------------

export interface PagerInput {
  /** Number of items in the current response payload. */
  shown: number;
  /** LAFS `page` block from envelope, if present. */
  page?: {
    mode?: string;
    limit?: number;
    offset?: number;
    hasMore?: boolean;
    total?: number;
  } | null;
  /** Top-level `total` field on the data payload (alternative to page.total). */
  total?: number;
  /** Top-level `filtered` field (e.g. tasks.list emits both total + filtered). */
  filtered?: number;
}

/**
 * Render a one-line "... 3 of 227 results (offset 0, --limit 3) ..." footer
 * sourced from the LAFS pagination block. Empty string when the payload is
 * complete (`shown >= total` and `hasMore` is false-y).
 */
export function pagerFooter(input: PagerInput): string {
  const { shown, page } = input;
  const total = page?.total ?? input.total ?? shown;
  const filtered = input.filtered;
  const hasMore = page?.hasMore === true || shown < total;
  const filterActive = typeof filtered === 'number' && filtered !== total;
  // Suppress when payload is complete and no filter is in play — a "1 of 1"
  // footer adds noise without information.
  if (!hasMore && !filterActive) return '';

  const parts: string[] = [`${shown} of ${total}`];
  if (filterActive) parts.push(`${filtered} after filter`);
  if (typeof page?.offset === 'number') parts.push(`offset ${page.offset}`);
  if (typeof page?.limit === 'number') parts.push(`--limit ${page.limit}`);
  if (hasMore) parts.push('--json for full set');
  return `${DIM}─── ${parts.join(' · ')} ───${NC}`;
}

// ---------------------------------------------------------------------------
// metaFooter — render decorator-stamped meta chrome
// ---------------------------------------------------------------------------

/**
 * Render a dim trailing line summarising decorator-stamped envelope meta.
 *
 * Surfaces:
 *   - `meta.duration_ms` — useful for perf-sensitive commands
 *   - `meta._nexus.{scope, projectId, canonicalCommand, indexFreshness}` —
 *     orchestration scope info the audit found dropped in every renderer
 *   - `meta.deprecated.{since, removeIn, replacement}` — alias-shim warnings
 *     that were silently lost in human output
 *
 * Returns empty string when no surfaceable fields are present.
 */
export function metaFooter(meta?: Record<string, unknown>): string {
  if (!meta || typeof meta !== 'object') return '';
  const lines: string[] = [];

  const deprecated = meta['deprecated'] as
    | { since?: string; removeIn?: string; replacement?: string }
    | undefined;
  if (deprecated && typeof deprecated === 'object') {
    const since = deprecated.since ? ` since ${deprecated.since}` : '';
    const removeIn = deprecated.removeIn ? ` · removed in ${deprecated.removeIn}` : '';
    const replacement = deprecated.replacement ? ` · use \`${deprecated.replacement}\`` : '';
    // YELLOW would be louder, but DIM keeps human output uncluttered. Callers
    // who want the warning to shout can render their own line above this.
    lines.push(`${DIM}deprecated${since}${removeIn}${replacement}${NC}`);
  }

  const nexus = meta['_nexus'] as Record<string, unknown> | undefined;
  const duration = meta['duration_ms'] as number | undefined;
  const chips: string[] = [];
  if (nexus && typeof nexus === 'object') {
    if (typeof nexus['scope'] === 'string') chips.push(`scope=${nexus['scope']}`);
    if (typeof nexus['projectName'] === 'string') {
      chips.push(`project=${nexus['projectName']}`);
    } else if (typeof nexus['projectId'] === 'string') {
      // Show a short slug instead of the full 32-char base64 id.
      const pid = String(nexus['projectId']);
      chips.push(`project=${pid.length > 16 ? `${pid.slice(0, 13)}…` : pid}`);
    }
    if (nexus['indexFreshness'] === 'stale') chips.push(`${DIM}index=stale${NC}`);
  }
  if (typeof duration === 'number' && duration > 0) chips.push(`${duration} ms`);

  if (chips.length > 0) lines.push(`${DIM}[${chips.join(' · ')}]${NC}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// truncated — consistent "and N more" suffix
// ---------------------------------------------------------------------------

/**
 * Slice an array and return both the slice and a footer line summarising the
 * truncation. Use instead of bare `.slice(0, N)` so users always see the
 * total when output is windowed.
 *
 * @example
 * const { items, footer } = truncated(allCallers, 10);
 * for (const c of items) lines.push(`  ${c}`);
 * if (footer) lines.push(`  ${footer}`);
 */
export function truncated<T>(
  arr: ReadonlyArray<T>,
  max: number,
): { items: ReadonlyArray<T>; footer: string } {
  if (arr.length <= max) return { items: arr, footer: '' };
  return {
    items: arr.slice(0, max),
    footer: `${DIM}… and ${arr.length - max} more (use --json or --limit ${arr.length} for full list)${NC}`,
  };
}
