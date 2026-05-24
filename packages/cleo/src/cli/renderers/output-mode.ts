/**
 * Output-mode renderer for the `--output {envelope|id|table|count|silent}`
 * flag (T9930 · Saga T9855 · E9.3).
 *
 * Dispatch produces ONE canonical envelope; this module RE-RENDERS that
 * envelope into the alternative shape the operator/agent asked for. The
 * `envelope` mode is the default and is handled inline by `cliOutput`.
 *
 * Coexistence with sibling flags
 * ------------------------------
 * - `--field` (T9929) — single-field plain-text projection. WINS when
 *   both `--field` and `--output` are passed (`--field` short-circuits
 *   to a scalar before `cliOutput` reaches this module). See the
 *   precedence note in `output-context.ts`.
 * - `--quiet` — affects the envelope/JSON path only. The id/table/count
 *   modes have their own minimal shape so `--quiet` is redundant.
 *
 * @task T9930
 * @epic T9855
 */

import type { OutputMode } from '../output-context.js';

/**
 * Heuristic id extraction across the family of envelope shapes the
 * dispatch surface produces.
 *
 * Walked in order:
 *   1. `data.task.id` — single-task mutate ops (`add`, `update`, ...).
 *   2. `data.tasks[].id` — list / find responses.
 *   3. `data.items[].id` — generic ListResponse from the SDK.
 *   4. `data.id` — bare id payloads (e.g. `cleo session start`).
 *
 * @returns id strings in the same order they appeared in the envelope.
 *          Empty array when no id can be located.
 */
function extractIds(data: unknown): string[] {
  if (data === null || typeof data !== 'object') return [];
  const rec = data as Record<string, unknown>;

  // 1. Single nested task ({task: {id, ...}})
  const task = rec['task'];
  if (task && typeof task === 'object') {
    const id = (task as Record<string, unknown>)['id'];
    if (typeof id === 'string') return [id];
  }

  // 2. List of tasks ({tasks: [...]})
  const tasks = rec['tasks'];
  if (Array.isArray(tasks)) {
    return tasks
      .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>)['id'] : undefined))
      .filter((id): id is string => typeof id === 'string');
  }

  // 3. Generic SDK ListResponse ({items: [...]})
  const items = rec['items'];
  if (Array.isArray(items)) {
    return items
      .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>)['id'] : undefined))
      .filter((id): id is string => typeof id === 'string');
  }

  // 4. Bare id
  const id = rec['id'];
  if (typeof id === 'string') return [id];

  return [];
}

/**
 * Pick the row count from a dispatch envelope.
 *
 * Honours the explicit `total` field when present (which can exceed
 * `tasks.length` after server-side pagination), otherwise falls back to
 * the length of whatever array surface the payload exposes.
 *
 * @returns `0` when the data shape carries neither a counted collection
 *          nor a recognisable total field.
 */
function extractCount(data: unknown): number {
  if (data === null || typeof data !== 'object') return 0;
  const rec = data as Record<string, unknown>;

  const total = rec['total'];
  if (typeof total === 'number' && Number.isFinite(total)) return total;

  const tasks = rec['tasks'];
  if (Array.isArray(tasks)) return tasks.length;

  const items = rec['items'];
  if (Array.isArray(items)) return items.length;

  // Single-record envelopes (`{task: {...}}`) count as 1.
  if (rec['task'] && typeof rec['task'] === 'object') return 1;
  if (typeof rec['id'] === 'string') return 1;

  return 0;
}

/**
 * Truncate a cell value to `max` chars, appending `…` when shortened.
 *
 * Operates on the JS character (UTF-16 code unit) length — sufficient for
 * the ASCII / BMP titles CLEO emits.
 */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, Math.max(0, max - 1)) + '…';
}

/**
 * Render a list-shaped payload as a fixed-width ASCII table.
 *
 * Columns: `id`, `status`, `priority`, `title` (truncated to 60 chars).
 * Each column is sized to the widest cell up to the title cap so the
 * output remains scannable in a 132-col terminal.
 */
