/**
 * Dual-scope SQLite DB open chokepoint for the SG-DB-SUBSTRATE-V2 consolidated schema.
 *
 * ## Overview (D1″ lifecycle split · T11246/E3 + T11247/E4)
 *
 * The owner-ratified D1″ decision (2026-05-30) collapses the CLEO SQLite fleet
 * into exactly **two `cleo.db` files per machine view**:
 *
 *   - **Project scope** — `<projectRoot>/.cleo/cleo.db`
 *     Contains every project-tier domain: `tasks_*` / `brain_*` (project-local
 *     memory) / `conduit_*` / `docs_*` / `telemetry_*` / lifecycle / provenance /
 *     chain / playbooks / agents (87 tables / 903 columns, T11360 count).
 *
 *   - **Global scope** — `$XDG_DATA_HOME/cleo/cleo.db`
 *     Contains every cross-project domain: `nexus_*` / `skills_*` /
 *     `signaldock_*` / `brain_*` (global cross-project memory)
 *     (49 tables / 555 columns, T11361 count).
 *
 * ## Lifecycle
 *
 * `openDualScopeDb` is the **single chokepoint** for all opens of the
 * consolidated schema. It:
 *   1. Resolves the DB file path from scope + `cwd` (project) or `getCleoHome()`
 *      (global).
 *   2. Opens a `node:sqlite` `DatabaseSync` handle.
 *   3. Applies the canonical pragma set from `specs/sqlite-pragmas.json` via
 *      {@link applyPerfPragmas}.
 *   4. Runs the drizzle-kit migrate step against the scope-appropriate
 *      migrations folder (`drizzle-cleo-project` or `drizzle-cleo-global`).
 *   5. Returns a cached, typed `NodeSQLiteDatabase<TSchema>` handle.
 *      Subsequent calls for the same (scope, cwd) return the cached handle.
 *
 * ## Note on co-existence with legacy openCleoDb
 *
 * During the E3/E4 → E6 exodus transition, `openCleoDb` (the existing
 * 8-role chokepoint) and `openDualScopeDb` (this module) co-exist. `openCleoDb`
 * will be updated by E3 to delegate to this function for the consolidated
 * schema. Until the E6 store rewrite, individual store modules still open their
 * own legacy DBs via `openCleoDb`. The E6 milestone removes the legacy opens.
 *
 * @module
 * @task T11512 (E4-T1)
 * @task T11513 (E4-T2 — idempotent write helpers in this same file)
 * @epic T11247 (E4)
 * @saga T11242 (SG-DB-SUBSTRATE-V2)
 * @adr ADR-068, ADR-069
 * @see packages/core/src/store/schema/cleo-project/index.ts — project schema
 * @see packages/core/src/store/schema/cleo-global/index.ts — global schema
 * @see packages/core/migrations/drizzle-cleo-project — project migrations
 * @see packages/core/migrations/drizzle-cleo-global — global migrations
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { getLogger } from '../logger.js';
import { getCleoHome, resolveCleoDir } from '../paths.js';
import { migrateWithRetry, reconcileJournal } from './migration-manager.js';
import { resolveCorePackageMigrationsFolder } from './resolve-migrations-folder.js';
import type * as CleoGlobalSchemaTypes from './schema/cleo-global/index.js';
import type * as CleoProjectSchemaTypes from './schema/cleo-project/index.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The two canonical scopes for the consolidated dual-scope `cleo.db` substrate.
 *
 * - `'project'` — per-project DB at `<projectRoot>/.cleo/cleo.db`
 * - `'global'` — per-user DB at `$XDG_DATA_HOME/cleo/cleo.db`
 */
export type DualScope = 'project' | 'global';

/** Typed Drizzle handle for the project-scope `cleo.db`. */
export type CleoProjectDb = NodeSQLiteDatabase<typeof CleoProjectSchemaTypes>;

/** Typed Drizzle handle for the global-scope `cleo.db`. */
export type CleoGlobalDb = NodeSQLiteDatabase<typeof CleoGlobalSchemaTypes>;

/**
 * Handle returned by {@link openDualScopeDb}.
 *
 * `TScope extends DualScope` narrows `db` to the correct schema type:
 * - `openDualScopeDb('project')` → `DualScopeDbHandle<'project'>` with `db: CleoProjectDb`
 * - `openDualScopeDb('global')` → `DualScopeDbHandle<'global'>` with `db: CleoGlobalDb`
 */
