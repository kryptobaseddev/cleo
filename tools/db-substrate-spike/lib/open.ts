/**
 * Consolidated-file open helper for the spike harnesses.
 *
 * Wraps `node:sqlite` `DatabaseSync` construction with the mandatory
 * consolidation pragma set ({@link applySpikePragmas}) so every harness opens
 * the consolidated file identically. node:sqlite is a CJS built-in; using a
 * direct ESM import works on Node 24.16 but `createRequire` keeps it robust
 * across loaders, mirroring the production chokepoint
 * (`open-cleo-db.ts`/`openCleoDbSnapshot`).
 *
 * @task T11244
 * @saga T11242
 */
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { applySpikePragmas } from './pragmas.js';

const require_ = createRequire(import.meta.url);

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSync;
}

const { DatabaseSync: DatabaseSyncCtor } = require_('node:sqlite') as NodeSqliteModule;

/**
 * Open a consolidated SQLite file with the mandatory spike pragma set applied.
 *
 * @param path - Absolute path to the consolidated file (or `:memory:`).
 * @param applyPragmas - When `true` (default) applies {@link applySpikePragmas}.
 * @returns An open `DatabaseSync` handle (caller owns `.close()`).
 */
export function openConsolidated(path: string, applyPragmas = true): DatabaseSync {
  const db = new DatabaseSyncCtor(path);
  if (applyPragmas) {
    applySpikePragmas(db);
  }
  return db;
}

/**
 * Probe the runtime SQLite version via `SELECT sqlite_version()`.
 *
 * @param db - An open handle, or `undefined` to open an in-memory probe.
 * @returns The SQLite version string (e.g. `3.53.0`).
 */
export function sqliteVersion(db?: DatabaseSync): string {
  const handle = db ?? new DatabaseSyncCtor(':memory:');
  try {
    const row = handle.prepare('SELECT sqlite_version() AS v').get() as { v: string };
    return row.v;
  } finally {
    if (!db) handle.close();
  }
}
