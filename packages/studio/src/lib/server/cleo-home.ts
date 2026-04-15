/**
 * Resolves CLEO home and project data paths for the studio server.
 *
 * Resolution order:
 *   1. CLEO_HOME env var — explicit override
 *   2. XDG_DATA_HOME / platform default (~/.local/share/cleo on Linux)
 *
 * Project data (tasks.db, brain.db) is resolved from:
 *   1. CLEO_ROOT env var (project root)
 *   2. process.cwd()/.cleo/
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the global CLEO home directory.
 * Linux: ~/.local/share/cleo
 * macOS: ~/Library/Application Support/cleo
 * Windows: %LOCALAPPDATA%\cleo
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
    return join(localAppData, 'cleo');
  }

  // Linux / XDG
  const xdgDataHome = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdgDataHome, 'cleo');
}

/**
 * Returns the CLEO project data directory (.cleo/).
 * Uses CLEO_ROOT env var or falls back to process.cwd().
 */
export function getCleoProjectDir(): string {
  const root = process.env['CLEO_ROOT'] ?? process.cwd();
  return join(root, '.cleo');
}

/**
 * Returns the absolute path to nexus.db (global).
 * nexus.db lives in the CLEO home directory.
 */
export function getNexusDbPath(): string {
  return join(getCleoHome(), 'nexus.db');
}

/**
 * Returns the absolute path to brain.db (project-local).
 */
export function getBrainDbPath(): string {
  return join(getCleoProjectDir(), 'brain.db');
}

/**
 * Returns the absolute path to tasks.db (project-local).
 */
export function getTasksDbPath(): string {
  return join(getCleoProjectDir(), 'tasks.db');
}

/**
 * Checks if a database file exists at the given path.
 */
export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
