/**
 * Automatic first-run migration executor: project-tier signaldock.db → conduit.db.
 *
 * Implements ADR-037 §8 — on the first cleo invocation after upgrading to
 * v2026.4.12, if a project-tier `.cleo/signaldock.db` exists and
 * `.cleo/conduit.db` does not, this module migrates all project-local data to
 * conduit.db and copies global-identity rows to the global-tier signaldock.db.
 *
 * Key properties:
 *   - Idempotent: `needsSignaldockToConduitMigration` returns false once conduit.db exists.
 *   - Atomic per file: transactions are used for conduit.db and global signaldock.db writes.
 *   - Non-destructive: legacy signaldock.db is renamed to `.pre-t310.bak`, not deleted.
 *   - Multi-project safe: `INSERT OR IGNORE` prevents duplicate global rows when multiple
 *     projects migrate the same agent.
 *   - Migrated agents flagged `requires_reauth=1` (new KDF scheme, ADR-037 §5).
 *
 * @task T358
 * @epic T310
 * @why ADR-037 §8 — automatic first-run migration from the pre-T310 project-tier
 *      signaldock.db to the new T310 topology (conduit.db + global signaldock.db
 *      + global-salt). Runs once per project on first cleo invocation after upgrade.
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType, SQLInputValue } from 'node:sqlite';
import { getLogger } from '../logger.js';
import { getCleoHome } from '../paths.js';
import { ensureConduitDb, getConduitDbPath } from './conduit-sqlite.js';
import { getGlobalSalt } from './global-salt.js';
import { ensureGlobalSignaldockDb } from './signaldock-sqlite.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result returned by `migrateSignaldockToConduit`.
 *
 * @task T358
 * @epic T310
 */
