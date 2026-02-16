/**
 * Init Engine
 *
 * Project initialization: creates the .cleo/ directory structure
 * with empty data files and default configuration.
 *
 * CRITICAL: Init is explicit, not automatic. The MCP server MUST NOT
 * silently create .cleo/ directories on first write.
 */

import { existsSync, mkdirSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';
import { readJsonFile } from './store.js';

/**
 * Engine result wrapper
 */
export interface EngineResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Default schema versions for new files
 */
const DEFAULT_VERSIONS = {
  todo: '2.10.0',
  config: '2.10.0',
  archive: '2.4.0',
  log: '2.4.0',
  sessions: '1.0.0',
};

/**
 * Initialize a CLEO project directory.
 *
 * Creates the .cleo/ directory structure with empty data files.
 * Returns error if already initialized (unless force=true).
 */
export function initProject(
  projectRoot: string,
  options?: {
    projectName?: string;
    force?: boolean;
  }
): EngineResult<{
  initialized: boolean;
  projectRoot: string;
  filesCreated: string[];
}> {
  const cleoDir = join(projectRoot, '.cleo');
  const isAlreadyInit = existsSync(cleoDir) && existsSync(join(cleoDir, 'todo.json'));

  if (isAlreadyInit && !options?.force) {
    return {
      success: false,
      error: {
        code: 'E_ALREADY_INITIALIZED',
        message: 'CLEO project already initialized. Use force=true to reinitialize.',
      },
    };
  }

  const filesCreated: string[] = [];
  const now = new Date().toISOString();
  const projectName = options?.projectName || deriveProjectName(projectRoot);

  // Create directory structure
  const dirs = [
    cleoDir,
    join(cleoDir, '.backups'),
    join(cleoDir, 'backups'),
    join(cleoDir, 'metrics'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  // Create todo.json
  const todoPath = join(cleoDir, 'todo.json');
  if (!existsSync(todoPath) || options?.force) {
    const todoData = {
      project: {
        name: projectName,
        currentPhase: null,
        phases: {},
        phaseHistory: [],
        releases: [],
      },
      lastUpdated: now,
      focus: {
        currentTask: null,
        currentPhase: null,
        blockedUntil: null,
        sessionNote: null,
        sessionNotes: [],
        nextAction: null,
        primarySession: null,
      },
      _meta: {
        schemaVersion: DEFAULT_VERSIONS.todo,
        specVersion: '3.1.0',
        checksum: '0000000000000000',
        configVersion: DEFAULT_VERSIONS.config,
        lastSessionId: null,
        activeSession: null,
        multiSessionEnabled: false,
        activeSessionCount: 0,
        sessionsFile: 'sessions.json',
        generation: 0,
      },
      tasks: [],
      labels: {},
    };
    writeFileSync(todoPath, JSON.stringify(todoData, null, 2) + '\n', 'utf-8');
    filesCreated.push('todo.json');
  }

  // Create config.json
  const configPath = join(cleoDir, 'config.json');
  if (!existsSync(configPath) || options?.force) {
    const configData = {
      version: DEFAULT_VERSIONS.config,
      _meta: {
        schemaVersion: DEFAULT_VERSIONS.config,
      },
    };
    writeFileSync(configPath, JSON.stringify(configData, null, 2) + '\n', 'utf-8');
    filesCreated.push('config.json');
  }

  // Create todo-archive.json
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (!existsSync(archivePath) || options?.force) {
    const archiveData = {
      project: projectName,
      _meta: {
        schemaVersion: DEFAULT_VERSIONS.archive,
        totalArchived: 0,
        lastArchived: null,
      },
      archivedTasks: [],
    };
    writeFileSync(archivePath, JSON.stringify(archiveData, null, 2) + '\n', 'utf-8');
    filesCreated.push('todo-archive.json');
  }

  // Create todo-log.jsonl (migrate from legacy todo-log.json if present)
  const logPath = join(cleoDir, 'todo-log.jsonl');
  const legacyLogPath = join(cleoDir, 'todo-log.json');
  if (!existsSync(logPath)) {
    if (existsSync(legacyLogPath) && !options?.force) {
      // Migrate legacy file
      renameSync(legacyLogPath, logPath);
      filesCreated.push('todo-log.jsonl (migrated from todo-log.json)');
    } else {
      writeFileSync(logPath, '', 'utf-8');
      filesCreated.push('todo-log.jsonl');
    }
  } else if (options?.force) {
    writeFileSync(logPath, '', 'utf-8');
    filesCreated.push('todo-log.jsonl');
  }

  return {
    success: true,
    data: {
      initialized: true,
      projectRoot,
      filesCreated,
    },
  };
}

/**
 * Check if auto-init is enabled via environment variable
 */
export function isAutoInitEnabled(): boolean {
  return process.env.CLEO_AUTO_INIT === 'true';
}

/**
 * Check initialization status and auto-init if configured
 */
export function ensureInitialized(
  projectRoot: string
): EngineResult<{ initialized: boolean }> {
  const cleoDir = join(projectRoot, '.cleo');
  const isInit = existsSync(cleoDir) && existsSync(join(cleoDir, 'todo.json'));

  if (isInit) {
    return { success: true, data: { initialized: true } };
  }

  if (isAutoInitEnabled()) {
    const result = initProject(projectRoot);
    if (result.success) {
      return { success: true, data: { initialized: true } };
    }
    return {
      success: false,
      error: result.error,
    };
  }

  return {
    success: false,
    error: {
      code: 'E_NOT_INITIALIZED',
      message: 'CLEO project not initialized. Run system.init or set CLEO_AUTO_INIT=true',
    },
  };
}

/**
 * Derive project name from directory path
 */
function deriveProjectName(projectRoot: string): string {
  const parts = projectRoot.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || 'cleo-project';
}

/**
 * Get current version (native implementation)
 */
export function getVersion(projectRoot: string): EngineResult<{ version: string }> {
  // Try reading VERSION file from project root
  const versionPaths = [
    join(projectRoot, 'VERSION'),
    join(projectRoot, '..', 'VERSION'), // mcp-server subdirectory
  ];

  for (const versionPath of versionPaths) {
    try {
      const { readFileSync } = require('fs');
      const version = readFileSync(versionPath, 'utf-8').trim();
      if (version) {
        return { success: true, data: { version } };
      }
    } catch {
      // Try next path
    }
  }

  // Fallback: try package.json
  try {
    const pkg = readJsonFile<{ version: string }>(join(projectRoot, 'package.json'));
    if (pkg?.version) {
      return { success: true, data: { version: pkg.version } };
    }
  } catch {
    // No package.json
  }

  return { success: true, data: { version: '0.0.0' } };
}
