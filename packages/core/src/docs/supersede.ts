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

import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import { and, eq, ne, or } from 'drizzle-orm';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { CleoError } from '../errors.js';
import { docsAttachments } from '../store/tasks-schema.js';
import { assertTwinCollapseWritable } from '../store/twin-collapse.js';

/**
 * Move a doc's supersession edges with its slug, from the registry row that
 * held the slug to the row that holds it now (T14565).
 *
 * `supersedes` / `superseded_by` name registry rows, and a registry row is one
 * version of a doc: `docs update` (and its modernize undo) moves the slug onto
 * another row. The edges belong to the doc, so every writer that moves a slug
 * between rows calls this in the same transaction:
 *
 * 1. the row now holding the slug takes the outgoing `supersedes` pointer of
 *    the row that held it;
 * 2. a superseded doc stays superseded: when the row that held the slug is
 *    `superseded`, the row holding it now takes that status and the successor
 *    together (one merge group), so it is never left a draft with a successor;
 *    otherwise it carries no successor;
 * 3. every other row pointing at the old row points at the new one;
 * 4. the old row gives its pointers up. It is a blob version now, with no
 *    slug: a doc added later with the same bytes takes that row, and must not
 *    inherit another doc's edges.
 *
 * A pointer is never set to the row it sits on. Call once per slug transfer.
 *
 * The caller mirrors the identity rows afterwards
 * (`mirrorConduitDocMeta`): the new row's doc and each returned row's doc.
 *
 * @param db - The project store handle, or the caller's open transaction.
 * @param fromRowId - `docs_attachments.id` of the row that held the slug.
 * @param toRowId - `docs_attachments.id` of the row that holds it now.
 * @returns The ids of the other rows whose pointer was moved.
 * @task T14565
 */
// @sync-side-effect docs.supersession.follows-slug the edges of the row that held the slug move to the row that holds it now (a superseded doc keeps its status and successor together), every row naming the old one is re-pointed and the old row gives its pointers up, in the caller's transaction (T14565)
export function rehomeSupersessionEdges(
  db: NodeSQLiteDatabase,
  fromRowId: string,
  toRowId: string,
): string[] {
  if (fromRowId === toRowId) return [];
  const edges = {
    lifecycleStatus: docsAttachments.lifecycleStatus,
    supersedes: docsAttachments.supersedes,
    supersededBy: docsAttachments.supersededBy,
  };
  const rowOf = (id: string) =>
    db.select(edges).from(docsAttachments).where(eq(docsAttachments.id, id)).get();
  const held = rowOf(fromRowId);
  const now = rowOf(toRowId);
  if (!held || !now) return [];

  const notSelf = (id: string | null): string | null => (id === toRowId ? null : id);
  const supersedes = notSelf(held.supersedes ?? null);
  // The status and its successor travel together (docs.lifecycle.transitions):
  // a superseded doc stays superseded, with its successor, on the row that
  // takes its slug.
  const superseded = held.lifecycleStatus === 'superseded';
  const lifecycleStatus = superseded ? 'superseded' : now.lifecycleStatus;
  const supersededBy = superseded ? notSelf(held.supersededBy ?? null) : null;
  if (
    (now.supersedes ?? null) !== supersedes ||
    (now.supersededBy ?? null) !== supersededBy ||
    now.lifecycleStatus !== lifecycleStatus
  ) {
    db.update(docsAttachments)
      .set({ supersedes, supersededBy, lifecycleStatus })
      .where(eq(docsAttachments.id, toRowId))
      .run();
  }

  const incoming = repointIncomingSupersessionEdges(db, fromRowId, toRowId);
  if (held.supersedes != null || held.supersededBy != null) {
    db.update(docsAttachments)
      .set({ supersedes: null, supersededBy: null })
      .where(eq(docsAttachments.id, fromRowId))
      .run();
  }
  return incoming;
}

/**
 * Repoint incoming supersession to an existing live row without changing its outgoing edges.
 *
 * @param db - The caller's transaction handle.
 * @param fromRowId - The version row being retired or reused.
 * @param toRowId - The existing row holding that document's live slug.
 * @returns The ids of rows whose pointer moved; callers mirror their doc metadata.
 * @internal
 */