export interface MigrationResult {
  /** `migrated` = migration ran and succeeded; `no-op` = not needed; `failed` = error occurred. */
  status: 'migrated' | 'no-op' | 'failed';
  /** Absolute path to the project root that was migrated. */
  projectRoot: string;
  /** Number of agents copied to global signaldock.db. */
  agentsCopied: number;
  /** Absolute path to the conduit.db that was created. */
  conduitPath: string;
  /** Absolute path to the global signaldock.db. */
  globalSignaldockPath: string;
  /** Absolute path to the legacy `.pre-t310.bak` file, or null if rename did not complete. */
  bakPath: string | null;
  /** Errors encountered during migration steps. Never thrown — always captured here. */
  errors: Array<{ step: string; error: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Project-local tables to copy from the legacy `signaldock.db` to the conduit DB.
 *
 * Each entry is a `{ src, dest }` pair. For most tables `src === dest`. The
 * attachment-family tables differ: the legacy `signaldock.db` stored them under
 * the BARE names (`attachments`, `attachment_versions`, …), but the consolidated
 * conduit forward migration now creates them under the `conduit_`-prefixed names
 * (T11563 — disjoint from the docs-domain bare `attachments` table that also
 * lives in the consolidated `cleo.db`). The copy must therefore map the legacy
 * source name to the prefixed destination name, otherwise rows would be inserted
 * into the unrelated docs `attachments` table.
 */
// T11578 (AC4): destinations are the PREFIXED consolidated `conduit_*` tables —
// the conduit runtime no longer materializes the BARE legacy tables. Copying
// from the legacy bare source into these prefixed targets is epoch-→-ISO coerced
// by copyTableRows for any target column carrying an ISO-8601 GLOB CHECK.
const PROJECT_TIER_TABLES = [
  { src: 'messages', dest: 'conduit_messages' },
  { src: 'conversations', dest: 'conduit_conversations' },
  { src: 'delivery_jobs', dest: 'conduit_delivery_jobs' },
  { src: 'dead_letters', dest: 'conduit_dead_letters' },
  { src: 'message_pins', dest: 'conduit_message_pins' },
  { src: 'attachments', dest: 'conduit_attachments' },
  { src: 'attachment_versions', dest: 'conduit_attachment_versions' },
  { src: 'attachment_approvals', dest: 'conduit_attachment_approvals' },
  { src: 'attachment_contributors', dest: 'conduit_attachment_contributors' },
] as const;

/** Global-identity tables to copy using INSERT OR IGNORE from legacy to global signaldock.db. */
const GLOBAL_IDENTITY_TABLES = [
  'agents',
  'capabilities',
  'skills',
  'agent_capabilities',
  'agent_skills',
  'agent_connections',
  'users',
  'accounts',
  'sessions',
  'verifications',
  'organization',
  'claim_codes',
  'org_agent_keys',
] as const;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the legacy migration is needed for the given project.
 *
 * Detection heuristic (ADR-037 §8):
 *   - `.cleo/signaldock.db` EXISTS AND `.cleo/conduit.db` DOES NOT EXIST
 *
 * Idempotent: returns false once conduit.db is present, regardless of .bak state.
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns True if migration is needed; false otherwise.
 *
 * @task T358
 * @epic T310
 */
export function needsSignaldockToConduitMigration(projectRoot: string): boolean {
  const legacyPath = join(projectRoot, '.cleo', 'signaldock.db');
  // E6-L3 (T11523): the conduit domain consolidated into the project `cleo.db`.
  // Probe the consolidated DB path (via getConduitDbPath) rather than the literal
  // legacy `conduit.db` — otherwise this one-shot legacy migration would believe
  // it is perpetually un-run on any post-consolidation project (`conduit.db` is
  // never created) and re-fire on every CLI startup.
  const conduitPath = getConduitDbPath(projectRoot);
  return existsSync(legacyPath) && !existsSync(conduitPath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether a table exists in the given database.
 *
 * @param db - An open DatabaseSync handle.
 * @param tableName - Name of the table to check.
 * @returns True if the table exists in sqlite_master.
 */
function tableExistsInDb(db: DatabaseSync, tableName: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(tableName) as { name: string } | undefined;
  return !!row;
}

/**
 * Get column names from a table in the given database.
 *
 * @param db - An open DatabaseSync handle.
 * @param tableName - Name of the table.
 * @returns Array of column names.
 */
function getTableColumns(db: DatabaseSync, tableName: string): string[] {
  const rows = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
    name: string;
    cid: number;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>;
  return rows.map((r) => r.name);
}

/**
 * Copy all rows from `srcTableName` in `srcDb` to `destTableName` in `destDb`.
 * Only columns that exist in both source and destination are copied (schema safety).
 * Uses INSERT OR IGNORE to handle unique constraint conflicts gracefully.
 *
 * Source and destination table names may differ (T11563): the conduit
 * attachment-family tables were renamed to `conduit_`-prefixed names in the
 * consolidated `cleo.db`, while the legacy `signaldock.db` source still uses the
 * bare names.
 *
 * @param srcDb - Source database (legacy signaldock.db).
 * @param destDb - Destination database (conduit.db or global signaldock.db).
 * @param srcTableName - Table to read rows from in `srcDb`.
 * @param destTableName - Table to write rows into in `destDb`. Defaults to `srcTableName`.
 * @param ignoreConflicts - When true uses INSERT OR IGNORE; when false uses INSERT.
 * @returns Number of rows found in source (not necessarily inserted — some may have been ignored).
 */
function copyTableRows(
  srcDb: DatabaseSync,
  destDb: DatabaseSync,
  srcTableName: string,
  destTableName: string = srcTableName,
  ignoreConflicts = false,
): number {
  const srcCols = getTableColumns(srcDb, srcTableName);
  const destCols = getTableColumns(destDb, destTableName);
  // Only copy columns that exist in both tables
  const cols = srcCols.filter((c) => destCols.includes(c));
  if (cols.length === 0) return 0;

  // T11578 (AC4): the prefixed `conduit_*` targets carry ISO-8601 TEXT timestamp
  // columns with an ISO GLOB CHECK, while the legacy bare source stored epoch
  // SECONDS integers. Coerce those columns to ISO so the verbatim row copy does
  // not fail (or, under INSERT OR IGNORE, silently drop) on the GLOB CHECK.
  const isoGlobCols = detectIsoGlobColumns(destDb, destTableName);

  const colList = cols.map((c) => `"${c}"`).join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const conflictClause = ignoreConflicts ? 'OR IGNORE' : '';
  const insertSql = `INSERT ${conflictClause} INTO "${destTableName}" (${colList}) VALUES (${placeholders})`;

  const rows = srcDb.prepare(`SELECT ${colList} FROM "${srcTableName}"`).all() as Record<
    string,
    unknown
  >[];
  if (rows.length === 0) return 0;

  const stmt = destDb.prepare(insertSql);
  for (const row of rows) {
    // Values originate from another SQLite row via prepare().all(), so at runtime
    // they are already SQLInputValue-compatible (string | number | bigint | Uint8Array | null).
    // The surrounding `Record<string, unknown>` type erases this, hence the narrow cast.
    const values = cols.map((c) => {
      const raw = row[c] ?? null;
      if (isoGlobCols.has(c) && typeof raw === 'number') {
        return epochSecondsToIso(raw);
      }
      return (raw ?? null) as SQLInputValue;
    });
    stmt.run(...values);
  }
  return rows.length;
}

/**
 * Regex matching the T11363-generated ISO-8601 GLOB CHECK constraint, e.g.
 * `CHECK ("created_at" IS NULL OR "created_at" GLOB '[0-9][0-9][0-9][0-9]-...')`.
 *
 * The constrained column name appears twice; we capture the first occurrence.
 *
 * @task T11578
 */
const ISO_GLOB_CHECK_REGEX = /CHECK\s*\(\s*"([^"]+)"\s+IS\s+NULL\s+OR\s+"[^"]+"\s+GLOB\s+'\[0-9/gi;

/**
 * Read a target table's DDL from `sqlite_master` and return the set of column
 * names that carry an ISO-8601 GLOB CHECK constraint (the consolidated
 * `conduit_*` timestamp columns introduced by T11363).
 *
 * @param db        - The destination DB handle (consolidated `cleo.db`).
 * @param tableName - Physical destination table name (e.g. `conduit_messages`).
 * @returns Set of column names requiring ISO-8601 TEXT values.
 * @task T11578
 */
function detectIsoGlobColumns(db: DatabaseSync, tableName: string): Set<string> {
  const escaped = tableName.replace(/'/g, "''");
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='${escaped}'`)
    .get() as { sql: string | null } | undefined;
  const out = new Set<string>();
  if (!row?.sql) return out;
  ISO_GLOB_CHECK_REGEX.lastIndex = 0; // global regex is stateful — reset before reuse
  for (const match of row.sql.matchAll(ISO_GLOB_CHECK_REGEX)) {
    const col = match[1];
    if (col) out.add(col);
  }
  return out;
}

/**
 * Convert a legacy epoch-SECONDS integer to a canonical ISO-8601 UTC string.
 *
 * The legacy conduit writers stored timestamps as `Math.floor(Date.now() / 1000)`
 * (§8.1 — seconds, never milliseconds), so this multiplies by 1000 before
 * constructing the `Date`. Used by {@link copyTableRows} to satisfy the ISO GLOB
 * CHECK on the prefixed `conduit_*` targets (T11578 · AC4).
 *
 * @param epochSeconds - Epoch seconds value from a legacy bare conduit row.
 * @returns ISO-8601 UTC timestamp string.
 * @task T11578
 */
function epochSecondsToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/**
 * Run PRAGMA integrity_check on `db` and return true if it passes.
 *
 * @param db - An open DatabaseSync handle.
 * @returns True if integrity_check returns 'ok'.
 */
function integrityCheckPasses(db: DatabaseSync): boolean {
  const rows = db.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>;
  return rows.length === 1 && rows[0]?.integrity_check === 'ok';
}

/**
 * Generate a timestamp suffix for broken-file names: `YYYYMMDD-HHmmss-mmm`.
 */
function brokenTimestamp(): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return (
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}` +
    `-${pad3(now.getMilliseconds())}`
  );
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

/**
 * Runs the signaldock.db → conduit.db migration for the given project.
 *
 * The migration is atomic per file (SQLite transactions for DB writes, atomic
 * rename for the backup step). Failures are captured in `result.errors` and
 * the function never throws — callers receive a `MigrationResult` with
 * `status: 'failed'` on error.
 *
 * Safe to call when no migration is needed (returns `{status: 'no-op', ...}`).
 * Safe to call on a partially-migrated install (idempotent via needsMigration check).
 *
 * @param projectRoot - Absolute path to the project root directory.
 * @returns A `MigrationResult` describing what was done and any errors encountered.
 *
 * @task T358
 * @epic T310
 */
export async function migrateSignaldockToConduit(projectRoot: string): Promise<MigrationResult> {
  const log = getLogger('migrate-signaldock-to-conduit');
  const legacyPath = join(projectRoot, '.cleo', 'signaldock.db');
  // E6-L3 (T11523): the conduit domain now lives in the consolidated project
  // `cleo.db`. Report that path as the migration target.
  const conduitPath = getConduitDbPath(projectRoot);
  const globalSignaldockPath = join(getCleoHome(), 'signaldock.db');
  const bakPath = `${legacyPath}.pre-t310.bak`;

  const result: MigrationResult = {
    status: 'no-op',
    projectRoot,
    agentsCopied: 0,
    conduitPath,
    globalSignaldockPath,
    bakPath: null,
    errors: [],
  };

  // -----------------------------------------------------------------------
  // Step 1: Check if migration is needed
  // -----------------------------------------------------------------------
  if (!needsSignaldockToConduitMigration(projectRoot)) {
    return result;
  }

  log.info({ projectRoot, legacyPath }, 'T310 migration: starting signaldock.db → conduit.db');

  // -----------------------------------------------------------------------
  // Step 2: Open legacy signaldock.db in READ-ONLY mode
  // -----------------------------------------------------------------------
  let legacy: DatabaseSync | null = null;
  try {
    legacy = new DatabaseSync(legacyPath, { readOnly: true });
    applyPerfPragmas(legacy, { enableWal: false }); // read-only: WAL cannot be set (T9023)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ legacyPath, error: message }, 'T310 migration: cannot open legacy signaldock.db');
    result.errors.push({ step: 'step-2-open-legacy', error: message });
    result.status = 'failed';
    return result;
  }

  // -----------------------------------------------------------------------
  // Step 3: Verify legacy integrity
  // -----------------------------------------------------------------------
  try {
    if (!integrityCheckPasses(legacy)) {
      const msg =
        'Legacy signaldock.db failed PRAGMA integrity_check. ' +
        'Migration aborted — no changes written. ' +
        'Recovery: inspect the database with sqlite3 and attempt manual repair before re-running.';
      log.error({ legacyPath }, msg);
      result.errors.push({ step: 'step-3-legacy-integrity', error: msg });
      result.status = 'failed';
      legacy.close();
      return result;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ legacyPath, error: message }, 'T310 migration: integrity_check threw on legacy DB');
    result.errors.push({ step: 'step-3-legacy-integrity', error: message });
    result.status = 'failed';
    legacy.close();
    return result;
  }

  // -----------------------------------------------------------------------
  // Steps 4–5: Ensure global cleo home + global signaldock.db exist
  // -----------------------------------------------------------------------
  const cleoHome = getCleoHome();
  try {
    if (!existsSync(cleoHome)) {
      mkdirSync(cleoHome, { recursive: true });
    }
    // ensureGlobalSignaldockDb is async but we need it sync here; open directly.
    // The global signaldock schema is applied by ensureGlobalSignaldockDb() when
    // the CLI starts. For migration purposes we open the DB (creating it if needed)
    // and rely on the schema already having been applied (or apply it inline).
    // We call ensureGlobalSignaldockDb() in a fire-and-forget style here, and
    // handle the open synchronously below with DatabaseSync.
    void ensureGlobalSignaldockDb();
  } catch {
    // Non-fatal: the global DB open below will create the file if needed.
  }

  // -----------------------------------------------------------------------
  // Step 6: Ensure global-salt exists (generates if absent)
  // -----------------------------------------------------------------------
  try {
    getGlobalSalt();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'T310 migration: getGlobalSalt failed — migration aborted');
    result.errors.push({ step: 'step-6-global-salt', error: message });
    result.status = 'failed';
    legacy.close();
    return result;
  }

  // -----------------------------------------------------------------------
  // Step 7: Create conduit.db via ensureConduitDb (applies full schema)
  // -----------------------------------------------------------------------
  let conduit: DatabaseSync | null = null;
  try {
    const ensureResult = await ensureConduitDb(projectRoot);
    // Open a direct handle for migration writes (ensureConduitDb returns singleton;
    // we open a fresh handle to avoid interfering with any singleton state).
    conduit = new DatabaseSync(ensureResult.path);
    applyPerfPragmas(conduit, { enableForeignKeys: false }); // FK off during bulk copy (T9023)
    // Explicitly disable FK for this handle: node:sqlite preserves PRAGMA foreign_keys
    // state across connections within a process (per-file internal cache), so simply
    // omitting the pragma (enableForeignKeys: false → null → skipped) is insufficient
    // when a prior handle set FK=ON. The explicit OFF here ensures bulk INSERT is not
    // blocked by cross-table FK ordering (messages before conversations in PROJECT_TIER_TABLES).
    conduit.exec('PRAGMA foreign_keys = OFF');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ conduitPath, error: message }, 'T310 migration: failed to create conduit.db');
    result.errors.push({ step: 'step-7-create-conduit', error: message });
    result.status = 'failed';
    legacy.close();
    return result;
  }

  // -----------------------------------------------------------------------
  // Steps 8–9: Copy project-tier tables + derive project_agent_refs + COMMIT
  // -----------------------------------------------------------------------
  try {
    conduit.exec('BEGIN TRANSACTION');

    // Copy project-local messaging tables verbatim. Source/destination names may
    // differ for the conduit attachment-family tables (T11563).
    for (const { src, dest } of PROJECT_TIER_TABLES) {
      if (tableExistsInDb(legacy, src) && tableExistsInDb(conduit, dest)) {
        copyTableRows(legacy, conduit, src, dest, false);
      }
    }

    // Rebuild FTS after message copy (T11578 · AC4: prefixed FTS index).
    if (tableExistsInDb(conduit, 'conduit_messages_fts')) {
      try {
        conduit.exec("INSERT INTO conduit_messages_fts(conduit_messages_fts) VALUES('rebuild')");
      } catch {
        // FTS rebuild failure is non-fatal — the triggers will populate it over time
      }
    }

    // Derive project_agent_refs from legacy agents table
    let agentsCountForConduit = 0;
    if (tableExistsInDb(legacy, 'agents')) {
      const legacyAgents = legacy.prepare('SELECT * FROM agents').all() as Array<
        Record<string, unknown>
      >;

      const hasClassificationCol = getTableColumns(legacy, 'agents').includes('classification');
      const hasLastUsedAtCol = getTableColumns(legacy, 'agents').includes('last_used_at');
      const hasCreatedAtCol = getTableColumns(legacy, 'agents').includes('created_at');
      const hasAgentIdCol = getTableColumns(legacy, 'agents').includes('agent_id');

      for (const agent of legacyAgents) {
        const agentId = hasAgentIdCol ? (agent['agent_id'] as string) : (agent['id'] as string);
        if (!agentId) continue;

        const createdAtRaw = hasCreatedAtCol ? (agent['created_at'] as number | null) : null;
        const attachedAt =
          createdAtRaw != null
            ? new Date(createdAtRaw * 1000).toISOString()
            : new Date().toISOString();

        const role = hasClassificationCol ? (agent['classification'] as string | null) : null;

        const lastUsedAtRaw = hasLastUsedAtCol ? (agent['last_used_at'] as number | null) : null;
        const lastUsedAt =
          lastUsedAtRaw != null ? new Date(lastUsedAtRaw * 1000).toISOString() : null;

        conduit
          .prepare(
            `INSERT OR IGNORE INTO conduit_project_agent_refs
               (agent_id, attached_at, role, capabilities_override, last_used_at, enabled)
             VALUES (?, ?, ?, NULL, ?, 1)`,
          )
          .run(agentId, attachedAt, role, lastUsedAt);

        agentsCountForConduit++;
      }
    }

    conduit.exec('COMMIT');
    result.agentsCopied = agentsCountForConduit;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'T310 migration: conduit.db write failed — rolling back');
    result.errors.push({ step: 'step-8-conduit-write', error: message });
    result.status = 'failed';

    try {
      conduit.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors
    }
    conduit.close();
    conduit = null;
    // Delete partial conduit.db
    try {
      if (existsSync(conduitPath)) {
        unlinkSync(conduitPath);
      }
    } catch {
      // Ignore deletion errors
    }
    legacy.close();
    return result;
  }

