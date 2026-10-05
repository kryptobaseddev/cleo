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

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArchiveReasonValue, Session, Task } from '@cleocode/contracts';
import { ARCHIVE_REASONS } from '@cleocode/contracts/enums.js';
import { ARCHIVE_REASON_TOMBSTONE } from '@cleocode/contracts/tasks/archive.js';
import type { NodeSQLiteDatabase } from 'drizzle-orm/node-sqlite';
import { drizzle } from 'drizzle-orm/node-sqlite';
import { resolveCleoDir } from '../paths.js';
import { type DependencyEdge, insertDependencyEdgeOrSkipCycle } from './dependency-cycles.js';
import { migrateSanitized } from './migration-manager.js';
import {
  dbExists,
  getDb,
  getNativeTasksDb,
  openNativeDatabase,
  resolveMigrationsFolder,
} from './sqlite.js';
import { testForeignKeysOff } from './sqlite-pragmas.js';
import type { SessionStatus } from './status-registry.js';
import * as schema from './tasks-schema.js';
import { installSchemaWriteGuard } from './worktree-build-guard.js';

/**
 * Normalise an imported archive-reason string to a valid {@link ArchiveReasonValue}.
 *
 * T11578 · AC1: the consolidated `tasks_tasks.archive_reason` column is
 * CHECK-backed by the 6-value T1408 enum. Imported migration JSON may carry a
 * missing reason or a legacy value (e.g. `'completed'`) that the bare legacy
 * `tasks` table accepted without a CHECK. Any out-of-enum value is mapped
 * defensively to the canonical tombstone (`'completed-unverified'`) rather than
 * throwing mid-import.
 *
 * @param reason - candidate archive-reason string from the migration source.
 * @returns a value guaranteed to satisfy the consolidated CHECK constraint.
 */
function normalizeImportedArchiveReason(reason: string | undefined): ArchiveReasonValue {
  if (reason && (ARCHIVE_REASONS as readonly string[]).includes(reason)) {
    return reason as ArchiveReasonValue;
  }
  return ARCHIVE_REASON_TOMBSTONE;
}

/**
 * Topological sort for tasks: ensures parents and dependency targets are inserted before
 * the tasks that reference them. Tasks referencing IDs outside the batch are treated as
 * roots (inserted as-is). Handles circular references defensively by breaking cycles.
 */
function topoSortTasks<
  T extends {
    id: string;
    parentId?: string | null | undefined;
    depends?: string[] | null | undefined;
  },
