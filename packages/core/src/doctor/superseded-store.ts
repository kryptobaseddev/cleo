/**
 * Detect pre-dual-scope store files left on disk under their old LIVE names.
 *
 * ## The failure this exists to stop (T12095)
 *
 * Before the E6 dual-scope migration (ADR-068), a project's task database was
 * `.cleo/tasks.db`. Afterwards it is `.cleo/cleo.db`, and task rows live in
 * PREFIXED tables (`tasks_tasks`, `tasks_sessions`, …) rather than bare `tasks`.
 * The migration does not delete the old file, so a migrated project has
 *
 *     .cleo/cleo.db     60 MB   modified today      ← the real store
 *     .cleo/tasks.db   408 KB   modified in June    ← superseded, still named
 *                                                     as though it were live
 *
 * Three separate things then point an agent at the wrong file:
 *
 * 1. The old name is the one every doc, ADR-013 §9 note and `cleo restore
 *    backup --file tasks.db` invocation still says out loud.
 * 2. Snapshots are written as `.cleo/backups/sqlite/tasks-<ts>.db` even though
 *    they are snapshots of `cleo.db`. So the superseded 408 KB file sits beside
 *    58 MB files bearing its own name — which reads unmistakably as truncation.
 * 3. `cleo.db` ALSO contains a bare, empty `tasks` table next to the populated
 *    `tasks_tasks`. Any direct SQL probe finds the empty decoy.
 *
 * Measured on 2026-08-09: an agent in a healthy project with 1,123 tasks looped
 * on "the current tasks.db is 417KB which is much smaller than the backups
 * (58MB) — maybe it was rotated/rebuilt", then began theorising that the real
 * store might be `llmtxt.db`. Nothing was wrong with the data. The layout
 * manufactured a corruption signal, and the agent believed it over the CLI.
 *
 * This check names the file, proves which store is authoritative by counting
 * rows in both, and says what to do — so the question is answered in one call
 * instead of becoming an investigation.
 *
 * @task T12095
 * @see ADR-068 — dual-scope DB chokepoint
 */

import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A store file that has been superseded by `cleo.db` but still exists under the
 * name that used to mean "the live database".
 */
export interface SupersededStoreEntry {
  /** Absolute path of the superseded file. */
  readonly path: string;
  /** Bare filename, e.g. `tasks.db`. */
  readonly name: string;
  /** Size in bytes. */
  readonly sizeBytes: number;
  /** Last modification time, ISO 8601. */
  readonly modifiedAt: string;
  /**
   * Rows found in the superseded file's own task table, if it has one.
   * `null` when the file has no such table or could not be read. A 0-byte
   * file yields `0`, never `null` — an empty file holds zero rows by
   * definition (T12099).
   */
  readonly rowsInSuperseded: number | null;
  /** Rows found in the LIVE store's prefixed table. */
  readonly rowsInLive: number | null;
  /**
   * Rows of the superseded table whose `id` is ABSENT from the live table —
   * what `--reconcile` would still copy. `0` means every row is already in
   * `cleo.db`; `null` means the comparison could not be made (T12319).
   */
  readonly missingInLive: number | null;
  /**
   * True when the live store demonstrably holds the data and this file does
   * not — i.e. it is safe to archive. False keeps the entry but withholds the
   * recommendation, because "delete the other database" must never be advised
   * on a guess.
   */
  readonly safeToArchive: boolean;
  /** Human-readable justification, suitable for printing verbatim. */
  readonly reason: string;
}

/** Result of {@link scanSupersededStores}. */
export interface SupersededStoreScanResult {
  /** Absolute project root that was scanned. */
  readonly projectRoot: string;
  /** Absolute path of the live dual-scope store. */
  readonly liveStorePath: string;
  /** Whether the live store exists — when false, nothing is superseded. */
  readonly liveStoreExists: boolean;
  /** Superseded files found, newest-modified first. */
  readonly entries: readonly SupersededStoreEntry[];
}

