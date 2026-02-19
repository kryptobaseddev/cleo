/**
 * Pre-flight migration checks.
 *
 * Detects when JSON data exists but hasn't been migrated to SQLite,
 * and provides actionable diagnostics for users upgrading to v2.
 *
 * Core module: CLI and MCP both call these functions.
 *
 * @task T4699
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../paths.js';

/** Pre-flight check result. */
export interface PreflightResult {
  /** Whether a storage migration is needed. */
  migrationNeeded: boolean;
  /** Current detected storage engine. */
  currentEngine: 'json' | 'sqlite' | 'dual' | 'none';
  /** Human-readable summary of what was detected. */
  summary: string;
  /** Actionable fix command. */
  fix: string | null;
  /** Detailed diagnostics. */
  details: {
    todoJsonExists: boolean;
    todoJsonTaskCount: number;
    archiveJsonExists: boolean;
    archiveJsonTaskCount: number;
    sessionsJsonExists: boolean;
    sessionsJsonCount: number;
    tasksDbExists: boolean;
    tasksDbSize: number;
    configEngine: string | null;
  };
}

/**
 * Check whether JSON data needs to be migrated to SQLite.
 *
 * Returns a diagnostic result that callers can use to warn users.
 * This function is read-only and never modifies any files.
 *
 * @task T4699
 */
export function checkStorageMigration(cwd?: string): PreflightResult {
  const cleoDir = getCleoDirAbsolute(cwd);

  const details: PreflightResult['details'] = {
    todoJsonExists: false,
    todoJsonTaskCount: 0,
    archiveJsonExists: false,
    archiveJsonTaskCount: 0,
    sessionsJsonExists: false,
    sessionsJsonCount: 0,
    tasksDbExists: false,
    tasksDbSize: 0,
    configEngine: null,
  };

  // Check config.json for engine setting
  const configPath = join(cleoDir, 'config.json');
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      details.configEngine = config?.storage?.engine ?? null;
    } catch {
      // Ignore parse errors
    }
  }

  // Check todo.json
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    details.todoJsonExists = true;
    try {
      const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
      details.todoJsonTaskCount = (data.tasks ?? []).length;
    } catch {
      // Corrupted but exists
    }
  }

  // Check todo-archive.json
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    details.archiveJsonExists = true;
    try {
      const data = JSON.parse(readFileSync(archivePath, 'utf-8'));
      details.archiveJsonTaskCount = (data.tasks ?? data.archivedTasks ?? []).length;
    } catch {
      // Corrupted but exists
    }
  }

  // Check sessions.json
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    details.sessionsJsonExists = true;
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      details.sessionsJsonCount = (data.sessions ?? []).length;
    } catch {
      // Corrupted but exists
    }
  }

  // Check tasks.db
  const dbPath = join(cleoDir, 'tasks.db');
  if (existsSync(dbPath)) {
    details.tasksDbExists = true;
    try {
      details.tasksDbSize = statSync(dbPath).size;
    } catch {
      // Can't stat
    }
  }

  // Determine current engine
  let currentEngine: PreflightResult['currentEngine'] = 'none';
  if (details.configEngine === 'sqlite' || details.configEngine === 'dual') {
    currentEngine = details.configEngine as 'sqlite' | 'dual';
  } else if (details.configEngine === 'json') {
    currentEngine = 'json';
  } else if (details.tasksDbExists) {
    currentEngine = 'sqlite';
  } else if (details.todoJsonExists) {
    currentEngine = 'json';
  }

  // Determine if migration is needed
  const jsonHasData = details.todoJsonTaskCount > 0
    || details.archiveJsonTaskCount > 0
    || details.sessionsJsonCount > 0;

  // Migration is flagged for broken or upgrade states:
  //
  // Cases:
  // 1. Config says sqlite but tasks.db is missing (broken state)
  // 2. No config engine set, JSON data exists, no tasks.db (v1→v2 upgrade)
  //
  // NOT flagged:
  // - Config says sqlite and tasks.db exists (normal post-migration state,
  //   even if JSON files remain as backups)
  // - Config says json explicitly (user opted out of SQLite)

  let migrationNeeded = false;
  let summary = '';
  let fix: string | null = null;

  if (details.configEngine === 'sqlite' && !details.tasksDbExists && jsonHasData) {
    // Config says sqlite but DB is missing - broken state
    migrationNeeded = true;
    summary = `Config engine is 'sqlite' but tasks.db is missing. `
      + `${details.todoJsonTaskCount} active tasks and ${details.archiveJsonTaskCount} archived tasks found in JSON files.`;
    fix = 'cleo migrate-storage --to-sqlite --verify';
  } else if (details.configEngine === 'sqlite' && !details.tasksDbExists && !jsonHasData) {
    // Config says sqlite, no DB, no JSON data - fresh project with bad config
    migrationNeeded = false;
    summary = 'No data found. Run cleo init to set up a new project.';
  } else if (
    details.configEngine === null
    && jsonHasData
    && !details.tasksDbExists
  ) {
    // No explicit config, JSON data exists but no SQLite DB.
    // User is upgrading from JSON era — SQLite is now the default in CLEO V2.
    const totalTasks = details.todoJsonTaskCount + details.archiveJsonTaskCount;
    migrationNeeded = true;
    summary = `Found ${totalTasks} task(s) in JSON files but no SQLite database. `
      + `SQLite is the default storage engine in CLEO V2. `
      + `Run migration to upgrade, or set storage.engine to 'json' in .cleo/config.json to keep using JSON.`;
    fix = 'cleo migrate-storage --to-sqlite --verify';
  } else if (!jsonHasData && !details.tasksDbExists) {
    summary = 'No data found. Run cleo init to set up a new project.';
  } else {
    summary = currentEngine === 'sqlite'
      ? `SQLite storage active (${details.tasksDbSize} bytes).`
      : `JSON storage active (${details.todoJsonTaskCount} tasks).`;
  }

  return {
    migrationNeeded,
    currentEngine,
    summary,
    fix,
    details,
  };
}
