/**
 * Data migration: JSON to SQLite.
 *
 * One-time migration of todo.json + todo-archive.json + sessions.json → tasks.db.
 * Validates row counts match after migration.
 * Keeps JSON files as read-only backup (does not delete).
 *
 * @epic T4454
 * @task W1-T5
 * @task T4721 - Added atomic migration support with custom db path
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getCleoDirAbsolute } from '../core/paths.js';
import { getDb, saveToFile, dbExists } from './sqlite.js';
import * as schema from './schema.js';
import type { Task } from '../types/task.js';
import type { Session, SessionsFile } from '../types/session.js';
import initSqlJs from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';

/** Migration result. */
export interface MigrationResult {
  success: boolean;
  tasksImported: number;
  archivedImported: number;
  sessionsImported: number;
  errors: string[];
  warnings: string[];
  existingCounts?: {
    tasks: number;
    archived: number;
    sessions: number;
  };
  jsonCounts?: {
    tasks: number;
    archived: number;
    sessions: number;
  };
}

/** Options for migration. */
export interface MigrationOptions {
  force?: boolean;
  dryRun?: boolean;
}

/** Count records in JSON source files. */
export function countJsonRecords(cleoDir: string): {
  tasks: number;
  archived: number;
  sessions: number;
} {
  let tasks = 0;
  let archived = 0;
  let sessions = 0;

  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const data = JSON.parse(readFileSync(todoPath, 'utf-8'));
      tasks = (data.tasks ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      const data = JSON.parse(readFileSync(archivePath, 'utf-8'));
      archived = (data.tasks ?? data.archivedTasks ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const data = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
      sessions = (data.sessions ?? []).length;
    } catch {
      // Corrupted file
    }
  }

  return { tasks, archived, sessions };
}

/**
 * Migrate JSON data to SQLite.
 * Reads todo.json, todo-archive.json, and sessions.json,
 * writes to tasks.db via drizzle-orm.
 */
/**
 * Migrate JSON data to SQLite with atomic rename pattern.
 * Writes to a temporary database file first, then atomically renames.
 *
 * @param cwd - Optional working directory
 * @param tempDbPath - Optional temporary database path for atomic migration
 * @param logger - Optional migration logger for audit trail (@task T4727)
 * @returns Migration result
 */
export async function migrateJsonToSqliteAtomic(
  cwd?: string,
  tempDbPath?: string,
  logger?: import('../core/migration/logger.js').MigrationLogger,
): Promise<MigrationResult> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const result: MigrationResult = {
    success: false,
    tasksImported: 0,
    archivedImported: 0,
    sessionsImported: 0,
    errors: [],
    warnings: [],
  };

  // If no temp path provided, use standard migration
  if (!tempDbPath) {
    return migrateJsonToSqlite(cwd);
  }

  // Close any existing DB connection
  const { closeDb, resetDbState } = await import('./sqlite.js');
  closeDb();

  try {
    logger?.info('import', 'init', 'Initializing SQL.js for migration');

    // Initialize sql.js and create new database at temp path
    const SQL = await initSqlJs();
    const nativeDb = new SQL.Database();

    // Create tables
    logger?.info('import', 'create-tables', 'Creating database tables');
    await createMigrationTables(nativeDb);

    // Create drizzle wrapper
    const db = drizzle(nativeDb, { schema });

    // Run the actual migration
    logger?.info('import', 'data-import', 'Starting data import from JSON files');
    await runMigrationDataImport(db, cleoDir, result, logger);

    // Save to temp file
    logger?.info('import', 'save-temp', 'Saving to temporary database file', {
      tempPath: tempDbPath.replace(cleoDir, '.'),
    });
    mkdirSync(dirname(tempDbPath), { recursive: true });
    const data = nativeDb.export();
    const buffer = Buffer.from(data);
    writeFileSync(tempDbPath, buffer);

    // Get file size for logging
    const { statSync } = await import('node:fs');
    const fileStats = statSync(tempDbPath);
    logger?.info('import', 'temp-saved', 'Temporary database saved', {
      size: fileStats.size,
      path: tempDbPath.replace(cleoDir, '.'),
    });

    // Close the database
    nativeDb.close();
    resetDbState();

    result.success = result.errors.length === 0;
    logger?.info('import', 'complete', 'Migration import completed', {
      success: result.success,
      tasksImported: result.tasksImported,
      archivedImported: result.archivedImported,
      sessionsImported: result.sessionsImported,
      errors: result.errors.length,
      warnings: result.warnings.length,
    });
    return result;
  } catch (err) {
    const errorMsg = `Atomic migration failed: ${String(err)}`;
    result.errors.push(errorMsg);
    logger?.error('import', 'failed', errorMsg, {
      error: String(err),
    });
    resetDbState();
    return result;
  }
}

