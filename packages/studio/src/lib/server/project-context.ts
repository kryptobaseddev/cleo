/**
 * Project context resolution for CLEO Studio.
 *
 * The active project is stored as a cookie (`cleo_project_id`).
 * When a project is selected, the studio resolves the project's
 * brain.db and tasks.db paths from the global nexus.db registry,
 * injecting them into database connections for the page load.
 *
 * nexus.db is always global (single instance); brain.db and tasks.db
 * are per-project.
 *
 * @task T622
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import type { Cookies } from '@sveltejs/kit';
import { getCleoHome, getCleoProjectDir } from './cleo-home.js';

const _require = createRequire(import.meta.url);
type _DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => _DatabaseSync;
};

/** Cookie name used to persist the active project selection. */
export const PROJECT_COOKIE = 'cleo_project_id';

/** How long the project context cookie lives (7 days). */
const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

/** Resolved paths for the active project context. */
export interface ProjectContext {
  /** The project ID from project_registry. */
  projectId: string;
  /** Human-readable project name. */
  name: string;
  /** Absolute path to the project root. */
  projectPath: string;
  /** Absolute path to brain.db for this project. */
  brainDbPath: string;
  /** Absolute path to tasks.db for this project. */
  tasksDbPath: string;
  /** Whether brain.db exists on disk. */
  brainDbExists: boolean;
  /** Whether tasks.db exists on disk. */
  tasksDbExists: boolean;
}

/**
 * Read the active project ID from the request cookie.
 * Returns null if no project is selected.
 */
export function getActiveProjectId(cookies: Cookies): string | null {
  return cookies.get(PROJECT_COOKIE) ?? null;
}

/**
 * Set the active project context cookie.
 */
export function setActiveProjectId(cookies: Cookies, projectId: string): void {
  cookies.set(PROJECT_COOKIE, projectId, {
    path: '/',
    maxAge: COOKIE_MAX_AGE,
    httpOnly: false,
    sameSite: 'lax',
  });
}

/**
 * Clear the active project context cookie.
 */
export function clearActiveProjectId(cookies: Cookies): void {
  cookies.delete(PROJECT_COOKIE, { path: '/' });
}

/**
 * Resolve the project context from the nexus.db registry for a given project ID.
 *
 * Returns null if the project is not registered or the DB rows are missing.
 * Falls back to deriving paths from the project_path column if brain_db_path
 * or tasks_db_path are not set in the registry.
 */
export function resolveProjectContext(projectId: string): ProjectContext | null {
  try {
    const nexusPath = join(getCleoHome(), 'nexus.db');
    if (!existsSync(nexusPath)) return null;

    const db = new DatabaseSync(nexusPath, { open: true });
    try {
      const row = db
        .prepare(
          'SELECT project_id, name, project_path, brain_db_path, tasks_db_path FROM project_registry WHERE project_id = ?',
        )
        .get(projectId) as
        | {
            project_id: string;
            name: string;
            project_path: string;
            brain_db_path: string | null;
            tasks_db_path: string | null;
          }
        | undefined;

      if (!row) return null;

      const brainDbPath = row.brain_db_path ?? join(row.project_path, '.cleo', 'brain.db');
      const tasksDbPath = row.tasks_db_path ?? join(row.project_path, '.cleo', 'tasks.db');

      return {
        projectId: row.project_id,
        name: row.name,
        projectPath: row.project_path,
        brainDbPath,
        tasksDbPath,
        brainDbExists: existsSync(brainDbPath),
        tasksDbExists: existsSync(tasksDbPath),
      };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * Resolve the default project context (current project from CLEO_ROOT / cwd).
 * Used as fallback when no project cookie is set.
 */
export function resolveDefaultProjectContext(): ProjectContext {
  const projectDir = getCleoProjectDir();
  const projectPath = projectDir.replace(/\/.cleo$/, '');
  const brainDbPath = join(projectDir, 'brain.db');
  const tasksDbPath = join(projectDir, 'tasks.db');
  return {
    projectId: '',
    name: projectPath.split('/').pop() ?? 'default',
    projectPath,
    brainDbPath,
    tasksDbPath,
    brainDbExists: existsSync(brainDbPath),
    tasksDbExists: existsSync(tasksDbPath),
  };
}

/**
 * List all registered projects from nexus.db.
 * Returns an empty array if nexus.db is unavailable.
 */
export function listRegisteredProjects(): Array<{
  projectId: string;
  name: string;
  projectPath: string;
  brainDbPath: string | null;
  tasksDbPath: string | null;
  lastIndexed: string | null;
  taskCount: number;
  nodeCount: number;
  relationCount: number;
  fileCount: number;
  lastSeen: string;
  healthStatus: string;
}> {
  try {
    const nexusPath = join(getCleoHome(), 'nexus.db');
    if (!existsSync(nexusPath)) return [];

    const db = new DatabaseSync(nexusPath, { open: true });
    try {
      const rows = db
        .prepare(
          `SELECT
            project_id,
            name,
            project_path,
            brain_db_path,
            tasks_db_path,
            last_indexed,
            task_count,
            stats_json,
            last_seen,
            health_status
          FROM project_registry
          ORDER BY last_seen DESC`,
        )
        .all() as Array<{
        project_id: string;
        name: string;
        project_path: string;
        brain_db_path: string | null;
        tasks_db_path: string | null;
        last_indexed: string | null;
        task_count: number;
        stats_json: string | null;
        last_seen: string;
        health_status: string;
      }>;

      return rows.map((row) => {
        let nodeCount = 0;
        let relationCount = 0;
        let fileCount = 0;
        try {
          const stats = JSON.parse(row.stats_json ?? '{}') as {
            nodeCount?: number;
            relationCount?: number;
            fileCount?: number;
          };
          nodeCount = stats.nodeCount ?? 0;
          relationCount = stats.relationCount ?? 0;
          fileCount = stats.fileCount ?? 0;
        } catch {
          // keep defaults
        }
        return {
          projectId: row.project_id,
          name: row.name,
          projectPath: row.project_path,
          brainDbPath: row.brain_db_path ?? null,
          tasksDbPath: row.tasks_db_path ?? null,
          lastIndexed: row.last_indexed ?? null,
          taskCount: row.task_count ?? 0,
          nodeCount,
          relationCount,
          fileCount,
          lastSeen: row.last_seen,
          healthStatus: row.health_status,
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}
