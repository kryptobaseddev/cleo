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

import {
  COLLECTION_IDENTITY_FIELDS,
  COLLECTION_KEYS as CONTRACT_COLLECTION_KEYS,
  DEFAULT_IDENTITY_FIELD,
} from '@cleocode/contracts';
import { truncateString } from '@cleocode/core';
import type { OutputMode } from '../output-context.js';

/**
 * Envelope keys that carry a list of records, in resolution order.
 *
 * SSoT for every renderer in this module. Before T12067 each renderer
 * carried its own inlined key list, and `results` — the collection key
 * `tasks.find` has always emitted — was absent from all of them. The
 * consequence was a self-contradicting CLI: `cleo find <q> --output count`
 * reported 1626 (read off the sibling `total` field) while `--output id`,
 * `--output table` and `--summary` all reported empty, because none of them
 * recognised the array sitting next to that total.
 *
 * `cleo find` is the surface the agent protocol mandates for all task
 * discovery ("use `cleo find` for discovery, NEVER `cleo list` for
 * browsing"), so an agent scripting the documented ID-pipeline idiom
 * (`cleo find … --output id | while read id`) silently processed zero rows
 * against a non-empty result set. Keeping the key list in one place is what
 * stops the next collection key from regressing the same way.
 *
 * @task T12067
 */
// T12077: imported from contracts rather than re-declared. A LOCAL copy is how
// `suggestions` (the key `tasks.next` emits) came to be missing here while the
// SSoT already listed it — `cleo next --output id` reported "No ids." against
// an envelope holding 836 candidates. One list, one place.
const COLLECTION_KEYS = CONTRACT_COLLECTION_KEYS;

/**
 * Resolve the first list-shaped collection on an envelope `data` payload.
 *
 * @param rec - the envelope `data` object.
 * @returns the matching array, or `undefined` when the payload carries none.
 *
 * @task T12067
 */
interface CollectionEntry {
  /** The key the rows were found under — determines the identity field. */
  key: string;
  /** The rows themselves. */
  rows: unknown[];
}

/**
 * Resolve the list-shaped collection on an envelope `data` payload.
 *
 * Known keys win, in {@link COLLECTION_KEYS} order, preserving the precedence
 * the canonical `tasks` shape has always had.
 *
 * ## The fallback, and why it is not "first array wins" (gh#1405)
 *
 * This file has now been patched four times by adding a key to a list, and each
 * time the key that was missing produced a confident zero rather than an error —
 * the miss is invisible precisely because an absent key and an empty collection
 * render identically. Adding three more keys fixes the three known verbs and
 * leaves the mechanism that hid them fully intact.
 *
 * So when no known key matches, fall back to the payload's own shape: a single
 * unambiguous array of records. Deliberately narrow — it requires EXACTLY ONE
 * top-level array-of-objects, so a payload carrying rows plus some incidental
 * array (`{task, warnings: []}`) still resolves to nothing here and is handled
 * by the single-record branches, exactly as before. An unlisted collection key
 * now degrades to "found it anyway" instead of "found nothing".
 *
 * @param rec - the envelope `data` object.
 * @returns the matching entry, or `undefined` when the payload carries none.
 *
 * @task T12067
 * @task gh#1405
 */
function pickCollectionEntry(rec: Record<string, unknown>): CollectionEntry | undefined {
  for (const key of COLLECTION_KEYS) {
    const value = rec[key];
    if (Array.isArray(value)) return { key, rows: value };
  }

  const candidates = Object.entries(rec).filter(
    ([, value]) =>
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row)),
  );
  if (candidates.length === 1) {
    const [key, value] = candidates[0] as [string, unknown[]];
    return { key, rows: value };
  }
  return undefined;
}

/** Rows only — for the callers that do not care which key carried them. */
function pickCollection(rec: Record<string, unknown>): unknown[] | undefined {
  return pickCollectionEntry(rec)?.rows;
}

/**
 * The property that identifies a record in the given collection.
 *
 * Lives here rather than in `@cleocode/contracts` because that package is
 * types-and-const-data only (arch gate 10); the registry is the data, this is
 * the lookup.
 *
 * @param key - The collection key the rows were found under.
 * @returns The identity property name.
 */
