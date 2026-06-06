/**
 * Set / clear a doc's explicit DISPLAY ALIAS number — decoupled from the slug.
 *
 * ## Why this module exists
 *
 * Under the ratified slug-primary model (saga T11778, ADR reconcile T11676) the
 * kebab `slug` is the canonical handle and the rendered number (e.g. ADR "051")
 * is a DISPLAY ALIAS only. Until T11875 that number was DERIVED by parsing the
 * digits out of the slug string (`adr-051-*` → 051) — so three DISTINCT ADRs
 * that all slug as `adr-051-*` rendered the same "051" with no way to
 * disambiguate. The collision is unresolvable in a slug-primary world because
 * renumbering a slug would break the canonical handle.
 *
 * T11875 adds a real `attachments.display_alias` INTEGER column. This module is
 * the SDK chokepoint that sets it (and validates uniqueness among `type='adr'`
 * docs). {@link import('./numbering.js').resolveDisplayNumber} prefers the
 * stored alias when present and falls back to the slug-derived number when null.
 *
 * The transaction lives in CORE (not the CLI / dispatch layer) because:
 *   1. The CLI boundary gate forbids business logic > 30 LOC in CLI commands.
 *   2. The DB-open chokepoint (`openCleoDb` / `getNativeTasksDb`) is core-owned
 *      per ADR-068; raw `DatabaseSync` opens outside `store/` are rejected.
 *   3. Future callers (HTTP dispatch, MCP, BRAIN bridges) re-use the same
 *      entry point without re-implementing the all-or-nothing uniqueness check.
 *
 * @task T11875 (Epic T11781 / Saga T11778)
 * @adr ADR-078 — Docs Provenance Graph (display-alias half of T11676 reconcile)
 */

import { ExitCode } from '@cleocode/contracts';
import { CleoError } from '../errors.js';

/** Row shape projected from `attachments` during the set-alias transaction. */
interface AttachmentAliasRow {
  id: string;
  slug: string | null;
  type: string | null;
  display_alias: number | null;
}

/** Row shape for the per-type uniqueness scan. */
interface AliasConflictRow {
  slug: string | null;
}

/** Stable error code surfaced when the target slug does not resolve to a row. */
export const SET_ALIAS_NOT_FOUND_CODE = 'E_NOT_FOUND';
/** Stable error code surfaced when the requested number is already taken. */
export const SET_ALIAS_TAKEN_CODE = 'E_ALIAS_TAKEN';
/** Stable error code surfaced when the requested number is not a positive int. */
export const SET_ALIAS_INVALID_CODE = 'E_VALIDATION';

/**
 * Input to {@link setDisplayAlias} (ADR-057 uniform params shape).
 */
export interface SetDisplayAliasParams {
  /** Slug of the doc to alias (must resolve to an existing `attachments` row). */
  slug: string;
  /**
   * The display-alias number to assign. Must be a positive integer. Pass
   * `null` to CLEAR an existing alias (revert to slug-derived rendering).
   */
  displayAlias: number | null;
}

/**
 * Result returned by {@link setDisplayAlias}.
 */
export interface SetDisplayAliasResult {
  /** Echoed slug of the doc that was aliased. */
  slug: string;
  /** Resolved `attachments.id` of the aliased doc. */
  attachmentId: string;
  /** Doc kind (`type` column) of the aliased doc, echoed for the envelope. */
  type: string | null;
  /** The previous alias value (or `null` if none was set). */
  previousAlias: number | null;
  /** The newly-assigned alias value (or `null` when cleared). */
  displayAlias: number | null;
  /** ISO-8601 timestamp the transaction committed. */
  updatedAt: string;
}