>(tasks: T[]): T[] {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const sorted: T[] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>(); // cycle detection

  function visit(task: T): void {
    if (visited.has(task.id)) return;
    if (inStack.has(task.id)) {
      // Circular reference detected — skip the recursive call to break the cycle
      return;
    }
    inStack.add(task.id);
    // Visit parent first if it exists in this batch
    if (task.parentId && taskMap.has(task.parentId)) {
      visit(taskMap.get(task.parentId)!);
    }
    // Visit dependency targets first if they exist in this batch
    if (task.depends) {
      for (const depId of task.depends) {
        if (taskMap.has(depId)) {
          visit(taskMap.get(depId)!);
        }
      }
    }
    inStack.delete(task.id);
    visited.add(task.id);
    sorted.push(task);
  }

  for (const task of tasks) {
    visit(task);
  }
  return sorted;
}

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
  logger?: import('../migration/logger.js').MigrationLogger,
): Promise<MigrationResult> {
  const cleoDir = resolveCleoDir(cwd);
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
    logger?.info('import', 'init', 'Initializing node:sqlite for migration');

    // Create temp directory and open file-backed database at temp path
    mkdirSync(dirname(tempDbPath), { recursive: true });
    const nativeDb = openNativeDatabase(tempDbPath, { enableWal: true });
    installSchemaWriteGuard(nativeDb); // T12687
    const db = drizzle({ client: nativeDb });

    // Run migrations to create tables.
    // T11578 · AC1: the runtime store now reads/writes the PREFIXED consolidated
    // tables (`tasks_tasks`, …). This standalone temp DB is meant to become the
    // project runtime DB, so it must carry the CONSOLIDATED schema first (which
    // creates `tasks_tasks`) — the legacy `drizzle-tasks` bare schema is then
    // applied for transition-period co-existence (same ordering getDb() uses).
    logger?.info('import', 'create-tables', 'Running drizzle migrations to create tables');
    const { resolveCorePackageMigrationsFolder } = await import('./resolve-migrations-folder.js');
    migrateSanitized(db, {
      migrationsFolder: resolveCorePackageMigrationsFolder('drizzle-cleo-project'),
    });
    const migrationsFolder = resolveMigrationsFolder();
    migrateSanitized(db, { migrationsFolder });

    // Foreign keys stay ON under vitest, as in production (T13228); a test
    // importing fixtures with orphan references opts out explicitly.
    if (testForeignKeysOff()) {
      nativeDb.exec('PRAGMA foreign_keys=OFF');
    }

    // Run the actual migration
    logger?.info('import', 'data-import', 'Starting data import from JSON files');
    await runMigrationDataImport(db, nativeDb, cleoDir, result, logger);

    // Get file size for logging (data already written to disk)
    logger?.info('import', 'save-temp', 'Database written to temporary file', {
      tempPath: tempDbPath.replace(cleoDir, '.'),
    });
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

/** An archived legacy task as `todo-archive.json` stores it. */
type ArchivedTask = Task & { archivedAt?: string; archiveReason?: string; cycleTimeDays?: number };

/** One task of the legacy import, active or archived, in one topo order (T13259). */
interface ImportQueueEntry {
  readonly id: string;
  readonly parentId?: string | null;
  readonly depends?: string[];
  readonly task: ArchivedTask;
  readonly archived: boolean;
}

function queueEntry(task: ArchivedTask, archived: boolean): ImportQueueEntry {
  return { id: task.id, parentId: task.parentId, depends: task.depends, task, archived };
}

/** References the legacy import keeps only when it holds their target (T13259). */
interface ImportReferences {
  /** The task's parent id, or null when the import holds no such task. */
  parent(task: Pick<Task, 'id' | 'parentId'>): string | null | undefined;
  /** The task's provenance session id, or undefined when no such session is imported. */
  session(task: Pick<Task, 'id' | 'provenance'>): string | undefined;
  /** The session's current task, or undefined when no such task is imported. */
  currentTask(session: Pick<Session, 'id' | 'taskWork'>): string | undefined;
  /** Whether the import holds a task with this id. */
  hasTask(id: string): boolean;
}

/** The ids a JSON file lists under `keys` (first present key), or none when unreadable. */
function jsonIds(path: string, keys: readonly string[]): string[] {
  if (!existsSync(path)) return [];
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    for (const key of keys) {
      const list = data[key];
      if (Array.isArray(list)) {
        return list
          .map((row) => (row !== null && typeof row === 'object' && 'id' in row ? row.id : null))
          .filter((id): id is string => typeof id === 'string');
      }
    }
  } catch {
    // The import section reports an unparseable file.
  }
  return [];
}

/**
 * What the legacy import holds, so a reference to anything else is dropped
 * with a warning naming it instead of failing its row (T13259).
 */
