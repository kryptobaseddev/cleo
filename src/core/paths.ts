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
import { existsSync, readFileSync, renameSync } from 'node:fs';

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

// ============================================================================
// Agent Outputs
// ============================================================================

const DEFAULT_AGENT_OUTPUTS_DIR = '.cleo/agent-outputs';

/**
 * Get the agent outputs directory (relative path) from config or default.
 *
 * Config lookup priority:
 *   1. config.agentOutputs.directory
 *   2. config.research.outputDir (deprecated)
 *   3. config.directories.agentOutputs (deprecated)
 *   4. Default: '.cleo/agent-outputs'
 *
 * @task T4700
 */
export function getAgentOutputsDir(cwd?: string): string {
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));

      // Priority 1: agentOutputs.directory (canonical)
      if (typeof config.agentOutputs === 'object' && config.agentOutputs?.directory) {
        return config.agentOutputs.directory;
      }
      // Also support agentOutputs as a plain string
      if (typeof config.agentOutputs === 'string' && config.agentOutputs) {
        return config.agentOutputs;
      }

      // Priority 2: research.outputDir (deprecated)
      if (config.research?.outputDir) {
        return config.research.outputDir;
      }

      // Priority 3: directories.agentOutputs (deprecated)
      if (config.directories?.agentOutputs) {
        return config.directories.agentOutputs;
      }
    } catch {
      // fallback to default
    }
  }

  return DEFAULT_AGENT_OUTPUTS_DIR;
}

/**
 * Get the absolute path to the agent outputs directory.
 * @task T4700
 */
export function getAgentOutputsAbsolute(cwd?: string): string {
  const dir = getAgentOutputsDir(cwd);
  if (isAbsolutePath(dir)) {
    return dir;
  }
  return resolve(getProjectRoot(cwd), dir);
}

/**
 * Get the absolute path to the MANIFEST.jsonl file.
 *
 * Checks config.agentOutputs.manifestFile for custom filename,
 * defaults to 'MANIFEST.jsonl'.
 *
 * @task T4700
 */
export function getManifestPath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  const configPath = join(projectRoot, '.cleo', 'config.json');

  let manifestFile = 'MANIFEST.jsonl';
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const customFile = config.agentOutputs?.manifestFile ?? config.research?.manifestFile;
      if (customFile) {
        manifestFile = customFile;
      }
    } catch {
      // fallback
    }
  }

  return resolve(projectRoot, outputDir, manifestFile);
}

/**
 * Get the absolute path to the MANIFEST.archive.jsonl file.
 * @task T4700
 */
export function getManifestArchivePath(cwd?: string): string {
  const outputDir = getAgentOutputsDir(cwd);
  const projectRoot = getProjectRoot(cwd);
  return resolve(projectRoot, outputDir, 'MANIFEST.archive.jsonl');
}

// ============================================================================
// Path Utilities
// ============================================================================

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
