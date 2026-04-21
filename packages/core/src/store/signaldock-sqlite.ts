/**
 * SQLite store for global-tier signaldock.db — canonical agent identity database.
 *
 * Post-T310 (ADR-037), signaldock.db lives at `$XDG_DATA_HOME/cleo/signaldock.db`
 * (resolved via getCleoHome()). It holds cross-project agent identity, capabilities
 * catalog, and cloud-sync tables. Project-local messaging state has moved to
 * conduit.db (managed by conduit-sqlite.ts, T344).
 *
 * Migration runner: standard drizzle pipeline via migrateSanitized + reconcileJournal
 * (migration-manager.ts). Replaces the bare-SQL GLOBAL_EMBEDDED_MIGRATIONS runner
 * that was previously embedded here (T1166 / T1150 Wave 2A-04).
 *
 * Migration folder: packages/core/migrations/drizzle-signaldock/
 *
 * GLOBAL-TIER ONLY. This module MUST NOT resolve paths under any project's .cleo/
 * directory. The path guard in getGlobalSignaldockDbPath() enforces this invariant.
 *
 * @task T346
 * @task T1166
 * @epic T310
 * @epic T1150
 * @related ADR-037
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { getCleoHome } from '../paths.js';
import { migrateSanitized, reconcileJournal } from './migration-manager.js';
import * as signaldockSchema from './signaldock-schema.js';
import { openNativeDatabase } from './sqlite.js';

/**
 * Database file name within the global cleo home directory.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_DB_FILENAME = 'signaldock.db';

/**
 * Schema version for global signaldock databases.
 *
 * @task T346
 * @epic T310
 */
export const GLOBAL_SIGNALDOCK_SCHEMA_VERSION = '2026.4.12';

/**
 * @deprecated Use GLOBAL_SIGNALDOCK_SCHEMA_VERSION. Retained during T310
 * migration window. Will be removed after all callers migrate (T355).
 */
export const SIGNALDOCK_SCHEMA_VERSION = GLOBAL_SIGNALDOCK_SCHEMA_VERSION;

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/**
 * Returns the GLOBAL-tier signaldock.db path. Post-T310, signaldock.db
 * holds canonical agent identity + cloud-sync tables. Project-local
 * messaging state lives in conduit.db (T344).
 *
 * Resolves to `getCleoHome() + '/signaldock.db'`.
 * Guard: asserts the resolved path starts with getCleoHome() (defense in depth,
 * mirrors the ADR-036 pattern used by getNexusDbPath in nexus-sqlite.ts).
 *
 * @task T346
 * @epic T310
 * @why ADR-037 split single signaldock.db into project conduit + global signaldock
 * @throws {Error} If resolved path is not under getCleoHome() — indicates a code
 *   path that bypasses canonical path resolution. Fix the caller, do not suppress.
 */
export function getGlobalSignaldockDbPath(): string {
  const cleoHome = getCleoHome();
  const dbPath = join(cleoHome, GLOBAL_SIGNALDOCK_DB_FILENAME);
  if (!dbPath.startsWith(cleoHome)) {
    throw new Error(
      `BUG: getGlobalSignaldockDbPath() resolved to "${dbPath}" which is NOT under ` +
        `getCleoHome() ("${cleoHome}"). signaldock.db is global-only per ADR-037. ` +
        `This indicates a code path that bypasses path resolution — ` +
        `fix the caller, do not suppress this error.`,
    );
  }
  return dbPath;
}

/**
 * @deprecated Use getGlobalSignaldockDbPath() directly. Retained during T310
 * migration window so the TypeScript build does not break until all callers
 * are updated (tracked in T355 accessor refactor).
 *
 * When called WITHOUT arguments: returns the global-tier path (forwards to
 * getGlobalSignaldockDbPath()).
 *
 * When called WITH a non-undefined `cwd` argument: throws a migration error
 * immediately. The project-tier path is now owned by conduit-sqlite.ts (T344).
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export function getSignaldockDbPath(cwd?: string): string {
  if (cwd !== undefined) {
    throw new Error(
      'getSignaldockDbPath(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only at $XDG_DATA_HOME/cleo/signaldock.db. ' +
        'Use getGlobalSignaldockDbPath(), or for project-local messaging use ' +
        'getConduitDbPath() from conduit-sqlite.ts (T344).',
    );
  }
  return getGlobalSignaldockDbPath();
}

// ---------------------------------------------------------------------------
// Migration folder resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the path to the drizzle-signaldock migrations folder.
 *
 * Walks upward from this module's location searching for a
 * `migrations/drizzle-signaldock` directory. Works across layouts:
 *  - src/store (dev via tsx) → finds packages/core/migrations/drizzle-signaldock
 *  - dist/store (tsc emit)   → finds packages/core/migrations/drizzle-signaldock
 *  - node_modules/@cleocode/core/dist/... → walks up to nearest package root
 *
 * @task T1166
 * @epic T1150
 */
