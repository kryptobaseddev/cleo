/**
 * DB-substrate survey primitives for `cleo doctor db-substrate`.
 *
 * Walks every entry in the `DB_INVENTORY` SSoT (`@cleocode/contracts`),
 * resolves each entry's `filePathTemplate` to an on-disk path, and
 * reports integrity, recent-write timestamp, file size, and up to 3
 * representative row counts per role.
 *
 * Two modes:
 *
 *   - `surveyProjectDbSubstrate(projectRoot)` — survey one project plus
 *     the global tier of databases.
 *   - `surveyFleetDbSubstrate(fleetRoot)` — walk every immediate
 *     subdirectory of `fleetRoot` that contains a `.cleo/` and survey
 *     each as a project. Surfaces orphan-project-root +
 *     nested-nexus-duplicate warnings (T9550 regression class) that the
 *     fleet survey detects en route.
 *
 * Path resolution honours the inventory's `<projectRoot>` and
 * `$XDG_DATA_HOME` tokens via `@cleocode/paths` (`getCleoHome`). All
 * DB opens flow through `openCleoDbSnapshot` (in `packages/core/src/store/`,
 * therefore inside the `db-open-guard` allowlist).
 *
 * @task T10307
 * @task T10311 — per-DB Drizzle migration coverage cross-check
 * @epic T10282
 * @saga T10281
 * @see ADR-068 — CLEO Database Charter
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DB_INVENTORY,
  type DbCrossDbInvariantId,
  type DbCrossDbOrphanReport,
  type DbInventoryEntry,
  type DbSubstrateAuditResult,
  type DbSubstrateEntry,
  type DbSubstrateMigrationCoverage,
  type DbSubstrateMigrationMissing,
  type DbSubstrateMigrationOrphan,
  type DbSubstrateProjectSurvey,
  type DbSubstrateSummary,
  type DbSubstrateSurveyOptions,
  type DbSubstrateWarning,
  type PragmaDriftItem,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';
import { resolveCorePackageMigrationsFolder } from '../store/resolve-migrations-folder.js';
import { loadPragmaSsot, normalisePragmaValue } from './pragma-ssot.js';

/**
 * Number of representative tables to row-count per DB.
 *
 * Capped at 3 to keep the survey latency bounded — anything more turns
 * a multi-DB fleet walk into a multi-second operation.
 */
const REPRESENTATIVE_TABLE_LIMIT = 3;

/**
 * Tables we never count rows from (SQLite internals + Drizzle bookkeeping).
 *
 * `sqlite_*` are SQLite's own internal tables — never useful for a
 * substrate audit. `__drizzle_migrations` (legacy + new) carries
 * one-row-per-migration metadata which is also not informative.
 */
const ROW_COUNT_TABLE_BLOCKLIST = new Set<string>(['__drizzle_migrations', '__cleo_migrations']);

/**
 * Default wall-clock budget for one `PRAGMA integrity_check` call.
 *
 * 60 seconds matches the operator-facing "60 s default, configurable via flag"
 * acceptance criterion of T10312. The check itself runs to completion because
 * `node:sqlite` is synchronous; the timer is consulted AFTER the call returns
 * and a DB that exceeded the budget is flagged via `timedOut: true`.
 */
const DEFAULT_INTEGRITY_CHECK_TIMEOUT_MS = 60_000;

/**
 * Upper bound on errors reported by a single `PRAGMA integrity_check(N)`
 * call. Capping the work done by SQLite is the only knob available to us
 * — `node:sqlite` has no progress_handler or interrupt() — so we cap to
 * 50 error rows. A clean DB always returns one `'ok'` row regardless of
 * this bound; a malformed DB returns at most 50 error rows, bounding
 * the maximum latency to roughly the cost of detecting a single
 * malformation plus the cap.
 *
 * The single-arg form `PRAGMA integrity_check(50)` is supported by every
 * SQLite version CLEO ships against (>= 3.42).
 *
 * @task T10312
 */
const INTEGRITY_CHECK_ERROR_CAP = 50;

/**
 * Resolve the canonical quarantine root for a project. Matches the
 * convention used by `recover-brain-db.ts`: `<projectRoot>/.cleo/quarantine/`.
 *
 * @remarks
 * The doctor survey uses the **directory containing the DB file** to
 * derive the quarantine root. For project-tier DBs that's `<projectRoot>/.cleo/`;
 * for global-tier DBs (e.g. `<cleoHome>/nexus.db`) that's `<cleoHome>/`.
 * Either way the quarantine sits next to the DB, never crossing
 * filesystem boundaries — atomic `renameSync` works in both cases.
 *
 * @param dbFilePath - Absolute path to the corrupt DB file.
 * @returns Absolute path to the quarantine root directory (not created yet).
 *
 * @task T10312
 */
function resolveQuarantineRoot(dbFilePath: string): string {
  return join(dirname(dbFilePath), 'quarantine');
}

/**
 * Move the corrupt DB plus any sidecar `-wal` / `-shm` files into a
 * fresh quarantine directory and return the directory path.
 *
 * @remarks
 * Naming: `<quarantineRoot>/<role>-malformed-<iso>/` per T10312 AC2.
 * The corrupt DB lands at `<quarantineDir>/<basename>.malformed`, and
 * sidecar moves are best-effort (a missing or already-gone sidecar is
 * NOT fatal to the quarantine).
 *
 * Uses `renameSync` for atomicity on the same filesystem. Cross-fs
 * renames throw EXDEV — we bubble that up so the caller surfaces the
 * quarantine failure rather than silently leaving the corrupt DB in place.
 *
 * @param dbFilePath - Absolute path to the corrupt DB.
 * @param role - Canonical role name from `DB_INVENTORY` (e.g. `'brain'`).
 * @param now - Epoch ms used to stamp the quarantine directory; injectable
 *   for testability.
 * @returns Absolute path to the newly-created quarantine directory.
 *
 * @task T10312
 */
function quarantineSubstrateDb(dbFilePath: string, role: string, now: number = Date.now()): string {
  const quarantineRoot = resolveQuarantineRoot(dbFilePath);
  const isoStamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const quarantineDir = join(quarantineRoot, `${role}-malformed-${isoStamp}`);
  mkdirSync(quarantineDir, { recursive: true });

  const dbBaseName = basename(dbFilePath);
  const dest = join(quarantineDir, `${dbBaseName}.malformed`);
  renameSync(dbFilePath, dest);

  // Move WAL + SHM sidecars; their state matters for any forensic post-mortem.
  for (const suffix of ['-wal', '-shm']) {
    const sidecarSrc = dbFilePath + suffix;
    if (existsSync(sidecarSrc)) {
      const sidecarDest = join(quarantineDir, `${dbBaseName}.malformed${suffix}`);
      try {
        renameSync(sidecarSrc, sidecarDest);
      } catch {
        // Sidecar move failure is non-fatal — the main file is already
        // safely quarantined.
      }
    }
  }

  return quarantineDir;
}

/**
 * Build the operator-facing `suggestedFix` string when a DB is corrupt.
 *
 * @remarks
 * The hard recovery command is always `cleo backup recover <role>`
 * (introduced by T10318 — uses the `recoverMalformedBrainDb` pipeline
 * from T10303). When auto-quarantine fired, we ALSO surface the
 * quarantine path inline so the operator can locate forensic state
 * without poking through the envelope's structured fields. The
 * machine-readable path stays available at {@link DbSubstrateEntry.quarantinedTo}.
 *
 * @param role - Canonical role name from `DB_INVENTORY`.
 * @param quarantineDir - Absolute quarantine path, or `null` when no
 *   quarantine happened (e.g. `autoQuarantine: false`).
 * @returns A one-line machine-readable repair command.
 *
 * @task T10312
 */
function composeSuggestedFix(role: string, quarantineDir: string | null): string {
  const cmd = `cleo backup recover ${role}`;
  if (quarantineDir === null) return cmd;
  return `${cmd} (corrupt DB quarantined to ${quarantineDir})`;
}

/**
 * Compute the stable project-id used to identify a project in
 * cross-project surveys. Matches the convention used by
 * `cleo nexus`: `base64url(path).slice(0, 32)`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns A 32-character base64url-encoded slice of the path.
 */