function renderTableList(tasks: Array<Record<string, unknown>>): string {
  if (tasks.length === 0) return 'No rows.';

  const COL_TITLE_MAX = 60;
  const rows = tasks.map((t) => ({
    id: typeof t['id'] === 'string' ? t['id'] : '',
    status: typeof t['status'] === 'string' ? t['status'] : '',
    priority: typeof t['priority'] === 'string' ? t['priority'] : '',
    title: truncate(typeof t['title'] === 'string' ? t['title'] : '', COL_TITLE_MAX),
  }));

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length)),
    status: Math.max(6, ...rows.map((r) => r.status.length)),
    priority: Math.max(8, ...rows.map((r) => r.priority.length)),
    title: Math.max(5, ...rows.map((r) => r.title.length)),
  };

  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  const header = `${pad('id', widths.id)}  ${pad('status', widths.status)}  ${pad(
    'priority',
    widths.priority,
  )}  ${pad('title', widths.title)}`;
  const sep = `${'-'.repeat(widths.id)}  ${'-'.repeat(widths.status)}  ${'-'.repeat(
    widths.priority,
  )}  ${'-'.repeat(widths.title)}`;
  const body = rows
    .map(
      (r) =>
        `${pad(r.id, widths.id)}  ${pad(r.status, widths.status)}  ${pad(
          r.priority,
          widths.priority,
        )}  ${pad(r.title, widths.title)}`,
    )
    .join('\n');

  return `${header}\n${sep}\n${body}`;
}

/**
 * Generic table fallback for non-list payloads.
 *
 * Flattens the top-level object into a two-column `field | value` table.
 * Nested objects/arrays are JSON-stringified so the output stays
 * single-line per row.
 */
function renderTableGeneric(data: Record<string, unknown>): string {
  const entries = Object.entries(data);
  if (entries.length === 0) return '(empty)';

  const rows = entries.map(([k, v]) => ({
    field: k,
    value:
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v),
  }));

  const VAL_MAX = 80;
  for (const r of rows) r.value = truncate(r.value, VAL_MAX);

  const widths = {
    field: Math.max(5, ...rows.map((r) => r.field.length)),
    value: Math.max(5, ...rows.map((r) => r.value.length)),
  };
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));

  const header = `${pad('field', widths.field)}  ${pad('value', widths.value)}`;
  const sep = `${'-'.repeat(widths.field)}  ${'-'.repeat(widths.value)}`;
  const body = rows
    .map((r) => `${pad(r.field, widths.field)}  ${pad(r.value, widths.value)}`)
    .join('\n');

  return `${header}\n${sep}\n${body}`;
}

/**
 * Result of {@link renderOutputMode}.
 *
 * `text` is the bytes the caller should write to stdout — `null` means
 * the mode requested silence and stdout MUST be left untouched.
 */
export interface OutputModeResult {
  /** Bytes to write to stdout (no trailing newline added by the renderer). */
  text: string | null;
}

/**
 * Re-render a successful dispatch envelope's `data` payload into the
 * shape requested by the `--output` flag.
 *
 * @param mode - the resolved mode from `getOutputMode()`. Caller MUST
 *               short-circuit when mode is `'envelope'` — this function
 *               only handles the four alternative modes.
 * @param data - the `DispatchResponse.data` payload (post field-filter).
 *
 * @example
 * ```ts
 * if (mode !== 'envelope') {
 *   const out = renderOutputMode(mode, response.data);
 *   if (out.text !== null) process.stdout.write(out.text + '\n');
 *   return;
 * }
 * ```
 */
export function renderOutputMode(mode: OutputMode, data: unknown): OutputModeResult {
  switch (mode) {
    case 'id': {
      const ids = extractIds(data);
      return { text: ids.length === 0 ? '' : ids.join('\n') };
    }
    case 'count': {
      return { text: String(extractCount(data)) };
    }
    case 'table': {
      if (data && typeof data === 'object') {
        const rec = data as Record<string, unknown>;
        const tasks = rec['tasks'];
        if (Array.isArray(tasks)) {
          return { text: renderTableList(tasks as Array<Record<string, unknown>>) };
        }
        const items = rec['items'];
        if (Array.isArray(items)) {
          return { text: renderTableList(items as Array<Record<string, unknown>>) };
        }
        return { text: renderTableGeneric(rec) };
      }
      return { text: data === null || data === undefined ? '(empty)' : String(data) };
    }
    case 'silent': {
      return { text: null };
    }
    case 'envelope':
      // Caller is responsible for short-circuiting envelope mode — emitting
      // here would double-render. Throwing keeps the contract explicit.
      throw new Error('renderOutputMode: envelope mode must be handled by caller');
  }
}
