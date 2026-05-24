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

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DB_INVENTORY,
  type DbInventoryEntry,
  type DbSubstrateAuditResult,
  type DbSubstrateEntry,
  type DbSubstrateMigrationCoverage,
  type DbSubstrateMigrationMissing,
  type DbSubstrateMigrationOrphan,
  type DbSubstrateProjectSurvey,
  type DbSubstrateSummary,
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
 * 3. Returns a fully-populated {@link DbSubstrateEntry} — all `null`
 *    fields are explicit rather than absent.
 *
 * Snapshot handle is always closed before returning, even on error.
 *
 * @param entry - The `DB_INVENTORY` row being inspected.
 * @param filePath - The resolved absolute path to the DB file.
 * @returns A populated {@link DbSubstrateEntry}.
 */
export function inspectDbFile(entry: DbInventoryEntry, filePath: string): DbSubstrateEntry {
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
  try {
    snapshot = openCleoDbSnapshot(filePath, { readOnly: true, applyPragmas: false });

    // PRAGMA integrity_check returns rows with column `integrity_check`.
    type IntegrityRow = { integrity_check: string };
    const integrityRows = snapshot.db.prepare('PRAGMA integrity_check').all() as IntegrityRow[];
    const integrityOK = integrityRows.length === 1 && integrityRows[0]?.integrity_check === 'ok';

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

    // Migration coverage cross-check (T10311). Only attempted when the
    // inventory declares a non-null `migrationsDir` AND the DB passed
    // integrity_check — there's no point cross-referencing a corrupt
    // journal against the file system.
    let migrationCoverage: DbSubstrateMigrationCoverage | null = null;
    if (integrityOK && entry.migrationsDir !== null) {
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
      integrityOK,
      rowCounts,
      lastWriteMs,
      sizeBytes,
      error: null,
      suggestedFix: integrityOK ? null : `cleo backup recover ${entry.role}`,
      migrationCoverage,
      pragmaDrift,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      filePath,
      exists: true,
      integrityOK: false,
      rowCounts: null,
      lastWriteMs,
      sizeBytes,
      error: message,
      suggestedFix: `cleo backup recover ${entry.role}`,
      migrationCoverage: null,
      pragmaDrift: null,
    };
  } finally {
    snapshot?.close();
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
 * @returns One {@link DbSubstrateProjectSurvey} keyed by canonical role.
 */
export function surveyProjectDbSubstrate(projectRoot: string): DbSubstrateProjectSurvey {
  const dbs: Record<string, DbSubstrateEntry> = {};
  for (const entry of DB_INVENTORY) {
    const filePath = resolveInventoryFilePath(entry, projectRoot);
    dbs[entry.role] = inspectDbFile(entry, filePath);
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
 * @returns The full {@link DbSubstrateAuditResult} with `scope='project'`.
 */
export function surveyDbSubstrate(projectRoot: string): DbSubstrateAuditResult {
  const projectSurvey = surveyProjectDbSubstrate(projectRoot);
  const warnings: DbSubstrateWarning[] = [];
  const orphan = detectOrphanProjectRootWarning(projectRoot);
  if (orphan) {
    warnings.push(orphan);
  }
  warnings.push(...detectNestedNexusDuplicates());
  return {
    scope: 'project',
    projects: [projectSurvey],
    summary: summarizeSubstrateSurveys([projectSurvey]),
    warnings,
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
 * @returns A {@link DbSubstrateAuditResult} with `scope='fleet'`.
 */
export function surveyFleetDbSubstrate(fleetRoot: string): DbSubstrateAuditResult {
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
    const survey = surveyProjectDbSubstrate(projectRoot);
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

  return {
    scope: 'fleet',
    projects: projectSurveys,
    summary: summarizeSubstrateSurveys(projectSurveys),
    warnings,
  };
}
