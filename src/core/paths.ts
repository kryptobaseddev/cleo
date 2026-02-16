/**
 * XDG-compliant path resolution for CLEO V2.
 *
 * Environment variables:
 *   CLEO_HOME   - Global installation directory (default: ~/.cleo)
 *   CLEO_DIR    - Project data directory (default: .cleo)
 *
 * @epic T4454
 * @task T4458
 */

import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, renameSync } from 'node:fs';

/**
 * Get the global CLEO home directory.
 * Respects CLEO_HOME env var, defaults to ~/.cleo.
 */
export function getCleoHome(): string {
  return process.env['CLEO_HOME'] ?? join(homedir(), '.cleo');
}

/**
 * Get the global CLEO templates directory.
 */
export function getCleoTemplatesDir(): string {
  return join(getCleoHome(), 'templates');
}

/**
 * Get the global CLEO schemas directory.
 */
export function getCleoSchemasDir(): string {
  return join(getCleoHome(), 'schemas');
}

/**
 * Get the global CLEO docs directory.
 */
export function getCleoDocsDir(): string {
  return join(getCleoHome(), 'docs');
}

/**
 * Get the project CLEO data directory (relative).
 * Respects CLEO_DIR env var, defaults to ".cleo".
 */
export function getCleoDir(cwd?: string): string {
  if (cwd) {
    return getCleoDirAbsolute(cwd);
  }
  return process.env['CLEO_DIR'] ?? '.cleo';
}

/**
 * Get the absolute path to the project CLEO directory.
 */
export function getCleoDirAbsolute(cwd?: string): string {
  const cleoDir = getCleoDir();
  if (isAbsolutePath(cleoDir)) {
    return cleoDir;
  }
  return resolve(cwd ?? process.cwd(), cleoDir);
}

/**
 * Get the project root from the CLEO directory.
 * If CLEO_DIR is ".cleo", the project root is its parent.
 */
export function getProjectRoot(cwd?: string): string {
  const cleoDirAbs = getCleoDirAbsolute(cwd);
  if (cleoDirAbs.endsWith('/.cleo') || cleoDirAbs.endsWith('\\.cleo')) {
    return dirname(cleoDirAbs);
  }
  return cwd ?? process.cwd();
}

/**
 * Resolve a project-relative path to an absolute path.
 */
export function resolveProjectPath(relativePath: string, cwd?: string): string {
  if (isAbsolutePath(relativePath)) {
    return relativePath;
  }
  // Expand leading tilde
  if (relativePath.startsWith('~/') || relativePath === '~') {
    return resolve(homedir(), relativePath.slice(2));
  }
  return resolve(getProjectRoot(cwd), relativePath);
}

/**
 * Get the path to the project's todo.json file.
 */
export function getTodoPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'todo.json');
}

/**
 * Get the path to the project's config.json file.
 */
export function getConfigPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'config.json');
}

/**
 * Get the path to the project's sessions.json file.
 */
export function getSessionsPath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'sessions.json');
}

/**
 * Get the path to the project's archive file.
 */
export function getArchivePath(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'todo-archive.json');
}

/**
 * Get the path to the project's log file.
 * Auto-migrates legacy todo-log.json to todo-log.jsonl if needed.
 * @task T4644
 */
export function getLogPath(cwd?: string): string {
  const cleoDir = getCleoDirAbsolute(cwd);
  const newPath = join(cleoDir, 'todo-log.jsonl');
  const legacyPath = join(cleoDir, 'todo-log.json');

  // Auto-migrate: rename legacy file if new file doesn't exist
  if (!existsSync(newPath) && existsSync(legacyPath)) {
    try {
      renameSync(legacyPath, newPath);
    } catch {
      // If rename fails (e.g. permissions), fall back to legacy path
      return legacyPath;
    }
  }

  return newPath;
}

/**
 * Get the backup directory for operational backups.
 */
export function getBackupDir(cwd?: string): string {
  return join(getCleoDirAbsolute(cwd), 'backups', 'operational');
}

/**
 * Get the global config file path.
 */
export function getGlobalConfigPath(): string {
  return join(getCleoHome(), 'config.json');
}

/**
 * Check if a path is absolute (POSIX or Windows).
 */
export function isAbsolutePath(path: string): boolean {
  // POSIX absolute
  if (path.startsWith('/')) return true;
  // Windows drive letter (C:\, D:/)
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  // UNC path
  if (path.startsWith('\\\\')) return true;
  return false;
}
