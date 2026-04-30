/**
 * Resolves CLEO home and project data paths.
 *
 * Resolution order:
 *   1. `CLEO_HOME` env var — explicit override
 *   2. XDG_DATA_HOME / platform default (`~/.local/share/cleo` on Linux)
 *
 * Project data (tasks.db, brain.db, conduit.db) is resolved from:
 *   1. `CLEO_ROOT` env var (project root)
 *   2. `process.cwd()/.cleo/`
 *
 * This module is a trimmed mirror of `packages/studio/src/lib/server/cleo-home.ts`
 * that contains only the path helpers required by the Living Brain substrate
 * adapters. Kept in sync manually; both files are small and stable.
 *
 * @task T969
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the CLEO home directory (where global DBs live).
 *
 * Resolution order:
 *   1. `CLEO_HOME` env var
 *   2. Platform default:
 *      - macOS: `~/Library/Application Support/cleo`
 *      - Windows: `%LOCALAPPDATA%\cleo\Data`
 *      - Linux: `$XDG_DATA_HOME/cleo` (defaults to `~/.local/share/cleo`)
 */
export function getCleoHome(): string {
  if (process.env['CLEO_HOME']) {
    return process.env['CLEO_HOME'];
  }
  const platform = process.platform;
  const home = homedir();
  if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'cleo');
  }
  if (platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local');
    // env-paths-style convention: append the Data subdir on Windows so this
    // matches what `cleo admin paths --json` reports as `cleoHome` (e.g.
    // `%LOCALAPPDATA%\cleo\Data`). Without the suffix, Brain looks for
    // `nexus.db` and `signaldock.db` one directory shallower than where the
    // CLI writes them.
    return join(localAppData, 'cleo', 'Data');
  }
  const xdgDataHome = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdgDataHome, 'cleo');
}

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
