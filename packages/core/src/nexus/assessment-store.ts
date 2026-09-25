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
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12348
 * @module nexus/assessment-store
 */

import { gunzipSync, gzipSync } from 'node:zlib';
import type { GraphIndexAssessment, GraphIndexReferenceReport } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

/** `_nexus_meta` key of the assessment summary. */
export const ASSESSMENT_KEY = 'graph_assessment';

/** `_nexus_meta` key of the separately stored reference list. */
export const ASSESSMENT_REFERENCES_KEY = 'graph_assessment_references';

/** gzip level of the stored reference list: level 1 is ~16x smaller at ~1 s per 450 MB. */
const REFERENCES_GZIP_LEVEL = 1;

/**
 * Encode a reference list for storage under {@link ASSESSMENT_REFERENCES_KEY}.
 *
 * @param references - The generation's retained references.
 * @returns gzip-compressed JSON, stored as a BLOB.
 */
export function encodeStoredReferences(
  references: readonly GraphIndexReferenceReport[],
): Uint8Array {
  return gzipSync(JSON.stringify(references), { level: REFERENCES_GZIP_LEVEL });
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
 * @param tx - Graph database handle or open transaction.
 * @param assessment - Assessment to persist.
 * @returns The summary as written.
 */
export function writeAssessment(
  tx: Pick<NodeSQLiteDatabase, 'run'>,
  assessment: GraphIndexAssessment,
): GraphIndexAssessment {
  const summary = assessmentSummary(assessment);
  tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${ASSESSMENT_KEY}, ${JSON.stringify(summary)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
  if (assessment.references !== undefined) {
    tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${ASSESSMENT_REFERENCES_KEY}, ${encodeStoredReferences(assessment.references)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
  } else if (summary.referenceCount === undefined) {
    tx.run(sql`DELETE FROM main._nexus_meta WHERE key = ${ASSESSMENT_REFERENCES_KEY}`);
  }
  return summary;
}
