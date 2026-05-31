/**
 * Read-only SQLite connection helpers for the Living Brain substrate adapters.
 *
 * Uses node:sqlite (Node.js built-in).
 *
 * Global databases (nexus.db, signaldock.db) are shared across all projects
 * and use module-level caches — their path is fixed per machine and never
 * changes between requests.
 *
 * Per-project databases (brain.db, tasks.db, conduit.db) are resolved from
 * the active {@link ProjectContext} passed by the caller. No cross-request
 * caching is performed: opening SQLite with `node:sqlite` is sub-millisecond,
 * and caching across different ProjectContexts is the precise bug this
 * module's Studio counterpart was rewritten to avoid.
 *
 * This file is a trimmed mirror of
 * `packages/studio/src/lib/server/db/connections.ts`, containing only the
 * getters required by the substrate adapters.
 *
 * ## E4-T5 transition (T11516 · SG-DB-SUBSTRATE-V2)
 *
 * This module now depends on `@cleocode/core` and delegates to
 * {@link openDualScopeDb} for new consolidated `cleo.db` access.  The legacy
 * per-domain DB getters ({@link getNexusDb}, {@link getBrainDb}, etc.) still
 * open the old per-domain files via per-line-allowed raw opens because the
 * substrate adapters in this package still target those legacy table schemas.
 * The full exodus to the consolidated `cleo.db` schema happens in E6 (T11249),
 * at which point the per-line `// db-open-allowed` markers and the legacy
 * getters are removed.
 *
 * @task T969
 * @task T11516 (E4-T5)
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { applyPerfPragmas } from '@cleocode/core/store/sqlite-pragmas.js';
import { dbExists, getNexusDbPath, getSignaldockDbPath } from './cleo-home.js';
import type { ProjectContext } from './project-context.js';

/**
 * Re-export of the dual-scope `cleo.db` chokepoint.
 *
 * Callers that target the new consolidated schema (E4+) should use
 * `openDualScopeDb` directly rather than the legacy per-domain getters below.
 *
 * @see packages/core/src/store/dual-scope-db.ts
 */
export { openDualScopeDb } from '@cleocode/core/db';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

// ---------------------------------------------------------------------------
// Typed row helper
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of a `node:sqlite` prepared statement.
 *
 * `node:sqlite` returns rows as `Record<string, SQLOutputValue>[]` — a generic
 * shape that's not directly assignable to the row interfaces defined by each
 * substrate adapter. This type captures just the subset of `StatementSync`
 * used by the typed-row helper below.
 */
interface PreparedStatementLike {
  all(...params: unknown[]): unknown[];
}

/**
 * Executes a prepared statement and returns rows typed as `T[]`.
 *
 * This helper consolidates the SQL-to-TypeScript boundary into a single,
 * auditable location. Each adapter specifies the expected row shape via the
 * type parameter; the unknown→T conversion happens exactly once per call
 * site rather than being scattered across every query site.
 *
 * Callers remain responsible for validating that the SQL projection matches
 * the declared type `T`.
 *
 * @param stmt - A prepared `node:sqlite` StatementSync.
 * @param params - Anonymous parameter bindings for the statement.
 * @returns Rows materialised as `T[]`.
 */
export function allTyped<T>(stmt: PreparedStatementLike, ...params: unknown[]): T[] {
  return stmt.all(...params) as T[];
}

// ---------------------------------------------------------------------------
// Global singleton caches (path never changes per process)
// ---------------------------------------------------------------------------

/** Cached nexus.db connection — global, path is machine-scoped. */
let nexusDb: DatabaseSync | null = null;

/** Cached signaldock.db connection — global, path is machine-scoped. */
let signaldockDb: DatabaseSync | null = null;

// ---------------------------------------------------------------------------
// Global DB getters (cached per process)
// ---------------------------------------------------------------------------

/**
 * Returns a read-only connection to the global nexus.db.
 * Returns null when the file does not exist on disk.
 *
 * @remarks
 * Uses `applyPerfPragmas` from `@cleocode/core` (SSoT, T9045).
 * The raw open is per-line-allowed during the E4 → E6 transition; substrate
 * adapters still target legacy nexus.db table names. Full exodus in E6 (T11249).
 */
export function getNexusDb(): DatabaseSync | null {
  if (nexusDb) return nexusDb;
  const path = getNexusDbPath();
  if (!dbExists(path)) return null;
  nexusDb = new DatabaseSync(path, { open: true }); // db-open-allowed: E4-T5 coexistence — adapters target legacy nexus.db schema; full exodus in E6 (T11249)
  applyPerfPragmas(nexusDb);
  return nexusDb;
}

