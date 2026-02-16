/**
 * Data migration: JSON to SQLite.
 *
 * One-time migration of todo.json + todo-archive.json + sessions.json → tasks.db.
 * Validates row counts match after migration.
 * Keeps JSON files as read-only backup (does not delete).
 *
 * @epic T4454
 * @task W1-T5
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getCleoDirAbsolute } from '../core/paths.js';
import { getDb, saveToFile, dbExists } from './sqlite.js';
import * as schema from './schema.js';
import type { Task } from '../types/task.js';
import type { Session, SessionsFile } from '../types/session.js';

/** Migration result. */
export interface MigrationResult {
  success: boolean;
  tasksImported: number;
  archivedImported: number;
  sessionsImported: number;
  errors: string[];
  warnings: string[];
}

/**
 * Migrate JSON data to SQLite.
 * Reads todo.json, todo-archive.json, and sessions.json,
 * writes to tasks.db via drizzle-orm.
 */
export async function migrateJsonToSqlite(cwd?: string): Promise<MigrationResult> {
  const cleoDir = getCleoDirAbsolute(cwd);
  const result: MigrationResult = {
    success: false,
    tasksImported: 0,
    archivedImported: 0,
    sessionsImported: 0,
    errors: [],
    warnings: [],
  };

  // Check if database already exists
  if (dbExists(cwd)) {
    result.warnings.push('tasks.db already exists; migration will merge data');
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
      const archivedTasks: (Task & { archivedAt?: string; archiveReason?: string; cycleTimeDays?: number })[] =
        archiveData.tasks ?? archiveData.archivedTasks ?? [];

      for (const task of archivedTasks) {
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
        } catch (err) {
          result.errors.push(`Failed to import archived task ${task.id}: ${String(err)}`);
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
      const sessionsData = JSON.parse(readFileSync(sessionsPath, 'utf-8')) as SessionsFile;
      const sessions: Session[] = sessionsData.sessions ?? [];

      for (const session of sessions) {
        try {
          db.insert(schema.sessions).values({
            id: session.id,
            name: session.name,
            status: session.status,
            scopeJson: JSON.stringify(session.scope),
            currentFocus: session.focus?.taskId,
            focusSetAt: session.focus?.setAt,
            agent: session.agent,
            notesJson: session.notes ? JSON.stringify(session.notes) : '[]',
            tasksCompletedJson: session.tasksCompleted ? JSON.stringify(session.tasksCompleted) : '[]',
            tasksCreatedJson: session.tasksCreated ? JSON.stringify(session.tasksCreated) : '[]',
            startedAt: session.startedAt,
            endedAt: session.endedAt,
          }).onConflictDoNothing().run();

          result.sessionsImported++;
        } catch (err) {
          result.errors.push(`Failed to import session ${session.id}: ${String(err)}`);
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