/**
 * Legacy store filenames paired with the live table that replaced their
 * contents. The bare table name is the pre-migration one; the prefixed name is
 * where the rows live now.
 */
const SUPERSEDED_STORES: readonly {
  readonly file: string;
  readonly bareTable: string;
  readonly liveTable: string;
}[] = [
  { file: 'tasks.db', bareTable: 'tasks', liveTable: 'tasks_tasks' },
  { file: 'brain.db', bareTable: 'brain_observations', liveTable: 'brain_observations' },
] as const;

/** The dual-scope store filename (ADR-068). */
export const LIVE_STORE_FILENAME = 'cleo.db';

/**
 * Count rows in a table, or `null` when the table or file is unreadable.
 *
 * Read-only and never throws: a superseded file may be truncated, locked, or
 * not even SQLite, and none of that should break the survey.
 */
function countRows(dbPath: string, table: string): number | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    // db-open-allowed: read-only forensic probe of a SUPERSEDED file no accessor owns — routing it through the chokepoint would register a live handle for the very store we are proving is dead
    db = new DatabaseSync(dbPath, { readOnly: true }); // db-open-allowed: read-only probe of a superseded, unowned file
    const exists = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?")
      .get(table);
    if (exists === undefined) return null;
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as
      | { c: number }
      | undefined;
    return row?.c ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/**
 * Count rows of `supersededPath#bareTable` whose `id` is absent from
 * `livePath#liveTable`, or `null` when either side cannot be read.
 *
 * Read-only: the live file is opened `readOnly` and the superseded file is
 * ATTACHed to that connection, which SQLite opens read-only as well.
 */