function identityFieldFor(key: string): string {
  return (
    (COLLECTION_IDENTITY_FIELDS as Record<string, string | undefined>)[key] ??
    DEFAULT_IDENTITY_FIELD
  );
}

/**
 * Read a record's identity, honouring the per-collection identity field.
 *
 * @param row - A record from a resolved collection.
 * @param key - The collection key it came from.
 * @returns The identity string, or `undefined` when the record carries none.
 */
function identityOf(row: unknown, key: string): string | undefined {
  if (row === null || typeof row !== 'object') return undefined;
  const value = (row as Record<string, unknown>)[identityFieldFor(key)];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Heuristic id extraction across the family of envelope shapes the
 * dispatch surface produces.
 *
 * Walked in order:
 *   1. `data.task.id` — single-task mutate ops (`add`, `update`, ...).
 *   2. `data.{tasks,items,results}[].id` — list / find responses
 *      ({@link COLLECTION_KEYS}).
 *   3. `data.id` — bare id payloads (e.g. `cleo session start`).
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

  // 2. List payloads — {tasks}, {items}, {results}, {sagas}, {worktrees}, ...
  // Projected through the collection's OWN identity field: `worktrees` identify
  // by `path` and `backups` by `backupId`, and projecting `id` unconditionally
  // dropped every row of both (gh#1405).
  const entry = pickCollectionEntry(rec);
  if (entry) {
    return entry.rows
      .map((row) => identityOf(row, entry.key))
      .filter((id): id is string => id !== undefined);
  }

  // 3. Bare id
  const id = rec['id'];
  if (typeof id === 'string') return [id];

  return [];
}

/**
 * Pick the row count from a dispatch envelope.
 *
 * Honours explicit count fields before array lengths. The precedence below
 * settles the filtered-listing-vs-total semantic (T11481 · DHQ-034):
 *
 *   1. `filtered` — the filter-aware match count of a `tasks.list` envelope
 *      (`{tasks, total, filtered}`). For a filtered listing
 *      (`list --parent X`, `list --status Y`) this is the count the operator
 *      asked about — NOT the global `total` (every task in the project) and
 *      NOT the returned-rows length (which differs from the match count under
 *      pagination, e.g. a Saga `bindingSource:'saga.groups'` page binding
 *      `tasks.length=10` while `filtered=19`).
 *   2. `total` — paginated read payloads that carry no distinct `filtered`
 *      field. Preserves the documented total-first behaviour (T10599) where
 *      there is no filter dimension.
 *   3. `count` — the canonical minimal mutate envelope field, especially for
 *      dry-run mutations where the raw inserted/created count can be zero while
 *      the predicted affected count is non-zero.
 *
 * @returns `0` when the data shape carries neither a counted collection
 *          nor a recognisable count field.
 */
function extractCount(data: unknown): number {
  if (data === null || typeof data !== 'object') return 0;
  const rec = data as Record<string, unknown>;

  // 1. Filter-aware match count of a `tasks.list` envelope. Wins over `total`
  // so a filtered listing reports the number of MATCHES, not the global total.
  const filtered = rec['filtered'];
  if (typeof filtered === 'number' && Number.isFinite(filtered)) return filtered;

  const total = rec['total'];
  if (typeof total === 'number' && Number.isFinite(total)) return total;

  // Minimal mutate envelopes expose an explicit count. For
  // `tasks.add-batch --dry-run`, Core projects this from `wouldCreate` so
  // `--output count` reports the number of tasks that would be created rather
  // than the zero durable-write count.
  const count = rec['count'];
  if (typeof count === 'number' && Number.isFinite(count)) return count;

  const collection = pickCollection(rec);
  if (collection) return collection.length;

  // Single-record envelopes (`{task: {...}}`) count as 1.
  if (rec['task'] && typeof rec['task'] === 'object') return 1;
  if (typeof rec['id'] === 'string') return 1;

  return 0;
}

/**
 * Render a list-shaped payload as a fixed-width ASCII table.
 *
 * Columns: `id`, `status`, `priority`, `title` (truncated to 60 chars).
 * Each column is sized to the widest cell up to the title cap so the
 * output remains scannable in a 132-col terminal.
 */
