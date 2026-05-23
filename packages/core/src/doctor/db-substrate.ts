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
 * @epic T10282
 * @saga T10281
 * @see ADR-068 — CLEO Database Charter
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  DB_INVENTORY,
  type DbInventoryEntry,
  type DbSubstrateAuditResult,
  type DbSubstrateEntry,
  type DbSubstrateProjectSurvey,
  type DbSubstrateSummary,
  type DbSubstrateWarning,
} from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { openCleoDbSnapshot } from '../store/open-cleo-db.js';

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
 * Detect orphan project-root `.cleo/` directories at the PARENT of a
 * known project root.
 *
 * @remarks
 * The T9550 regression class wrote `.cleo/` at a project's parent path
 * (e.g. `/mnt/projects/.cleo/`) when `cwd` resolution miscascaded. This
 * helper checks the parent for a `.cleo/` directory and, if found,
 * surfaces it as a warning.
 *
 * @param projectRoot - Absolute path to one project root.
 * @returns A warning if `<parent>/.cleo/` exists; otherwise `null`.
 */
export function detectOrphanProjectRootWarning(projectRoot: string): DbSubstrateWarning | null {
  const parent = dirname(projectRoot);
  if (parent === projectRoot) {
    // We're at the filesystem root — no parent to scan.
    return null;
  }
  const orphanCleoPath = join(parent, '.cleo');
  if (!existsSync(orphanCleoPath)) {
    return null;
  }
  let lastWriteMs: number | null = null;
  try {
    lastWriteMs = statSync(orphanCleoPath).mtimeMs;
  } catch {
    // Ignore — leave null.
  }
  return {
    kind: 'orphan-project-root',
    path: orphanCleoPath,
    lastWriteMs,
  };
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

  // Fleet-wide warnings: orphan project-root .cleo/ at fleetRoot itself,
  // plus per-project parent-orphan detection, plus nested-nexus.
  const warnings: DbSubstrateWarning[] = [];
  if (existsSync(join(fleetRoot, '.cleo'))) {
    let lastWriteMs: number | null = null;
    try {
      lastWriteMs = statSync(join(fleetRoot, '.cleo')).mtimeMs;
    } catch {
      // Ignore — leave null.
    }
    warnings.push({
      kind: 'orphan-project-root',
      path: join(fleetRoot, '.cleo'),
      lastWriteMs,
    });
  }
  warnings.push(...detectNestedNexusDuplicates());

  return {
    scope: 'fleet',
    projects: projectSurveys,
    summary: summarizeSubstrateSurveys(projectSurveys),
    warnings,
  };
}