export function computeSubstrateProjectId(projectRoot: string): string {
  // Buffer is available in Node — no need for `crypto`.
  return Buffer.from(projectRoot).toString('base64url').slice(0, 32);
}

/**
 * Substitute `<projectRoot>` / `$XDG_DATA_HOME` tokens in an inventory
 * entry's `filePathTemplate` to an absolute on-disk path.
 *
 * Project-tier and derived-tier entries are anchored at `projectRoot`;
 * global-tier entries are anchored at `getCleoHome()`.
 *
 * @param entry - One row from `DB_INVENTORY`.
 * @param projectRoot - Absolute path to the project root (used only for
 *   `<projectRoot>` substitution).
 * @returns The resolved absolute path.
 */
export function resolveInventoryFilePath(entry: DbInventoryEntry, projectRoot: string): string {
  const cleoHome = getCleoHome();
  return entry.filePathTemplate
    .replace('<projectRoot>', projectRoot)
    .replace('$XDG_DATA_HOME/cleo', cleoHome);
}

/**
 * Choose up to {@link REPRESENTATIVE_TABLE_LIMIT} representative tables
 * from a snapshot handle's schema. Skips SQLite internals and the
 * Drizzle/CLEO migration tables.
 *
 * @param snapshotDb - Open snapshot handle.
 * @returns Alphabetically-ordered list of table names (≤ 3 entries).
 */
function pickRepresentativeTables(
  snapshotDb: ReturnType<typeof openCleoDbSnapshot>['db'],
): string[] {
  type SchemaRow = { name: string };
  const rows = snapshotDb
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as SchemaRow[];
  const filtered = rows.map((r) => r.name).filter((n) => !ROW_COUNT_TABLE_BLOCKLIST.has(n));
  return filtered.slice(0, REPRESENTATIVE_TABLE_LIMIT);
}

/**
 * Walk the canonical drift-pragma list against an open snapshot handle
 * and report every pragma whose actual value diverges from the SSoT.
 *
 * @remarks
 * Reads each pragma name from {@link PragmaSsot.driftPragmas} (sourced
 * from `specs/sqlite-pragmas.json#driftPragmas`), runs `PRAGMA <name>`
 * against `snapshotDb`, normalises the result via
 * {@link normalisePragmaValue}, and compares against the SSoT-declared
 * expected value (case-insensitively).
 *
 * Pragmas whose query throws are surfaced with `actual: null` so the
 * envelope reader can distinguish "differs" from "could not measure".
 *
 * **Important**: this function expects the snapshot to have been opened
 * WITHOUT `applyPragmas` (i.e. `applyPragmas: false`). The drift report
 * measures what the DB actually carries on disk + the connection's
 * defaults, NOT what `applyPerfPragmas` would set after open. This
 * captures the case where a discovery tool or legacy opener queries the
 * DB without going through the SSoT — exactly the regression class
 * Saga T10281 / Epic T10283 was filed to surface.
 *
 * @param snapshotDb - Open read-only snapshot handle.
 * @returns Drift items; empty array when every queried pragma matches
 *   the canonical expectation.
 *
 * @task T10310
 * @epic T10283
 * @saga T10281
 */
export function walkPragmaDrift(
  snapshotDb: ReturnType<typeof openCleoDbSnapshot>['db'],
): PragmaDriftItem[] {
  const ssot = loadPragmaSsot();
  const drift: PragmaDriftItem[] = [];

  for (const pragmaName of ssot.driftPragmas) {
    const expected = ssot.expectedByName.get(pragmaName.toLowerCase());
    if (expected === undefined) {
      // The SSoT lists a pragma in driftPragmas but no expectation —
      // surface as null actual to make the misconfiguration visible
      // rather than silently skipping.
      drift.push({ pragma: pragmaName, expected: '<missing-ssot>', actual: null });
      continue;
    }

    let actualRaw: string | null = null;
    try {
      // PRAGMA <name> returns a single row keyed by the pragma name.
      // We narrow the unknown row to a string-or-number value and
      // stringify defensively.
      const row = snapshotDb.prepare(`PRAGMA ${pragmaName}`).get() as
        | Record<string, string | number | bigint | null>
        | undefined;
      if (row !== undefined) {
        const rowValue = row[pragmaName];
        if (rowValue !== null && rowValue !== undefined) {
          actualRaw = typeof rowValue === 'bigint' ? String(rowValue) : String(rowValue);
        }
      }
    } catch {
      actualRaw = null;
    }

    if (actualRaw === null) {
      // Pragma query failed entirely OR returned no row — surface drift
      // with actual=null so the envelope reader can spot it without
      // a separate "could not measure" channel.
      drift.push({ pragma: pragmaName, expected, actual: null });
      continue;
    }

    const expectedNormalised = normalisePragmaValue(pragmaName, expected);
    const actualNormalised = normalisePragmaValue(pragmaName, actualRaw);
    if (expectedNormalised !== actualNormalised) {
      drift.push({ pragma: pragmaName, expected, actual: actualRaw });
    }
  }

  return drift;
}

/**
 * Run a row count against a representative table.
 *
 * Wrapped in try/catch so a single broken table doesn't kill the whole
 * substrate survey for a DB.
 *
 * @param snapshotDb - Open snapshot handle.
 * @param tableName - Name of the table to count.
 * @returns The integer row count, or `null` when the count threw.
 */
function safeRowCount(
  snapshotDb: ReturnType<typeof openCleoDbSnapshot>['db'],
  tableName: string,
): number | null {
  try {
    // Identifier interpolation: tableName comes from sqlite_master so
    // it's already validated. Belt-and-braces: reject anything that
    // isn't a SQL identifier.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
      return null;
    }
    const row = snapshotDb.prepare(`SELECT COUNT(*) as c FROM ${tableName}`).get() as
      | { c: number | bigint }
      | undefined;
    if (!row) return null;
    return typeof row.c === 'bigint' ? Number(row.c) : row.c;
  } catch {
    return null;
  }
}

/**
 * Resolve the absolute path to the migrations folder for an inventory
 * entry whose `migrationsDir` is non-null.
 *
 * @remarks
 * The inventory stores `migrationsDir` as a repo-relative path
 * (e.g. `packages/core/migrations/drizzle-tasks/`). At runtime the
 * @cleocode/core package ships those migrations under its own root, so
 * we delegate to {@link resolveCorePackageMigrationsFolder} which works
 * across workspace-dev, bundled, and global-install layouts. The set
 * name is the trailing path segment of `migrationsDir` (with the
 * trailing slash stripped).
 *
 * @param migrationsDir - Repo-relative path from `DbInventoryEntry.migrationsDir`.
 * @returns Absolute path to the migrations folder.
 *
 * @task T10311
 */
export function resolveInventoryMigrationsFolder(migrationsDir: string): string {
  // Strip trailing slash and take basename — the SSoT path is structured
  // as `<…>/drizzle-<role>/` so basename is the set name.
  const normalized = migrationsDir.endsWith('/') ? migrationsDir.slice(0, -1) : migrationsDir;
  const setName = basename(normalized);
  return resolveCorePackageMigrationsFolder(setName);
}

/**
 * Cross-reference `__drizzle_migrations` rows against migration files on
 * disk and produce a {@link DbSubstrateMigrationCoverage} diff.
 *
 * @remarks
 * The cross-reference uses Drizzle's canonical SHA-256(migration.sql)
 * hash via `readMigrationFiles` — the same algorithm used by
 * `migrate()` and `reconcileJournal`. Hashes are the authoritative
 * identifier; folder names are surfaced for human readability only.
 *
 * Failure modes that return `null` (not an error):
 *   - The DB has no `__drizzle_migrations` table (reserved opener,
 *     fresh DB before bootstrap).
 *   - `readMigrationFiles` throws (e.g. migrationsDir does not exist
 *     in the running install — should never happen in production but
 *     can during test fixtures that point at a temp path).
 *
 * @param snapshotDb - Open read-only snapshot of the target DB.
 * @param migrationsFolderPath - Absolute path to the migrations folder.
 * @returns A populated {@link DbSubstrateMigrationCoverage}, or `null`
 *   when the cross-reference cannot be performed.
 *
 * @task T10311
 */
