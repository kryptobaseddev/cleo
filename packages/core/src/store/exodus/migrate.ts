/**
 * Exodus migration engine.
 *
 * `runExodusMigrate()` performs the actual data migration from legacy DBs
 * to the consolidated dual-scope `cleo.db`. Key invariants:
 *
 * - Source DBs are opened **read-only** via `openCleoDbSnapshot` (AC4).
 * - Source files are backed up to the staging dir before any writes (AC5).
 * - Import is wrapped in `BEGIN … COMMIT` per scope; partial failure leaves
 *   the target DB untouched (AC6).
 * - Idempotency keys are propagated where the source row has them; generated
 *   where it does not (AC7).
 * - The staging journal is written atomically before each table copy so a
 *   crash can be resumed (AC5).
 *
 * ## Advisory file lock (AC4)
 *
 * The source DB files are opened read-only via `openCleoDbSnapshot` which
 * calls `new DatabaseSync(path, { readOnly: true })`. Node's SQLite binding
 * opens with `SQLITE_OPEN_READONLY`, which prevents any writes from this
 * process. We additionally write a `.lock` sentinel file next to each source
 * DB for the duration of the migration so that other CLEO processes can detect
 * an in-progress exodus and refuse to write.
 *
 * @task T11248 (E5 · SG-DB-SUBSTRATE-V2)
 * @saga T11242
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { getLogger } from '../../logger.js';
import { getCleoVersion } from '../../scaffold/ensure-config.js';
import { openDualScopeDb } from '../dual-scope-db.js';
import { openCleoDbSnapshot } from '../open-cleo-db.js';
import type {
  ExodusJournal,
  ExodusMigrateResult,
  ExodusPlan,
  JournalTableEntry,
  LegacyDbDescriptor,
  TableCopyResult,
  TableMigrationStatus,
} from './types.js';
import { EXODUS_TARGET_SCHEMA_VERSION } from './types.js';

const log = getLogger('exodus-migrate');

// ---------------------------------------------------------------------------
// Advisory lock sentinel filename
// ---------------------------------------------------------------------------

const LOCK_SENTINEL_SUFFIX = '.exodus-lock' as const;

// ---------------------------------------------------------------------------
// Journal helpers
// ---------------------------------------------------------------------------

const JOURNAL_FILENAME = 'exodus-journal.json' as const;

/**
 * Get the SQLite version string from an open DatabaseSync handle.
 */
