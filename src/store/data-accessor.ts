/**
 * DataAccessor: File-level storage abstraction for core modules.
 *
 * Core modules operate on whole-file data structures (TaskFile, ArchiveFile, SessionsFile).
 * The DataAccessor abstracts WHERE that data is stored (SQLite via Drizzle ORM)
 * while preserving the read-modify-write pattern that core business logic relies on.
 *
 * This is the DRY/SOLID injection point: core modules accept a DataAccessor parameter
 * instead of calling readJson/saveJson directly.
 *
 * Implementation: SqliteDataAccessor (materializes/dematerializes from SQLite tables)
 *
 * @epic T4454
 */

import type { Task, TaskFile } from '../types/task.js';
import type { Session } from '../types/session.js';
import type { ArchiveFields } from './db-helpers.js';

/** Archive file structure. */
export interface ArchiveFile {
  archivedTasks: Array<import('../types/task.js').Task>;
  version?: string;
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
  readonly engine: 'sqlite';

  // ---- Task data ----

  /** Load the full TaskFile (tasks + project meta + work state). */
  loadTaskFile(): Promise<TaskFile>;

  /** Save the full TaskFile atomically. Creates backup before write. */
  saveTaskFile(data: TaskFile): Promise<void>;

  // ---- Archive data ----

  /** Load the archive file. Returns null if archive doesn't exist. */
  loadArchive(): Promise<ArchiveFile | null>;

  /** Save the archive file atomically. Creates backup before write. */
  saveArchive(data: ArchiveFile): Promise<void>;

  // ---- Session data ----

  /** Load all sessions from the store. Returns empty array if none exist. */
  loadSessions(): Promise<Session[]>;

  /** Save all sessions to the store atomically. */
  saveSessions(sessions: Session[]): Promise<void>;

  // ---- Audit log ----

  /** Append an entry to the audit log. */
  appendLog(entry: Record<string, unknown>): Promise<void>;

  // ---- Lifecycle ----

  /** Release any resources (close DB connections, etc.). */
  close(): Promise<void>;

  // ---- Fine-grained task operations (T5034) ----
  // Optional methods for targeted single-task writes.
  // Callers check existence before use; absence triggers full-file fallback.

  /** Upsert a single task (targeted write, no full-file reload). */
  upsertSingleTask?(task: Task): Promise<void>;

  /** Archive a single task by ID (sets status='archived' + archive metadata). */
  archiveSingleTask?(taskId: string, fields: ArchiveFields): Promise<void>;

  /** Delete a single task permanently from the tasks table. */
  removeSingleTask?(taskId: string): Promise<void>;

  /** Insert a row into the task_relations table (T5168). */
  addRelation?(taskId: string, relatedTo: string, relationType: string): Promise<void>;

  // ---- Metadata (schema_meta KV store) ----

  /** Read a typed value from the metadata store. Returns null if not found. */
  getMetaValue?<T>(key: string): Promise<T | null>;

  /** Write a typed value to the metadata store. */
  setMetaValue?(key: string, value: unknown): Promise<void>;

  /** Read the schema version from metadata. Convenience for getMetaValue('schema_version'). */
  getSchemaVersion?(): Promise<string | null>;
}

/**
 * Create a DataAccessor for the given working directory.
 * Always creates a SQLite accessor (ADR-006 canonical storage).
 *
 * ALL accessors returned are safety-enabled by default via SafetyDataAccessor wrapper.
 * Use CLEO_DISABLE_SAFETY=true to bypass (emergency only).
 *
 * @param _engine - Ignored. Kept for API compatibility during migration period.
 * @param cwd - Working directory (defaults to process.cwd())
 */
export async function createDataAccessor(
  _engine?: 'sqlite',
  cwd?: string,
): Promise<DataAccessor> {
  const { createSqliteDataAccessor } = await import('./sqlite-data-accessor.js');
  const inner = await createSqliteDataAccessor(cwd);

  // Always wrap with safety - cannot be bypassed at factory level
  const { wrapWithSafety } = await import('./safety-data-accessor.js');
  return wrapWithSafety(inner, cwd);
}

/** Convenience: get a DataAccessor with auto-detected engine. */
export async function getAccessor(cwd?: string): Promise<DataAccessor> {
  return createDataAccessor(undefined, cwd);
}