function importReferences(cleoDir: string, result: MigrationResult): ImportReferences {
  const tasks = new Set([
    ...jsonIds(join(cleoDir, 'todo.json'), ['tasks']),
    ...jsonIds(join(cleoDir, 'todo-archive.json'), ['tasks', 'archivedTasks']),
  ]);
  const sessions = new Set(jsonIds(join(cleoDir, 'sessions.json'), ['sessions']));
  const dropped = (what: string) => {
    result.warnings.push(`${what} dropped: not in the import (T13259)`);
  };
  return {
    parent(task) {
      if (!task.parentId || tasks.has(task.parentId)) return task.parentId;
      dropped(`Task ${task.id}: parent ${task.parentId}`);
      return null;
    },
    session(task) {
      const id = task.provenance?.sessionId ?? undefined;
      if (!id || sessions.has(id)) return id;
      dropped(`Task ${task.id}: session ${id}`);
      return undefined;
    },
    currentTask(session) {
      const id = session.taskWork?.taskId ?? undefined;
      if (!id || tasks.has(id)) return id;
      dropped(`Session ${session.id}: current task ${id}`);
      return undefined;
    },
    hasTask: (id) => tasks.has(id),
  };
}

/**
 * Insert the dependency edges the import collected, after every task exists
 * (T13259). An edge to a task the import does not hold is dropped with a
 * warning naming it; an edge the cycle guard refuses is skipped with a
 * warning naming the cycle (T12886).
 */
function insertImportedDependencyEdges(
  db: NodeSQLiteDatabase,
  edges: readonly DependencyEdge[],
  refs: ImportReferences,
  result: MigrationResult,
): void {
  for (const edge of edges) {
    if (!refs.hasTask(edge.dependsOn)) {
      result.warnings.push(
        `Task ${edge.taskId}: dependency ${edge.dependsOn} dropped: not in the import (T13259)`,
      );
      continue;
    }
    const skipped = insertDependencyEdgeOrSkipCycle(db, edge);
    if (skipped) result.warnings.push(`Task ${edge.taskId}: ${skipped.message}`);
  }
}

/**
 * Run the actual data import for migration.
 */
