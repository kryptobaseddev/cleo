/**
 * Resolves CLEO home and project data paths for the studio server.
 *
 * Resolution order:
 *   1. CLEO_HOME env var — explicit override
 *   2. OS-appropriate data path via `@cleocode/core` → `env-paths`
 *      (XDG on Linux, `~/Library/Application Support/cleo` on macOS,
 *      `%LOCALAPPDATA%\cleo\Data` on Windows)
 *
 * Project data (tasks.db, brain.db) is resolved from:
 *   1. CLEO_ROOT env var (project root)
 *   2. process.cwd()/.cleo/
 *
 * Previously this module hand-rolled platform detection which caused a
 * Windows path mismatch (see brain/src/cleo-home.ts for details).
 * Fixed in T1874 (Closes #102, supersedes #103) by delegating to
 * `@cleocode/core`'s canonical `getCleoHome` which uses env-paths.
 *
 * @task T1874
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoHome as getCleoHomeFromCore } from '@cleocode/core';

/**
 * Returns the CLEO home directory (where global DBs live).
 *
 * Delegates to `@cleocode/core`'s `getCleoHome` which uses `env-paths`
 * for OS-appropriate, XDG-compliant path resolution.
 *
 * @returns Absolute path to the global CLEO data directory
 *
 * @example
 * ```typescript
 * const home = getCleoHome(); // e.g. "/home/user/.local/share/cleo"
 * ```
 */
export function getCleoHome(): string {
  return getCleoHomeFromCore();
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
