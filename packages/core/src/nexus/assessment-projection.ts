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

import type {
  GraphIndexAssessment,
  GraphIndexAssessmentProjection,
  GraphIndexFilePage,
  GraphIndexFileReport,
  GraphIndexFileStatus,
  GraphIndexFileStatusCounts,
  GraphIndexReferenceKind,
  GraphIndexReferenceKindCounts,
  GraphIndexReferencePage,
  GraphIndexReferenceReport,
} from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
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
    // @sync-invariant none:input-shape a malformed CLI flag is refused before any read; nothing is written
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
    // @sync-invariant none:input-shape a malformed CLI flag is refused before any read; nothing is written
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

/** References in the default page of `assessment.referencesPage` (T13330). */
export const DEFAULT_REFERENCE_PAGE_SIZE = 20;

/**
 * Largest reference page one status call returns (T13330).
 *
 * A reference is ~700 B of JSON, so this bounds a page near 3.5 MB however
 * large the repository; the whole list is walked with `nextOffset`.
 */
export const MAX_REFERENCE_PAGE_SIZE = 5_000;

/**
 * Zero count for every reference kind. Typed as the contract's
 * `Record<kind, number>`, so the compiler rejects a missing or unknown kind:
 * the kind list below is derived from it and cannot drift from the contract.
 */
const EMPTY_REFERENCE_KIND_COUNTS: Readonly<GraphIndexReferenceKindCounts> = {
  'unmodeled-source': 0,
  ambiguous: 0,
  external: 0,
  dynamic: 0,
  shadowed: 0,
  unresolved: 0,
};

/** Whether `value` names a contract reference kind. */
function isReferenceKind(value: string): value is GraphIndexReferenceKind {
  return Object.hasOwn(EMPTY_REFERENCE_KIND_COUNTS, value);
}

/** Every reference limitation kind, derived from the contract's kind counts. */
export const GRAPH_INDEX_REFERENCE_KINDS: readonly GraphIndexReferenceKind[] = Object.keys(
  EMPTY_REFERENCE_KIND_COUNTS,
).filter(isReferenceKind);

/** Which references a status projection returns (T13330). */
export interface ReferencePageRequest {
  /** Page size, 1 to {@link MAX_REFERENCE_PAGE_SIZE}. */
  limit: number;
  /** References to skip before the page. */
  offset: number;
  /** Page only references of this kind. */
  kind?: GraphIndexReferenceKind;
}

/** Raw CLI flag values accepted by {@link parseReferencePageRequest}. */
export interface ReferencePageFlags {
  /** `--references-limit`. */
  limit?: string;
  /** `--references-offset`. */
  offset?: string;
  /** `--reference-kind`. */
  kind?: string;
}

/** A page of references read from the published generation, with whole-list totals. */
export interface ReferencePageResult {
  /** References per kind across the whole list. */
  byKind: GraphIndexReferenceKindCounts;
  /** The requested page. */
  page: GraphIndexReferencePage;
  /** UTF-8 size of the whole list as one JSON array. */
  bytes: number;
}

/**
 * Validate `cleo nexus status --references` paging flags (T13330).
 * @param flags - Raw flag values as the CLI received them.
 * @returns The validated request; a 20-reference first page by default.
 * @throws CleoError with `INVALID_INPUT` for a malformed or out-of-range count or an unknown kind.
 * @example
 * ```ts
 * parseReferencePageRequest({ limit: '500', offset: '1000', kind: 'unresolved' });
 * ```
 */
