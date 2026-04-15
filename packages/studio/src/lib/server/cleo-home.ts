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
  const xdgDataHome = process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share');
  return join(xdgDataHome, 'cleo');
}

export function getCleoProjectDir(): string {
  const root = process.env['CLEO_ROOT'] ?? process.cwd();
  return join(root, '.cleo');
}

export function getNexusDbPath(): string {
  return join(getCleoHome(), 'nexus.db');
}

export function getBrainDbPath(): string {
  return join(getCleoProjectDir(), 'brain.db');
}

export function getTasksDbPath(): string {
  return join(getCleoProjectDir(), 'tasks.db');
}

export function getConduitDbPath(): string {
  return join(getCleoProjectDir(), 'conduit.db');
}

export function getSignaldockDbPath(): string {
  return join(getCleoHome(), 'signaldock.db');
}

export function dbExists(dbPath: string): boolean {
  return existsSync(dbPath);
}
