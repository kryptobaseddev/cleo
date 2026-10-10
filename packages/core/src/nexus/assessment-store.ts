/**
 * Storage layout of the published graph assessment (T12348).
 *
 * The assessment used to be ONE `_nexus_meta` JSON value holding every
 * retained unresolved/unmodeled reference with its full evidence — 472 MB on
 * this repository, 647k references against a 3.75 MB remainder. Every reader
 * paid to parse and validate all of it: `cleo nexus status` took ~10 s and
 * returned a 472 MB envelope, and every analysis re-read it before starting.
 *
 * The summary (`graph_assessment`) now carries everything except the
 * reference list, plus `referenceCount`; the list lives under
 * `graph_assessment_references` and is read only when asked for. Both are
 * written in the publishing transaction, so they always describe the same
 * generation. A historical value with inline `references` stays readable.
 *
 * The list is stored gzip-compressed (a BLOB), because every publication
 * rewrites it: 453 MB of JSON is 116k pages written to the WAL and 116k more
 * at checkpoint — measured at 0.6 ms per page write on this repository's FUSE
 * mount, most of a 49-minute publication. At gzip level 1 it is 28 MB, costs
 * ~0.6 s to compress and ~0.55 s to inflate. A historical plain-text list is
 * still read as stored.
 *
 * The list is written one reference per line, in gzip members of
 * {@link REFERENCES_PER_MEMBER} references, and read back line by line
 * (T13326). Building it as ONE `JSON.stringify` string failed outright on a
 * 5 357-file repository: 846 151 references exceed V8's maximum string length
 * (2^29 - 24 characters), so publication died with "Invalid string length"
 * after every other phase had finished. The text is still one valid JSON
 * array, so a reader that parses it whole keeps working for lists that fit.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12348
 * @module nexus/assessment-store
 */

import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip, gunzipSync, gzipSync } from 'node:zlib';
import type { GraphIndexAssessment, GraphIndexReferenceReport } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { encodeStoredAssessment } from './stored-roots.js';

/** `_nexus_meta` key of the assessment summary. */
export const ASSESSMENT_KEY = 'graph_assessment';

/** `_nexus_meta` key of the separately stored reference list. */
export const ASSESSMENT_REFERENCES_KEY = 'graph_assessment_references';

/** gzip level of the stored reference list: level 1 is ~16x smaller at ~1 s per 450 MB. */
const REFERENCES_GZIP_LEVEL = 1;

/**
 * References compressed per gzip member of the stored list.
 *
 * Bounds the largest string the encoder builds to one member's worth (a few
 * MB) whatever the repository size, while keeping members large enough that
 * per-member gzip framing does not cost compression.
 */
const REFERENCES_PER_MEMBER = 4096;

/** Newline byte; JSON text never contains a raw one inside a value. */
const NEWLINE = 0x0a;

/**
 * Encode a reference list for storage under {@link ASSESSMENT_REFERENCES_KEY}.
 *
 * The decompressed text is the JSON array `[\n<ref>,\n<ref>\n]` — one
 * reference per line — written as concatenated gzip members, so no string
 * longer than one member's text is ever built (T13326).
 *
 * @param references - The generation's retained references.
 * @returns gzip-compressed JSON, stored as a BLOB.
 */
export function encodeStoredReferences(
  references: readonly GraphIndexReferenceReport[],
): Uint8Array {
  const members: Buffer[] = [];
  let text = '[';
  references.forEach((reference, index) => {
    text += `${index === 0 ? '\n' : ',\n'}${JSON.stringify(reference)}`;
    if ((index + 1) % REFERENCES_PER_MEMBER === 0) {
      members.push(gzipSync(text, { level: REFERENCES_GZIP_LEVEL }));
      text = '';
    }
  });
  members.push(gzipSync(`${text}\n]`, { level: REFERENCES_GZIP_LEVEL }));
  return Buffer.concat(members);
}