export interface DualScopeDbHandle<TScope extends DualScope = DualScope> {
  /** The Drizzle ORM handle typed against the consolidated schema for `scope`. */
  readonly db: TScope extends 'project' ? CleoProjectDb : CleoGlobalDb;
  /** The scope this handle was opened against. */
  readonly scope: TScope;
  /** Absolute path to the underlying SQLite file. */
  readonly dbPath: string;
  /**
   * Close the underlying native handle and evict this entry from the
   * singleton cache. Safe to call multiple times (idempotent).
   */
  close(): void;
}

// ── Internal singleton state ─────────────────────────────────────────────────

/** Cache key = `${scope}::${dbPath}` */
type CacheKey = string;

interface CacheEntry {
  handle: DualScopeDbHandle;
  nativeDb: DatabaseSync;
  initPromise: Promise<DualScopeDbHandle> | null;
}

const _cache = new Map<CacheKey, CacheEntry>();

/**
 * Build the singleton cache key for a given scope + resolved DB path.
 * Uses `::` as a separator that cannot appear in POSIX paths.
 */
function cacheKey(scope: DualScope, dbPath: string): CacheKey {
  return `${scope}::${dbPath}`;
}

// ── Path resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the absolute path to the dual-scope `cleo.db` for the given scope.
 *
 * - `project`: `resolveCleoDir(cwd)` + `'cleo.db'` (falls under `<root>/.cleo/`)
 * - `global`:  `getCleoHome()` + `'cleo.db'` (falls under XDG data home `/cleo/`)
 */
export function resolveDualScopeDbPath(scope: DualScope, cwd?: string): string {
  if (scope === 'project') {
    return join(resolveCleoDir(cwd), 'cleo.db');
  }
  return join(getCleoHome(), 'cleo.db');
}

// ── Migration folder resolution ──────────────────────────────────────────────

/**
 * Return the migrations folder name for the given scope.
 * The folder lives under `@cleocode/core/migrations/<name>`.
 */
function migrationsSetName(scope: DualScope): string {
  return scope === 'project' ? 'drizzle-cleo-project' : 'drizzle-cleo-global';
}

// ── Lazy drizzle loading ─────────────────────────────────────────────────────

// The drizzle-orm/node-sqlite driver statically imports `node:sqlite`, so we
// load it lazily (matching the pattern in sqlite.ts, T11280) to avoid pulling
// the native binding at module-load time and breaking lazy-init assertions.
const _require = createRequire(import.meta.url);

type DrizzleFn = typeof import('drizzle-orm/node-sqlite').drizzle;

let _drizzle: DrizzleFn | null = null;

function getDrizzle(): DrizzleFn {
  if (_drizzle === null) {
    const mod = _require('drizzle-orm/node-sqlite') as { drizzle: DrizzleFn };
    _drizzle = mod.drizzle;
  }
  return _drizzle;
}

// Also lazy-load DatabaseSync to avoid eager node:sqlite pull.
type DatabaseSyncCtor = new (
  path: string,
  options?: { readOnly?: boolean; allowExtension?: boolean },
) => DatabaseSync;

let _DatabaseSyncCtor: DatabaseSyncCtor | null = null;

function getDatabaseSyncCtor(): DatabaseSyncCtor {
  if (_DatabaseSyncCtor === null) {
    const mod = _require('node:sqlite') as { DatabaseSync: DatabaseSyncCtor };
    _DatabaseSyncCtor = mod.DatabaseSync;
  }
  return _DatabaseSyncCtor;
}

// ── Schema loading ───────────────────────────────────────────────────────────

// Dynamic imports for schema barrels. Loaded once per scope and cached.
// We use dynamic import() to avoid loading both schemas at module-init time —
// only the requested scope's schema is loaded.

let _projectSchema: typeof CleoProjectSchemaTypes | null = null;
let _globalSchema: typeof CleoGlobalSchemaTypes | null = null;

async function loadProjectSchema(): Promise<typeof CleoProjectSchemaTypes> {
  if (_projectSchema === null) {
    _projectSchema = await import('./schema/cleo-project/index.js');
  }
  return _projectSchema;
}

async function loadGlobalSchema(): Promise<typeof CleoGlobalSchemaTypes> {
  if (_globalSchema === null) {
    _globalSchema = await import('./schema/cleo-global/index.js');
  }
  return _globalSchema;
}

// ── Existence table for migration reconciliation ──────────────────────────────

/**
 * The "existence table" used by {@link reconcileJournal} to detect whether
 * migrations have been run before.
 *
 * For the project scope the first domain is `tasks_tasks`; for global it
 * is `nexus_project_registry`. These are the canonical first tables in each
 * scope's migration.
 */
