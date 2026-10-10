/**
 * Derive `topics` / `related_tasks` provenance at the docs write path — T13357.
 *
 * The `attachments.topics` and `attachments.related_tasks` columns exist but
 * no runtime writer ever populated them (only the one-shot T10165 backfill
 * migration did), which left the `docs_wikilinks` edge table at 0 rows and
 * the provenance graph without mention edges.
 *
 * Sources (deliberately cheap — the write path must not need extra input):
 *
 * - `relatedTasks`: every `T<digits>` mention in the doc body. Agents already
 *   cite task ids in their docs; the extraction simply makes the habit
 *   visible to the graph.
 * - `topics`: the attachment's `labels` (already threaded through
 *   `docs add --labels` into the attachment JSON).
 *
 * Both columns store JSON arrays as TEXT (see schema/attachments.ts); this
 * module returns the decoded arrays and lets callers decide persistence.
 *
 * @task T13357 (Epic T13340 / Saga T13339)
 * @see deriveWikilinkEdges — packages/core/src/docs/wikilinks.ts (consumer)
 */

/** Matches a CLEO task id mention: word-bounded `T` + at least 3 digits. */
const TASK_ID_PATTERN = /\bT(\d{3,})\b/g;

/**
 * A MIME type whose bytes are UTF-8 text and therefore safe to scan for
 * mentions. Mirrors the fetch-envelope rule (T13352) but lives here to keep
 * the store layer free of CLI-facing imports.
 *
 * @param mime - IANA MIME type, or undefined when unknown.
 * @returns True when the body can be decoded and scanned as text.
 * @task T13357
 */
export function isScannableTextMime(mime: string | undefined): boolean {
  if (!mime) return false;
  const base = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base === 'application/octet-stream') return false;
  return (
    base.startsWith('text/') ||
    base === 'application/json' ||
    base === 'application/xml' ||
    base === 'application/yaml' ||
    base === 'application/x-yaml'
  );
}

/**
 * Extract sorted, de-duplicated `T####` task id mentions from a text body.
 *
 * @param contentText - Decoded UTF-8 body.
 * @returns Ascending unique task ids (e.g. `['T123', 'T4567']`).
 * @task T13357
 */
export function extractTaskMentions(contentText: string): string[] {
  const ids = new Set<string>();
  for (const match of contentText.matchAll(TASK_ID_PATTERN)) {
    ids.add(`T${match[1]}`);
  }
  return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

/**
 * Derived provenance for one doc write. Arrays are empty (never null) so
 * callers can persist unconditionally with a JSON-or-null policy.
 */
export interface DerivedDocLinks {
  /** Task ids mentioned in the body. */
  readonly relatedTasks: readonly string[];
  /** Topic labels carried on the attachment. */
  readonly topics: readonly string[];
}

/**
 * Derive provenance links for a doc write.
 *
 * @param contentText - Decoded UTF-8 body (empty string for binary/unreadable).
 * @param labels - Attachment labels, when the writer carries them.
 * @returns The derived {@link DerivedDocLinks}.
 * @task T13357
 */
export function deriveDocLinks(contentText: string, labels?: readonly string[]): DerivedDocLinks {
  return {
    relatedTasks: extractTaskMentions(contentText),
    topics: labels ? [...new Set(labels)].sort() : [],
  };
}

/**
 * JSON-or-null column policy: empty arrays persist as NULL (keeping rows
 * indistinguishable from legacy untouched rows), non-empty as a JSON array.
 *
 * @param values - Derived values.
 * @returns JSON string or null.
 * @task T13357
 */
export function linksJsonOrNull(values: readonly string[]): string | null {
  return values.length === 0 ? null : JSON.stringify(values);
}
