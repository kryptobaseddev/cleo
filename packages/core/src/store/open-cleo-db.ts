/**
 * Canonical DB-open chokepoint for all CLEO SQLite databases.
 *
 * ## Invariant (ADR-068 §3, T9047)
 *
 * Every CLEO SQLite database open MUST flow through `openCleoDb(role, cwd)`.
 * Raw `new DatabaseSync(path)` calls outside `packages/core/src/store/` are
 * rejected by the `db-open-guard` CI job (`scripts/lint-no-raw-db-opens.mjs`).
 *
 * ## Rationale (ADR-069 Coordination Layers)
 *
 * - **Pragma consistency**: every handle receives the SSoT pragma set from
 *   `specs/sqlite-pragmas.json` (busy_timeout, WAL, cache_size, mmap_size).
 * - **Topology visibility**: the `CleoDbRole` union enumerates all databases;
 *   `cleo health` can audit which are open.
 * - **Lifecycle centralisation**: singleton management and WAL state live in
 *   one place, preventing lock contention between concurrent CLI processes.
 *
 * ## Usage
 *
 * ```typescript
 * import { openCleoDb } from '@cleocode/core/store/open-cleo-db';
 *
 * const handle = await openCleoDb('tasks', cwd);
 * // use handle.db (DatabaseSync) ...
 * await handle.close();
 * ```
 *
 * @task T9047
 * @adr ADR-068, ADR-069
 */

import type { DatabaseSync } from 'node:sqlite';
import { getConduitNativeDb } from './conduit-sqlite.js';
import { getNexusDb } from './nexus-sqlite.js';
import { ensureGlobalSignaldockDb, getGlobalSignaldockNativeDb } from './signaldock-sqlite.js';
import { getDb as getTasksDb } from './sqlite.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

/** Canonical roles for the 6 SQLite databases (ADR-068), plus planned llmtxt/docs storage. */
export type CleoDbRole =
  | 'tasks'
  | 'brain'
  | 'sessions'
  | 'signaldock'
  | 'conduit'
  | 'nexus'
  | 'llmtxt';

type ImplementedCleoDbRole = Exclude<CleoDbRole, 'llmtxt'>;

interface DrizzleWithClient {
  $client?: unknown;
}

/** Handle returned by {@link openCleoDb}. */
export interface CleoDbHandle {
  db: unknown;
  role: CleoDbRole;
  close(): Promise<void>;
}

/** @deprecated Use {@link CleoDbHandle}. */
export type DBHandle = CleoDbHandle;

/** Internal opener for a given role. */
type DbOpener = (cwd?: string) => Promise<unknown>;

/** Open the global signaldock.db via its canonical module. */
async function openSignaldockDb(_cwd?: string): Promise<unknown> {
  await ensureGlobalSignaldockDb();
  return getGlobalSignaldockNativeDb();
}

/** Open the conduit.db for the given project (or current process). */
async function openConduitDb(cwd?: string): Promise<unknown> {
  const { ensureConduitDb } = await import('./conduit-sqlite.js');
  ensureConduitDb(cwd ?? process.cwd());
  return getConduitNativeDb();
}

const ROLE_OPENERS: Record<ImplementedCleoDbRole, DbOpener> = {
  tasks: getTasksDb as unknown as DbOpener,
  brain: getTasksDb as unknown as DbOpener,
  sessions: getTasksDb as unknown as DbOpener,
  signaldock: openSignaldockDb,
  conduit: openConduitDb,
  nexus: getNexusDb as unknown as DbOpener,
};

function unwrapNativeSqliteDb(db: unknown): unknown {
  if (db && typeof db === 'object' && '$client' in db) {
    return (db as DrizzleWithClient).$client ?? db;
  }
  return db;
}

function isDatabaseSync(db: unknown): db is DatabaseSync {
  return Boolean(db && typeof db === 'object' && 'exec' in db && 'prepare' in db);
}

/**
 * Open (or create) a CLEO database by canonical role.
 *
 * Single chokepoint for all DB opens. Applies pragma SSoT at open time.
 */
export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle> {
  if (role === 'llmtxt') {
    throw new Error('CLEO DB role llmtxt is not yet implemented');
  }

  const opener = ROLE_OPENERS[role];
  if (!opener) {
    throw new Error(`Unknown CLEO DB role: ${role}`);
  }

  const openedDb = await opener(cwd);
  const db = unwrapNativeSqliteDb(openedDb);

  // Apply pragma SSoT (T9053) — applyPerfPragmas expects DatabaseSync
  if (isDatabaseSync(db)) {
    applyPerfPragmas(db);
  }

  return {
    db,
    role,
    async close() {
      // Idempotent — individual modules manage their own singletons
    },
  };
}

/**
 * Legacy alias for `openCleoDb('tasks')`.
 * @deprecated Use {@link openCleoDb} with explicit role.
 */
export async function openTasksDb(cwd?: string): Promise<CleoDbHandle> {
  return openCleoDb('tasks', cwd);
}
