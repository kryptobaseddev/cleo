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
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12348
 * @module nexus/assessment-store
 */

import type { GraphIndexAssessment } from '@cleocode/contracts';
import { sql } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';

/** `_nexus_meta` key of the assessment summary. */
export const ASSESSMENT_KEY = 'graph_assessment';

/** `_nexus_meta` key of the separately stored reference list. */
export const ASSESSMENT_REFERENCES_KEY = 'graph_assessment_references';

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
    tx.run(sql`INSERT INTO main._nexus_meta (key, value) VALUES (${ASSESSMENT_REFERENCES_KEY}, ${JSON.stringify(assessment.references)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = strftime('%s', 'now')`);
  } else if (summary.referenceCount === undefined) {
    tx.run(sql`DELETE FROM main._nexus_meta WHERE key = ${ASSESSMENT_REFERENCES_KEY}`);
  }
  return summary;
}
