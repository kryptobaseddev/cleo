/**
 * Canonical DB-open chokepoint for all CLEO SQLite databases.
 *
 * @task T9050
 * @adr ADR-068, ADR-069
 */

import type { DatabaseSync } from 'node:sqlite';
import { getNexusDb } from './nexus-sqlite.js';
import { getDb as getTasksDb } from './sqlite.js';
import { applyPerfPragmas } from './sqlite-pragmas.js';

/** Canonical roles for the 6 SQLite databases (ADR-068). */
export type CleoDbRole = 'tasks' | 'brain' | 'sessions' | 'signaldock' | 'conduit' | 'nexus';

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

const ROLE_OPENERS: Record<CleoDbRole, DbOpener> = {
  tasks: getTasksDb as unknown as DbOpener,
  brain: getTasksDb as unknown as DbOpener,
  sessions: getTasksDb as unknown as DbOpener,
  signaldock: getTasksDb as unknown as DbOpener, // TODO: wire signaldock-sqlite.ts
  conduit: getTasksDb as unknown as DbOpener, // TODO: wire conduit-sqlite.ts
  nexus: getNexusDb as unknown as DbOpener,
};

/**
 * Open (or create) a CLEO database by canonical role.
 *
 * Single chokepoint for all DB opens. Applies pragma SSoT at open time.
 */
export async function openCleoDb(role: CleoDbRole, cwd?: string): Promise<CleoDbHandle> {
  const opener = ROLE_OPENERS[role];
  if (!opener) {
    throw new Error(`Unknown CLEO DB role: ${role}`);
  }

  const db = await opener(cwd);

  // Apply pragma SSoT (T9053) — applyPerfPragmas expects DatabaseSync
  if (db && typeof db === 'object' && 'exec' in (db as Record<string, unknown>)) {
    applyPerfPragmas(db as DatabaseSync);
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