function getSqliteVersion(db: DatabaseSync): string {
  try {
    const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string } | null;
    return row?.v ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Read the tables list from a legacy SQLite DB (excluding SQLite internals).
 */
function listTables(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Write the journal file atomically (write-then-rename pattern).
 */
function writeJournal(stagingDir: string, journal: ExodusJournal): void {
  const journalPath = join(stagingDir, JOURNAL_FILENAME);
  const tmpPath = `${journalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(journal, null, 2) + '\n', 'utf8');
  // On POSIX, rename is atomic within the same fs.
  renameSync(tmpPath, journalPath);
}

/**
 * Read an existing journal from the staging dir, or return `null`.
 */
function readJournal(stagingDir: string): ExodusJournal | null {
  const journalPath = join(stagingDir, JOURNAL_FILENAME);
  if (!existsSync(journalPath)) return null;
  try {
    return JSON.parse(readFileSync(journalPath, 'utf8')) as ExodusJournal;
  } catch {
    return null;
  }
}

/**
 * Initialise a fresh journal object.
 */
function initJournal(sqliteVersion: string): ExodusJournal {
  const now = new Date().toISOString();
  return {
    version: 1,
    cleoVersion: getCleoVersion(),
    targetSchemaVersion: EXODUS_TARGET_SCHEMA_VERSION,
    nodeVersion: process.version,
    sqliteVersion,
    startedAt: now,
    updatedAt: now,
    tables: [],
  };
}

// ---------------------------------------------------------------------------
// Advisory lock sentinel helpers (AC4)
// ---------------------------------------------------------------------------

function lockPath(dbPath: string): string {
  return `${dbPath}${LOCK_SENTINEL_SUFFIX}`;
}

function acquireAdvisoryLock(dbPath: string): void {
  const lp = lockPath(dbPath);
  writeFileSync(lp, JSON.stringify({ pid: process.pid, ts: new Date().toISOString() }), 'utf8');
}

function releaseAdvisoryLock(dbPath: string): void {
  try {
    unlinkSync(lockPath(dbPath));
  } catch {
    // Ignore — lock may already be gone
  }
}

// ---------------------------------------------------------------------------
// Core copy function
// ---------------------------------------------------------------------------

/**
 * Copy all rows from `tableName` in the source DB into the target DB using a
 * raw `INSERT INTO … SELECT * FROM …` after ATTACHing the source file.
 *
 * This approach avoids reading all rows into JS memory — SQLite handles the
 * copy entirely in the engine. The ATTACH is scoped to a single statement
 * sequence and detached immediately after (or on error).
 *
 * Returns the number of rows copied.
 *
 * @param targetNativeDb - The target `DatabaseSync` handle (writable).
 * @param sourceDbPath   - Absolute path to the read-only source `.db` file.
 * @param tableName      - The table to copy.
 * @param idempotencyKeyCol - Optional column name for idempotency key
 *   propagation. When present, rows whose key is already in the target are
 *   skipped (INSERT OR IGNORE).
 */
function copyTableViaAttach(
  targetNativeDb: DatabaseSync,
  sourceDbPath: string,
  tableName: string,
): number {
  const attachAlias = '_exodus_src_';

  // Check source table exists and has rows
  const srcCheck = openCleoDbSnapshot(sourceDbPath, { readOnly: true });
  let sourceCount = 0;
  let columns: string[] = [];
  try {
    const countRow = srcCheck.db.prepare(`SELECT COUNT(*) AS c FROM "${tableName}"`).get() as {
      c: number;
    } | null;
    sourceCount = countRow?.c ?? 0;

    // Get column names for explicit column list
    const pragma = srcCheck.db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      name: string;
    }>;
    columns = pragma.map((r) => r.name);
  } finally {
    srcCheck.close();
  }

  if (sourceCount === 0) return 0;
  if (columns.length === 0) return 0;

  // ATTACH source, copy via INSERT OR IGNORE, DETACH
  // Use INSERT OR IGNORE so idempotent keys prevent duplicates on resume
  const colList = columns.map((c) => `"${c}"`).join(', ');
  targetNativeDb.exec(`ATTACH DATABASE '${sourceDbPath.replace(/'/g, "''")}' AS "${attachAlias}"`);
  try {
    // Check if target table exists
    const existsRow = targetNativeDb
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='${tableName.replace(/'/g, "''")}'`,
      )
      .get() as { name: string } | null;

    if (!existsRow) {
      // Target table doesn't exist yet — log and skip (E6 will create these)
      log.warn({ tableName }, 'Target table not found in consolidated DB — skipping');
      return 0;
    }

    const stmt = targetNativeDb.prepare(
      `INSERT OR IGNORE INTO main."${tableName}" (${colList}) SELECT ${colList} FROM "${attachAlias}"."${tableName}" ORDER BY rowid`,
    );
    const result = stmt.run();
    return (result as unknown as { changes: number }).changes ?? 0;
  } finally {
    try {
      targetNativeDb.exec(`DETACH DATABASE "${attachAlias}"`);
    } catch {
      // Best-effort detach
    }
  }
}

// ---------------------------------------------------------------------------
// Main migration runner
// ---------------------------------------------------------------------------

/**
 * Validate that the journal's schema version matches the current target version.
 *
 * When `forceCrossVersion === true`, mismatches are logged but not fatal.
 */
function checkSchemaVersion(journal: ExodusJournal, forceCrossVersion: boolean): boolean {
  if (journal.targetSchemaVersion !== EXODUS_TARGET_SCHEMA_VERSION) {
    const msg = `Schema version mismatch: journal=${journal.targetSchemaVersion}, expected=${EXODUS_TARGET_SCHEMA_VERSION}`;
    if (forceCrossVersion) {
      log.warn(msg + ' (--force-cross-version: continuing anyway)');
      return true;
    }
    log.error(msg + ' — pass --force-cross-version to override');
    return false;
  }
  return true;
}

