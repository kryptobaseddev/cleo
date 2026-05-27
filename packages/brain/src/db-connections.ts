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
 * @task T969
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { dbExists, getNexusDbPath, getSignaldockDbPath } from './cleo-home.js';
import type { ProjectContext } from './project-context.js';

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
// Pragma application (T9045 — inline because @cleocode/brain doesn't depend on @cleocode/core)
//
// Mirrors the canonical set from packages/core/src/store/sqlite-pragmas.ts.
// Keep in sync with specs/sqlite-pragmas.json.
// ---------------------------------------------------------------------------

/**
 * Apply the canonical CLEO performance pragma set to a DatabaseSync handle.
 *
 * @internal — brain-package-local, no dep on core.
 */
function applyBrainPragmas(db: DatabaseSync): void {
  db.exec(
    [
      'PRAGMA busy_timeout = 5000',
      'PRAGMA journal_mode = WAL',
      'PRAGMA synchronous = NORMAL',
      'PRAGMA foreign_keys = ON',
      'PRAGMA cache_size = -8192',
      'PRAGMA mmap_size = 67108864',
    ].join('; '),
  );
}

// ---------------------------------------------------------------------------
// Global DB getters (cached per process)
// ---------------------------------------------------------------------------

/**
 * Returns a read-only connection to the global nexus.db.
 * Returns null when the file does not exist on disk.
 */
export function getNexusDb(): DatabaseSync | null {
  if (nexusDb) return nexusDb;
  const path = getNexusDbPath();
  if (!dbExists(path)) return null;
  nexusDb = new DatabaseSync(path, { open: true });
  applyBrainPragmas(nexusDb); // T9045
  return nexusDb;
}

/**
 * Returns a read-only connection to the global signaldock.db.
 * Returns null when the file does not exist on disk.
 */
export function getSignaldockDb(): DatabaseSync | null {
  if (signaldockDb) return signaldockDb;
  const path = getSignaldockDbPath();
  if (!dbExists(path)) return null;
  signaldockDb = new DatabaseSync(path, { open: true });
  applyBrainPragmas(signaldockDb); // T9045
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
 */
export function getBrainDb(ctx: ProjectContext): DatabaseSync | null {
  const path = ctx.brainDbPath;
  if (!existsSync(path)) return null;
  try {
    const __db = new DatabaseSync(path, { open: true });
    applyBrainPragmas(__db); // T9045
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
 */
export function getTasksDb(ctx: ProjectContext): DatabaseSync | null {
  const path = ctx.tasksDbPath;
  if (!existsSync(path)) return null;
  const __db = new DatabaseSync(path, { open: true });
  applyBrainPragmas(__db); // T9045
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
 */
export function getConduitDb(ctx: ProjectContext): DatabaseSync | null {
  const path = join(dirname(ctx.brainDbPath), 'conduit.db');
  if (!existsSync(path)) return null;
  const __db = new DatabaseSync(path, { open: true });
  applyBrainPragmas(__db); // T9045
  return __db;
}