async function runMigrationDataImport(
  db: NodeSQLiteDatabase,
  native: DatabaseSync,
  cleoDir: string,
  result: MigrationResult,
  logger?: import('../migration/logger.js').MigrationLogger,
): Promise<void> {
  // T13259: the import is one transaction with foreign keys deferred, in
  // the order sessions → tasks → archived tasks → dependency edges, so the
  // order inside the JSON files never fails a foreign key. A reference to a
  // row the import does not hold is dropped with a warning naming it.
  const refs = importReferences(cleoDir, result);
  const pendingEdges: DependencyEdge[] = [];
  native.exec('BEGIN IMMEDIATE');
  native.exec('PRAGMA defer_foreign_keys = ON');
  try {
    // === MIGRATE SESSIONS from sessions.json ===
    const sessionsPath = join(cleoDir, 'sessions.json');
    if (existsSync(sessionsPath)) {
      try {
        logger?.info('import', 'read-sessions', 'Reading sessions.json', {
          path: sessionsPath.replace(cleoDir, '.'),
        });

        const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8'));
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
            const normalizedStatus = (
              validStatuses.includes(session.status) ? session.status : 'ended'
            ) as SessionStatus;
            // Provide default name for sessions with null/undefined names
            const normalizedName = session.name || `session-${session.id}`;

            db.insert(schema.sessions)
              .values({
                id: session.id,
                name: normalizedName,
                status: normalizedStatus,
                scopeJson: JSON.stringify(session.scope),
                currentTask: refs.currentTask(session),
                taskStartedAt: session.taskWork?.setAt,
                agent: session.agent,
                notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
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

            // Log progress every 10 sessions
            if ((i + 1) % 10 === 0 || i === sessions.length - 1) {
              logger?.logImportProgress(
                'import',
                'sessions',
                result.sessionsImported,
                totalSessions,
              );
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

        logger?.info(
          'import',
          'sessions-complete',
          `Completed importing ${result.sessionsImported} sessions`,
          {
            imported: result.sessionsImported,
          },
        );
      } catch (err) {
        const errorMsg = `Failed to parse sessions.json: ${String(err)}`;
        result.errors.push(errorMsg);
        logger?.error('import', 'parse-sessions', errorMsg);
      }
    } else {
      logger?.warn(
        'import',
        'sessions-missing',
        'sessions.json not found, skipping session import',
      );
    }

    // === TASKS: active (todo.json) and archived (todo-archive.json), topo-
    // sorted TOGETHER, so every parent precedes its children whichever file
    // holds it and the parent guard triggers always see it (T13259). ===
    const todoPath = join(cleoDir, 'todo.json');
    const archivePath = join(cleoDir, 'todo-archive.json');
    const queue: ImportQueueEntry[] = [];
    if (existsSync(todoPath)) {
      try {
        logger?.info('import', 'read-todo', 'Reading todo.json', {
          path: todoPath.replace(cleoDir, '.'),
        });
        const todoData = JSON.parse(readFileSync(todoPath, 'utf-8'));
        for (const task of (todoData.tasks ?? []) as Task[]) queue.push(queueEntry(task, false));
      } catch (err) {
        const errorMsg = `Failed to parse todo.json: ${String(err)}`;
        result.errors.push(errorMsg);
        logger?.error('import', 'parse-todo', errorMsg);
      }
    } else {
      result.warnings.push('todo.json not found, skipping task import');
      logger?.warn('import', 'todo-missing', 'todo.json not found, skipping task import');
    }
    if (existsSync(archivePath)) {
      try {
        logger?.info('import', 'read-archive', 'Reading todo-archive.json', {
          path: archivePath.replace(cleoDir, '.'),
        });
        const archiveData = JSON.parse(readFileSync(archivePath, 'utf-8'));
        for (const task of (archiveData.tasks ??
          archiveData.archivedTasks ??
          []) as ArchivedTask[]) {
          queue.push(queueEntry(task, true));
        }
      } catch (err) {
        const errorMsg = `Failed to parse todo-archive.json: ${String(err)}`;
        result.errors.push(errorMsg);
        logger?.error('import', 'parse-archive', errorMsg);
      }
    }
    const ordered = topoSortTasks(queue);
    logger?.info('import', 'tasks-start', `Starting import of ${ordered.length} tasks`, {
      totalTasks: ordered.length,
    });
    for (const [i, entry] of ordered.entries()) {
      const { task, archived } = entry;
      try {
        // No await inside the transaction: a yield would let another writer
        // on this shared handle land in it (T13259, LOW-1).
        if (archived) {
          db.insert(schema.tasks)
            .values({
              id: task.id,
              title: task.title,
              description: task.description || `Task: ${task.title}`,
              status: 'archived',
              priority: task.priority ?? 'medium',
              type: task.type,
              parentId: refs.parent(task),
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
              archiveReason: normalizeImportedArchiveReason(task.archiveReason),
              cycleTimeDays: task.cycleTimeDays,
            })
            .onConflictDoNothing()
            .run();
          result.archivedImported++;
        } else {
          // T877 invariant: derive a terminal pipeline_stage for legacy
          // status=done/cancelled rows missing it, so imports satisfy the
          // SQLite trigger that enforces status ↔ pipeline_stage alignment.
          const importedPipelineStage: string | null =
            (task as { pipelineStage?: string | null }).pipelineStage ??
            (task.status === 'done'
              ? 'contribution'
              : task.status === 'cancelled'
                ? 'cancelled'
                : null);
          db.insert(schema.tasks)
            .values({
              id: task.id,
              title: task.title,
              description: task.description || `Task: ${task.title}`,
              status: task.status,
              priority: task.priority ?? 'medium',
              type: task.type,
              parentId: refs.parent(task),
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
              sessionId: refs.session(task),
              pipelineStage: importedPipelineStage,
            })
            .onConflictDoNothing()
            .run();
          // Dependencies wait until every task exists (T13259).
          for (const depId of task.depends ?? []) {
            pendingEdges.push({ taskId: task.id, dependsOn: depId });
          }
          result.tasksImported++;
        }
        if ((i + 1) % 100 === 0 || i === ordered.length - 1) {
          logger?.logImportProgress(
            'import',
            'tasks',
            result.tasksImported + result.archivedImported,
            ordered.length,
          );
        }
      } catch (err) {
        const errorMsg = `Failed to import ${archived ? 'archived task' : 'task'} ${task.id}: ${String(err)}`;
        result.errors.push(errorMsg);
        logger?.error('import', archived ? 'archived-import' : 'task-import', errorMsg, {
          taskId: task.id,
          error: String(err),
        });
      }
    }
    logger?.info('import', 'tasks-complete', 'Completed importing tasks', {
      imported: result.tasksImported,
      archived: result.archivedImported,
      failed: result.errors.length,
    });

    // === DEPENDENCIES, once every task (active and archived) exists ===
    insertImportedDependencyEdges(db, pendingEdges, refs, result);
    // A residual violation would fail COMMIT with a bare constraint error:
    // name every violating row and its missing parent instead (LOW-2).
    const violations = native.prepare('PRAGMA foreign_key_check').all() as Array<{
      table: string;
      rowid: number | null;
      parent: string;
    }>;
    if (violations.length > 0) {
      throw new Error(
        `foreign key violations: ${violations
          .slice(0, 20)
          .map((v) => `${v.table} row ${v.rowid ?? '?'} → missing ${v.parent}`)
          .join('; ')}${violations.length > 20 ? ` (+${violations.length - 20} more)` : ''}`,
      );
    }
    native.exec('COMMIT');
  } catch (err) {
    if (native.isTransaction) native.exec('ROLLBACK');
    result.errors.push(`Import rolled back: ${String(err)}`);
    logger?.error('import', 'rollback', `Import rolled back: ${String(err)}`);
  }
}

export async function migrateJsonToSqlite(
  cwd?: string,
  options?: MigrationOptions,
): Promise<MigrationResult> {
  const cleoDir = resolveCleoDir(cwd);
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
    const tasksResult = await db
      .select({ count: count() })
      .from(schema.tasks)
      .where(ne(schema.tasks.status, 'archived'))
      .get();
    const archivedResult = await db
      .select({ count: count() })
      .from(schema.tasks)
      .where(eq(schema.tasks.status, 'archived'))
      .get();
    const sessionsResult = await db.select({ count: count() }).from(schema.sessions).get();

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
          diffs.push(`tasks: DB=${existingCounts.tasks}, JSON=${jsonCounts.tasks}`);
        }
        if (existingCounts.archived !== jsonCounts.archived) {
          diffs.push(`archived: DB=${existingCounts.archived}, JSON=${jsonCounts.archived}`);
        }
        if (existingCounts.sessions !== jsonCounts.sessions) {
          diffs.push(`sessions: DB=${existingCounts.sessions}, JSON=${jsonCounts.sessions}`);
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
        result.warnings.push('Database already contains migrated data. Use --force to re-import.');
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
    result.warnings.push('Force mode: Re-importing data despite existing database.');
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
  const nativeDb = getNativeTasksDb(cwd);
  if (!nativeDb) {
    result.errors.push('Tasks store handle not available after getDb');
    return result;
  }
  await runMigrationDataImport(db, nativeDb, cleoDir, result);

  // Save database to disk

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
  const { listTasks } = await import('./tasks-sqlite.js');
  const { listSessions } = await import('./session-store.js');
  const { eq } = await import('drizzle-orm');

  const tasks = await listTasks(undefined, cwd);

  // Get archived tasks separately
  const db = await getDb(cwd);
  const archivedRows = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.status, 'archived'))
    .all();

  // Convert rows to Task format
  const archived: Task[] = archivedRows.map((row: (typeof archivedRows)[number]) => ({
    id: row.id,
    title: row.title,
    status: 'done' as const,
    priority: (row.priority ?? 'medium') as Task['priority'],
    createdAt: row.createdAt,
    description: row.description ?? '',
    updatedAt: row.updatedAt,
    completedAt: row.completedAt ?? undefined,
  }));

  const sessions = await listSessions(undefined, cwd);

  return { tasks, archived, sessions };
}