/**
 * Returns a read-only connection to the global signaldock.db.
 * Returns null when the file does not exist on disk.
 *
 * @remarks
 * Uses `applyPerfPragmas` from `@cleocode/core` (SSoT, T9045).
 * The raw open is per-line-allowed during the E4 → E6 transition; substrate
 * adapters still target legacy signaldock.db table names. Full exodus in E6 (T11249).
 */
export function getSignaldockDb(): DatabaseSync | null {
  if (signaldockDb) return signaldockDb;
  const path = getSignaldockDbPath();
  if (!dbExists(path)) return null;
  signaldockDb = new DatabaseSync(path, { open: true }); // db-open-allowed: E4-T5 coexistence — adapters target legacy signaldock.db schema; full exodus in E6 (T11249)
  applyPerfPragmas(signaldockDb);
  return signaldockDb;
}

// ---------------------------------------------------------------------------
// Per-project DB getters (NOT cached — resolved from ProjectContext)
// ---------------------------------------------------------------------------

/**
 * Detect the brain.db malformation signature (T10303) without taking a
 * dependency on `@cleocode/core`. The reader side does NOT auto-recover —
 * recovery is owned by the writer side in `@cleocode/core/store/memory-sqlite.ts`.
 * Reader-side detection returns `null` so substrate adapters degrade
 * gracefully (matches the existing "DB doesn't exist" semantics).
 *
 * @internal — brain-package-local.
 * @task T10303
 */
function isMalformationError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: string; errcode?: number }).code;
  const errcode = (err as Error & { errcode?: number }).errcode;
  if (code === 'ERR_SQLITE_ERROR' && errcode === 11) return true;
  return /malformed/i.test(err.message ?? '');
}

/**
 * Opens a connection to brain.db for the given project context.
 *
 * Each call opens a fresh DatabaseSync against the path stored in `ctx`.
 * Returns null when brain.db does not exist for the project OR when the
 * file is detected as malformed (T10303). Reader-side malformation is
 * handled by returning null — recovery is owned by the writer side in
 * `@cleocode/core/store/memory-sqlite.ts:getBrainDb`, which runs the
 * `recoverMalformedBrainDb()` pipeline before the next process re-opens.
 *
 * @param ctx - The active project context.
 *
 * @remarks
 * Uses `applyPerfPragmas` from `@cleocode/core` (SSoT, T9045).
 * The raw open is per-line-allowed during the E4 → E6 transition; substrate
 * adapters still target legacy brain.db table names. Full exodus in E6 (T11249).
 */
export function getBrainDb(ctx: ProjectContext): DatabaseSync | null {
  const path = ctx.brainDbPath;
  if (!existsSync(path)) return null;
  try {
    const __db = new DatabaseSync(path, { open: true }); // db-open-allowed: E4-T5 coexistence — adapters target legacy brain.db schema; full exodus in E6 (T11249)
    applyPerfPragmas(__db);
    return __db;
  } catch (err) {
    if (isMalformationError(err)) return null;
    throw err;
  }
}

/**
 * Opens a connection to tasks.db for the given project context.
 *
 * Each call opens a fresh DatabaseSync against the path stored in `ctx`.
 * Returns null when tasks.db does not exist for the project.
 *
 * @param ctx - The active project context.
 *
 * @remarks
 * Uses `applyPerfPragmas` from `@cleocode/core` (SSoT, T9045).
 * The raw open is per-line-allowed during the E4 → E6 transition; substrate
 * adapters still target legacy tasks.db table names. Full exodus in E6 (T11249).
 */
export function getTasksDb(ctx: ProjectContext): DatabaseSync | null {
  const path = ctx.tasksDbPath;
  if (!existsSync(path)) return null;
  const __db = new DatabaseSync(path, { open: true }); // db-open-allowed: E4-T5 coexistence — adapters target legacy tasks.db schema; full exodus in E6 (T11249)
  applyPerfPragmas(__db);
  return __db;
}

/**
 * Opens a connection to conduit.db for the given project context.
 *
 * conduit.db lives alongside brain.db in the project's `.cleo/` directory.
 * Its path is derived from the brain.db path since `ProjectContext` does not
 * carry a dedicated `conduitDbPath` field.
 *
 * Returns null when conduit.db does not exist for the project.
 *
 * @param ctx - The active project context.
 *
 * @remarks
 * Uses `applyPerfPragmas` from `@cleocode/core` (SSoT, T9045).
 * The raw open is per-line-allowed during the E4 → E6 transition; substrate
 * adapters still target legacy conduit.db table names. Full exodus in E6 (T11249).
 */
export function getConduitDb(ctx: ProjectContext): DatabaseSync | null {
  const path = join(dirname(ctx.brainDbPath), 'conduit.db');
  if (!existsSync(path)) return null;
  const __db = new DatabaseSync(path, { open: true }); // db-open-allowed: E4-T5 coexistence — adapters target legacy conduit.db schema; full exodus in E6 (T11249)
  applyPerfPragmas(__db);
  return __db;
}