/**
 * Parse a stored reference list into its items without building one string
 * of the whole list (T13326).
 *
 * Reads the line-per-reference form written by {@link encodeStoredReferences},
 * and the single-line form written before it — compressed or plain text —
 * by parsing that one line whole, as it was always read.
 *
 * @param value - The raw `_nexus_meta.value` of {@link ASSESSMENT_REFERENCES_KEY}.
 * @returns The stored items, not yet validated.
 * @throws When the value is neither text nor a compressed list, or is not a JSON array.
 * @example
 * ```ts
 * const references = z.array(referenceSchema).parse(parseStoredReferences(row.value));
 * ```
 */
export function parseStoredReferences(value: unknown): unknown[] {
  let bytes: Buffer;
  if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
  else if (value instanceof Uint8Array) bytes = gunzipSync(value);
  // @sync-invariant none:input-shape a malformed stored list is refused on read; nothing is written
  else throw new Error('Graph reference metadata is neither text nor a compressed list.');
  const firstBreak = bytes.indexOf(NEWLINE);
  if (firstBreak === -1 || bytes.toString('utf8', 0, firstBreak).trim() !== '[') {
    const whole: unknown = JSON.parse(bytes.toString('utf8'));
    // @sync-invariant none:input-shape a malformed stored list is refused on read; nothing is written
    if (!Array.isArray(whole)) throw new Error('Graph reference metadata is not a list.');
    return whole;
  }
  const items: unknown[] = [];
  let start = firstBreak + 1;
  while (start < bytes.length) {
    const end = bytes.indexOf(NEWLINE, start);
    const line = bytes
      .toString('utf8', start, end === -1 ? bytes.length : end)
      .trim()
      .replace(/,$/, '');
    if (line !== ']' && line !== '') items.push(JSON.parse(line));
    if (end === -1) break;
    start = end + 1;
  }
  return items;
}

/** One stored reference, not yet validated, and the UTF-8 size of its JSON. */
export interface StoredReferenceItem {
  /** The parsed reference. */
  item: unknown;
  /** UTF-8 bytes of the reference's own JSON text. */
  bytes: number;
}

/**
 * Stream a stored reference list one reference at a time (T13330).
 *
 * The compressed list is inflated incrementally and split on line breaks, so
 * neither the decompressed text nor the parsed list is ever held whole: a
 * reader that keeps one page holds one page. The single-line form written
 * before T13326 has no line breaks to split on; it was small enough to be
 * written whole, so it is parsed whole, as it was always read.
 *
 * @param value - The raw `_nexus_meta.value` of {@link ASSESSMENT_REFERENCES_KEY}.
 * @returns The stored references in stored order.
 * @throws When the value is neither text nor a compressed list, or is not a JSON array.
 * @example
 * ```ts
 * for await (const { item } of streamStoredReferences(row.value)) count++;
 * ```
 */
export async function* streamStoredReferences(
  value: unknown,
): AsyncGenerator<StoredReferenceItem, void, undefined> {
  let source: AsyncIterable<Buffer>;
  if (typeof value === 'string') source = Readable.from([Buffer.from(value, 'utf8')]);
  else if (value instanceof Uint8Array) source = Readable.from([value]).pipe(createGunzip());
  // @sync-invariant none:input-shape a malformed stored list is refused on read; nothing is written
  else throw new Error('Graph reference metadata is neither text nor a compressed list.');
  // Unterminated bytes, kept as chunks and joined once per line (T13372): a
  // join per CHUNK, then a rescan of the whole buffer, made a long line —
  // the legacy single-line list is one line — cost quadratic time.
  let parts: Buffer[] = [];
  let legacy = false;
  let sawOpening = false;
  for await (const chunk of source) {
    if (legacy) {
      parts.push(chunk);
      continue;
    }
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      const lineBytes =
        parts.length === 0
          ? chunk.subarray(start, end)
          : Buffer.concat([...parts, chunk.subarray(start, end)]);
      parts = [];
      const line = lineBytes.toString('utf8').trim();
      if (!sawOpening) {
        if (line !== '[') {
          // Not the line-per-reference form: keep every byte for a whole parse.
          legacy = true;
          parts = [lineBytes, chunk.subarray(end)];
          break;
        }
        sawOpening = true;
      } else {
        const text = line.replace(/,$/, '');
        if (text !== ']' && text !== '')
          yield { item: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf8') };
      }
      start = end + 1;
    }
    if (!legacy && start < chunk.length) parts.push(chunk.subarray(start));
  }
  const rest = Buffer.concat(parts).toString('utf8').trim();
  if (sawOpening && !legacy) {
    const text = rest.replace(/,$/, '');
    if (text !== ']' && text !== '')
      yield { item: JSON.parse(text), bytes: Buffer.byteLength(text, 'utf8') };
    return;
  }
  const whole: unknown = JSON.parse(rest);
  // @sync-invariant none:input-shape a malformed stored list is refused on read; nothing is written
  if (!Array.isArray(whole)) throw new Error('Graph reference metadata is not a list.');
  for (const item of whole) yield { item, bytes: Buffer.byteLength(JSON.stringify(item), 'utf8') };
}