function existenceTable(scope: DualScope): string {
  return scope === 'project' ? 'tasks_tasks' : 'nexus_project_registry';
}

// ── Core open logic ──────────────────────────────────────────────────────────

/**
 * Open (or re-use) the consolidated dual-scope `cleo.db` for the given scope.
 *
 * @param scope - `'project'` for the per-project DB; `'global'` for the
 *   per-user cross-project DB.
 * @param cwd - Optional working directory used to resolve the project root for
 *   the `'project'` scope. Ignored for `'global'`.
 * @returns A typed {@link DualScopeDbHandle} wrapping the Drizzle ORM instance
 *   bound to the consolidated schema for the requested scope. The handle is
 *   cached per (scope, dbPath) — subsequent calls return the same instance.
 *
 * @example
 * ```ts
 * const proj = await openDualScopeDb('project', process.cwd());
 * const global = await openDualScopeDb('global');
 * ```
 *
 * @task T11512
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function openDualScopeDb(
  scope: 'project',
  cwd?: string,
): Promise<DualScopeDbHandle<'project'>>;
export async function openDualScopeDb(
  scope: 'global',
  cwd?: string,
): Promise<DualScopeDbHandle<'global'>>;
export async function openDualScopeDb(scope: DualScope, cwd?: string): Promise<DualScopeDbHandle> {
  const dbPath = resolveDualScopeDbPath(scope, cwd);
  const key = cacheKey(scope, dbPath);

  // Return cached handle if available and not mid-init.
  const existing = _cache.get(key);
  if (existing) {
    if (existing.initPromise) {
      return existing.initPromise;
    }
    return existing.handle;
  }

  const log = getLogger('dual-scope-db');

  // Create a placeholder entry so concurrent callers wait for the same init.
  const initPromise: Promise<DualScopeDbHandle> = (async (): Promise<DualScopeDbHandle> => {
    log.debug({ scope, dbPath }, 'opening dual-scope cleo.db');

    // Ensure the directory exists before opening.
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open the native SQLite handle.
    //
    // `allowExtension: true` permits — but does NOT load — SQLite loadable
    // extensions. The brain domain (E6-L2 · T11522) loads the `sqlite-vec`
    // extension on this shared handle for vector similarity search; node:sqlite
    // requires the flag at construction time (it cannot be toggled afterwards
    // via `enableLoadExtension`). Enabling the flag is harmless for every other
    // domain — no extension is loaded automatically, and the cache stays
    // single-keyed regardless of which domain opens the handle first.
    const DatabaseSyncCtor = getDatabaseSyncCtor();
    const nativeDb = new DatabaseSyncCtor(dbPath, { allowExtension: true });

    // Apply canonical pragma set (specs/sqlite-pragmas.json SSoT).
    applyPerfPragmas(nativeDb);

    // Load the schema barrel for this scope.
    const schema = scope === 'project' ? await loadProjectSchema() : await loadGlobalSchema();

    // Create the Drizzle ORM wrapper.
    // Drizzle v1 RC3 node-sqlite API: pass { client, schema } as a single config object.
    const drizzle = getDrizzle();
    // biome-ignore lint/suspicious/noExplicitAny: schema type is scope-specific; typed via DualScopeDbHandle<TScope>
    const db = drizzle({ client: nativeDb, schema }) as NodeSQLiteDatabase<any>;

    // Resolve the migrations folder for this scope.
    const migrationsFolder = resolveCorePackageMigrationsFolder(migrationsSetName(scope));

    // Reconcile the migration journal (handles WAL/journal divergence across
    // SQLite version upgrades — same pattern as sqlite.ts / memory-sqlite.ts).
    reconcileJournal(nativeDb, migrationsFolder, existenceTable(scope), `dual-scope-db[${scope}]`);

    // Run any pending migrations.
    migrateWithRetry(
      db,
      migrationsFolder,
      nativeDb,
      existenceTable(scope),
      `dual-scope-db[${scope}]`,
    );

    log.debug({ scope, dbPath }, 'dual-scope cleo.db ready');

    const handle: DualScopeDbHandle = {
      db,
      scope,
      dbPath,
      close() {
        _cache.delete(key);
        try {
          nativeDb.close();
        } catch {
          // Idempotent — ignore double-close errors.
        }
      },
    };

    // Update the cache entry to mark init complete.
    const entry = _cache.get(key);
    if (entry) {
      entry.initPromise = null;
      entry.handle = handle;
    }

    return handle;
  })();

  // Store a placeholder with the in-flight promise so concurrent callers wait.
  _cache.set(key, {
    // biome-ignore lint/suspicious/noExplicitAny: placeholder until initPromise resolves
    handle: null as any,
    // biome-ignore lint/suspicious/noExplicitAny: nativeDb not available yet
    nativeDb: null as any,
    initPromise,
  });

  return initPromise;
}

/**
 * Reset all cached handles. Primarily for use in tests between test cases.
 * Closes all open handles before evicting from the cache.
 *
 * @internal
 */
