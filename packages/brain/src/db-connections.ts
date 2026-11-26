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
import { getErrorMessage } from '@cleocode/contracts/errors.js';
import { openCleoDbSnapshot } from '@cleocode/core/store/open-cleo-db.js';
import { getGlobalStorePath } from './cleo-home.js';
import type { ProjectContext } from './project-context.js';
import type { BrainEdge, BrainNode, BrainNodeKind, BrainSubstrateResult } from './types.js';

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
 * Receives one read failure of a substrate, so the caller can report it
 * instead of returning a silently empty substrate (T14656).
 */
export type StoreErrorSink = (message: string) => void;

/**
 * Runs `read` against a read-only snapshot of the store at `path`.
 *
 * @param path - Absolute path to a consolidated `cleo.db`.
 * @param read - Synchronous read; the handle is closed when it returns.
 * @param onError - Receives the failure when the store exists but cannot be
 *   opened (a restore in progress, a malformed file) or `read` throws. Without
 *   it a failed open returns null and a throwing `read` propagates.
 * @returns The read's result, or null when the store is missing, cannot be
 *   opened, or `read` failed and `onError` received the failure.
 */
function readStore<T>(
  path: string,
  read: (db: DatabaseSync) => T,
  onError?: StoreErrorSink,
): T | null {
  if (!existsSync(path)) return null;
  let snapshot: ReturnType<typeof openCleoDbSnapshot>;
  try {
    snapshot = openCleoDbSnapshot(path, { readOnly: true });
  } catch (err) {
    onError?.(`store cannot be opened: ${getErrorMessage(err)}`);
    return null;
  }
  try {
    return read(snapshot.db);
  } catch (err) {
    if (!onError) throw err;
    onError(getErrorMessage(err));
    return null;
  } finally {
    snapshot.close();
  }
}

/**
 * Runs `read` against the project-scope `cleo.db` named by `ctx`.
 *
 * @param ctx - The active project context; `tasksDbPath` names its `cleo.db`.
 * @param read - Synchronous read against the project store.
 * @param onError - Receives an open or read failure (see {@link StoreErrorSink}).
 * @returns The read's result, or null when the store is missing or unreadable.
 */
export function readProjectStore<T>(
  ctx: ProjectContext,
  read: (db: DatabaseSync) => T,
  onError?: StoreErrorSink,
): T | null {
  return readStore(ctx.tasksDbPath, read, onError);
}

/**
 * Runs `read` against the global-scope `cleo.db` under CLEO home.
 *
 * @param read - Synchronous read against the global store.
 * @param onError - Receives an open or read failure (see {@link StoreErrorSink}).
 * @returns The read's result, or null when the store is missing or unreadable.
 */
export function readGlobalStore<T>(
  read: (db: DatabaseSync) => T,
  onError?: StoreErrorSink,
): T | null {
  return readStore(getGlobalStorePath(), read, onError);
}

// ---------------------------------------------------------------------------
// Per-query failure capture
// ---------------------------------------------------------------------------

/**
 * Runs one substrate query, recording its failure instead of throwing, so one
 * failing query never skips the substrate's other queries (T14656).
 *
 * @param errors - Collects `<name>: <message>` for each failed query.
 * @param name - The query's name in the recorded message (usually its table).
 * @param query - The query to run.
 * @returns The query's rows, or an empty array when it failed.
 */
export function tryQuery<T>(errors: string[], name: string, query: () => T[]): T[] {
  try {
    return query();
  } catch (err) {
    errors.push(`${name}: ${getErrorMessage(err)}`);
    return [];
  }
}

/**
 * Runs one node query through {@link tryQuery}, adding `kind` to `failedKinds`
 * when it fails, so edges to unloaded nodes of that kind are dropped (T14659).
 *
 * @param errors - Collects `<name>: <message>` for each failed query.
 * @param failedKinds - Collects the kind of each failed node query.
 * @param kind - The node kind the query loads.
 * @param name - The query's name in the recorded message (usually its table).
 * @param query - The query to run.
 * @returns The query's rows, or an empty array when it failed.
 */
export function tryNodeQuery<T>(
  errors: string[],
  failedKinds: Set<BrainNodeKind>,
  kind: BrainNodeKind,
  name: string,
  query: () => T[],
): T[] {
  const before = errors.length;
  const rows = tryQuery(errors, name, query);
  if (errors.length > before) failedKinds.add(kind);
  return rows;
}

/**
 * Builds the store error sink of an adapter: a whole-store failure (an open
 * failure or a thrown read) records the message and marks every node kind the
 * adapter owns as failed, since none of them loaded (T14659).
 *
 * @param errors - Collects the failure message.
 * @param failedKinds - Receives every kind in `kinds` on failure.
 * @param kinds - The node kinds the adapter loads from this store.
 * @returns The sink to pass to {@link readProjectStore} or {@link readGlobalStore}.
 */
export function storeFailureSink(
  errors: string[],
  failedKinds: Set<BrainNodeKind>,
  kinds: readonly BrainNodeKind[],
): StoreErrorSink {
  return (message) => {
    errors.push(message);
    for (const kind of kinds) failedKinds.add(kind);
  };
}

/**
 * Builds an adapter result, joining the recorded failures into `error`.
 *
 * @param nodes - Nodes read from the substrate.
 * @param edges - Edges read from the substrate.
 * @param errors - Failures recorded while reading; empty when every read succeeded.
 * @param failedKinds - Kinds whose node query failed (see {@link tryNodeQuery}).
 * @returns The result, with `error` set only when a read failed and
 *   `failedKinds` only when a node query failed.
 */
export function substrateResult(
  nodes: BrainNode[],
  edges: BrainEdge[],
  errors: string[],
  failedKinds: ReadonlySet<BrainNodeKind> = new Set(),
): BrainSubstrateResult {
  if (errors.length === 0) return { nodes, edges };
  return failedKinds.size === 0
    ? { nodes, edges, error: errors.join('; ') }
    : { nodes, edges, error: errors.join('; '), failedKinds: [...failedKinds] };
}