export function resolveSignaldockMigrationsFolder(): string {
  const __filename = fileURLToPath(import.meta.url);
  let current = dirname(__filename);
  const root = '/';

  for (let depth = 0; depth < 8 && current !== root; depth++) {
    const candidate = join(current, 'migrations', 'drizzle-signaldock');
    if (existsSync(candidate)) return candidate;
    current = dirname(current);
  }

  // Fallback: the source-layout assumption (legacy behavior)
  const fallback = join(dirname(__filename), '..', '..', 'migrations', 'drizzle-signaldock');
  return fallback;
}

// ---------------------------------------------------------------------------
// Migration runner
// ---------------------------------------------------------------------------

/**
 * Run drizzle migrations to create/update signaldock.db tables.
 *
 * Uses reconcileJournal + migrateSanitized for backwards compatibility with
 * existing signaldock.db files in the wild. The reconciler's Scenario 1 and
 * Scenario 3 probe-and-mark-applied logic detects when the schema already
 * matches (e.g., an existing DB that had the T897 migration applied via the
 * old bare-SQL runner) and inserts journal rows without re-running DDL.
 *
 * Replaces the former applyGlobalSignaldockSchema() / GLOBAL_EMBEDDED_MIGRATIONS
 * bare-SQL runner (T1166 / T1150 Wave 2A-04).
 *
 * @param nativeDb - An open DatabaseSync handle at the global signaldock path
 * @task T1166
 * @epic T1150
 */
function runSignaldockMigrations(nativeDb: DatabaseSync): void {
  const migrationsFolder = resolveSignaldockMigrationsFolder();

  // Reconcile the Drizzle journal before running migrations.
  // Handles:
  //   Scenario 1: agents table exists but __drizzle_migrations does not
  //               → bootstrap the baseline as applied
  //   Scenario 3: column exists but journal entry absent
  //               → insert missing journal entry to avoid duplicate-column errors
  //   Scenario 4: null name in journal entries
  //               → backfill names so Drizzle v1 beta can detect applied migrations
  reconcileJournal(nativeDb, migrationsFolder, 'agents', 'signaldock');

  // Create the drizzle ORM wrapper and run pending migrations.
  const db = drizzle({ client: nativeDb, schema: signaldockSchema });
  migrateSanitized(db, { migrationsFolder });
}

// ---------------------------------------------------------------------------
// Database lifecycle
// ---------------------------------------------------------------------------

/** Singleton native DatabaseSync handle for the current process. */
let _globalSignaldockNativeDb: DatabaseSync | null = null;

/**
 * Ensure global signaldock.db exists with the full global schema applied.
 * Creates the global cleo home directory if it doesn't exist.
 * Idempotent — safe to call multiple times.
 *
 * @returns Object with action ('created' | 'exists') and the database path
 * @task T346
 * @task T1166
 * @epic T310
 */
export async function ensureGlobalSignaldockDb(): Promise<{
  action: 'created' | 'exists';
  path: string;
}> {
  const dbPath = getGlobalSignaldockDbPath();
  const alreadyExists = existsSync(dbPath);

  // Ensure global cleo home directory exists
  const cleoHome = getCleoHome();
  if (!existsSync(cleoHome)) {
    mkdirSync(cleoHome, { recursive: true });
  }

  const nativeDb = openNativeDatabase(dbPath);
  try {
    // Check if schema already applied (agents table as sentinel)
    const hasSchema = (() => {
      try {
        const result = nativeDb
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agents'")
          .get() as { name: string } | undefined;
        return !!result;
      } catch {
        return false;
      }
    })();

    // Run drizzle migrations (reconcileJournal + migrateSanitized).
    // For existing DBs that used the old bare-SQL runner, reconcileJournal
    // Scenario 1 bootstraps the __drizzle_migrations journal from the existing
    // agents table, and Scenario 3 marks T897 ALTER columns as applied without
    // re-running the DDL.
    runSignaldockMigrations(nativeDb);

    // Store native handle for backup integration (getGlobalSignaldockNativeDb)
    _globalSignaldockNativeDb = nativeDb;

    return {
      action: alreadyExists && hasSchema ? 'exists' : 'created',
      path: dbPath,
    };
  } catch (err) {
    nativeDb.close();
    _globalSignaldockNativeDb = null;
    throw err;
  }
  // NOTE: We intentionally do NOT close `nativeDb` here — the native handle is
  // retained as _globalSignaldockNativeDb for backup integration. Callers
  // that need a short-lived open/close pattern should open the DB themselves.
}