// @sync-side-effect docs.supersession.follows-slug incoming edges keep naming the same document when its retired content row is reused (T14580)
export function repointIncomingSupersessionEdges(
  db: NodeSQLiteDatabase,
  fromRowId: string,
  toRowId: string,
): string[] {
  if (fromRowId === toRowId) return [];
  const others = ne(docsAttachments.id, toRowId);
  const incoming = db
    .select({ id: docsAttachments.id })
    .from(docsAttachments)
    .where(
      and(
        others,
        or(eq(docsAttachments.supersedes, fromRowId), eq(docsAttachments.supersededBy, fromRowId)),
      ),
    )
    .all();
  if (incoming.length > 0) {
    db.update(docsAttachments)
      .set({ supersedes: toRowId })
      .where(and(others, eq(docsAttachments.supersedes, fromRowId)))
      .run();
    db.update(docsAttachments)
      .set({ supersededBy: toRowId })
      .where(and(others, eq(docsAttachments.supersededBy, fromRowId)))
      .run();
  }
  return incoming.map((row) => row.id);
}

/** Row shape projected from `docs_attachments` during the supersede transaction. */
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
  const { reason } = params;
  const cwd = projectRoot;
  // T14288: either slug may be an old alias; resolve each to its doc's live slug.
  const { resolveDocRef } = await import('./slug-rename.js');
  const oldSlug = (await resolveDocRef(cwd, params.oldSlug))?.slug ?? params.oldSlug;
  const newSlug = (await resolveDocRef(cwd, params.newSlug))?.slug ?? params.newSlug;

  if (oldSlug === newSlug) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `oldSlug and newSlug must differ — got '${oldSlug}' for both`,
    );
  }

  // E6-L6 (T11526): the `attachments` table is part of the legacy drizzle-tasks
  // family, created inside the project `cleo.db` by getDb()'s migrations. Route
  // through getDb()/getNativeTasksDb() (rather than openCleoDb('project'), which
  // only runs the consolidated schema) so the table is guaranteed present. The
  // native handle is a shared singleton — do NOT close it here.
  const { getDb, getNativeTasksDb } = await import('../store/sqlite.js');
  await getDb(cwd);
  const db = getNativeTasksDb(cwd);
  if (!db) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'docs supersede: project cleo.db could not be opened (no native handle)',
    );
  }
  // T12535: fail fast on a store degraded by a failed twin collapse.
  assertTwinCollapseWritable(db, 'attachments');
  {
    const now = new Date().toISOString();

    // BEGIN IMMEDIATE — acquire the write lock up front so two concurrent
    // supersedes contend at lock-acquisition time rather than after running
    // the lookups (which would corrupt the latest-wins invariant).
    db.exec('BEGIN IMMEDIATE');

    let oldRow: AttachmentSupersedeRow | undefined;
    let newRow: AttachmentSupersedeRow | undefined;

    try {
      const lookup = db.prepare(
        'SELECT id, slug, lifecycle_status, supersedes, superseded_by FROM docs_attachments WHERE slug = ?',
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
        "UPDATE docs_attachments SET lifecycle_status = 'superseded', superseded_by = ? WHERE id = ?",
      ).run(newRow.id, oldRow.id);

      db.prepare('UPDATE docs_attachments SET supersedes = ? WHERE id = ?').run(
        oldRow.id,
        newRow.id,
      );

      // T14288: both docs' identity rows carry the supersession, in this transaction.
      const { mirrorConduitDocMeta } = await import('../store/conduit-doc-history.js');
      await mirrorConduitDocMeta(cwd, { rowId: oldRow.id });
      await mirrorConduitDocMeta(cwd, { rowId: newRow.id });

      db.exec('COMMIT');
    } catch (txErr) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Rollback is best-effort — propagating the original error matters more.
      }
      throw txErr;
    }

    // T13357: refresh the wikilinks edge table so the new supersedes pair
    // shows up as graph edges. Best-effort — the supersede itself committed.
    try {
      const { rebuildDocsWikilinks } = await import('./wikilinks.js');
      await rebuildDocsWikilinks({ projectRoot });
    } catch (rebuildErr) {
      // T13711: drizzle interpolates the full SQL + params into err.message
      // (~900 KB on axiom-app) — warn with the bounded driver cause, never the
      // parameter dump.
      const { boundedErrorMessage } = await import('../lib/error-message.js');
      process.emitWarning(
        `docs wikilinks rebuild failed after supersede ${oldSlug} -> ${newSlug}: ${boundedErrorMessage(rebuildErr)}`,
      );
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
  }
}