/**
 * Decode a stored reference list back to its JSON text.
 *
 * Accepts the compressed BLOB written since T12348 and the plain JSON text
 * written before it; anything else is malformed metadata.
 *
 * @param value - The raw `_nexus_meta.value` of {@link ASSESSMENT_REFERENCES_KEY}.
 * @returns The list's JSON text.
 * @throws When the value is neither text nor a compressed list.
 * @example
 * ```ts
 * const references = JSON.parse(decodeStoredReferences(row.value));
 * ```
 */
export function decodeStoredReferences(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Uint8Array) return gunzipSync(value).toString('utf8');
  throw new Error('Graph reference metadata is neither text nor a compressed list.');
}

/**
 * Return the summary form of an assessment: the reference list removed and
 * its length recorded as `referenceCount`.
 *
 * An assessment without a `references` list is returned unchanged, so a
 * summary stays a summary and a historical index without references keeps
 * its shape.
 *
 * @param assessment - Full or summary assessment.
 * @returns The summary a reader of `graph_assessment` observes.
 * @example
 * ```ts
 * const head = assessmentSummary(stagedAssessment);
 * ```
 */
export function assessmentSummary(assessment: GraphIndexAssessment): GraphIndexAssessment {
  if (assessment.references === undefined) return assessment;
  const { references, ...summary } = assessment;
  return { ...summary, referenceCount: references.length };
}

/**
 * Write an assessment inside the caller's transaction.
 *
 * - A full assessment writes its summary and replaces the reference list.
 * - A summary that already carries `referenceCount` (for example a provenance
 *   re-record of an unchanged generation) rewrites the summary only, keeping
 *   the stored list of that same generation.
 * - An assessment with neither removes any stale list.
 *
 * Root paths are stored relative to the recorded project root (T12474); read
 * them back through `readKnowledgeIndexAssessment`, which resolves them
 * against the live project root.
 *
 * @param tx - Graph database handle or open transaction.
 * @param assessment - Assessment to persist, with absolute in-memory paths.
 * @returns The summary written, in its in-memory (absolute-path) form.
 */
export function writeAssessment(
  tx: Pick<NodeSQLiteDatabase, 'run'>,
  assessment: GraphIndexAssessment,
): GraphIndexAssessment {
  const summary = assessmentSummary(assessment);
  tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${ASSESSMENT_KEY}, ${JSON.stringify(encodeStoredAssessment(summary))})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
  if (assessment.references !== undefined) {
    tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${ASSESSMENT_REFERENCES_KEY}, ${encodeStoredReferences(assessment.references)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
  } else if (summary.referenceCount === undefined) {
    tx.run(sql`DELETE FROM main._nexus_meta WHERE key = ${ASSESSMENT_REFERENCES_KEY}`);
  }
  return summary;
}

/**
 * Whether the stored assessment still holds absolute root paths — the form
 * written before T12474. Extracts only the two root fields.
 *
 * @param db - Graph database handle.
 * @returns `true` when a legacy absolute record should be rewritten portably.
 */
export function storedAssessmentHasAbsoluteRoots(db: Pick<NodeSQLiteDatabase, 'values'>): boolean {
  const row = db.values(
    sql`SELECT json_extract(value, '$.sourceRoot'), json_extract(value, '$.sourceRoots.projectRoot')
      FROM main._nexus_meta WHERE key = ${ASSESSMENT_KEY}`,
  )[0];
  return (row ?? []).some((path) => typeof path === 'string' && isAbsolute(path));
}