/**
 * @deprecated Use ensureGlobalSignaldockDb(). Retained during T310 migration
 * window for callers in init.ts and agent-registry-accessor.ts.
 *
 * When called WITHOUT arguments: forwards to ensureGlobalSignaldockDb().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function ensureSignaldockDb(
  cwd?: string,
): Promise<{ action: 'created' | 'exists'; path: string }> {
  if (cwd !== undefined) {
    throw new Error(
      'ensureSignaldockDb(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use ensureGlobalSignaldockDb() for global identity, or ' +
        'ensureConduitDb(cwd) from conduit-sqlite.ts for project messaging (T344).',
    );
  }
  return ensureGlobalSignaldockDb();
}

/**
 * Check global signaldock.db health: table count, WAL mode, schema version.
 * Used by `cleo doctor` to verify global signaldock.db integrity.
 *
 * @returns Health report object, or object with exists=false if the DB does not exist.
 * @task T346
 * @epic T310
 */
export async function checkGlobalSignaldockDbHealth(): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  const dbPath = getGlobalSignaldockDbPath();
  if (!existsSync(dbPath)) {
    return {
      exists: false,
      path: dbPath,
      tableCount: 0,
      walMode: false,
      schemaVersion: null,
      foreignKeysEnabled: false,
    };
  }

  const nativeDb = openNativeDatabase(dbPath, { readonly: true });
  try {
    const tables = nativeDb
      .prepare(
        "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .get() as { count: number };

    const journalMode = nativeDb.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    const fkEnabled = nativeDb.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };

    // Schema version: check the __drizzle_migrations journal for evidence of
    // migrations applied. Fallback to _signaldock_meta for pre-T1166 DBs.
    let schemaVersion: string | null = null;
    try {
      // Post-T1166 path: check if drizzle journal has entries
      const journalRow = nativeDb
        .prepare('SELECT COUNT(*) as cnt FROM "__drizzle_migrations"')
        .get() as { cnt: number } | undefined;
      if (journalRow && journalRow.cnt > 0) {
        schemaVersion = GLOBAL_SIGNALDOCK_SCHEMA_VERSION;
      }
    } catch {
      // __drizzle_migrations does not exist yet — fall through to _signaldock_meta
    }

    if (!schemaVersion) {
      try {
        // Pre-T1166 path: _signaldock_meta table (old bare-SQL runner)
        const meta = nativeDb
          .prepare("SELECT value FROM _signaldock_meta WHERE key = 'schema_version'")
          .get() as { value: string } | undefined;
        schemaVersion = meta?.value ?? null;
      } catch {
        // _signaldock_meta may not exist on very old or partially-initialized DBs
      }
    }

    return {
      exists: true,
      path: dbPath,
      tableCount: tables.count,
      walMode: journalMode.journal_mode === 'wal',
      schemaVersion,
      foreignKeysEnabled: fkEnabled.foreign_keys === 1,
    };
  } finally {
    nativeDb.close();
  }
}

/**
 * @deprecated Use checkGlobalSignaldockDbHealth(). Retained during T310 migration
 * window for callers in `cleo doctor` and other diagnostics.
 *
 * When called WITHOUT arguments: forwards to checkGlobalSignaldockDbHealth().
 * When called WITH a non-undefined `cwd` argument: throws a migration error.
 *
 * @param cwd - Must be undefined. Any other value throws a migration error.
 * @task T346
 * @epic T310
 */
export async function checkSignaldockDbHealth(cwd?: string): Promise<{
  exists: boolean;
  path: string;
  tableCount: number;
  walMode: boolean;
  schemaVersion: string | null;
  foreignKeysEnabled: boolean;
} | null> {
  if (cwd !== undefined) {
    throw new Error(
      'checkSignaldockDbHealth(cwd) is removed as of T310 (v2026.4.12). ' +
        'signaldock.db is now global-only. ' +
        'Use checkGlobalSignaldockDbHealth() for global signaldock health, or ' +
        'checkConduitDbHealth(cwd) from conduit-sqlite.ts for project conduit health (T344).',
    );
  }
  return checkGlobalSignaldockDbHealth();
}

/**
 * Get the underlying node:sqlite DatabaseSync instance for global signaldock.db.
 * Returns the handle stored by the most recent ensureGlobalSignaldockDb() call,
 * or null if the database has not yet been initialized in this process.
 *
 * Used by sqlite-backup.ts to activate the signaldock GLOBAL_SNAPSHOT_TARGET
 * (spec §6.2, T310).
 *
 * @task T346
 * @epic T310
 */
export function getGlobalSignaldockNativeDb(): DatabaseSync | null {
  return _globalSignaldockNativeDb;
}

/**
 * Reset the in-process global signaldock.db singleton.
 * ONLY for use in test isolation — never call in production code.
 *
 * @task T346
 * @epic T310
 */
export function _resetGlobalSignaldockDb_TESTING_ONLY(): void {
  if (_globalSignaldockNativeDb) {
    try {
      if (_globalSignaldockNativeDb.isOpen) {
        _globalSignaldockNativeDb.close();
      }
    } catch {
      // Ignore close errors
    }
    _globalSignaldockNativeDb = null;
  }
}
