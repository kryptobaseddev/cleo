/**
 * Pre-flight migration checks.
 *
 * Detects when legacy JSON data exists but hasn't been migrated to SQLite,
 * and provides actionable diagnostics for users upgrading from V1.
 *
 * Per ADR-006, SQLite is the ONLY supported storage engine.
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
  /** Current detected storage engine. Always 'sqlite' or 'none'. */
  currentEngine: 'sqlite' | 'none';
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
    tasksJsonExists: boolean;
    tasksDbExists: boolean;
    tasksDbSize: number;
    configEngine: string | null;
  };
}

/**
 * Check whether legacy JSON data needs to be migrated to SQLite.
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
    tasksJsonExists: false,
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

  // Check legacy todo.json
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

  // Check legacy todo-archive.json
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

  // Check legacy sessions.json
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

  // Check legacy tasks.json
  const tasksJsonPath = join(cleoDir, 'tasks.json');
  if (existsSync(tasksJsonPath)) {
    details.tasksJsonExists = true;
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

  // Determine current engine — per ADR-006, only sqlite or none
  const currentEngine: PreflightResult['currentEngine'] = details.tasksDbExists ? 'sqlite' : 'none';

  // Determine if migration is needed
  const jsonHasData = details.todoJsonTaskCount > 0
    || details.archiveJsonTaskCount > 0
    || details.sessionsJsonCount > 0;

  let migrationNeeded = false;
  let summary = '';
  let fix: string | null = null;

  const hasStaleLegacyFiles = details.todoJsonExists || details.archiveJsonExists || details.sessionsJsonExists || details.tasksJsonExists;

  if (!details.tasksDbExists && jsonHasData) {
    // Legacy JSON data exists but no SQLite DB — migration needed
    const totalTasks = details.todoJsonTaskCount + details.archiveJsonTaskCount;
    migrationNeeded = true;
    summary = `Found ${totalTasks} task(s) in legacy JSON files but no SQLite database. `
      + `SQLite is the only supported storage engine (ADR-006). `
      + `Run migration to upgrade.`;
    fix = 'cleo upgrade';
  } else if (!details.tasksDbExists && !jsonHasData) {
    summary = 'No data found. Run cleo init to set up a new project.';
  } else if (details.tasksDbExists && hasStaleLegacyFiles) {
    summary = `SQLite storage active (${details.tasksDbSize} bytes) but stale legacy JSON files exist.`;
    migrationNeeded = true;
    fix = 'cleo upgrade';
  } else {
    summary = `SQLite storage active (${details.tasksDbSize} bytes).`;
  }

  return {
    migrationNeeded,
    currentEngine,
    summary,
    fix,
    details,
  };
}