function renderTableList(
  tasks: Array<Record<string, unknown>>,
  identityField: string = DEFAULT_IDENTITY_FIELD,
): string {
  if (tasks.length === 0) return '';

  const COL_TITLE_MAX = 60;
  const rows = tasks.map((t) => ({
    id: typeof t[identityField] === 'string' ? (t[identityField] as string) : '',
    status: typeof t['status'] === 'string' ? t['status'] : '',
    priority: typeof t['priority'] === 'string' ? t['priority'] : '',
    title: truncateString(typeof t['title'] === 'string' ? t['title'] : '', COL_TITLE_MAX),
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
  for (const r of rows) r.value = truncateString(r.value, VAL_MAX);

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
export type OutputEmptyReason = 'no-renderable-records' | 'no-renderable-ids' | 'silent-mode';

/**
 * A projection mode that cannot answer for this payload, and must REFUSE.
 *
 * Distinct from an empty result on purpose (gh#1402 / gh#1405): "no rows
 * matched" and "this collection has no identity I can project" are different
 * facts, and an empty stream rendered them identically. The documented ID
 * pipeline (`--output id | while read id`) then looped zero times and looked
 * exactly like an empty project.
 *
 * @task gh#1405
 */
export interface OutputModeRefusal {
  /** Typed code for the envelope. */
  code: 'E_OUTPUT_IDENTITY_UNDECLARED';
  /** Operator-facing explanation. */
  message: string;
  /** What to do instead. */
  fix: string;
}

export interface OutputModeResult {
  /** Bytes to write to stdout (no trailing newline added by the renderer). */
  text: string | null;
  /** Machine-readable reason when a renderer has no success text to emit. */
  emptyReason?: OutputEmptyReason;
  /**
   * Set when the mode must fail rather than emit. The caller turns this into a
   * typed error envelope + non-zero exit; it never writes `text`.
   */
  refusal?: OutputModeRefusal;
}

export class UnsupportedRendererError extends Error {
  readonly code = 'E_RENDERER_UNSUPPORTED';

  constructor(mode: string) {
    super(`Unsupported output renderer: ${mode}`);
    this.name = 'UnsupportedRendererError';
  }
}

/**
 * Render the dispatch envelope's `data` payload as one line per record.
 *
 * Format: `<id> [<status>] <title-truncated-60>` per row.
 *
 * Single-record envelopes (`{task: {...}}`, bare `{id, status, title}`) emit
 * exactly one line. List-shaped envelopes (`{tasks: []}` / `{items: []}`)
 * emit one line per element. Records missing `id` are skipped (consistent
 * with `--output id`). An empty collection emits NOTHING — an empty stream is
 * the correct representation of zero rows in a machine-readable mode, and the
 * human explanation goes to stderr (gh#1317).
 *
 * Title is truncated to 60 chars (UTF-16 code units) with a trailing `…`
 * when shortened — matches the cell cap used by `renderTableList`.
 *
 * @task T9932
 * @epic T9855
 */
export function renderSummary(data: unknown): OutputModeResult {
  if (data === null || typeof data !== 'object') {
    return { text: '', emptyReason: 'no-renderable-records' };
  }
  const rec = data as Record<string, unknown>;

  // 1. List shapes — {tasks}, {items}, {results}, {sagas}, {worktrees}, ...
  const entry = pickCollectionEntry(rec);
  if (entry) {
    return renderSummaryList(entry.rows, identityFieldFor(entry.key));
  }

  // 2. Single nested task ({task: {id, status, title}}) — e.g. `cleo show`.
  const task = rec['task'];
  if (task && typeof task === 'object') {
    return { text: renderSummaryRow(task as Record<string, unknown>) };
  }

  // 3. Bare record (`{id, status, title}`).
  if (typeof rec['id'] === 'string') {
    return { text: renderSummaryRow(rec) };
  }

  return { text: '', emptyReason: 'no-renderable-records' };
}

/** Render a single record line: `<id> [<status>] <title-truncated-60>`. */
function renderSummaryRow(
  record: Record<string, unknown>,
  identityField: string = DEFAULT_IDENTITY_FIELD,
): string {
  const id = typeof record[identityField] === 'string' ? (record[identityField] as string) : '';
  const status = typeof record['status'] === 'string' ? record['status'] : '';
  const title = truncateString(typeof record['title'] === 'string' ? record['title'] : '', 60);
  return `${id} [${status}] ${title}`;
}

/** Render a list of records, one line each. Skips rows lacking an id. */
function renderSummaryList(
  rows: unknown[],
  identityField: string = DEFAULT_IDENTITY_FIELD,
): OutputModeResult {
  if (rows.length === 0) return { text: '', emptyReason: 'no-renderable-records' };
  const lines: string[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec[identityField] !== 'string') continue;
    lines.push(renderSummaryRow(rec, identityField));
  }
  return lines.length === 0
    ? { text: '', emptyReason: 'no-renderable-records' }
    : { text: lines.join('\n') };
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
/**
 * How much of a matching result set a projection mode actually returned.
 *
 * @task T12123
 */
export interface TruncationFacts {
  /** Rows emitted on stdout. */
  returned: number;
  /** Rows the query matched. */
  total: number;
}

/**
 * Detect that a projection mode is about to emit fewer rows than the query
 * matched.
 *
 * Why this exists (T12123 · GH #1242)
 * -----------------------------------
 * `cleo list --status pending --output count` reported 1075 while
 * `--output id` returned 10 for the same query, seconds apart, with no
 * `_truncated`, no `hasMore`, no `nextCursor`, and nothing on stderr. The
 * short list was indistinguishable from a complete list of ten.
 *
 * Neither number is wrong. `count` is the filter-aware match count by design
 * (see {@link extractCount} and T11481 · DHQ-034), and `TASK_LIST_DEFAULT_LIMIT`
 * is 10. The defect is that the enumeration modes silently discard the `page`
 * metadata the envelope already carries — `{mode:"offset", limit:10, offset:0,
 * hasMore:true, total:1075}` — so the caller has no way to learn it saw a page.
 *
 * The consequence is worse than a short list. An agent enumerating tasks
 * bottom-up to diff against a top-down walk got 16 of ~220 rows and reported
 * "2 orphans" — a clean, plausible, entirely artefactual finding, which also
 * implied the other 205 had been verified. Absent rows read as "these do not
 * exist" rather than "these were not returned".
 *
 * @param data - The envelope `data` payload.
 * @param page - The envelope `page` metadata, when the command supplied it.
 * @returns The counts when the emitted set is a strict subset of the matched
 *          set; `null` when the result is complete (or not a collection).
 */
export function detectTruncation(data: unknown, page?: unknown): TruncationFacts | null {
  if (data === null || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  const collection = pickCollection(rec);
  if (!collection) return null;
  const returned = collection.length;

  // Prefer the envelope's own pagination statement when present.
  if (page !== null && typeof page === 'object') {
    const pageRec = page as Record<string, unknown>;
    const total = pageRec['total'];
    if (pageRec['hasMore'] === true && typeof total === 'number' && total > returned) {
      return { returned, total };
    }
  }

  // Fall back to the filter-aware match count the payload carries. This is the
  // same field `--output count` prints, so the warning and that number can
  // never disagree.
  const filtered = rec['filtered'];
  if (typeof filtered === 'number' && filtered > returned) {
    return { returned, total: filtered };
  }
  const total = rec['total'];
  if (typeof total === 'number' && total > returned && rec['filtered'] === undefined) {
    return { returned, total };
  }
  return null;
}

/**
 * Render surfaces that emit one line per RETURNED row and therefore can
 * present a page as if it were the whole set.
 *
 * `count` is deliberately absent: it prints the filter-aware match count, so
 * it is the one mode that already tells the truth about the full population.
 *
 * @task T12123
 */
export type TruncatableRender = Extract<OutputMode, 'id' | 'table'> | 'summary';

/**
 * The truncation warning text for a projection mode.
 *
 * Deliberately written to stderr by the caller, never stdout: `--output id`
 * exists to be piped, and a warning line inside the id stream would corrupt
 * the very consumer it is meant to protect (ADR-086 — one clean payload per
 * call on stdout). The exit code is deliberately left at 0 as well: flipping
 * it would break every `set -e` consumer to fix a silent-truncation bug,
 * trading one silent failure for a loud unrelated one.
 *
 * @task T12123
 */
export function formatTruncationWarning(
  facts: TruncationFacts,
  mode: TruncatableRender,
  enumerateAllFlag?: string,
): string {
  const surface = mode === 'summary' ? '--summary' : `--output ${mode}`;
  const head = `cleo: TRUNCATED — ${surface} returned ${facts.returned} of ${facts.total} matching rows. `;

  // The remedy is only printed when the CALLING COMMAND declares a flag that
  // actually enumerates everything, and the caller supplies its spelling. This
  // warning is emitted from the generic `cliOutput`, which every command reaches
  // — so an unconditional "re-run with --all (or --limit 0)" is advice that is
  // wrong for most of them. On `cleo find` specifically BOTH halves are wrong:
  // no `all` arg is declared, and `--limit 0` is `slice(0, 0)` — zero rows. Once
  // the unknown-flag guard lands, that suggestion becomes a hard
  // E_UNKNOWN_FLAG exit rather than a harmless one, i.e. the CLI refusing the
  // invocation it just told the caller to run.
  //
  // Keeping the flag's spelling with the command that owns it means a command
  // that gains or loses the flag cannot fall out of step with this message —
  // there is no second list here to update.
  if (enumerateAllFlag) {
    return (
      `${head}Re-run with ${enumerateAllFlag} to enumerate every match, ` +
      'or pass --limit/--offset to page deliberately.'
    );
  }
  return `${head}Pass --limit <n> / --offset <n> to page deliberately, or narrow the query.`;
}

export function renderOutputMode(mode: OutputMode, data: unknown): OutputModeResult {
  switch (mode) {
    case 'id': {
      const ids = extractIds(data);
      if (ids.length > 0) return { text: ids.join('\n') };

      // Rows are PRESENT but none yielded an identity. That is a gap in the
      // identity registry, not an empty result, and emitting an empty stream
      // here is what made gh#1402 read as "this project has no sagas". An
      // empty collection still emits nothing and exits 0 — zero rows is a
      // truthful empty stream.
      const entry =
        data && typeof data === 'object'
          ? pickCollectionEntry(data as Record<string, unknown>)
          : undefined;
      if (entry && entry.rows.length > 0) {
        return {
          text: null,
          refusal: {
            code: 'E_OUTPUT_IDENTITY_UNDECLARED',
            message:
              `--output id cannot project the ${entry.rows.length} record(s) under ` +
              `"${entry.key}": no record carries "${identityFieldFor(entry.key)}". ` +
              'Refusing to emit an empty stream, which would be indistinguishable ' +
              'from a result set with no rows.',
            fix:
              `Declare the identity for "${entry.key}" in COLLECTION_IDENTITY_FIELDS ` +
              '(packages/contracts/src/collection-keys.ts), or use ' +
              `--field /data/${entry.key} to project the field you need.`,
          },
        };
      }
      return { text: '', emptyReason: 'no-renderable-ids' };
    }
    case 'count': {
      return { text: String(extractCount(data)) };
    }
    case 'table': {
      if (data && typeof data === 'object') {
        const rec = data as Record<string, unknown>;
        const entry = pickCollectionEntry(rec);
        if (entry) {
          const text = renderTableList(
            entry.rows as Array<Record<string, unknown>>,
            identityFieldFor(entry.key),
          );
          // An empty TSV is zero bytes, and the REASON still travels — to
          // stderr, via the caller. Losing it here would trade one defect for
          // another: a silent empty stream with no way to tell "no rows" from
          // "the command did not run" (gh#1317).
          return text.length === 0 ? { text: '', emptyReason: 'no-renderable-records' } : { text };
        }
        return { text: renderTableGeneric(rec) };
      }
      return data === null || data === undefined
        ? { text: '', emptyReason: 'no-renderable-records' }
        : { text: String(data) };
    }
    case 'silent': {
      return { text: null, emptyReason: 'silent-mode' };
    }
    case 'envelope':
      // Caller is responsible for short-circuiting envelope mode — emitting
      // here would double-render. Throwing keeps the contract explicit.
      throw new UnsupportedRendererError(mode);
    default:
      throw new UnsupportedRendererError(String(mode));
  }
}