/**
 * Assign (or clear) the explicit display-alias number for the doc identified by
 * `slug`, decoupled from the slug string.
 *
 * Effects (inside a single SQLite `BEGIN IMMEDIATE` transaction — all-or-none):
 *
 *   1. Resolve the row whose `slug` matches `params.slug`. `E_NOT_FOUND` when
 *      no such row exists.
 *   2. When assigning (non-null) AND the target doc is `type='adr'`, scan every
 *      OTHER `type='adr'` row for the same `display_alias`. Any conflict throws
 *      `E_ALIAS_TAKEN` and the transaction rolls back — numbers are unique among
 *      ADRs. Non-adr kinds skip the uniqueness check (they may reuse numbers).
 *   3. `UPDATE attachments SET display_alias = ? WHERE id = ?`.
 *
 * Uniqueness is enforced HERE (dispatch/SDK layer) rather than via a SQL UNIQUE
 * constraint because the constraint is scoped to a single `type` value — the
 * same discipline already used for `lifecycle_status` validation — so future
 * taxonomy changes never require a schema migration.
 *
 * Signature follows ADR-057 — `(projectRoot, params)` is the canonical shape for
 * core operations consumed by typed dispatch handlers and thin CLI verbs.
 *
 * @param projectRoot - Absolute project-root path. Production callers resolve it
 *   via `getProjectRoot()`; tests pass a temp dir.
 * @param params - {@link SetDisplayAliasParams}.
 * @returns {@link SetDisplayAliasResult} describing the before/after alias state.
 *
 * @throws {CleoError} `E_VALIDATION` when `displayAlias` is a non-positive /
 *   non-integer number.
 * @throws {CleoError} `E_NOT_FOUND` when `slug` resolves to no row.
 * @throws {CleoError} `E_ALIAS_TAKEN` when an ADR already owns the number.
 */
export async function setDisplayAlias(
  projectRoot: string,
  params: SetDisplayAliasParams,
): Promise<SetDisplayAliasResult> {
  const { slug, displayAlias } = params;

  if (displayAlias !== null && (!Number.isInteger(displayAlias) || displayAlias < 1)) {
    throw new CleoError(
      ExitCode.VALIDATION_ERROR,
      `display alias must be a positive integer — got '${String(displayAlias)}'`,
    );
  }

  // E6-L6 (T11526): `attachments` is part of the legacy drizzle-tasks family,
  // created inside the project `cleo.db` by getDb()'s migrations. Route through
  // getDb()/getNativeTasksDb() (rather than openCleoDb('project'), which only
  // runs the consolidated schema) so the table is guaranteed present. The native
  // handle is a shared singleton — do NOT close it here.
  const { getDb, getNativeTasksDb } = await import('../store/sqlite.js');
  await getDb(projectRoot);
  const db = getNativeTasksDb();
  if (!db) {
    throw new CleoError(
      ExitCode.GENERAL_ERROR,
      'docs set-alias: project cleo.db could not be opened (no native handle)',
    );
  }

  const now = new Date().toISOString();

  // BEGIN IMMEDIATE — acquire the write lock up front so two concurrent
  // set-alias calls contend at lock-acquisition time rather than after the
  // uniqueness scan (which would let both writers pass the check and collide).
  db.exec('BEGIN IMMEDIATE');

  let row: AttachmentAliasRow | undefined;
  try {
    row = db
      .prepare('SELECT id, slug, type, display_alias FROM attachments WHERE slug = ?')
      .get(slug) as AttachmentAliasRow | undefined;

    if (!row) {
      throw new CleoError(ExitCode.NOT_FOUND, `slug '${slug}' does not match any attachment row`);
    }

    // Uniqueness scan — only for ADRs, only when assigning a non-null number.
    if (displayAlias !== null && row.type === 'adr') {
      const conflict = db
        .prepare(
          "SELECT slug FROM attachments WHERE type = 'adr' AND display_alias = ? AND id <> ?",
        )
        .get(displayAlias, row.id) as AliasConflictRow | undefined;
      if (conflict) {
        throw new CleoError(
          ExitCode.VALIDATION_ERROR,
          `display alias ${displayAlias} is already assigned to ADR '${conflict.slug ?? '(unknown)'}' — ` +
            'pick a different number (aliases are unique among type=adr docs)',
          {
            details: {
              field: 'displayAlias',
              code: SET_ALIAS_TAKEN_CODE,
              actual: displayAlias,
              conflictingSlug: conflict.slug,
            },
          },
        );
      }
    }

    db.prepare('UPDATE attachments SET display_alias = ? WHERE id = ?').run(displayAlias, row.id);

    db.exec('COMMIT');
  } catch (txErr) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Rollback is best-effort — propagating the original error matters more.
    }
    throw txErr;
  }

  return {
    slug,
    attachmentId: row.id,
    type: row.type,
    previousAlias: row.display_alias,
    displayAlias,
    updatedAt: now,
  };
}
