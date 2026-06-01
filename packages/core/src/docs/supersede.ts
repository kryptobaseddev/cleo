/**
 * Atomic doc supersession — flip an older doc to `lifecycle_status='superseded'`
 * and link both rows via the `supersedes` / `superseded_by` self-FK pointers
 * shipped by the T10158 migration.
 *
 * The transaction lives here (not in the CLI or dispatch layer) because:
 *
 * 1. The boundary contract forbids business logic > 30 LOC in CLI commands
 *    (`scripts/lint-cli-package-boundary.mjs`).
 * 2. The DB-open chokepoint (`openCleoDb`) is core-owned per ADR-068 and the
 *    `lint-no-direct-db-open` gate rejects raw `DatabaseSync` opens outside
 *    `packages/core/src/store/`. Doing the open here keeps both gates green.
 * 3. Future callers (HTTP dispatch, MCP, BRAIN bridges) can re-use the same
 *    SDK entry point without re-implementing the all-or-nothing semantics.
 *
 * The supersession edge surfaced to readers (`cleo docs provenance`, T10166)
 * is reconstructed at read time from the FK columns — no dedicated edges
 * table exists. The deterministic `edgeId` returned here
 * (`supersedes:<newId>-><oldId>`) lets concurrent callers that win the race
 * observe a stable identifier and lets future provenance reads quote the
 * same handle.
 *
 * @task T10162
 * @epic T10157 — C-DOCS-SSOT
 * @saga T9855 — SG-TEMPLATE-CONFIG-SSOT
 * @adr ADR-078 — Docs Provenance Graph
 */

import type { DatabaseSync } from 'node:sqlite';
import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';
import { openCleoDb } from '../store/open-cleo-db.js';

/** Row shape projected from `attachments` during the supersede transaction. */
interface AttachmentSupersedeRow {
  id: string;
  slug: string | null;
  lifecycle_status: string;
  supersedes: string | null;
  superseded_by: string | null;
}

/** Stable error code surfaced on the LAFS envelope when a slug is unknown. */
export const SUPERSEDE_NOT_FOUND_CODE = 'E_NOT_FOUND';
/** Stable error code surfaced when the same slug is given on both sides. */
export const SUPERSEDE_SAME_SLUG_CODE = 'E_INVALID_INPUT';

/** Input to {@link supersedeDoc} (ADR-057 uniform params shape). */
export interface SupersedeDocParams {
  /** Slug of the doc being replaced (must resolve to an existing row). */
  oldSlug: string;
  /** Slug of the doc that replaces {@link oldSlug} (must resolve to a row). */
  newSlug: string;
  /** Optional human-readable reason carried back on the response only. */
  reason?: string;
}

/**
 * Legacy input alias — kept for older callers that named the type
 * `SupersedeDocInput`. Prefer {@link SupersedeDocParams}.
 *
 * @deprecated
 */
export type SupersedeDocInput = SupersedeDocParams;

/** Result returned by {@link supersedeDoc}. */
export interface SupersedeDocResult {
  /** Echoed input slug for the older doc. */
  oldSlug: string;
  /** Echoed input slug for the newer doc. */
  newSlug: string;
  /** Resolved `attachments.id` for the older doc. */
  oldAttachmentId: string;
  /** Resolved `attachments.id` for the newer doc. */
  newAttachmentId: string;
  /** ISO-8601 timestamp the transaction committed. */
  supersededAt: string;
  /** Deterministic lineage handle (`supersedes:<newId>-><oldId>`). */
  edgeId: string;
  /** Echo of {@link SupersedeDocInput.reason}, when provided. */
  reason?: string;
}

/**
 * Build the deterministic edge identifier surfaced on the supersede response.
 *
 * The identifier intentionally embeds both attachment IDs so that callers
 * who only have the response envelope can reconstruct the supersession edge
 * without a second read. The format mirrors the
 * `ProvenanceEdge.relation/from/to` triple (T10166).
 */
