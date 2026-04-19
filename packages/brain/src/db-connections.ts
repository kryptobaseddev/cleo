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
  return signaldockDb;
}

// ---------------------------------------------------------------------------
// Per-project DB getters (NOT cached — resolved from ProjectContext)
// ---------------------------------------------------------------------------

/**
 * Opens a connection to brain.db for the given project context.
 *
 * Each call opens a fresh DatabaseSync against the path stored in `ctx`.
 * Returns null when brain.db does not exist for the project.
 *
 * @param ctx - The active project context.
 */
export function getBrainDb(ctx: ProjectContext): DatabaseSync | null {
  const path = ctx.brainDbPath;
  if (!existsSync(path)) return null;
  return new DatabaseSync(path, { open: true });
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
  return new DatabaseSync(path, { open: true });
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
  return new DatabaseSync(path, { open: true });
}
