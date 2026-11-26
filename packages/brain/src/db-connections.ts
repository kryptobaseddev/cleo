/**
 * Read-only store access for the Living Brain substrate adapters.
 *
 * The adapters read the consolidated stores, never the legacy per-domain files
 * (`brain.db`, `tasks.db`, `conduit.db`, `nexus.db`, `signaldock.db`), which are
 * decoys or retired (T12095, T14583):
 *
 * - **Project `cleo.db`** (`<project>/.cleo/cleo.db`): `tasks_*`, `brain_*`,
 *   `conduit_*` and the `nexus_*` code graph (ADR-090).
 * - **Global `cleo.db`** (`<cleoHome>/cleo.db`): `agent_registry_*`.
 *
 * Every read goes through the store chokepoint's snapshot opener
 * ({@link openCleoDbSnapshot}): a read-only handle with no migrations and no
 * singleton, opened for one read and closed after it. Opening is
 * sub-millisecond, and no handle is cached across project contexts.
 *
 * @task T969
 * @task T14583 (consolidated cleo.db through the store chokepoint)
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { openCleoDbSnapshot } from '@cleocode/core/store/open-cleo-db.js';
import { getGlobalStorePath } from './cleo-home.js';
import type { ProjectContext } from './project-context.js';

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
// Store readers
// ---------------------------------------------------------------------------

/**
 * Runs `read` against a read-only snapshot of the store at `path`.
 *
 * @param path - Absolute path to a consolidated `cleo.db`.
 * @param read - Synchronous read; the handle is closed when it returns.
 * @returns The read's result, or null when the store is missing or cannot be
 *   opened (a restore in progress, a malformed file), so the substrate degrades
 *   to no nodes.
 */
function readStore<T>(path: string, read: (db: DatabaseSync) => T): T | null {
  if (!existsSync(path)) return null;
  let snapshot: ReturnType<typeof openCleoDbSnapshot>;
  try {
    snapshot = openCleoDbSnapshot(path, { readOnly: true });
  } catch {
    return null;
  }
  try {
    return read(snapshot.db);
  } finally {
    snapshot.close();
  }
}

/**
 * Runs `read` against the project-scope `cleo.db` named by `ctx`.
 *
 * @param ctx - The active project context; `tasksDbPath` names its `cleo.db`.
 * @param read - Synchronous read against the project store.
 * @returns The read's result, or null when the store is missing or unreadable.
 */
export function readProjectStore<T>(ctx: ProjectContext, read: (db: DatabaseSync) => T): T | null {
  return readStore(ctx.tasksDbPath, read);
}

/**
 * Runs `read` against the global-scope `cleo.db` under CLEO home.
 *
 * @param read - Synchronous read against the global store.
 * @returns The read's result, or null when the store is missing or unreadable.
 */
export function readGlobalStore<T>(read: (db: DatabaseSync) => T): T | null {
  return readStore(getGlobalStorePath(), read);
}