function countMissingById(
  livePath: string,
  supersededPath: string,
  bareTable: string,
  liveTable: string,
): number | null {
  let db: DatabaseSync | null = null;
  try {
    // db-open-allowed: read-only forensic comparison of a SUPERSEDED file against the live store (same rationale as countRows)
    db = new DatabaseSync(livePath, { readOnly: true }); // db-open-allowed: read-only probe of a superseded, unowned file
    db.exec(`ATTACH DATABASE '${supersededPath.replace(/'/g, "''")}' AS superseded`);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS c FROM superseded."${bareTable}" s ` +
          `WHERE NOT EXISTS (SELECT 1 FROM main."${liveTable}" l WHERE l.id = s.id)`,
      )
      .get() as { c: number } | undefined;
    return row?.c ?? null;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed or never opened */
    }
  }
}

/** The supported command that copies stranded rows into `cleo.db` (T12319). */
export const SUPERSEDED_STORE_RECONCILE_COMMAND = 'cleo doctor superseded-store --reconcile';

/**
 * Scan a project for store files superseded by `cleo.db`.
 *
 * Read-only — deletes nothing and opens nothing for write. The caller decides
 * what to do with the recommendation.
 *
 * @param projectRoot - absolute path to the project root.
 * @returns the survey; `entries` is empty for a project that never migrated or
 *   that has already been tidied.
 *
 * @example
 * ```ts
 * const scan = scanSupersededStores('/mnt/projects/PepsVida');
 * for (const e of scan.entries) console.log(e.name, e.reason);
 * // tasks.db  superseded by cleo.db: 0 rows here vs 1123 in cleo.db#tasks_tasks …
 * ```
 *
 * @task T12095
 */
export function scanSupersededStores(projectRoot: string): SupersededStoreScanResult {
  const liveStorePath = join(projectRoot, '.cleo', LIVE_STORE_FILENAME);
  const liveStoreExists = existsSync(liveStorePath);

  if (!liveStoreExists) {
    // No dual-scope store means nothing has been superseded — a pre-migration
    // project's `tasks.db` IS its live database and must not be flagged.
    return { projectRoot, liveStorePath, liveStoreExists: false, entries: [] };
  }

  const liveMtimeMs = statSync(liveStorePath).mtimeMs;
  const entries: SupersededStoreEntry[] = [];

  for (const { file, bareTable, liveTable } of SUPERSEDED_STORES) {
    const path = join(projectRoot, '.cleo', file);
    if (!existsSync(path)) continue;

    const stat = statSync(path);
    // A file NEWER than cleo.db is not obviously dead — say nothing rather than
    // risk advising removal of something still being written.
    if (stat.mtimeMs >= liveMtimeMs) continue;

    // A 0-byte file holds zero rows BY DEFINITION — bypass countRows, which
    // would return null (nothing to open) and manufacture the "unknown number
    // of rows" corruption signal this check exists to kill (T12099). `null`
    // remains reserved for a NONZERO file that could not be read.
    const rowsInSuperseded = stat.size === 0 ? 0 : countRows(path, bareTable);
    const rowsInLive = countRows(liveStorePath, liveTable);
    // `rowsInSuperseded === 0` must be EXPLICIT, never `?? 0`. `null` means the
    // file could not be read — corrupt, locked, truncated, or not SQLite — and
    // "I could not read it" is not "it is empty". Coalescing the two would
    // recommend archiving precisely the file whose contents are unknown, which
    // is the one case where being wrong loses data.
    // T12319: a file whose every row is already in cleo.db (reconciled) is
    // equally dead — proven by key, never by a count comparison.
    const missingInLive =
      stat.size === 0 ? 0 : countMissingById(liveStorePath, path, bareTable, liveTable);
    const safeToArchive = (rowsInLive ?? 0) > 0 && (rowsInSuperseded === 0 || missingInLive === 0);

    let reason: string;
    if (stat.size === 0 && safeToArchive) {
      reason =
        `${file} is 0 bytes — an empty file holds zero rows by definition, so there is ` +
        `nothing to reconcile. The live store ${LIVE_STORE_FILENAME}#${liveTable} holds ` +
        `${rowsInLive} rows. Safe to archive.`;
    } else if (safeToArchive && rowsInSuperseded !== 0) {
      reason =
        `every one of the ${rowsInSuperseded} rows in ${file}#${bareTable} is already present in ` +
        `${LIVE_STORE_FILENAME}#${liveTable} (${rowsInLive} rows) — reconciled. Safe to archive.`;
    } else if (safeToArchive) {
      reason =
        `superseded by ${LIVE_STORE_FILENAME}: ${rowsInSuperseded ?? 0} rows in ${file}#${bareTable} ` +
        `vs ${rowsInLive} in ${LIVE_STORE_FILENAME}#${liveTable}. Last written ` +
        `${stat.mtime.toISOString().slice(0, 10)}, while ${LIVE_STORE_FILENAME} was written ` +
        `${new Date(liveMtimeMs).toISOString().slice(0, 10)}. Its name is the one the docs and ` +
        `\`cleo restore backup --file tasks.db\` still say, and snapshots are named ` +
        `\`tasks-<ts>.db\` even though they snapshot ${LIVE_STORE_FILENAME} — so this file reads ` +
        `as a truncated live DB when it is simply the pre-migration one.`;
    } else {
      reason =
        `predates ${LIVE_STORE_FILENAME} but still holds ${rowsInSuperseded ?? 'an unknown number of'} ` +
        `rows in ${bareTable} (live ${liveTable}: ${rowsInLive ?? 'unreadable'}; ` +
        `${missingInLive ?? 'an unknown number of'} missing from it). NOT recommended for removal. ` +
        `Preview the copy with \`${SUPERSEDED_STORE_RECONCILE_COMMAND} --dry-run\`, then run ` +
        `\`${SUPERSEDED_STORE_RECONCILE_COMMAND}\` to copy the missing rows into ` +
        `${LIVE_STORE_FILENAME} (additive, verified, legacy file left in place).`;
    }

    entries.push({
      path,
      name: file,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      rowsInSuperseded,
      rowsInLive,
      missingInLive,
      safeToArchive,
      reason,
    });
  }

  entries.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
  return { projectRoot, liveStorePath, liveStoreExists: true, entries };
}