/**
 * Create tables for migration (standalone version without singleton state).
 */
async function createMigrationTables(nativeDb: import('sql.js').Database): Promise<void> {
  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','active','blocked','done','cancelled','archived')),
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('critical','high','medium','low')),
      type TEXT CHECK(type IN ('epic','task','subtask')),
      parent_id TEXT REFERENCES tasks(id),
      phase TEXT,
      size TEXT CHECK(size IN ('small','medium','large')),
      position INTEGER,
      position_version INTEGER DEFAULT 0,
      labels_json TEXT DEFAULT '[]',
      notes_json TEXT DEFAULT '[]',
      acceptance_json TEXT DEFAULT '[]',
      files_json TEXT DEFAULT '[]',
      origin TEXT,
      blocked_by TEXT,
      epic_lifecycle TEXT,
      no_auto_complete INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT,
      completed_at TEXT,
      cancelled_at TEXT,
      cancellation_reason TEXT,
      archived_at TEXT,
      archive_reason TEXT,
      cycle_time_days INTEGER,
      verification_json TEXT,
      created_by TEXT,
      modified_by TEXT,
      session_id TEXT
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, depends_on)
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS task_relations (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      related_to TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL DEFAULT 'related'
        CHECK(relation_type IN ('related','blocks','duplicates')),
      PRIMARY KEY (task_id, related_to)
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','ended','orphaned','suspended')),
      scope_json TEXT NOT NULL DEFAULT '{}',
      current_task TEXT,
      task_started_at TEXT,
      agent TEXT,
      notes_json TEXT DEFAULT '[]',
      tasks_completed_json TEXT DEFAULT '[]',
      tasks_created_json TEXT DEFAULT '[]',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS task_work_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      set_at TEXT NOT NULL DEFAULT (datetime('now')),
      cleared_at TEXT
    );
  `);

  nativeDb.run(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Create indexes
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_deps_depends_on ON task_dependencies(depends_on);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);');
  nativeDb.run('CREATE INDEX IF NOT EXISTS idx_work_history_session ON task_work_history(session_id);');

  // Set schema version
  nativeDb.run(
    `INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('schemaVersion', '1.0.0')`,
  );
}

/**
 * Run the actual data import for migration.
 */
async function runMigrationDataImport(
  db: import('drizzle-orm/sql-js').SQLJsDatabase<typeof schema>,
  cleoDir: string,
  result: MigrationResult,
  logger?: import('../core/migration/logger.js').MigrationLogger,
): Promise<void> {
  // === MIGRATE TASKS from todo.json ===
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      logger?.info('import', 'read-todo', 'Reading todo.json', {
        path: todoPath.replace(cleoDir, '.'),
      });

      const todoData = JSON.parse(readFileSync(todoPath, 'utf-8'));
      const tasks: Task[] = todoData.tasks ?? [];
      const totalTasks = tasks.length;

      logger?.info('import', 'tasks-start', `Starting import of ${totalTasks} tasks`, {
        totalTasks,
      });

      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        try {
          db.insert(schema.tasks).values({
            id: task.id,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority ?? 'medium',
            type: task.type,
            parentId: task.parentId,
            phase: task.phase,
            size: task.size,
            position: task.position,
            labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
            notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
            acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
            filesJson: task.files ? JSON.stringify(task.files) : '[]',
            origin: task.origin,
            blockedBy: task.blockedBy,
            epicLifecycle: task.epicLifecycle,
            noAutoComplete: task.noAutoComplete,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            completedAt: task.completedAt,
            cancelledAt: task.cancelledAt,
            cancellationReason: task.cancellationReason,
            verificationJson: task.verification ? JSON.stringify(task.verification) : undefined,
            createdBy: task.provenance?.createdBy,
            modifiedBy: task.provenance?.modifiedBy,
            sessionId: task.provenance?.sessionId,
          }).onConflictDoNothing().run();

          // Insert dependencies
          if (task.depends) {
            for (const depId of task.depends) {
              db.insert(schema.taskDependencies)
                .values({ taskId: task.id, dependsOn: depId })
                .onConflictDoNothing()
                .run();
            }
          }

          result.tasksImported++;

          // Log progress every 100 tasks
          if ((i + 1) % 100 === 0 || i === tasks.length - 1) {
            logger?.logImportProgress('import', 'tasks', result.tasksImported, totalTasks);
          }
        } catch (err) {
          const errorMsg = `Failed to import task ${task.id}: ${String(err)}`;
          result.errors.push(errorMsg);
          logger?.error('import', 'task-import', errorMsg, {
            taskId: task.id,
            error: String(err),
          });
        }
      }

      logger?.info('import', 'tasks-complete', `Completed importing ${result.tasksImported} tasks`, {
        imported: result.tasksImported,
        failed: result.errors.length,
      });
    } catch (err) {
      const errorMsg = `Failed to parse todo.json: ${String(err)}`;
      result.errors.push(errorMsg);
      logger?.error('import', 'parse-todo', errorMsg);
    }
  } else {
    result.warnings.push('todo.json not found, skipping task import');
    logger?.warn('import', 'todo-missing', 'todo.json not found, skipping task import');
  }

  // === MIGRATE ARCHIVED TASKS from todo-archive.json ===
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      logger?.info('import', 'read-archive', 'Reading todo-archive.json', {
        path: archivePath.replace(cleoDir, '.'),
      });

      const archiveData = JSON.parse(readFileSync(archivePath, 'utf-8'));
      const archivedTasks: (Task & { archivedAt?: string; archiveReason?: string; cycleTimeDays?: number })[] =
        archiveData.tasks ?? archiveData.archivedTasks ?? [];
      const totalArchived = archivedTasks.length;

      logger?.info('import', 'archive-start', `Starting import of ${totalArchived} archived tasks`, {
        totalArchived,
      });

      for (let i = 0; i < archivedTasks.length; i++) {
        const task = archivedTasks[i];
        try {
          db.insert(schema.tasks).values({
            id: task.id,
            title: task.title,
            description: task.description,
            status: 'archived',
            priority: task.priority ?? 'medium',
            type: task.type,
            parentId: task.parentId,
            phase: task.phase,
            size: task.size,
            position: task.position,
            labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
            notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
            acceptanceJson: task.acceptance ? JSON.stringify(task.acceptance) : '[]',
            filesJson: task.files ? JSON.stringify(task.files) : '[]',
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            completedAt: task.completedAt,
            archivedAt: task.archivedAt ?? task.completedAt ?? new Date().toISOString(),
            archiveReason: task.archiveReason ?? 'migrated',
            cycleTimeDays: task.cycleTimeDays,
          }).onConflictDoNothing().run();

          result.archivedImported++;

          // Log progress every 50 archived tasks
          if ((i + 1) % 50 === 0 || i === archivedTasks.length - 1) {
            logger?.logImportProgress('import', 'archived', result.archivedImported, totalArchived);
          }
        } catch (err) {
          const errorMsg = `Failed to import archived task ${task.id}: ${String(err)}`;
          result.errors.push(errorMsg);
          logger?.error('import', 'archived-import', errorMsg, {
            taskId: task.id,
            error: String(err),
          });
        }
      }

      logger?.info('import', 'archive-complete', `Completed importing ${result.archivedImported} archived tasks`, {
        imported: result.archivedImported,
      });
    } catch (err) {
      const errorMsg = `Failed to parse todo-archive.json: ${String(err)}`;
      result.errors.push(errorMsg);
      logger?.error('import', 'parse-archive', errorMsg);
    }
  }

  // === MIGRATE SESSIONS from sessions.json ===
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      logger?.info('import', 'read-sessions', 'Reading sessions.json', {
        path: sessionsPath.replace(cleoDir, '.'),
      });

      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as SessionsFile;
      const sessions: Session[] = sessionsData.sessions ?? [];
      const totalSessions = sessions.length;

      logger?.info('import', 'sessions-start', `Starting import of ${totalSessions} sessions`, {
        totalSessions,
      });

      for (let i = 0; i < sessions.length; i++) {
        const session = sessions[i];
        try {
          // Normalize status: map legacy 'archived' to 'ended' for SQLite CHECK constraint
          const validStatuses = ['active', 'ended', 'orphaned', 'suspended'];
          const normalizedStatus = validStatuses.includes(session.status)
            ? session.status
            : 'ended';
          // Provide default name for sessions with null/undefined names
          const normalizedName = session.name || `session-${session.id}`;

          db.insert(schema.sessions).values({
            id: session.id,
            name: normalizedName,
            status: normalizedStatus,
            scopeJson: JSON.stringify(session.scope),
            currentTask: session.taskWork?.taskId ?? session.focus?.taskId,
            taskStartedAt: session.taskWork?.setAt ?? session.focus?.setAt,
            agent: session.agent,
            notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
            tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
            tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
            startedAt: session.startedAt,
            endedAt: session.endedAt,
          }).onConflictDoNothing().run();

          result.sessionsImported++;

          // Log progress every 10 sessions
          if ((i + 1) % 10 === 0 || i === sessions.length - 1) {
            logger?.logImportProgress('import', 'sessions', result.sessionsImported, totalSessions);
          }
        } catch (err) {
          const errorMsg = `Failed to import session ${session.id}: ${String(err)}`;
          result.errors.push(errorMsg);
          logger?.error('import', 'session-import', errorMsg, {
            sessionId: session.id,
            error: String(err),
          });
        }
      }

      logger?.info('import', 'sessions-complete', `Completed importing ${result.sessionsImported} sessions`, {
        imported: result.sessionsImported,
      });
    } catch (err) {
      const errorMsg = `Failed to parse sessions.json: ${String(err)}`;
      result.errors.push(errorMsg);
      logger?.error('import', 'parse-sessions', errorMsg);
    }
  } else {
    logger?.warn('import', 'sessions-missing', 'sessions.json not found, skipping session import');
  }
}

export async function migrateJsonToSqlite(
  cwd?: string,
  options?: MigrationOptions,
): Promise<MigrationResult> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const result: MigrationResult = {
    success: false,
    tasksImported: 0,
    archivedImported: 0,
    sessionsImported: 0,
    errors: [],
    warnings: [],
  };

  // Count JSON source records
  const jsonCounts = countJsonRecords(cleoDir);
  result.jsonCounts = jsonCounts;

  // Check if database already exists for idempotency
  if (dbExists(cwd)) {
    const { ne, eq, count } = await import('drizzle-orm');
    const db = await getDb(cwd);

    // Count existing rows in SQLite
    const tasksResult = db
      .select({ count: count() })
      .from(schema.tasks)
      .where(ne(schema.tasks.status, 'archived'))
      .get();
    const archivedResult = db
      .select({ count: count() })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'archived'))
      .get();
    const sessionsResult = db
      .select({ count: count() })
      .from(schema.sessions)
      .get();

    const existingCounts = {
      tasks: tasksResult?.count ?? 0,
      archived: archivedResult?.count ?? 0,
      sessions: sessionsResult?.count ?? 0,
    };
    result.existingCounts = existingCounts;

    // Handle dry-run mode: show diff without making changes
    if (options?.dryRun) {
      const countsMatch =
        existingCounts.tasks === jsonCounts.tasks &&
        existingCounts.archived === jsonCounts.archived &&
        existingCounts.sessions === jsonCounts.sessions;

      if (countsMatch) {
        result.warnings.push(
          'Dry-run: Database already contains migrated data. No changes needed.',
        );
      } else {
        const diffs: string[] = [];
        if (existingCounts.tasks !== jsonCounts.tasks) {
          diffs.push(
            `tasks: DB=${existingCounts.tasks}, JSON=${jsonCounts.tasks}`,
          );
        }
        if (existingCounts.archived !== jsonCounts.archived) {
          diffs.push(
            `archived: DB=${existingCounts.archived}, JSON=${jsonCounts.archived}`,
          );
        }
        if (existingCounts.sessions !== jsonCounts.sessions) {
          diffs.push(
            `sessions: DB=${existingCounts.sessions}, JSON=${jsonCounts.sessions}`,
          );
        }
        result.warnings.push(
          `Dry-run: Data mismatch detected - ${diffs.join('; ')}. Would import ${jsonCounts.tasks - existingCounts.tasks} tasks, ${jsonCounts.archived - existingCounts.archived} archived, ${jsonCounts.sessions - existingCounts.sessions} sessions.`,
        );
      }

      result.success = true;
      return result;
    }

    // Check if migration is already complete (unless force is specified)
    if (!options?.force) {
      const countsMatch =
        existingCounts.tasks === jsonCounts.tasks &&
        existingCounts.archived === jsonCounts.archived &&
        existingCounts.sessions === jsonCounts.sessions;

      if (countsMatch) {
        result.warnings.push(
          'Database already contains migrated data. Use --force to re-import.',
        );
        result.success = true;
        return result;
      }

      // Counts differ - report mismatch
      result.warnings.push(
        `Data mismatch detected: DB has ${existingCounts.tasks} tasks, ${existingCounts.archived} archived, ${existingCounts.sessions} sessions; JSON has ${jsonCounts.tasks} tasks, ${jsonCounts.archived} archived, ${jsonCounts.sessions} sessions. Use --force to re-import.`,
      );
      result.success = true;
      return result;
    }

    // Force mode: continue with migration
    result.warnings.push(
      'Force mode: Re-importing data despite existing database.',
    );
  }

  // Handle dry-run mode when DB doesn't exist
  if (options?.dryRun) {
    result.warnings.push(
      `Dry-run: Would import ${jsonCounts.tasks} tasks, ${jsonCounts.archived} archived tasks, ${jsonCounts.sessions} sessions.`,
    );
    result.success = true;
    return result;
  }

  const db = await getDb(cwd);

  // === MIGRATE TASKS from todo.json ===
  const todoPath = join(cleoDir, 'todo.json');
  if (existsSync(todoPath)) {
    try {
      const todoData = JSON.parse(readFileSync(todoPath, 'utf-8'));
      const tasks: Task[] = todoData.tasks ?? [];

      for (const task of tasks) {
        try {
          db.insert(schema.tasks)
            .values({
              id: task.id,
              title: task.title,
              description: task.description,
              status: task.status,
              priority: task.priority ?? 'medium',
              type: task.type,
              parentId: task.parentId,
              phase: task.phase,
              size: task.size,
              position: task.position,
              labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
              notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
              acceptanceJson: task.acceptance
                ? JSON.stringify(task.acceptance)
                : '[]',
              filesJson: task.files ? JSON.stringify(task.files) : '[]',
              origin: task.origin,
              blockedBy: task.blockedBy,
              epicLifecycle: task.epicLifecycle,
              noAutoComplete: task.noAutoComplete,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              completedAt: task.completedAt,
              cancelledAt: task.cancelledAt,
              cancellationReason: task.cancellationReason,
              verificationJson: task.verification
                ? JSON.stringify(task.verification)
                : undefined,
              createdBy: task.provenance?.createdBy,
              modifiedBy: task.provenance?.modifiedBy,
              sessionId: task.provenance?.sessionId,
            })
            .onConflictDoNothing()
            .run();

          // Insert dependencies
          if (task.depends) {
            for (const depId of task.depends) {
              db.insert(schema.taskDependencies)
                .values({ taskId: task.id, dependsOn: depId })
                .onConflictDoNothing()
                .run();
            }
          }

          result.tasksImported++;
        } catch (err) {
          result.errors.push(`Failed to import task ${task.id}: ${String(err)}`);
        }
      }
    } catch (err) {
      result.errors.push(`Failed to parse todo.json: ${String(err)}`);
    }
  } else {
    result.warnings.push('todo.json not found, skipping task import');
  }

  // === MIGRATE ARCHIVED TASKS from todo-archive.json ===
  const archivePath = join(cleoDir, 'todo-archive.json');
  if (existsSync(archivePath)) {
    try {
      const archiveData = JSON.parse(readFileSync(archivePath, 'utf-8'));
      const archivedTasks: (Task & {
        archivedAt?: string;
        archiveReason?: string;
        cycleTimeDays?: number;
      })[] = archiveData.tasks ?? archiveData.archivedTasks ?? [];

      for (const task of archivedTasks) {
        try {
          db.insert(schema.tasks)
            .values({
              id: task.id,
              title: task.title,
              description: task.description,
              status: 'archived',
              priority: task.priority ?? 'medium',
              type: task.type,
              parentId: task.parentId,
              phase: task.phase,
              size: task.size,
              position: task.position,
              labelsJson: task.labels ? JSON.stringify(task.labels) : '[]',
              notesJson: task.notes ? JSON.stringify(task.notes) : '[]',
              acceptanceJson: task.acceptance
                ? JSON.stringify(task.acceptance)
                : '[]',
              filesJson: task.files ? JSON.stringify(task.files) : '[]',
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
              completedAt: task.completedAt,
              archivedAt:
                task.archivedAt ??
                task.completedAt ??
                new Date().toISOString(),
              archiveReason: task.archiveReason ?? 'migrated',
              cycleTimeDays: task.cycleTimeDays,
            })
            .onConflictDoNothing()
            .run();

          result.archivedImported++;
        } catch (err) {
          result.errors.push(
            `Failed to import archived task ${task.id}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(`Failed to parse todo-archive.json: ${String(err)}`);
    }
  }

  // === MIGRATE SESSIONS from sessions.json ===
  const sessionsPath = join(cleoDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    try {
      const sessionsData = JSON.parse(
        readFileSync(sessionsPath, 'utf-8'),
      ) as SessionsFile;
      const sessions: Session[] = sessionsData.sessions ?? [];

      for (const session of sessions) {
        try {
          // Normalize status: map legacy 'archived' to 'ended' for SQLite CHECK constraint
          // @task T4658 @epic T4654
          const validStatuses = ['active', 'ended', 'orphaned', 'suspended'];
          const normalizedStatus = validStatuses.includes(session.status)
            ? session.status
            : 'ended'; // 'archived' and any other legacy statuses -> 'ended'
          // Provide default name for sessions with null/undefined names
          const normalizedName = session.name || `session-${session.id}`;

          db.insert(schema.sessions)
            .values({
              id: session.id,
              name: normalizedName,
              status: normalizedStatus,
              scopeJson: JSON.stringify(session.scope),
              currentTask: session.taskWork?.taskId ?? session.focus?.taskId,
              taskStartedAt: session.taskWork?.setAt ?? session.focus?.setAt,
              agent: session.agent,
              notesJson: session.notes
                ? JSON.stringify(session.notes)
                : '[]',
              tasksCompletedJson: session.tasksCompleted
                ? JSON.stringify(session.tasksCompleted)
                : '[]',
              tasksCreatedJson: session.tasksCreated
                ? JSON.stringify(session.tasksCreated)
                : '[]',
              startedAt: session.startedAt,
              endedAt: session.endedAt,
            })
            .onConflictDoNothing()
            .run();

          result.sessionsImported++;
        } catch (err) {
          result.errors.push(
            `Failed to import session ${session.id}: ${String(err)}`,
          );
        }
      }
    } catch (err) {
      result.errors.push(`Failed to parse sessions.json: ${String(err)}`);
    }
  }

  // Save database to disk
  saveToFile();

  result.success = result.errors.length === 0;
  return result;
}

/**
 * Export SQLite data back to JSON format (for inspection or emergency recovery).
 */
export async function exportToJson(cwd?: string): Promise<{
  tasks: Task[];
  archived: Task[];
  sessions: Session[];
}> {
  const { listTasks } = await import('./task-store.js');
  const { listSessions } = await import('./session-store.js');
  const { eq } = await import('drizzle-orm');

  const tasks = await listTasks(undefined, cwd);

  // Get archived tasks separately
  const db = await getDb(cwd);
  const archivedRows = db.select().from(schema.tasks)
    .where(eq(schema.tasks.status, 'archived'))
    .all();

  // Convert rows to Task format
  const archived: Task[] = archivedRows.map(row => ({
    id: row.id,
    title: row.title,
    status: 'done' as const,
    priority: (row.priority ?? 'medium') as Task['priority'],
    createdAt: row.createdAt,
    description: row.description ?? undefined,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  }));

  const sessions = await listSessions(undefined, cwd);

  return { tasks, archived, sessions };
}