export function computeMigrationCoverage(
  snapshotDb: ReturnType<typeof openCleoDbSnapshot>['db'],
  migrationsFolderPath: string,
): DbSubstrateMigrationCoverage | null {
  // 1. Confirm the journal table exists. If not, the DB hasn't been
  //    bootstrapped yet — return null so callers don't mistake a
  //    pre-bootstrap state for a failure.
  type SchemaRow = { name: string };
  const journalRows = snapshotDb
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'")
    .all() as SchemaRow[];
  if (journalRows.length === 0) {
    return null;
  }

  // 2. Read the journal. Drizzle's standard columns are (id, hash,
  //    created_at, name) — name may be absent on very old DBs but hash
  //    is always present.
  type JournalRow = { hash: string; created_at: number | bigint | null };
  let appliedRows: JournalRow[];
  try {
    appliedRows = snapshotDb
      .prepare('SELECT hash, created_at FROM __drizzle_migrations ORDER BY id')
      .all() as JournalRow[];
  } catch {
    // Journal table exists but row read failed (column drift, locked, …)
    // — surface as an empty applied set so the missing-files diff still
    // signals to the operator. Better to over-report than swallow.
    appliedRows = [];
  }

  // 3. Read files on disk via the same routine Drizzle uses internally.
  let fileEntries: ReturnType<typeof readMigrationFiles>;
  try {
    fileEntries = readMigrationFiles({ migrationsFolder: migrationsFolderPath });
  } catch {
    // Folder unreachable in this install — cannot cross-check.
    return null;
  }

  // 4. Build hash sets and diff in both directions.
  const fileHashes = new Set<string>(fileEntries.map((f) => f.hash));
  const dbHashes = new Set<string>(appliedRows.map((r) => r.hash));

  const orphanRows: DbSubstrateMigrationOrphan[] = [];
  for (const row of appliedRows) {
    if (fileHashes.has(row.hash)) continue;
    orphanRows.push({
      hash: row.hash,
      createdAt:
        row.created_at === null
          ? null
          : typeof row.created_at === 'bigint'
            ? Number(row.created_at)
            : row.created_at,
    });
  }

  const missingFiles: DbSubstrateMigrationMissing[] = [];
  for (const fileEntry of fileEntries) {
    if (dbHashes.has(fileEntry.hash)) continue;
    missingFiles.push({ name: fileEntry.name, hash: fileEntry.hash });
  }

  return {
    applied: appliedRows.length,
    expected: fileEntries.length,
    orphanRows,
    missingFiles,
  };
}

/**
 * Inspect one resolved DB file and produce the per-role substrate entry.
 *
 * @remarks
 * Performs:
 * 1. `fs.statSync` for size + mtime + existence check.
 * 2. `openCleoDbSnapshot` (read-only) for integrity_check + row counts.
 *    The integrity_check call is bounded by
 *    {@link DbSubstrateSurveyOptions.integrityCheckTimeoutMs} (default 60 s)
 *    — wall-clock measured; SQLite work capped via
 *    `PRAGMA integrity_check({@link INTEGRITY_CHECK_ERROR_CAP})`.
 * 3. On failure (integrity_check returned non-`'ok'`, open threw, OR
 *    elapsed exceeded the timeout) AND `autoQuarantine !== false`,
 *    moves the corrupt DB plus `-wal`/`-shm` sidecars into
 *    `<projectRoot>/.cleo/quarantine/<role>-malformed-<iso>/` (T10312).
 * 4. Returns a fully-populated {@link DbSubstrateEntry} — all `null`
 *    fields are explicit rather than absent.
 *
 * Snapshot handle is always closed before returning, even on error.
 *
 * @param entry - The `DB_INVENTORY` row being inspected.
 * @param filePath - The resolved absolute path to the DB file.
 * @param options - Tuning knobs for timeout + quarantine behaviour.
 *   Defaults: `integrityCheckTimeoutMs=60000`, `autoQuarantine=true`.
 * @returns A populated {@link DbSubstrateEntry}.
 */
