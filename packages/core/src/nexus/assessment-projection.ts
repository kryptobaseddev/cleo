/**
 * Bounded status projection of the published graph assessment (T12560).
 *
 * `cleo nexus status` used to emit `assessment.files` whole: one row per
 * assessed file at ~635 B each, so the envelope grew with the repository —
 * 3.9 MB on this one, and 391 MB for one reporter. The status call is the one
 * every agent is told to make FIRST, so its size must not depend on how many
 * files exist.
 *
 * The projection keeps the counts (`fileCount`, `filesByStatus`) and one page
 * of rows (`filesPage`, 20 by default). The complete list is returned under
 * `files` only when every row is explicitly requested; otherwise it is named
 * in `_withheld` with its UTF-8 JSON size, following the MVI projection rule
 * that a partial copy is never placed under the real field name.
 *
 * Code placed in `packages/core/` per Package-Boundary Check — verified against AGENTS.md.
 *
 * @task T12560
 * @module nexus/assessment-projection
 */

import {
  ExitCode,
  type GraphIndexAssessment,
  type GraphIndexAssessmentProjection,
  type GraphIndexFilePage,
  type GraphIndexFileReport,
  type GraphIndexFileStatus,
  type GraphIndexFileStatusCounts,
} from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Rows in the default page of `assessment.filesPage`. */
export const DEFAULT_ASSESSMENT_FILE_PAGE_SIZE = 20;

/** Every file processing outcome, in report order. */
export const GRAPH_INDEX_FILE_STATUSES: readonly GraphIndexFileStatus[] = [
  'analyzed',
  'excluded',
  'unsupported',
  'oversized',
  'failed',
];

/** Which file rows a status projection returns. */
export interface AssessmentFilesRequest {
  /** Return every row under `files`; paging options narrow it back to a page. */
  all?: boolean;
  /** Page size; `0` requests every remaining row. Defaults to {@link DEFAULT_ASSESSMENT_FILE_PAGE_SIZE}. */
  limit?: number;
  /** Rows to skip before the page. Defaults to 0. */
  offset?: number;
  /** Page only rows with this status. */
  status?: GraphIndexFileStatus;
}

/** Raw CLI flag values accepted by {@link parseAssessmentFilesRequest}. */
export interface AssessmentFilesFlags {
  /** `--files`. */
  files?: boolean;
  /** `--limit`. */
  limit?: string;
  /** `--offset`. */
  offset?: string;
  /** `--file-status`. */
  fileStatus?: string;
}

/**
 * Parse one non-negative integer flag, rejecting partial parses such as `10x`.
 * @internal
 */
function parseCount(flag: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value.trim()))
    throw new CleoError(ExitCode.INVALID_INPUT, `--${flag} must be a non-negative integer`, {
      fix: `cleo nexus status --${flag} <n>`,
      details: { field: flag, actual: value },
    });
  return Number(value.trim());
}

/**
 * Validate `cleo nexus status` file-paging flags.
 * @param flags - Raw flag values as the CLI received them.
 * @returns The validated request.
 * @throws CleoError with `INVALID_INPUT` for a malformed count or unknown status.
 * @example
 * ```ts
 * parseAssessmentFilesRequest({ limit: '50', offset: '100', fileStatus: 'failed' });
 * ```
 */
export function parseAssessmentFilesRequest(flags: AssessmentFilesFlags): AssessmentFilesRequest {
  const status = flags.fileStatus?.trim();
  if (status !== undefined && !GRAPH_INDEX_FILE_STATUSES.some((known) => known === status))
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `--file-status must be one of ${GRAPH_INDEX_FILE_STATUSES.join(', ')}`,
      {
        fix: 'cleo nexus status --file-status failed',
        details: { field: 'file-status', actual: status },
      },
    );
  return {
    ...(flags.files ? { all: true } : {}),
    ...(flags.limit === undefined ? {} : { limit: parseCount('limit', flags.limit) }),
    ...(flags.offset === undefined ? {} : { offset: parseCount('offset', flags.offset) }),
    ...(status === undefined
      ? {}
      : { status: GRAPH_INDEX_FILE_STATUSES.find((known) => known === status) }),
  };
}

/**
 * UTF-8 size of `JSON.stringify(rows)`, summed row by row so a list of
 * hundreds of MB is never serialized as one string.
 * @internal
 */
function jsonArrayBytes(rows: readonly GraphIndexFileReport[]): number {
  let bytes = 2 + Math.max(rows.length - 1, 0);
  for (const row of rows) bytes += Buffer.byteLength(JSON.stringify(row), 'utf8');
  return bytes;
}

/** @internal */
function countByStatus(rows: readonly GraphIndexFileReport[]): GraphIndexFileStatusCounts {
  const counts: GraphIndexFileStatusCounts = {
    analyzed: 0,
    excluded: 0,
    unsupported: 0,
    oversized: 0,
    failed: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/** @internal */
function pageFiles(
  rows: readonly GraphIndexFileReport[],
  request: AssessmentFilesRequest,
): GraphIndexFilePage {
  const matching = request.status ? rows.filter((row) => row.status === request.status) : rows;
  const offset = request.offset ?? 0;
  const size = request.limit ?? (request.all ? 0 : DEFAULT_ASSESSMENT_FILE_PAGE_SIZE);
  const end = size === 0 ? matching.length : Math.min(offset + size, matching.length);
  const page = matching.slice(offset, end);
  return {
    offset,
    limit: size === 0 ? null : size,
    ...(request.status ? { status: request.status } : {}),
    total: matching.length,
    returned: page.length,
    nextOffset: end < matching.length ? end : null,
    rows: page,
  };
}

/**
 * Project an assessment for `cleo nexus status`: counts plus one page of file rows.
 *
 * `files` is returned whole only for `{ all: true }` (or `limit: 0`) with no
 * offset or status filter. Every other request returns `filesPage` and names
 * `files` in `_withheld` with the full list's UTF-8 JSON size, so a consumer
 * never mistakes a page for the complete list.
 * @param assessment - The published assessment summary.
 * @param request - Which rows to return; the default is the first 20.
 * @returns The bounded projection.
 * @example
 * ```ts
 * const status = projectAssessmentFiles(assessment);
 * status.filesByStatus.failed; // gaps, without loading the list into the envelope
 * ```
 */
export function projectAssessmentFiles(
  assessment: GraphIndexAssessment,
  request: AssessmentFilesRequest = {},
): GraphIndexAssessmentProjection {
  const { files, ...rest } = assessment;
  const summary = { fileCount: files.length, filesByStatus: countByStatus(files) };
  const complete =
    (request.all === true || request.limit === 0) && !request.offset && !request.status;
  if (complete) return { ...rest, ...summary, files };
  return {
    _withheld: { files: jsonArrayBytes(files) },
    ...rest,
    ...summary,
    filesPage: pageFiles(files, request),
  };
}
