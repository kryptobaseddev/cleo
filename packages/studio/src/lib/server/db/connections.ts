/**
 * Read-only SQLite connection helpers for CLEO Studio.
 *
 * Uses node:sqlite (Node.js built-in) with read-only mode.
 * All three CLEO databases (nexus, brain, tasks) are accessed here.
 * Connections are opened lazily and cached per process lifetime.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { dbExists, getBrainDbPath, getNexusDbPath, getTasksDbPath } from '../cleo-home.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Cached read-only connection instances. */
let nexusDb: DatabaseSync | null = null;
let brainDb: DatabaseSync | null = null;
let tasksDb: DatabaseSync | null = null;

/**
 * Returns a cached read-only connection to nexus.db.
 * Returns null if nexus.db does not exist.
 */
export function getNexusDb(): DatabaseSync | null {
  if (nexusDb) return nexusDb;
  const path = getNexusDbPath();
  if (!dbExists(path)) return null;
  nexusDb = new DatabaseSync(path, { open: true });
  return nexusDb;
}

/**
 * Returns a cached read-only connection to brain.db.
 * Returns null if brain.db does not exist.
 */
export function getBrainDb(): DatabaseSync | null {
  if (brainDb) return brainDb;
  const path = getBrainDbPath();
  if (!dbExists(path)) return null;
  brainDb = new DatabaseSync(path, { open: true });
  return brainDb;
}

/**
 * Returns a cached read-only connection to tasks.db.
 * Returns null if tasks.db does not exist.
 */
export function getTasksDb(): DatabaseSync | null {
  if (tasksDb) return tasksDb;
  const path = getTasksDbPath();
  if (!dbExists(path)) return null;
  tasksDb = new DatabaseSync(path, { open: true });
  return tasksDb;
}

/**
 * Returns availability status for all three databases.
 */
export function getDbStatus(): {
  nexus: boolean;
  brain: boolean;
  tasks: boolean;
  nexusPath: string;
  brainPath: string;
  tasksPath: string;
} {
  return {
    nexus: dbExists(getNexusDbPath()),
    brain: dbExists(getBrainDbPath()),
    tasks: dbExists(getTasksDbPath()),
    nexusPath: getNexusDbPath(),
    brainPath: getBrainDbPath(),
    tasksPath: getTasksDbPath(),
  };
}