  // -----------------------------------------------------------------------
  // Step 10: PRAGMA integrity_check on conduit.db
  // -----------------------------------------------------------------------
  try {
    if (!integrityCheckPasses(conduit)) {
      const msg = 'conduit.db failed PRAGMA integrity_check after write';
      log.error({ conduitPath }, msg);
      result.errors.push({ step: 'step-10-conduit-integrity', error: msg });
      result.status = 'failed';
      conduit.close();
      conduit = null;
      // Move broken conduit.db
      const brokenPath = `${conduitPath}.broken-${brokenTimestamp()}`;
      try {
        renameSync(conduitPath, brokenPath);
      } catch {
        // Ignore rename errors
      }
      legacy.close();
      return result;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'T310 migration: conduit.db integrity_check threw');
    result.errors.push({ step: 'step-10-conduit-integrity', error: message });
    result.status = 'failed';
    if (conduit) {
      conduit.close();
      conduit = null;
    }
    legacy.close();
    return result;
  }

  // Close our migration handle for conduit; the singleton from ensureConduitDb is untouched
  conduit.close();
  conduit = null;

  // -----------------------------------------------------------------------
  // Steps 11–13: Copy global-identity rows to global signaldock.db
  // -----------------------------------------------------------------------
  let globalDb: DatabaseSync | null = null;
  try {
    if (!existsSync(globalSignaldockPath)) {
      // Ensure the schema exists — open and apply minimal schema
      // ensureGlobalSignaldockDb() was called above (async); give it a chance
      // to complete by opening directly here.
      mkdirSync(cleoHome, { recursive: true });
    }
    globalDb = new DatabaseSync(globalSignaldockPath);
    applyPerfPragmas(globalDb, { enableForeignKeys: false }); // FK off during bulk copy (T9023)
    globalDb.exec('PRAGMA foreign_keys = OFF'); // Explicit OFF — same node:sqlite per-file FK cache issue (T9023)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { globalSignaldockPath, error: message },
      'T310 migration: cannot open global signaldock.db',
    );
    result.errors.push({ step: 'step-11-open-global', error: message });
    result.status = 'failed';
    legacy.close();
    return result;
  }

  let agentsCopiedToGlobal = 0;
  try {
    globalDb.exec('BEGIN TRANSACTION');

    // Copy all global-identity tables using INSERT OR IGNORE. Source and
    // destination share the same name for this tier.
    for (const tableName of GLOBAL_IDENTITY_TABLES) {
      if (tableExistsInDb(legacy, tableName) && tableExistsInDb(globalDb, tableName)) {
        copyTableRows(legacy, globalDb, tableName, tableName, true /* ignoreConflicts */);
      }
    }

    // Count agents actually in legacy
    if (tableExistsInDb(legacy, 'agents')) {
      const countRow = legacy.prepare('SELECT COUNT(*) as cnt FROM agents').get() as {
        cnt: number;
      };
      agentsCopiedToGlobal = countRow.cnt;
    }

    // Mark ALL migrated agents as requiring reauth (new KDF scheme)
    // Only mark rows that came from THIS legacy (i.e., all rows — INSERT OR IGNORE
    // means existing rows were skipped; their requires_reauth stays unchanged).
    // We mark every agent we inserted (agent_id from legacy) as requires_reauth=1.
    if (tableExistsInDb(legacy, 'agents') && tableExistsInDb(globalDb, 'agents')) {
      const legacyAgentIds = legacy.prepare('SELECT agent_id FROM agents').all() as Array<{
        agent_id: string;
      }>;

      for (const { agent_id } of legacyAgentIds) {
        // Only update if this is a newly-inserted row (requires_reauth=0 means it was
        // either newly inserted or pre-existing with requires_reauth not set).
        // We unconditionally set requires_reauth=1 for all agents from this migration;
        // if the row was already present (INSERT OR IGNORE skipped it), we leave it.
        // To detect new insertions: compare changes() or use a marker.
        // Per spec: mark all migrated agents requires_reauth=1.
        // We use a conservative approach: only update if the row was NOT pre-existing.
        // Since INSERT OR IGNORE doesn't tell us if a row was inserted or ignored,
        // we use the approach of: set requires_reauth=1 WHERE requires_reauth=0.
        // This safely marks newly-inserted agents and leaves pre-existing ones unchanged.
        globalDb
          .prepare(
            'UPDATE agents SET requires_reauth = 1 WHERE agent_id = ? AND requires_reauth = 0',
          )
          .run(agent_id);
      }
    }

    globalDb.exec('COMMIT');
    result.agentsCopied = agentsCopiedToGlobal;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { error: message },
      'T310 migration: global signaldock.db write failed — rolling back',
    );
    result.errors.push({ step: 'step-12-global-write', error: message });
    result.status = 'failed';

    try {
      globalDb.exec('ROLLBACK');
    } catch {
      // Ignore rollback errors
    }
    globalDb.close();
    globalDb = null;
    legacy.close();
    // conduit.db is valid — leave it in place
    return result;
  }

  // -----------------------------------------------------------------------
  // Step 14: PRAGMA integrity_check on global signaldock.db
  // -----------------------------------------------------------------------
  try {
    if (!integrityCheckPasses(globalDb)) {
      const msg = 'Global signaldock.db failed PRAGMA integrity_check after write';
      log.error({ globalSignaldockPath }, msg);
      result.errors.push({ step: 'step-14-global-integrity', error: msg });
      result.status = 'failed';
      globalDb.close();
      globalDb = null;
      const brokenPath = `${globalSignaldockPath}.broken-${brokenTimestamp()}`;
      try {
        renameSync(globalSignaldockPath, brokenPath);
      } catch {
        // Ignore rename errors
      }
      legacy.close();
      return result;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ error: message }, 'T310 migration: global signaldock.db integrity_check threw');
    result.errors.push({ step: 'step-14-global-integrity', error: message });
    result.status = 'failed';
    if (globalDb) {
      globalDb.close();
      globalDb = null;
    }
    legacy.close();
    return result;
  }

  globalDb.close();
  globalDb = null;

  // -----------------------------------------------------------------------
  // Step 15: Ensure global-salt exists (already done in step 6, re-check)
  // -----------------------------------------------------------------------
  // Salt was already ensured in step 6 — no repeat action needed.

  // -----------------------------------------------------------------------
  // Step 16: Atomic rename legacy → .pre-t310.bak
  // -----------------------------------------------------------------------
  legacy.close();
  legacy = null;

  try {
    renameSync(legacyPath, bakPath);
    result.bakPath = bakPath;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Non-fatal per spec §4.4: next run will re-attempt (conduit.db absent check
    // handles idempotency). But here conduit.db IS present, so needsMigration
    // returns false on next run — the legacy file stays around harmlessly.
    log.error(
      { legacyPath, bakPath, error: message },
      'T310 migration: rename to .pre-t310.bak failed — legacy file left in place (harmless)',
    );
    result.errors.push({ step: 'step-16-rename-bak', error: message });
    // Still consider the migration successful — conduit.db and global signaldock.db are valid.
  }

  // -----------------------------------------------------------------------
  // Step 17: Success logs
  // -----------------------------------------------------------------------
  log.info(
    { projectRoot, agentsCopied: result.agentsCopied, conduitPath, bakPath: result.bakPath },
    `T310 migration complete: ${result.agentsCopied} agents migrated to global, conduit.db created`,
  );
  log.warn(
    {},
    'T310 migration: API keys have been re-keyed. External systems holding old API keys ' +
      '(CI env vars, remote agent configs) must be updated.',
  );
  log.info(
    { legacyPath, bakPath: result.bakPath, conduitPath },
    'T310 migration recovery: if problems occur, rename .pre-t310.bak to signaldock.db ' +
      'and delete conduit.db to re-run migration.',
  );

  result.status = 'migrated';
  return result;
}
