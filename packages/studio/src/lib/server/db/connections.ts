/**
 * Read-only SQLite connection helpers for CLEO Studio.
 *
 * Uses node:sqlite (Node.js built-in) with read-only mode.
 * All five CLEO databases (nexus, brain, tasks, conduit, signaldock) are accessed here.
 * Connections are opened lazily and cached per process lifetime.
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import {
  dbExists,
  getBrainDbPath,
  getConduitDbPath,
  getNexusDbPath,
  getSignaldockDbPath,
  getTasksDbPath,
} from '../cleo-home.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

/** Cached read-only connection instances. */
let nexusDb: DatabaseSync | null = null;
let brainDb: DatabaseSync | null = null;
let tasksDb: DatabaseSync | null = null;
let conduitDb: DatabaseSync | null = null;
let signaldockDb: DatabaseSync | null = null;

export function getNexusDb(): DatabaseSync | null {
  if (nexusDb) return nexusDb;
  const path = getNexusDbPath();
  if (!dbExists(path)) return null;
  nexusDb = new DatabaseSync(path, { open: true });
  return nexusDb;
}

export function getBrainDb(): DatabaseSync | null {
  if (brainDb) return brainDb;
  const path = getBrainDbPath();
  if (!dbExists(path)) return null;
  brainDb = new DatabaseSync(path, { open: true });
  return brainDb;
}

export function getTasksDb(): DatabaseSync | null {
  if (tasksDb) return tasksDb;
  const path = getTasksDbPath();
  if (!dbExists(path)) return null;
  tasksDb = new DatabaseSync(path, { open: true });
  return tasksDb;
}

export function getConduitDb(): DatabaseSync | null {
  if (conduitDb) return conduitDb;
  const path = getConduitDbPath();
  if (!dbExists(path)) return null;
  conduitDb = new DatabaseSync(path, { open: true });
  return conduitDb;
}

export function getSignaldockDb(): DatabaseSync | null {
  if (signaldockDb) return signaldockDb;
  const path = getSignaldockDbPath();
  if (!dbExists(path)) return null;
  signaldockDb = new DatabaseSync(path, { open: true });
  return signaldockDb;
}

export function getDbStatus(): {
  nexus: boolean;
  brain: boolean;
  tasks: boolean;
  conduit: boolean;
  signaldock: boolean;
  nexusPath: string;
  brainPath: string;
  tasksPath: string;
  conduitPath: string;
  signaldockPath: string;
} {
  return {
    nexus: dbExists(getNexusDbPath()),
    brain: dbExists(getBrainDbPath()),
    tasks: dbExists(getTasksDbPath()),
    conduit: dbExists(getConduitDbPath()),
    signaldock: dbExists(getSignaldockDbPath()),
    nexusPath: getNexusDbPath(),
    brainPath: getBrainDbPath(),
    tasksPath: getTasksDbPath(),
    conduitPath: getConduitDbPath(),
    signaldockPath: getSignaldockDbPath(),
  };
}
