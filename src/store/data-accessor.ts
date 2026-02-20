/**
 * DataAccessor: File-level storage abstraction for core modules.
 *
 * Core modules operate on whole-file data structures (TaskFile, ArchiveFile, SessionsFile).
 * The DataAccessor abstracts WHERE that data is stored (JSON files vs SQLite)
 * while preserving the read-modify-write pattern that core business logic relies on.
 *
 * This is the DRY/SOLID injection point: core modules accept a DataAccessor parameter
 * instead of calling readJson/saveJson directly.
 *
 * Two implementations:
 * - JsonDataAccessor: reads/writes .cleo/*.json files (current behavior)
 * - SqliteDataAccessor: materializes/dematerializes from SQLite tables
 *
 * @epic T4454
 */

import type { TaskFile } from '../types/task.js';
import type { Session } from '../types/session.js';

/** Archive file structure. */
export interface ArchiveFile {
  archivedTasks: Array<import('../types/task.js').Task>;
  version?: string;
}

/** Sessions file structure. Must match types/session.ts SessionsFile. */
export interface SessionsFile {
  sessions: Session[];
  version: string;
  _meta: {
    schemaVersion: string;
    lastUpdated: string;
  };
}

/**
 * DataAccessor interface.
 *
 * Core modules call these methods instead of readJson/saveJson.
 * Each method maps directly to the file-level operations that
 * core modules already perform.
 */
export interface DataAccessor {
  /** The storage engine backing this accessor. */
  readonly engine: 'json' | 'sqlite' | 'dual';

  // ---- Task data (tasks.json equivalent) ----

  /** Load the full TaskFile (tasks + project meta + work state). */
  loadTaskFile(): Promise<TaskFile>;

  /** Save the full TaskFile atomically. Creates backup before write. */
  saveTaskFile(data: TaskFile): Promise<void>;

  /** @deprecated Use loadTaskFile() instead. */
  loadTodoFile(): Promise<TaskFile>;

  /** @deprecated Use saveTaskFile() instead. */
  saveTodoFile(data: TaskFile): Promise<void>;

  // ---- Archive data (todo-archive.json equivalent) ----

  /** Load the archive file. Returns null if archive doesn't exist. */
  loadArchive(): Promise<ArchiveFile | null>;

  /** Save the archive file atomically. Creates backup before write. */
  saveArchive(data: ArchiveFile): Promise<void>;

  // ---- Session data (sessions.json equivalent) ----

  /** Load the sessions file. Returns empty sessions array if file doesn't exist. */
  loadSessions(): Promise<SessionsFile>;

  /** Save the sessions file atomically. */
  saveSessions(data: SessionsFile): Promise<void>;

  // ---- Audit log (todo-log.jsonl equivalent) ----

  /** Append an entry to the audit log. */
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // ---- Lifecycle ----

  /** Release any resources (close DB connections, etc.). */
  close(): Promise<void>;
}

/**
 * Create a DataAccessor for the given working directory.
 * Auto-detects engine from .cleo/config.json (storage.engine field).
 *
 * ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper.
 * Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).
 *
 * @param engine - Force a specific engine, or undefined for auto-detect
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function createDataAccessor(
  engine?: 'json' | 'sqlite' | 'dual',
  cwd?: string,
): Promise<DataAccessor> {
  const resolvedEngine = engine ?? (await detectEngine(cwd));

  // Create the inner accessor based on engine
  let inner: DataAccessor;
  switch (resolvedEngine) {
    case 'sqlite': {
      const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
      inner = await createSqliteDataAccessor(cwd);
      break;
    }
    case 'dual': {
      // Dual mode: write to both, read from SQLite with JSON fallback
      const { createJsonDataAccessor } = await import('./json-data-accessor.js');
      const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
      inner = createDualDataAccessor(
        await createJsonDataAccessor(cwd),
        await createSqliteDataAccessor(cwd),
      );
      break;
    }
    case 'json':
    default: {
      const { createJsonDataAccessor } = await import('./json-data-accessor.js');
      inner = await createJsonDataAccessor(cwd);
      break;
    }
  }

  // Always wrap with safety - cannot be bypassed at factory level
  const { wrapWithSafety } = await import('./safety-data-accessor.js');
  return wrapWithSafety(inner, cwd);
}

/** Convenience: get a DataAccessor with auto-detected engine. */
export async function getAccessor(cwd?: string): Promise<DataAccessor> {
  return createDataAccessor(undefined, cwd);
}

// ---- Internal helpers ----

async function detectEngine(cwd?: string): Promise<'json' | 'sqlite' | 'dual'> {
  try {
    const { existsSync, readFileSync } = await import('node:fs');
    const { getCleoDirAbsolute } = await import('../core/paths.js');
    const cleoDir = getCleoDirAbsolute(cwd);
    const configPath = (await import('node:path')).join(cleoDir, 'config.json');

    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const engine = config?.storage?.engine;
      if (engine === 'sqlite' || engine === 'dual' || engine === 'json') {
        return engine;
      }
    }

    // Auto-detect: if tasks.db exists, use sqlite
    const dbPath = (await import('node:path')).join(cleoDir, 'tasks.db');
    if (existsSync(dbPath)) {
      return 'sqlite';
    }
  } catch {
    // Fall through to default
  }
  return 'json';
}

/**
 * Dual-write DataAccessor.
 * Writes to both JSON and SQLite. Reads from SQLite, falls back to JSON.
 */
function createDualDataAccessor(json: DataAccessor, sqlite: DataAccessor): DataAccessor {
  return {
    engine: 'dual' as const,

    async loadTaskFile() {
      try {
        return await sqlite.loadTaskFile();
      } catch {
        return await json.loadTaskFile();
      }
    },

    async saveTaskFile(data) {
      await Promise.allSettled([
        json.saveTaskFile(data),
        sqlite.saveTaskFile(data),
      ]);
    },

    // Deprecated aliases
    async loadTodoFile() {
      return this.loadTaskFile();
    },

    async saveTodoFile(data: TaskFile) {
      return this.saveTaskFile(data);
    },

    async loadArchive() {
      try {
        return await sqlite.loadArchive();
      } catch {
        return await json.loadArchive();
      }
    },

    async saveArchive(data) {
      await Promise.allSettled([
        json.saveArchive(data),
        sqlite.saveArchive(data),
      ]);
    },

    async loadSessions() {
      try {
        return await sqlite.loadSessions();
      } catch {
        return await json.loadSessions();
      }
    },

    async saveSessions(data) {
      await Promise.allSettled([
        json.saveSessions(data),
        sqlite.saveSessions(data),
      ]);
    },

    async appendLog(entry) {
      // Logs always go to JSONL file (append-only, both backends)
      await json.appendLog(entry);
    },

    async close() {
      await Promise.allSettled([json.close(), sqlite.close()]);
    },
  };
}
