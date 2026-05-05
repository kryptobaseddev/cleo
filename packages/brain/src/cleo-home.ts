/**
 * CLEO home + project DB path resolution for `@cleocode/brain`.
 *
 * Path resolution delegates to the `@cleocode/paths` SSoT
 * ({@link getCleoHome}). Project data (tasks.db, brain.db, conduit.db) is
 * resolved from `CLEO_ROOT` (or `process.cwd()`).
 *
 * Previously this module imported `env-paths` directly which caused a Windows
 * path mismatch with the rest of the CLEO ecosystem (the CLI used env-paths
 * returning `%LOCALAPPDATA%\cleo\Data` while brain used a bare
 * `%LOCALAPPDATA%\cleo`, looking up `nexus.db` one directory shallower than
 * where it was written). Fixed in T1874 (Closes #102, supersedes #103).
 *
 * @task T1874 (original Windows fix)
 * @task T1886 (migrated to @cleocode/paths SSoT)
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome } from '@cleocode/paths';

export { getCleoHome };

/**
 * Returns the project's `.cleo/` directory.
 * Resolved from `CLEO_ROOT` env var, falling back to `process.cwd()`.
 */
export function getCleoProjectDir(): string {
  const root = process.env['CLEO_ROOT'] ?? process.cwd();
  return join(root, '.cleo');
}

/** Returns the absolute path to the global nexus.db file. */
export function getNexusDbPath(): string {
  return join(getCleoHome(), 'nexus.db');
}

/** Returns the absolute path to the project-scoped brain.db file. */
export function getBrainDbPath(): string {
  return join(getCleoProjectDir(), 'brain.db');
}

/** Returns the absolute path to the project-scoped tasks.db file. */
export function getTasksDbPath(): string {
  return join(getCleoProjectDir(), 'tasks.db');
}

/** Returns the absolute path to the project-scoped conduit.db file. */
export function getConduitDbPath(): string {
  return join(getCleoProjectDir(), 'conduit.db');
}

/** Returns the absolute path to the global signaldock.db file. */
export function getSignaldockDbPath(): string {
  return join(getCleoHome(), 'signaldock.db');
}

/** Returns true when the given DB file exists on disk. */
export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