function makeEdgeId(newAttachmentId: string, oldAttachmentId: string): string {
  return `supersedes:${newAttachmentId}->${oldAttachmentId}`;
}

/**
 * Atomically supersede {@link SupersedeDocParams.oldSlug} with
 * {@link SupersedeDocParams.newSlug}.
 *
 * Effects (inside a single SQLite immediate-write transaction):
 *
 * 1. Set `attachments.lifecycle_status = 'superseded'` on the row whose slug
 *    matches `oldSlug`.
 * 2. Set `attachments.superseded_by = <newAttachmentId>` on the same row.
 *    (Latest-wins overwrite — a previously-recorded successor is replaced.)
 * 3. Set `attachments.supersedes = <oldAttachmentId>` on the row whose slug
 *    matches `newSlug`.
 *
 * Either ALL three writes commit or NONE do. The transaction is `BEGIN
 * IMMEDIATE` so a concurrent supersession attempt against the same `oldSlug`
 * fails with `SQLITE_BUSY` rather than racing past the integrity check.
 *
 * Signature follows ADR-057 — `(projectRoot, params)` is the canonical shape
 * for core operations consumed by typed dispatch handlers.
 *
 * @param projectRoot - Absolute project-root path. Resolved by the dispatch
 *   layer via {@link getProjectRoot} for production callers; tests pass a
 *   temp dir.
 * @param params - {@link SupersedeDocParams}.
 *
 * @throws {CleoError} `E_NOT_FOUND` when either slug does not resolve to a row.
 * @throws {CleoError} `E_INVALID_INPUT` when `oldSlug === newSlug`.
 */
export async function supersedeDoc(
  projectRoot: string,
  params: SupersedeDocParams,
): Promise<SupersedeDocResult> {
  const { oldSlug, newSlug, reason } = params;
  const cwd = projectRoot;

  if (oldSlug === newSlug) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `oldSlug and newSlug must differ — got '${oldSlug}' for both`,
    );
  }

  const handle = await openCleoDb('project', cwd);
  try {
    const db = handle.db as DatabaseSync;
    const now = new Date().toISOString();

    // BEGIN IMMEDIATE — acquire the write lock up front so two concurrent
    // supersedes contend at lock-acquisition time rather than after running
    // the lookups (which would corrupt the latest-wins invariant).
    db.exec('BEGIN IMMEDIATE');

    let oldRow: AttachmentSupersedeRow | undefined;
    let newRow: AttachmentSupersedeRow | undefined;

    try {
      const lookup = db.prepare(
        'SELECT id, slug, lifecycle_status, supersedes, superseded_by FROM attachments WHERE slug = ?',
      );
      oldRow = lookup.get(oldSlug) as AttachmentSupersedeRow | undefined;
      newRow = lookup.get(newSlug) as AttachmentSupersedeRow | undefined;

      if (!oldRow) {
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `oldSlug '${oldSlug}' does not match any attachment row`,
        );
      }
      if (!newRow) {
        throw new CleoError(
          ExitCode.NOT_FOUND,
          `newSlug '${newSlug}' does not match any attachment row`,
        );
      }

      db.prepare(
        "UPDATE attachments SET lifecycle_status = 'superseded', superseded_by = ? WHERE id = ?",
      ).run(newRow.id, oldRow.id);

      db.prepare('UPDATE attachments SET supersedes = ? WHERE id = ?').run(oldRow.id, newRow.id);

      db.exec('COMMIT');
    } catch (txErr) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback is best-effort — propagating the original error matters more.
      }
      throw txErr;
    }

    const edgeId = makeEdgeId(newRow.id, oldRow.id);

    const result: SupersedeDocResult = {
      oldSlug,
      newSlug,
      oldAttachmentId: oldRow.id,
      newAttachmentId: newRow.id,
      supersededAt: now,
      edgeId,
    };
    if (reason !== undefined) result.reason = reason;
    return result;
  } finally {
    await handle.close();
  }
}