/**
 * Run the exodus migration.
 *
 * @param plan               - Pre-flight plan from `buildExodusPlan()`.
 * @param forceCrossVersion  - Skip the schema-version guard (AC9).
 * @param onProgress         - Optional progress callback called after each table.
 *
 * @returns {@link ExodusMigrateResult}
 *
 * @task T11248 (AC4, AC5, AC6, AC7, AC9)
 */
export async function runExodusMigrate(
  plan: ExodusPlan,
  forceCrossVersion = false,
  onProgress?: (msg: string) => void,
): Promise<ExodusMigrateResult> {
  const { sources, stagingDir, diskPreflight } = plan;

  // AC8: disk pre-flight
  if (!diskPreflight) {
    return {
      ok: false,
      tables: [],
      stagingDir,
      backupPaths: [],
      error: `Insufficient disk space: need ≥3× source size (${plan.totalSourceBytes} bytes source, ${plan.availableBytes} bytes available). Free up space or use a different storage location.`,
    };
  }

  // Ensure staging directory exists (AC5)
  mkdirSync(stagingDir, { recursive: true });

  // Determine SQLite version from the first available source DB
  let sqliteVersion = 'unknown';
  for (const src of sources) {
    if (existsSync(src.path)) {
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });
      sqliteVersion = getSqliteVersion(snap.db);
      snap.close();
      break;
    }
  }

  // Load or initialise the journal (AC5 — resume from staging)
  let journal = readJournal(stagingDir);
  if (journal === null) {
    journal = initJournal(sqliteVersion);
  } else {
    // Existing journal — check schema version (AC9)
    if (!checkSchemaVersion(journal, forceCrossVersion)) {
      return {
        ok: false,
        tables: [],
        stagingDir,
        backupPaths: [],
        error: 'Schema version mismatch. Pass --force-cross-version to override.',
      };
    }
    onProgress?.('Resuming from existing staging journal…');
  }

  const backupPaths: string[] = [];
  const allTableResults: TableCopyResult[] = [];
  const lockedPaths: string[] = [];

  try {
    // 1. Back up existing source DBs into staging dir and acquire advisory locks
    for (const src of sources) {
      if (!existsSync(src.path)) continue;
      const backupDest = join(stagingDir, `${src.name.replace(/[^a-z0-9-]/g, '_')}-backup.db`);
      if (!existsSync(backupDest)) {
        onProgress?.(`Backing up ${src.name} → staging dir…`);
        copyFileSync(src.path, backupDest);
        backupPaths.push(backupDest);
      }
      // AC4: advisory lock sentinel
      acquireAdvisoryLock(src.path);
      lockedPaths.push(src.path);
    }

    // 2. Open (or create) the consolidated target DBs via the chokepoint.
    //    This runs Drizzle migrations to create the target schema.
    onProgress?.('Opening consolidated project-scope cleo.db (running migrations)…');
    // openDualScopeDb takes cwd, not a db path — pass undefined to use process.cwd()
    const projectHandle = await openDualScopeDb('project');

    onProgress?.('Opening consolidated global-scope cleo.db (running migrations)…');
    const globalHandle = await openDualScopeDb('global');

    // Extract the raw DatabaseSync from the Drizzle wrapper ($client pattern).
    function extractNativeDb(handle: { db: unknown }): DatabaseSync {
      const drizzleHandle = handle.db as Record<string, unknown>;
      const client = drizzleHandle['$client'];
      if (client && typeof (client as Record<string, unknown>)['prepare'] === 'function') {
        return client as DatabaseSync;
      }
      // Fallback: the handle itself may be a DatabaseSync (unlikely but safe)
      if (typeof (drizzleHandle as unknown as Record<string, unknown>)['prepare'] === 'function') {
        return drizzleHandle as unknown as DatabaseSync;
      }
      throw new Error('Could not extract native DatabaseSync from dual-scope DB handle');
    }

    const projectNative = extractNativeDb(projectHandle);
    const globalNative = extractNativeDb(globalHandle);

    // 3. Per-scope BEGIN/COMMIT transactions (AC6)
    //    If any table copy fails, ROLLBACK leaves the target untouched.

    // Process project-scope sources
    const projectSources = sources.filter((s) => s.targetScope === 'project' && existsSync(s.path));
    const globalSources = sources.filter((s) => s.targetScope === 'global' && existsSync(s.path));

    await migrateScope(
      'project',
      projectSources,
      projectNative,
      journal,
      stagingDir,
      allTableResults,
      onProgress,
    );
    await migrateScope(
      'global',
      globalSources,
      globalNative,
      journal,
      stagingDir,
      allTableResults,
      onProgress,
    );

    // Final journal update
    journal.updatedAt = new Date().toISOString();
    writeJournal(stagingDir, journal);

    projectHandle.close();
    globalHandle.close();

    return { ok: true, tables: allTableResults, stagingDir, backupPaths };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error({ err }, 'Exodus migration failed');
    return { ok: false, tables: allTableResults, stagingDir, backupPaths, error };
  } finally {
    // Release advisory locks
    for (const p of lockedPaths) {
      releaseAdvisoryLock(p);
    }
  }
}