export function inspectDbFile(
  entry: DbInventoryEntry,
  filePath: string,
  options: DbSubstrateSurveyOptions = {},
): DbSubstrateEntry {
  const timeoutMs = options.integrityCheckTimeoutMs ?? DEFAULT_INTEGRITY_CHECK_TIMEOUT_MS;
  const autoQuarantine = options.autoQuarantine ?? true;

  if (!existsSync(filePath)) {
    return {
      filePath,
      exists: false,
      integrityOK: null,
      rowCounts: null,
      lastWriteMs: null,
      sizeBytes: null,
      error: null,
      suggestedFix: null,
      migrationCoverage: null,
      pragmaDrift: null,
      quarantinedTo: null,
      integrityCheckMs: null,
      timedOut: false,
    };
  }

  let lastWriteMs: number | null = null;
  let sizeBytes: number | null = null;
  try {
    const stat = statSync(filePath);
    lastWriteMs = stat.mtimeMs;
    sizeBytes = stat.size;
  } catch {
    // stat failed — leave both null; survey continues so we still get a
    // diagnostic for the open path below.
  }

  let snapshot: ReturnType<typeof openCleoDbSnapshot> | null = null;
  let integrityCheckMs: number | null = null;
  try {
    snapshot = openCleoDbSnapshot(filePath, { readOnly: true, applyPragmas: false });

    // PRAGMA integrity_check(N) caps SQLite's work at N error rows.
    // Wall-clock measured to flag slow DBs via `timedOut`.
    type IntegrityRow = { integrity_check: string };
    const t0 = Date.now();
    const integrityRows = snapshot.db
      .prepare(`PRAGMA integrity_check(${INTEGRITY_CHECK_ERROR_CAP})`)
      .all() as IntegrityRow[];
    integrityCheckMs = Date.now() - t0;
    const rawOk = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok';
    // `timeoutMs <= 0` disables the timeout (operator opt-out).
    const timedOut = timeoutMs > 0 && integrityCheckMs > timeoutMs;
    const integrityOK = rawOk && !timedOut;

    let rowCounts: Record<string, number> | null = null;
    let pragmaDrift: PragmaDriftItem[] | null = null;
    if (integrityOK) {
      const tables = pickRepresentativeTables(snapshot.db);
      if (tables.length > 0) {
        rowCounts = {};
        for (const tableName of tables) {
          const count = safeRowCount(snapshot.db, tableName);
          if (count !== null) {
            rowCounts[tableName] = count;
          }
        }
      }
      // Pragma drift walk — only meaningful on a DB that passed
      // integrity_check. A corrupt DB's pragmas are not reliably
      // queryable (and the survey already surfaces `integrityOK=false`
      // which is the higher-priority signal).
      pragmaDrift = walkPragmaDrift(snapshot.db);
    }

    if (integrityOK) {
      // Migration coverage cross-check (T10311). Only attempted when the
      // inventory declares a non-null `migrationsDir` AND the DB passed
      // integrity_check — there's no point cross-referencing a corrupt
      // journal against the file system.
      let migrationCoverage: DbSubstrateMigrationCoverage | null = null;
      if (entry.migrationsDir !== null) {
        try {
          const migrationsFolderPath = resolveInventoryMigrationsFolder(entry.migrationsDir);
          migrationCoverage = computeMigrationCoverage(snapshot.db, migrationsFolderPath);
        } catch {
          // Resolver threw (e.g. @cleocode/core not findable from this
          // module — should never happen at runtime). Leave coverage as
          // null; the rest of the substrate audit still surfaces.
          migrationCoverage = null;
        }
      }

      return {
        filePath,
        exists: true,
        integrityOK: true,
        rowCounts,
        lastWriteMs,
        sizeBytes,
        error: null,
        suggestedFix: null,
        migrationCoverage,
        pragmaDrift,
        quarantinedTo: null,
        integrityCheckMs,
        timedOut: false,
      };
    }

    // ── Failure path ───────────────────────────────────────────────
    // Close the handle BEFORE quarantine so the rename can take the file
    // without contention from the open snapshot.
    snapshot.close();
    snapshot = null;

    let quarantinedTo: string | null = null;
    let quarantineErr: string | null = null;
    if (autoQuarantine) {
      try {
        quarantinedTo = quarantineSubstrateDb(filePath, entry.role);
      } catch (qErr) {
        // Quarantine failure is non-fatal — surface as an addendum to
        // the error string so the operator knows the corrupt DB is
        // still in place.
        quarantineErr = qErr instanceof Error ? qErr.message : String(qErr);
      }
    }

    const errParts: string[] = [];
    if (timedOut) {
      errParts.push(`integrity_check exceeded timeout: ${integrityCheckMs}ms > ${timeoutMs}ms`);
    }
    if (!rawOk) {
      const offending = integrityRows
        .map((r) => r.integrity_check)
        .filter((v) => v !== 'ok')
        .slice(0, 5)
        .join('; ');
      errParts.push(
        offending.length > 0
          ? `integrity_check reported: ${offending}`
          : 'integrity_check did not return ok',
      );
    }
    if (quarantineErr !== null) {
      errParts.push(`auto-quarantine failed: ${quarantineErr}`);
    }

    return {
      filePath,
      exists: true,
      integrityOK: false,
      rowCounts: null,
      lastWriteMs,
      sizeBytes,
      error: errParts.length > 0 ? errParts.join(' | ') : null,
      suggestedFix: composeSuggestedFix(entry.role, quarantinedTo),
      migrationCoverage: null,
      pragmaDrift: null,
      quarantinedTo,
      integrityCheckMs,
      timedOut,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Close the snapshot if it managed to open before throwing on pragma.
    snapshot?.close();
    snapshot = null;

    let quarantinedTo: string | null = null;
    let quarantineErr: string | null = null;
    if (autoQuarantine && existsSync(filePath)) {
      try {
        quarantinedTo = quarantineSubstrateDb(filePath, entry.role);
      } catch (qErr) {
        quarantineErr = qErr instanceof Error ? qErr.message : String(qErr);
      }
    }

    const errParts: string[] = [message];
    if (quarantineErr !== null) {
      errParts.push(`auto-quarantine failed: ${quarantineErr}`);
    }

    return {
      filePath,
      exists: true,
      integrityOK: false,
      rowCounts: null,
      lastWriteMs,
      sizeBytes,
      error: errParts.join(' | '),
      suggestedFix: composeSuggestedFix(entry.role, quarantinedTo),
      migrationCoverage: null,
      pragmaDrift: null,
      quarantinedTo,
      integrityCheckMs,
      timedOut: false,
    };
  } finally {
    snapshot?.close();
  }
}

// ============================================================================
// Cross-DB invariant walker (T10323 — Saga T10281 / Epic T10285)
// ============================================================================

/**
 * Max number of orphan rows the bounded queries will return per invariant.
 *
 * Keeps walk latency bounded: each invariant runs at most one query that
 * scans at most this many candidate rows, so a fleet of malformed DBs
 * cannot blow up the substrate audit's wall-clock budget.
 *
 * @task T10323
 */
const CROSS_DB_QUERY_LIMIT = 100;

/**
 * Number of sample orphan keys carried in each report. The full count is
 * tracked separately on `DbCrossDbOrphanReport.orphanCount`.
 *
 * @task T10323
 */
const CROSS_DB_SAMPLE_LIMIT = 5;

/** Stable text for the I3 path-mismatch invariant fix. */
const I3_FIX = 'Run `cleo nexus reset-project-id` to realign nexus.db with project-context.json';
/** Stable text for the I1 invariant fix. */
const I1_FIX = 'Run `cleo memory observe --task <taskId>` to re-anchor';
/** Stable text for the I2 invariant fix. */
const I2_FIX = 'Run `cleo docs prune --remove-orphan-blobs`';
/** Stable text for the I4 invariant fix. */
const I4_FIX =
  'Repair llmtxt session linkage — re-run `cleo session start --link-task <taskId>` or prune the orphan llmtxt session row';
/** Stable text for the I5 invariant fix. */
const I5_FIX =
  'Repair conduit job anchor — re-anchor the job to a live tasks/brain row or run `cleo conduit prune --orphans`';

/**
 * Helper: open a snapshot of `filePath` when it exists, returning `null`
 * (no throw) for every failure mode. The cross-DB walker tolerates every
 * absent / corrupt / unreadable source DB without short-circuiting the
 * rest of the invariants.
 *
 * @param filePath - Absolute path to the candidate SQLite file.
 * @returns The open snapshot handle, or `null` when the file is missing
 *   / opener threw.
 */
function tryOpenSnapshot(filePath: string): ReturnType<typeof openCleoDbSnapshot> | null {
  if (!existsSync(filePath)) return null;
  try {
    return openCleoDbSnapshot(filePath, { readOnly: true, applyPragmas: false });
  } catch {
    return null;
  }
}

/**
 * Helper: build a `skipped` report for an invariant whose prerequisites
 * are not met (missing source DB, missing column, opener threw, etc.).
 *
 * @param invariant - Canonical invariant ID.
 * @param description - Stable invariant description.
 * @param suggestedFix - Canonical repair command.
 * @param reason - Free-form skip reason for triage.
 * @returns A populated {@link DbCrossDbOrphanReport} with `skipped: true`.
 */
function buildSkippedReport(
  invariant: DbCrossDbInvariantId,
  description: string,
  suggestedFix: string,
  reason: string,
): DbCrossDbOrphanReport {
  return {
    invariant,
    description,
    orphanCount: 0,
    sample: [],
    suggestedFix,
    skipped: true,
    skipReason: reason,
  };
}

/**
 * Helper: check whether a SQLite snapshot has a given table.
 *
 * @param snapshot - The open snapshot handle (NOT null — caller checks).
 * @param tableName - Exact table name to check (case-sensitive).
 * @returns `true` when `sqlite_master` carries a row with `name=<tableName>`.
 */
function snapshotHasTable(
  snapshot: ReturnType<typeof openCleoDbSnapshot>,
  tableName: string,
): boolean {
  type Row = { name: string };
  try {
    const rows = snapshot.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1")
      .all(tableName) as Row[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Helper: check whether a SQLite snapshot has a given column on a given
 * table.
 *
 * @param snapshot - The open snapshot handle (NOT null — caller checks).
 * @param tableName - Exact table name.
 * @param columnName - Exact column name (case-sensitive).
 * @returns `true` when `PRAGMA table_info(<tableName>)` carries a row
 *   with `name=<columnName>`.
 */
function snapshotHasColumn(
  snapshot: ReturnType<typeof openCleoDbSnapshot>,
  tableName: string,
  columnName: string,
): boolean {
  // table_info accepts a quoted identifier; tableName is validated by
  // caller (only used on hardcoded table names from this module).
  type ColumnInfoRow = { name: string };
  try {
    const rows = snapshot.db.prepare(`PRAGMA table_info(${tableName})`).all() as ColumnInfoRow[];
    return rows.some((r) => r.name === columnName);
  } catch {
    return false;
  }
}

/**
 * I1 invariant: `brain_memory_links.task_id` (brain.db) must reference an
 * existing `tasks.id` row in tasks.db.
 *
 * @remarks
 * Strategy: read every distinct `task_id` from brain.db's
 * `brain_memory_links` (LIMIT 100), then for each candidate ask tasks.db
 * whether the row exists. The walker scans at most 100 candidate IDs,
 * regardless of how many orphan links the brain has — operators see
 * "≥ 100" only when the population truly exceeds the cap.
 *
 * @param tasksSnap - Open snapshot of tasks.db, or `null` when missing.
 * @param brainSnap - Open snapshot of brain.db, or `null` when missing.
 * @returns A {@link DbCrossDbOrphanReport} for invariant I1.
 */
export function checkInvariantI1(
  tasksSnap: ReturnType<typeof openCleoDbSnapshot> | null,
  brainSnap: ReturnType<typeof openCleoDbSnapshot> | null,
): DbCrossDbOrphanReport {
  const description =
    'brain_memory_links.task_id (brain.db) must reference an existing tasks.id row in tasks.db';

  if (brainSnap === null) {
    return buildSkippedReport('I1', description, I1_FIX, 'brain.db missing or unreadable');
  }
  if (tasksSnap === null) {
    return buildSkippedReport('I1', description, I1_FIX, 'tasks.db missing or unreadable');
  }
  if (!snapshotHasTable(brainSnap, 'brain_memory_links')) {
    return buildSkippedReport(
      'I1',
      description,
      I1_FIX,
      'brain.db has no brain_memory_links table',
    );
  }
  if (!snapshotHasTable(tasksSnap, 'tasks')) {
    return buildSkippedReport('I1', description, I1_FIX, 'tasks.db has no tasks table');
  }

  type LinkRow = { task_id: string };
  let candidateIds: string[];
  try {
    const rows = brainSnap.db
      .prepare(
        `SELECT DISTINCT task_id FROM brain_memory_links WHERE task_id IS NOT NULL LIMIT ${CROSS_DB_QUERY_LIMIT}`,
      )
      .all() as LinkRow[];
    candidateIds = rows.map((r) => r.task_id);
  } catch (err) {
    return buildSkippedReport(
      'I1',
      description,
      I1_FIX,
      `brain.db query threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const orphans: string[] = [];
  const lookup = tasksSnap.db.prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1');
  for (const taskId of candidateIds) {
    try {
      const row = lookup.get(taskId) as { id: string } | undefined;
      if (row === undefined) {
        orphans.push(taskId);
      }
    } catch {
      // Lookup threw — treat as inconclusive (skip this row, don't bias).
    }
  }

  return {
    invariant: 'I1',
    description,
    orphanCount: orphans.length,
    sample: orphans.slice(0, CROSS_DB_SAMPLE_LIMIT),
    suggestedFix: I1_FIX,
    skipped: false,
    skipReason: '',
  };
}

/**
 * I2 invariant: `blob_attachments.doc_slug` (manifest.db) used as a
 * `T####`-shaped task identifier must reference an existing tasks.id row.
 *
 * @remarks
 * CLEO uses `taskId` as the `docSlug` for blob attachments
 * (see `packages/core/src/store/llmtxt-blob-adapter.ts`). Doc slugs that
 * match the canonical `^T\d+$` shape MUST point at a live task; any
 * other doc-slug shape (changesets, ADRs, research notes…) is out of
 * scope for this invariant.
 *
 * @param tasksSnap - Open snapshot of tasks.db, or `null` when missing.
 * @param manifestSnap - Open snapshot of manifest.db, or `null` when missing.
 * @returns A {@link DbCrossDbOrphanReport} for invariant I2.
 */
export function checkInvariantI2(
  tasksSnap: ReturnType<typeof openCleoDbSnapshot> | null,
  manifestSnap: ReturnType<typeof openCleoDbSnapshot> | null,
): DbCrossDbOrphanReport {
  const description =
    "manifest.db blob_attachments.doc_slug shaped like 'T####' must reference an existing tasks.id row";

  if (manifestSnap === null) {
    return buildSkippedReport('I2', description, I2_FIX, 'manifest.db missing or unreadable');
  }
  if (tasksSnap === null) {
    return buildSkippedReport('I2', description, I2_FIX, 'tasks.db missing or unreadable');
  }
  if (!snapshotHasTable(manifestSnap, 'blob_attachments')) {
    return buildSkippedReport(
      'I2',
      description,
      I2_FIX,
      'manifest.db has no blob_attachments table',
    );
  }
  if (!snapshotHasTable(tasksSnap, 'tasks')) {
    return buildSkippedReport('I2', description, I2_FIX, 'tasks.db has no tasks table');
  }

  type SlugRow = { doc_slug: string };
  let candidates: string[];
  try {
    // Only T-shaped slugs. SQLite GLOB beats LIKE for prefix discrimination.
    const rows = manifestSnap.db
      .prepare(
        `SELECT DISTINCT doc_slug FROM blob_attachments WHERE doc_slug GLOB 'T[0-9]*' AND doc_slug IS NOT NULL LIMIT ${CROSS_DB_QUERY_LIMIT}`,
      )
      .all() as SlugRow[];
    candidates = rows.map((r) => r.doc_slug);
  } catch (err) {
    return buildSkippedReport(
      'I2',
      description,
      I2_FIX,
      `manifest.db query threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const orphans: string[] = [];
  const lookup = tasksSnap.db.prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1');
  for (const slug of candidates) {
    try {
      const row = lookup.get(slug) as { id: string } | undefined;
      if (row === undefined) {
        orphans.push(slug);
      }
    } catch {
      // Lookup threw — skip silently.
    }
  }

  return {
    invariant: 'I2',
    description,
    orphanCount: orphans.length,
    sample: orphans.slice(0, CROSS_DB_SAMPLE_LIMIT),
    suggestedFix: I2_FIX,
    skipped: false,
    skipReason: '',
  };
}

/**
 * I3 invariant: nexus.db's `project_registry.project_path` row for the
 * current project must match `projectRoot` (or, when no row exists, the
 * project simply has not been registered with the nexus yet — that is
 * skipped, not flagged).
 *
 * @remarks
 * `.cleo/project-context.json` does NOT carry a `projectId` field; the
 * canonical identifier is derived from `base64url(path).slice(0, 32)`.
 * The invariant therefore asserts that the nexus registry's recorded
 * `project_path` MATCHES the live project root for the computed ID.
 *
 * Detected drift: a single nexus row whose `project_path` no longer
 * matches `projectRoot` (e.g. project was moved on disk; the
 * registry still points at the old location).
 *
 * @param projectRoot - Absolute path to the project root being audited.
 * @param nexusSnap - Open snapshot of nexus.db, or `null` when missing.
 * @returns A {@link DbCrossDbOrphanReport} for invariant I3.
 */
export function checkInvariantI3(
  projectRoot: string,
  nexusSnap: ReturnType<typeof openCleoDbSnapshot> | null,
): DbCrossDbOrphanReport {
  const description =
    'nexus.db project_registry.project_path must match the live projectRoot for this project_id';

  if (nexusSnap === null) {
    return buildSkippedReport('I3', description, I3_FIX, 'nexus.db missing or unreadable');
  }
  if (!snapshotHasTable(nexusSnap, 'project_registry')) {
    return buildSkippedReport('I3', description, I3_FIX, 'nexus.db has no project_registry table');
  }

  const expectedProjectId = computeSubstrateProjectId(projectRoot);

  type RegistryRow = { project_id: string; project_path: string };
  let row: RegistryRow | undefined;
  try {
    row = nexusSnap.db
      .prepare('SELECT project_id, project_path FROM project_registry WHERE project_id = ? LIMIT 1')
      .get(expectedProjectId) as RegistryRow | undefined;
  } catch (err) {
    return buildSkippedReport(
      'I3',
      description,
      I3_FIX,
      `nexus.db query threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // No registry row: project simply isn't tracked by the nexus yet — not
  // a violation. The invariant only fires when a row exists AND its
  // recorded path differs from the live projectRoot.
  if (row === undefined) {
    return buildSkippedReport(
      'I3',
      description,
      I3_FIX,
      `nexus.db has no project_registry row for projectId=${expectedProjectId}`,
    );
  }

  const orphans: string[] = [];
  if (row.project_path !== projectRoot) {
    orphans.push(`${row.project_id} (path: ${row.project_path}, expected: ${projectRoot})`);
  }

  return {
    invariant: 'I3',
    description,
    orphanCount: orphans.length,
    sample: orphans.slice(0, CROSS_DB_SAMPLE_LIMIT),
    suggestedFix: I3_FIX,
    skipped: false,
    skipReason: '',
  };
}

/**
 * I4 invariant: llmtxt.db's `session_id` (if the schema declares one)
 * must reference an existing `sessions.id` row in tasks.db.
 *
 * @remarks
 * Schema-aware: the live llmtxt schema (`llmtxt@2026.4.x`) does NOT yet
 * declare a `session_id` column on any table. The walker probes
 * `sqlite_master` for tables carrying a `session_id` column and runs
 * the check only when one exists. The check stays compatible with future
 * llmtxt schemas that introduce session linkage without code changes.
 *
 * When a candidate column is found, the bounded query gathers distinct
 * `session_id` values (LIMIT 100) and cross-references each against
 * tasks.db's `sessions` table.
 *
 * @param tasksSnap - Open snapshot of tasks.db, or `null` when missing.
 * @param llmtxtSnap - Open snapshot of llmtxt.db, or `null` when missing.
 * @returns A {@link DbCrossDbOrphanReport} for invariant I4.
 */
export function checkInvariantI4(
  tasksSnap: ReturnType<typeof openCleoDbSnapshot> | null,
  llmtxtSnap: ReturnType<typeof openCleoDbSnapshot> | null,
): DbCrossDbOrphanReport {
  const description =
    'llmtxt.db tables carrying a session_id column must reference an existing sessions.id row in tasks.db';

  if (llmtxtSnap === null) {
    return buildSkippedReport('I4', description, I4_FIX, 'llmtxt.db missing or unreadable');
  }
  if (tasksSnap === null) {
    return buildSkippedReport('I4', description, I4_FIX, 'tasks.db missing or unreadable');
  }
  if (!snapshotHasTable(tasksSnap, 'sessions')) {
    return buildSkippedReport('I4', description, I4_FIX, 'tasks.db has no sessions table');
  }

  // Find any user table in llmtxt.db that has a `session_id` column.
  // The schema may evolve — we don't hardcode a table name.
  //
  // NOTE: SQL `LIKE '__%'` matches ANY two-character-prefixed name (the
  // underscore is a single-character wildcard in SQL). Use a literal
  // escape so we exclude only the Drizzle/CLEO bookkeeping tables that
  // genuinely begin with `__`.
  type TableRow = { name: string };
  let userTables: string[];
  try {
    const rows = llmtxtSnap.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'",
      )
      .all() as TableRow[];
    userTables = rows.map((r) => r.name);
  } catch (err) {
    return buildSkippedReport(
      'I4',
      description,
      I4_FIX,
      `llmtxt.db schema query threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tablesWithSessionId: string[] = [];
  for (const t of userTables) {
    if (snapshotHasColumn(llmtxtSnap, t, 'session_id')) {
      tablesWithSessionId.push(t);
    }
  }

  if (tablesWithSessionId.length === 0) {
    return buildSkippedReport(
      'I4',
      description,
      I4_FIX,
      'llmtxt.db has no table with a session_id column (schema does not yet declare session linkage)',
    );
  }

  type SessionRow = { session_id: string };
  const allCandidates = new Set<string>();
  for (const tableName of tablesWithSessionId) {
    if (allCandidates.size >= CROSS_DB_QUERY_LIMIT) break;
    // Identifier safety: tableName comes from sqlite_master so it's
    // already a valid identifier. Belt-and-braces regex check below.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) continue;
    const remaining = CROSS_DB_QUERY_LIMIT - allCandidates.size;
    try {
      const rows = llmtxtSnap.db
        .prepare(
          `SELECT DISTINCT session_id FROM ${tableName} WHERE session_id IS NOT NULL LIMIT ${remaining}`,
        )
        .all() as SessionRow[];
      for (const r of rows) {
        allCandidates.add(r.session_id);
      }
    } catch {
      // Skip this table on failure — don't bias the report.
    }
  }

  const orphans: string[] = [];
  const lookup = tasksSnap.db.prepare('SELECT id FROM sessions WHERE id = ? LIMIT 1');
  for (const sessionId of allCandidates) {
    try {
      const row = lookup.get(sessionId) as { id: string } | undefined;
      if (row === undefined) {
        orphans.push(sessionId);
      }
    } catch {
      // skip silently
    }
  }

  return {
    invariant: 'I4',
    description,
    orphanCount: orphans.length,
    sample: orphans.slice(0, CROSS_DB_SAMPLE_LIMIT),
    suggestedFix: I4_FIX,
    skipped: false,
    skipReason: '',
  };
}

/**
 * I5 invariant: `dead_letters.job_id` (conduit.db) must reference either
 * an existing tasks.id row OR a brain anchor (page node, observation, …).
 *
 * @remarks
 * Conduit jobs anchor against the broader CLEO substrate — a job's
 * `job_id` may be a task ID (`T####`) or a brain entity (e.g.
 * `observation:O-…`). The walker resolves each candidate against both
 * targets and only flags rows that match neither.
 *
 * @param tasksSnap - Open snapshot of tasks.db, or `null` when missing.
 * @param brainSnap - Open snapshot of brain.db, or `null` when missing.
 * @param conduitSnap - Open snapshot of conduit.db, or `null` when missing.
 * @returns A {@link DbCrossDbOrphanReport} for invariant I5.
 */
export function checkInvariantI5(
  tasksSnap: ReturnType<typeof openCleoDbSnapshot> | null,
  brainSnap: ReturnType<typeof openCleoDbSnapshot> | null,
  conduitSnap: ReturnType<typeof openCleoDbSnapshot> | null,
): DbCrossDbOrphanReport {
  const description =
    'conduit.db conduit_dead_letters.job_id must reference an existing tasks.id row OR a brain anchor (brain_page_nodes.id / brain_observations.id)';

  if (conduitSnap === null) {
    return buildSkippedReport('I5', description, I5_FIX, 'conduit.db missing or unreadable');
  }
  if (!snapshotHasTable(conduitSnap, 'conduit_dead_letters')) {
    return buildSkippedReport(
      'I5',
      description,
      I5_FIX,
      'conduit.db has no conduit_dead_letters table',
    );
  }
  // Both targets missing → cannot resolve; skip.
  if (tasksSnap === null && brainSnap === null) {
    return buildSkippedReport(
      'I5',
      description,
      I5_FIX,
      'both tasks.db and brain.db missing — cannot resolve job anchors',
    );
  }

  type JobRow = { job_id: string };
  let candidates: string[];
  try {
    const rows = conduitSnap.db
      .prepare(
        `SELECT DISTINCT job_id FROM conduit_dead_letters WHERE job_id IS NOT NULL LIMIT ${CROSS_DB_QUERY_LIMIT}`,
      )
      .all() as JobRow[];
    candidates = rows.map((r) => r.job_id);
  } catch (err) {
    return buildSkippedReport(
      'I5',
      description,
      I5_FIX,
      `conduit.db query threw: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const tasksLookup =
    tasksSnap !== null && snapshotHasTable(tasksSnap, 'tasks')
      ? tasksSnap.db.prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1')
      : null;
  const brainPageLookup =
    brainSnap !== null && snapshotHasTable(brainSnap, 'brain_page_nodes')
      ? brainSnap.db.prepare('SELECT id FROM brain_page_nodes WHERE id = ? LIMIT 1')
      : null;
  const brainObsLookup =
    brainSnap !== null && snapshotHasTable(brainSnap, 'brain_observations')
      ? brainSnap.db.prepare('SELECT id FROM brain_observations WHERE id = ? LIMIT 1')
      : null;

  const orphans: string[] = [];
  for (const jobId of candidates) {
    let anchored = false;
    try {
      if (tasksLookup !== null && (tasksLookup.get(jobId) as { id: string } | undefined)) {
        anchored = true;
      }
    } catch {
      // skip
    }
    if (!anchored) {
      try {
        if (
          brainPageLookup !== null &&
          (brainPageLookup.get(jobId) as { id: string } | undefined)
        ) {
          anchored = true;
        }
      } catch {
        // skip
      }
    }
    if (!anchored) {
      try {
        if (brainObsLookup !== null && (brainObsLookup.get(jobId) as { id: string } | undefined)) {
          anchored = true;
        }
      } catch {
        // skip
      }
    }
    if (!anchored) {
      orphans.push(jobId);
    }
  }

  return {
    invariant: 'I5',
    description,
    orphanCount: orphans.length,
    sample: orphans.slice(0, CROSS_DB_SAMPLE_LIMIT),
    suggestedFix: I5_FIX,
    skipped: false,
    skipReason: '',
  };
}

/**
 * Run every cross-DB invariant in the T10320 catalogue (I1–I5) and
 * return per-invariant orphan reports.
 *
 * @remarks
 * Resolves every DB path through the inventory SSoT, opens each as a
 * read-only snapshot, runs the bounded invariant queries, and closes
 * the snapshots before returning. Every failure mode — missing file,
 * malformed DB, missing column, missing table — is captured on the
 * corresponding report's `skipped: true` branch; the walker never
 * throws.
 *
 * Each invariant has its own dedicated checker (exported for unit
 * tests) so the integration suite can verify the per-invariant
 * semantics in isolation.
 *
 * @param projectRoot - Absolute path to the project root.
 * @returns Five {@link DbCrossDbOrphanReport} entries — one per invariant,
 *   always in the canonical order I1, I2, I3, I4, I5.
 *
 * @task T10323
 * @epic T10285
 * @saga T10281
 */
export function walkCrossDbInvariants(projectRoot: string): DbCrossDbOrphanReport[] {
  // Resolve every DB path through the inventory SSoT — no hardcoded
  // paths. Roles we care about: tasks, brain, conduit, manifest,
  // llmtxt, nexus.
  const resolveByRole = (role: string): string | null => {
    const entry = DB_INVENTORY.find((e) => e.role === role);
    return entry ? resolveInventoryFilePath(entry, projectRoot) : null;
  };

  const tasksPath = resolveByRole('tasks');
  const brainPath = resolveByRole('brain');
  const conduitPath = resolveByRole('conduit');
  const manifestPath = resolveByRole('manifest');
  const llmtxtPath = resolveByRole('llmtxt');
  const nexusPath = resolveByRole('nexus');

  const tasksSnap = tasksPath ? tryOpenSnapshot(tasksPath) : null;
  const brainSnap = brainPath ? tryOpenSnapshot(brainPath) : null;
  const conduitSnap = conduitPath ? tryOpenSnapshot(conduitPath) : null;
  const manifestSnap = manifestPath ? tryOpenSnapshot(manifestPath) : null;
  const llmtxtSnap = llmtxtPath ? tryOpenSnapshot(llmtxtPath) : null;
  const nexusSnap = nexusPath ? tryOpenSnapshot(nexusPath) : null;

  try {
    const reports: DbCrossDbOrphanReport[] = [
      checkInvariantI1(tasksSnap, brainSnap),
      checkInvariantI2(tasksSnap, manifestSnap),
      checkInvariantI3(projectRoot, nexusSnap),
      checkInvariantI4(tasksSnap, llmtxtSnap),
      checkInvariantI5(tasksSnap, brainSnap, conduitSnap),
    ];
    return reports;
  } finally {
    // Close every snapshot we opened, regardless of which checks ran.
    tasksSnap?.close();
    brainSnap?.close();
    conduitSnap?.close();
    manifestSnap?.close();
    llmtxtSnap?.close();
    nexusSnap?.close();
  }
}

/**
 * Walk the inventory and survey every project-tier + global-tier
 * database visible from one project root.
 *
 * @remarks
 * `derived` tier entries (e.g. `manifest.db`) are surveyed the same as
 * project-tier ones — they too need integrity verification even though
 * they can be rebuilt. The caller decides whether to treat their
 * absence as healthy.
 *
 * @param projectRoot - Absolute path to the project root to survey.
 * @param options - Tuning knobs forwarded to {@link inspectDbFile}.
 * @returns One {@link DbSubstrateProjectSurvey} keyed by canonical role.
 */
export function surveyProjectDbSubstrate(
  projectRoot: string,
  options: DbSubstrateSurveyOptions = {},
): DbSubstrateProjectSurvey {
  const dbs: Record<string, DbSubstrateEntry> = {};
  for (const entry of DB_INVENTORY) {
    const filePath = resolveInventoryFilePath(entry, projectRoot);
    dbs[entry.role] = inspectDbFile(entry, filePath, options);
  }
  return {
    projectRoot,
    projectId: computeSubstrateProjectId(projectRoot),
    dbs,
  };
}

/**
 * Decide whether the `.cleo/` directory at `cleoDirPath` belongs to a
 * legitimate CLEO project root.
 *
 * @remarks
 * The legitimacy heuristic (T10308 AC2):
 *
 *   "If `<dir>/.cleo/` exists AND `<dir>/.cleo/project-info.json` AND
 *    `<dir>/.cleo/tasks.db` BOTH exist, the directory IS a legitimate
 *    project root. Otherwise it's an orphan."
 *
 * Both markers must be present for legitimacy — `project-info.json` is
 * written by `cleo init`, and `tasks.db` is the canonical SQLite store.
 * A `.cleo/` directory missing EITHER one is treated as an orphan
 * (regression class T9550: stray `.cleo/.context-state.json` writes
 * from sibling workspaces).
 *
 * @param cleoDirPath - Absolute path to a `.cleo/` directory (i.e. the
 *   directory under suspicion, NOT its parent).
 * @returns `true` when both legitimacy markers exist; `false` otherwise.
 *
 * @task T10308
 */
export function isLegitimateCleoProjectRoot(cleoDirPath: string): boolean {
  return (
    existsSync(join(cleoDirPath, 'project-info.json')) && existsSync(join(cleoDirPath, 'tasks.db'))
  );
}

/**
 * Best-effort read of the `workspace` field from
 * `<cleoDirPath>/.context-state.json`.
 *
 * @remarks
 * The 2026-05-23 audit found that `/mnt/projects/.cleo/.context-state.json`
 * carried `{ workspace: '/mnt/projects/awesome-skills' }` — irrefutable
 * evidence that the orphan was being written by the `awesome-skills`
 * workspace via mis-resolved cwd. This helper surfaces that attribution
 * so operators can identify the offending workspace and patch it.
 *
 * Any failure mode (missing file, unparseable JSON, missing field, wrong
 * type) returns `null` — never throws.
 *
 * @param cleoDirPath - Absolute path to the `.cleo/` directory under
 *   investigation.
 * @returns The `workspace` field when present and a string; `null`
 *   otherwise.
 *
 * @task T10308
 */
export function readParentWorkspace(cleoDirPath: string): string | null {
  const statePath = join(cleoDirPath, '.context-state.json');
  if (!existsSync(statePath)) return null;
  try {
    const raw = readFileSync(statePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'workspace' in parsed &&
      typeof (parsed as { workspace: unknown }).workspace === 'string'
    ) {
      return (parsed as { workspace: string }).workspace;
    }
    return null;
  } catch {
    // Parse error, IO error — surface as "no attribution available".
    return null;
  }
}

/**
 * Build a fully-populated orphan-project-root warning for a `.cleo/`
 * directory that has been confirmed as an orphan.
 *
 * @param cleoDirPath - Absolute path to the orphan `.cleo/` directory.
 * @returns A populated {@link DbSubstrateWarning} of kind
 *   `'orphan-project-root'`.
 *
 * @task T10308
 */
function buildOrphanWarning(cleoDirPath: string): DbSubstrateWarning {
  let lastWriteMs: number | null = null;
  try {
    lastWriteMs = statSync(cleoDirPath).mtimeMs;
  } catch {
    // Ignore — leave null.
  }
  return {
    kind: 'orphan-project-root',
    path: cleoDirPath,
    lastWriteMs,
    parentWorkspace: readParentWorkspace(cleoDirPath),
  };
}

/**
 * Detect orphan project-root `.cleo/` directories at the PARENT of a
 * known project root.
 *
 * @remarks
 * The T9550 regression class wrote `.cleo/` at a project's parent path
 * (e.g. `/mnt/projects/.cleo/`) when `cwd` resolution miscascaded. This
 * helper checks the parent for a `.cleo/` directory and, if found AND
 * the parent is NOT itself a legitimate CLEO project root (per
 * {@link isLegitimateCleoProjectRoot}), surfaces it as a warning.
 *
 * T10308 strengthens the original T10307 implementation with the
 * legitimacy check + `.context-state.json` attribution.
 *
 * @param projectRoot - Absolute path to one project root.
 * @returns A warning if `<parent>/.cleo/` exists AND is not itself a
 *   legitimate project root; otherwise `null`.
 */
export function detectOrphanProjectRootWarning(projectRoot: string): DbSubstrateWarning | null {
  const parent = dirname(projectRoot);
  if (parent === projectRoot) {
    // We're at the filesystem root — no parent to scan.
    return null;
  }
  const parentCleoPath = join(parent, '.cleo');
  if (!existsSync(parentCleoPath)) {
    return null;
  }
  // Legitimacy heuristic (T10308 AC2): if the parent has BOTH
  // project-info.json and tasks.db, it's a real CLEO project root —
  // surveying the child was the misuse, not the parent's existence.
  if (isLegitimateCleoProjectRoot(parentCleoPath)) {
    return null;
  }
  return buildOrphanWarning(parentCleoPath);
}

/**
 * Detect nested-nexus structural duplicates at
 * `<cleoHome>/nexus/{nexus,signaldock}.db`.
 *
 * @remarks
 * The canonical XDG layout writes these as flat files under `cleoHome`
 * (e.g. `~/.local/share/cleo/nexus.db`). Older code paths sometimes
 * wrote them into a nested `nexus/` subdirectory. Either pattern is
 * harmless individually, but co-existence is a structural duplicate
 * and a sign of bit-rot.
 *
 * @returns Zero, one, or two warning entries (one per duplicate file).
 */
export function detectNestedNexusDuplicates(): DbSubstrateWarning[] {
  const warnings: DbSubstrateWarning[] = [];
  const cleoHome = getCleoHome();
  for (const name of ['nexus.db', 'signaldock.db'] as const) {
    const nestedPath = join(cleoHome, 'nexus', name);
    if (existsSync(nestedPath)) {
      let lastWriteMs: number | null = null;
      try {
        lastWriteMs = statSync(nestedPath).mtimeMs;
      } catch {
        // Ignore — leave null.
      }
      warnings.push({
        kind: 'nested-nexus-duplicate',
        path: nestedPath,
        lastWriteMs,
      });
    }
  }
  return warnings;
}

/**
 * Roll up per-DB substrate entries into the aggregate counters surfaced
 * in `envelope.data.summary`.
 *
 * @param surveys - All per-project surveys.
 * @returns A {@link DbSubstrateSummary}.
 */
export function summarizeSubstrateSurveys(
  surveys: readonly DbSubstrateProjectSurvey[],
): DbSubstrateSummary {
  let total = 0;
  let healthy = 0;
  let missing = 0;
  let corrupt = 0;
  for (const survey of surveys) {
    for (const dbEntry of Object.values(survey.dbs)) {
      total += 1;
      if (!dbEntry.exists) {
        missing += 1;
      } else if (dbEntry.integrityOK === true) {
        healthy += 1;
      } else {
        corrupt += 1;
      }
    }
  }
  return { totalDbs: total, healthy, missing, corrupt };
}

/**
 * Single-project substrate survey — covers the current project root +
 * the global tier of databases.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param options - Tuning knobs forwarded to {@link inspectDbFile}.
 * @returns The full {@link DbSubstrateAuditResult} with `scope='project'`.
 */
export function surveyDbSubstrate(
  projectRoot: string,
  options: DbSubstrateSurveyOptions = {},
): DbSubstrateAuditResult {
  const projectSurvey = surveyProjectDbSubstrate(projectRoot, options);
  const warnings: DbSubstrateWarning[] = [];
  const orphan = detectOrphanProjectRootWarning(projectRoot);
  if (orphan) {
    warnings.push(orphan);
  }
  warnings.push(...detectNestedNexusDuplicates());
  // T10323: cross-DB invariants are checked once per project per audit.
  const crossDbOrphans = walkCrossDbInvariants(projectRoot);
  return {
    scope: 'project',
    projects: [projectSurvey],
    summary: summarizeSubstrateSurveys([projectSurvey]),
    warnings,
    crossDbOrphans,
  };
}

/**
 * Multi-project (fleet) substrate survey.
 *
 * Walks every immediate subdirectory of `fleetRoot` that contains a
 * `.cleo/` directory, and surveys each as a project root. The global
 * tier is collapsed into the FIRST project's entries — running global
 * DB integrity checks once per fleet is enough; running them per
 * project would just multiply the same `integrity_check` calls.
 *
 * @param fleetRoot - Absolute path whose immediate children are
 *   candidate project roots (e.g. `/mnt/projects/`).
 * @param options - Tuning knobs forwarded to {@link inspectDbFile}.
 * @returns A {@link DbSubstrateAuditResult} with `scope='fleet'`.
 */
export function surveyFleetDbSubstrate(
  fleetRoot: string,
  options: DbSubstrateSurveyOptions = {},
): DbSubstrateAuditResult {
  const projectRoots: string[] = [];
  try {
    const entries = readdirSync(fleetRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = join(fleetRoot, entry.name);
      if (existsSync(join(candidate, '.cleo'))) {
        projectRoots.push(candidate);
      }
    }
  } catch {
    // readdir failed — fleet root unreadable; fall through with an
    // empty list so the caller still gets a well-formed envelope.
  }

  // Stable sort so the envelope is deterministic across runs.
  projectRoots.sort();

  // For the FIRST project we include the freshly-surveyed global-tier
  // entries; for every subsequent project we reuse the same global-tier
  // findings to avoid running PRAGMA integrity_check on the same global
  // file N times.
  const projectSurveys: DbSubstrateProjectSurvey[] = [];
  let firstProjectGlobalEntries: Map<string, DbSubstrateEntry> | null = null;
  for (const projectRoot of projectRoots) {
    const survey = surveyProjectDbSubstrate(projectRoot, options);
    if (firstProjectGlobalEntries === null) {
      firstProjectGlobalEntries = new Map<string, DbSubstrateEntry>();
      for (const inventoryEntry of DB_INVENTORY) {
        if (inventoryEntry.tier === 'global') {
          const dbEntry = survey.dbs[inventoryEntry.role];
          if (dbEntry !== undefined) {
            firstProjectGlobalEntries.set(inventoryEntry.role, dbEntry);
          }
        }
      }
      projectSurveys.push(survey);
    } else {
      // Build a fresh survey that reuses the cached global-tier findings.
      const reusedDbs: Record<string, DbSubstrateEntry> = {};
      for (const inventoryEntry of DB_INVENTORY) {
        if (inventoryEntry.tier === 'global') {
          const cached = firstProjectGlobalEntries.get(inventoryEntry.role);
          if (cached !== undefined) {
            reusedDbs[inventoryEntry.role] = cached;
            continue;
          }
        }
        const original = survey.dbs[inventoryEntry.role];
        if (original !== undefined) {
          reusedDbs[inventoryEntry.role] = original;
        }
      }
      projectSurveys.push({
        projectRoot: survey.projectRoot,
        projectId: survey.projectId,
        dbs: reusedDbs,
      });
    }
  }

  // Fleet-wide warnings: orphan project-root .cleo/ at fleetRoot itself
  // (subject to the same legitimacy heuristic as the single-project case
  // — T10308 AC2), plus nested-nexus.
  const warnings: DbSubstrateWarning[] = [];
  const fleetRootCleoPath = join(fleetRoot, '.cleo');
  if (existsSync(fleetRootCleoPath) && !isLegitimateCleoProjectRoot(fleetRootCleoPath)) {
    warnings.push(buildOrphanWarning(fleetRootCleoPath));
  }
  warnings.push(...detectNestedNexusDuplicates());

  // T10323: in fleet mode we run cross-DB invariants per project. The
  // global-tier shape (nexus.db) is shared, but I1/I2/I4/I5 are
  // project-scoped — we want one set of reports per project root.
  const crossDbOrphans: DbCrossDbOrphanReport[] = [];
  for (const survey of projectSurveys) {
    crossDbOrphans.push(...walkCrossDbInvariants(survey.projectRoot));
  }

  return {
    scope: 'fleet',
    projects: projectSurveys,
    summary: summarizeSubstrateSurveys(projectSurveys),
    warnings,
    crossDbOrphans,
  };
}