export function _resetDualScopeDbCache(): void {
  for (const entry of _cache.values()) {
    if (entry.handle) {
      try {
        entry.handle.close();
      } catch {
        // ignore
      }
    }
  }
  _cache.clear();
  // Also reset schema caches so tests can reload fresh schemas.
  _projectSchema = null;
  _globalSchema = null;
}

// ── Idempotent write helpers (E4-T2 · T11513) ───────────────────────────────

import type { InferInsertModel } from 'drizzle-orm';
import type { SQLiteTableWithColumns, TableConfig } from 'drizzle-orm/sqlite-core';

/**
 * Attempt to insert `row` into `table`. If a row with the same value for
 * `keyColumn` already exists (UNIQUE conflict), the insert is silently skipped.
 *
 * Wraps Drizzle v1's `.onConflictDoNothing()` to provide a type-safe,
 * retry-safe idempotent insert for tables that carry an `idempotency_key`
 * column or any other UNIQUE column.
 *
 * @param db - The Drizzle database handle (project or global scope).
 * @param table - The Drizzle table reference from the consolidated schema.
 * @param row - The row data to insert (all required columns).
 * @param _keyColumn - The column name to conflict on (informational; the
 *   conflict resolution is applied table-wide via `.onConflictDoNothing()`).
 *   Pass the column name as a hint for documentation purposes.
 * @returns The number of rows actually inserted (0 or 1).
 *
 * @example
 * ```ts
 * import { tasksTasksTable } from '@cleocode/core/store/schema/cleo-project';
 * const inserted = await insertIdempotent(db, tasksTasksTable, newTask, 'idempotencyKey');
 * ```
 *
 * @task T11513 (E4-T2)
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function insertIdempotent<TTable extends SQLiteTableWithColumns<TableConfig>>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts both project and global schema handles
  db: NodeSQLiteDatabase<any>,
  table: TTable,
  row: InferInsertModel<TTable>,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _keyColumn: string,
): Promise<number> {
  const result = await db.insert(table).values(row).onConflictDoNothing().returning();
  return result.length;
}

/**
 * Upsert `row` into `table`, updating all non-key columns when a row with
 * the same `keyColumn` value already exists.
 *
 * Wraps Drizzle v1's `.onConflictDoUpdate()` for retry-safe upsert semantics.
 *
 * @param db - The Drizzle database handle.
 * @param table - The Drizzle table reference.
 * @param row - The row data to insert or update.
 * @param keyColumn - The conflict-target column name (must be a UNIQUE or
 *   PRIMARY KEY column on the table).
 * @param conflictTarget - The column reference used as the `.target` for
 *   `.onConflictDoUpdate()`. Pass the Drizzle column reference (e.g.
 *   `table.idempotencyKey`).
 * @param set - The columns to update on conflict. If omitted, all columns
 *   in `row` are used as the update set.
 * @returns The number of rows inserted or updated (always 1).
 *
 * @example
 * ```ts
 * await upsertIdempotent(db, tasksTasksTable, updatedTask, 'idempotencyKey',
 *   tasksTasksTable.idempotencyKey);
 * ```
 *
 * @task T11513 (E4-T2)
 * @epic T11247 (E4)
 * @saga T11242
 */
export async function upsertIdempotent<TTable extends SQLiteTableWithColumns<TableConfig>>(
  // biome-ignore lint/suspicious/noExplicitAny: accepts both project and global schema handles
  db: NodeSQLiteDatabase<any>,
  table: TTable,
  row: InferInsertModel<TTable>,
  /** The conflict-target column name (informational hint for callers). */
  _keyColumn: string,
  // biome-ignore lint/suspicious/noExplicitAny: column reference type varies by table
  conflictTarget: any,
  set?: Partial<InferInsertModel<TTable>>,
): Promise<number> {
  const updateSet = set ?? row;
  const result = await db
    .insert(table)
    .values(row)
    .onConflictDoUpdate({
      target: conflictTarget,
      // biome-ignore lint/suspicious/noExplicitAny: updateSet shape varies by table; type-safe at call sites
      set: updateSet as any,
    })
    .returning();
  return result.length;
}