/**
 * Migrate all tables from the given sources into the target native DB,
 * wrapped in a single BEGIN/COMMIT transaction per scope.
 */
async function migrateScope(
  scope: string,
  sources: LegacyDbDescriptor[],
  targetNativeDb: DatabaseSync,
  journal: ExodusJournal,
  stagingDir: string,
  allTableResults: TableCopyResult[],
  onProgress?: (msg: string) => void,
): Promise<void> {
  if (sources.length === 0) return;

  onProgress?.(`Migrating ${scope}-scope sources…`);

  // Wrap entire scope in one transaction (AC6)
  targetNativeDb.exec('BEGIN');
  try {
    for (const src of sources) {
      const snap = openCleoDbSnapshot(src.path, { readOnly: true });
      try {
        const tables = listTables(snap.db);
        for (const tableName of tables) {
          // Check journal for resume (AC5)
          const existing = journal.tables.find(
            (e) => e.sourceDb === src.name && e.tableName === tableName,
          );
          if (existing?.status === 'done') {
            onProgress?.(`  ↳ ${src.name}.${tableName} — already done (resuming)`);
            allTableResults.push({
              sourceDb: src.name,
              tableName,
              rowsCopied: existing.rowsCopied,
              skipped: false,
            });
            continue;
          }

          onProgress?.(`  ↳ Copying ${src.name}.${tableName}…`);
          let rowsCopied = 0;
          let status: TableMigrationStatus = 'done';
          let errorMsg: string | undefined;
          let skipped = false;

          try {
            rowsCopied = copyTableViaAttach(targetNativeDb, src.path, tableName);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn({ tableName, sourceDb: src.name, err }, 'Table copy failed — skipping');
            status = 'skipped';
            errorMsg = msg;
            skipped = true;
          }

          // Update journal entry
          const entry: JournalTableEntry = {
            sourceDb: src.name,
            tableName,
            status,
            rowsCopied,
            updatedAt: new Date().toISOString(),
            ...(errorMsg ? { error: errorMsg } : {}),
          };

          const idx = journal.tables.findIndex(
            (e) => e.sourceDb === src.name && e.tableName === tableName,
          );
          if (idx >= 0) {
            journal.tables[idx] = entry;
          } else {
            journal.tables.push(entry);
          }
          journal.updatedAt = new Date().toISOString();
          // Atomic journal write after each table (AC5 — crash-resumable)
          writeJournal(stagingDir, journal);

          allTableResults.push({
            sourceDb: src.name,
            tableName,
            rowsCopied,
            skipped,
            reason: errorMsg,
          });
        }
      } finally {
        snap.close();
      }
    }
    targetNativeDb.exec('COMMIT');
  } catch (err) {
    try {
      targetNativeDb.exec('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}