export function parseReferencePageRequest(flags: ReferencePageFlags): ReferencePageRequest {
  const kind = flags.kind?.trim();
  if (kind !== undefined && !GRAPH_INDEX_REFERENCE_KINDS.some((known) => known === kind))
    // @sync-invariant none:input-shape a malformed CLI flag is refused before any read; nothing is written
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `--reference-kind must be one of ${GRAPH_INDEX_REFERENCE_KINDS.join(', ')}`,
      {
        fix: 'cleo nexus status --references --reference-kind unresolved',
        details: { field: 'reference-kind', actual: kind },
      },
    );
  const limit = parseCount('references-limit', flags.limit) ?? DEFAULT_REFERENCE_PAGE_SIZE;
  if (limit < 1 || limit > MAX_REFERENCE_PAGE_SIZE)
    // @sync-invariant none:input-shape a malformed CLI flag is refused before any read; nothing is written
    throw new CleoError(
      ExitCode.INVALID_INPUT,
      `--references-limit must be from 1 to ${MAX_REFERENCE_PAGE_SIZE}; walk the whole list ` +
        'with --references-offset <referencesPage.nextOffset>',
      {
        fix: `cleo nexus status --references --references-limit ${MAX_REFERENCE_PAGE_SIZE} --references-offset 0`,
        details: { field: 'references-limit', actual: flags.limit },
      },
    );
  return {
    limit,
    offset: parseCount('references-offset', flags.offset) ?? 0,
    ...(kind === undefined
      ? {}
      : { kind: GRAPH_INDEX_REFERENCE_KINDS.find((known) => known === kind) }),
  };
}

/**
 * Attach a reference page to a status projection (T13330).
 *
 * `references` is never placed in the projection: it is named in `_withheld`
 * with the whole list's UTF-8 JSON size, beside the per-kind counts and the
 * requested page, so a consumer never mistakes a page for the complete list.
 * @param projection - The bounded status projection.
 * @param result - The page and totals read from the published generation.
 * @returns The projection with `referencesByKind` and `referencesPage`.
 * @example
 * ```ts
 * const status = withReferencePage(projectAssessmentFiles(summary), page);
 * ```
 */
export function withReferencePage(
  projection: GraphIndexAssessmentProjection,
  result: ReferencePageResult,
): GraphIndexAssessmentProjection {
  const { references: _references, ...rest } = projection;
  return {
    ...rest,
    _withheld: { ...projection._withheld, references: result.bytes },
    referencesByKind: result.byKind,
    referencesPage: result.page,
  };
}

/** How {@link pageReferences} reads one stored reference. */
export interface ReferenceReaders {
  /** The reference's kind, validated; called for every reference. */
  kind: (item: unknown) => GraphIndexReferenceKind;
  /** The fully validated reference; called only for rows in the page. */
  row: (item: unknown) => GraphIndexReferenceReport;
}

/**
 * Fold a stream of stored references into one page plus whole-list totals (T13330).
 *
 * Every reference is counted by kind and then dropped; only the rows of the
 * requested page are kept. Memory is therefore bounded by the page whatever
 * the length of the list — 846 151 references on one repository.
 * @param items - Stored references in stored order, with their JSON sizes.
 * @param request - Page size, offset and optional kind filter.
 * @param readers - Validation for a reference's kind and for a page row.
 * @returns The page, per-kind counts, whole-list JSON size and reference count.
 * @example
 * ```ts
 * const result = await pageReferences(streamStoredReferences(blob), request, readers);
 * ```
 */
export async function pageReferences(
  items:
    | AsyncIterable<{ item: unknown; bytes: number }>
    | Iterable<{ item: unknown; bytes: number }>,
  request: ReferencePageRequest,
  readers: ReferenceReaders,
): Promise<ReferencePageResult & { count: number }> {
  const byKind: GraphIndexReferenceKindCounts = { ...EMPTY_REFERENCE_KIND_COUNTS };
  const rows: GraphIndexReferenceReport[] = [];
  let count = 0;
  let matching = 0;
  let bytes = 0;
  for await (const { item, bytes: size } of items) {
    const kind = readers.kind(item);
    byKind[kind] += 1;
    count += 1;
    bytes += size;
    if (request.kind !== undefined && kind !== request.kind) continue;
    if (matching >= request.offset && rows.length < request.limit) rows.push(readers.row(item));
    matching += 1;
  }
  const end = Math.min(request.offset + request.limit, matching);
  return {
    count,
    byKind,
    bytes: bytes + 2 + Math.max(count - 1, 0),
    page: {
      offset: request.offset,
      limit: request.limit,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      total: matching,
      returned: rows.length,
      nextOffset: end < matching ? end : null,
      rows,
    },
  };
}
