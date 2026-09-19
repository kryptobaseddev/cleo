/**
 * Project context resolution for CLEO Studio.
 *
 * The active project is stored as a cookie (`cleo_project_id`).
 * When a project is selected, the studio resolves the project's
 * consolidated project store from the global cleo.db registry,
 * injecting them into database connections for the page load.
 *
 * Task and brain tables share the project store. The cross-project registry
 * lives in the global store; legacy stored domain paths are not authoritative.
 *
 * @task T622
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { getProjectInfoSync } from '@cleocode/core';
import { openCleoDbSnapshot } from '@cleocode/core/store/open-cleo-db';
import type { Cookies } from '@sveltejs/kit';
import {
  getCleoProjectDir,
  getNexusDbPath,
  getTasksDbPath,
  withStudioProjectScope,
} from './cleo-home.js';

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
  /** Absolute consolidated project store path containing brain tables. */
  brainDbPath: string;
  /** Absolute consolidated project store path containing task tables. */
  tasksDbPath: string;
  /** Whether the consolidated brain store exists on disk. */
  brainDbExists: boolean;
  /** Whether the consolidated task store exists on disk. */
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
 * Resolve project context from the consolidated global registry.
 *
 * Returns null if the project is not registered or the DB rows are missing.
 * Legacy domain-path columns are ignored; canonical paths derive from the selected root.
 * @param projectId - Stable registered project identity selected by the request.
 * @returns The selected project context, or null when the registry or row is absent.
 * @throws When an existing registry cannot be read; diagnostic failure is not absence.
 * @remarks Snapshot reads are read-only and do not apply journal pragmas or rewrite registry rows.
 * @example
 * ```ts
 * const context = resolveProjectContext(projectId);
 * ```
 */
export function resolveProjectContext(projectId: string): ProjectContext | null {
  // T11578 · AC3: the cross-project registry lives in the consolidated GLOBAL
  // `cleo.db` (the standalone `nexus.db` is retired post-E6), in the PREFIXED
  // `nexus_project_registry` table.
  const globalDbPath = getNexusDbPath();
  if (!existsSync(globalDbPath)) return null;

  // Read-only snapshot via chokepoint API (T9685-B3, ADR-068): the registry
  // is read-only from Studio context — writes happen via the CLI.
  const snap = openCleoDbSnapshot(globalDbPath, { readOnly: true, applyPragmas: false });
  try {
    const row = snap.db
      .prepare(
        'SELECT project_id, name, project_path FROM nexus_project_registry WHERE project_id = ?',
      )
      .get(projectId) as
      | {
          project_id: string;
          name: string;
          project_path: string;
        }
      | undefined;

    if (!row) return null;

    const tasksDbPath = getTasksDbPath(row.project_path);
    const brainDbPath = tasksDbPath;

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
    snap.close();
  }
}

/**
 * Resolve the default project context (current project from CLEO_ROOT / cwd).
 * Used as fallback when no project cookie is set.
 * @returns Canonical modern-store paths and the available persisted identity.
 * @throws When existing identity metadata cannot be decoded.
 * @remarks Projects without metadata retain the legacy empty identity; this does not
 * assert that they are registered or have verified portable identity.
 * @example
 * ```ts
 * const context = resolveDefaultProjectContext();
 * ```
 */
export function resolveDefaultProjectContext(): ProjectContext {
  const projectDir = getCleoProjectDir();
  const projectPath = dirname(projectDir);
  const tasksDbPath = getTasksDbPath();
  const brainDbPath = tasksDbPath;
  const info = withStudioProjectScope(projectPath, () => getProjectInfoSync(projectPath));
  if (!info && existsSync(join(projectDir, 'project-info.json'))) {
    throw new Error(`Cannot read Studio project identity at ${projectDir}/project-info.json`);
  }
  return {
    projectId: info?.projectId || info?.projectHash || '',
    name: basename(projectPath) || 'default',
    projectPath,
    brainDbPath,
    tasksDbPath,
    brainDbExists: existsSync(brainDbPath),
    tasksDbExists: existsSync(tasksDbPath),
  };
}

/**
 * List registered projects with canonical modern domain paths.
 * Returns an empty array when the global registry store is absent.
 * @returns Registry projects with current canonical store paths and recorded statistics.
 * @throws When an existing registry cannot be read; failures do not become an empty population.
 * @remarks Recorded statistics retain their existing freshness semantics. Path resolution
 * does not migrate data or claim that project graph contents live in the global registry.
 * @example
 * ```ts
 * const projects = listRegisteredProjects();
 * ```
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
  // T11578 · AC3: registry lives in the consolidated GLOBAL `cleo.db`
  // (`nexus_project_registry`), not the retired standalone `nexus.db`.
  const globalDbPath = getNexusDbPath();
  if (!existsSync(globalDbPath)) return [];

  // Read-only snapshot via chokepoint API (T9685-B3, ADR-068): the registry
  // is read-only from Studio context — writes happen via the CLI.
  const snap = openCleoDbSnapshot(globalDbPath, { readOnly: true, applyPragmas: false });
  try {
    const rows = snap.db
      .prepare(
        `SELECT
          project_id,
          name,
          project_path,
          last_indexed,
          task_count,
          stats_json,
          last_seen,
          health_status
        FROM nexus_project_registry
        ORDER BY last_seen DESC`,
      )
      .all() as Array<{
      project_id: string;
      name: string;
      project_path: string;
      last_indexed: string | null;
      task_count: number;
      stats_json: string | null;
      last_seen: string;
      health_status: string;
    }>;

    /**
     * Strict server-side exclusion: any project whose path contains a `.temp/`
     * segment is filtered out before reaching the client. This rule is
     * non-negotiable (cannot be revealed via UI toggle) — `.temp/` is reserved
     * for ephemeral fixture/scratch state that must never appear in the
     * project switcher.
     */
    const TEMP_PATH_PATTERN = /(^|\/)\.temp(\/|$)/;

    return rows
      .filter((row) => !TEMP_PATH_PATTERN.test(row.project_path))
      .map((row) => {
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
        const storePath = getTasksDbPath(row.project_path);
        return {
          projectId: row.project_id,
          name: row.name,
          projectPath: row.project_path,
          brainDbPath: storePath,
          tasksDbPath: storePath,
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
    snap.close();
  }
}
