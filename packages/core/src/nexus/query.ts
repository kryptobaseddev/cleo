/**
 * NEXUS query parser and resolver - cross-project task references.
 *
 * Supports the `project:taskId` syntax:
 *   - `my-app:T001`  - Named project
 *   - `.:T001`       - Current project
 *   - `*:T001`       - Wildcard (all projects)
 *   - `T001`         - Implicit current project
 *
 * @task T4574
 * @epic T4540
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { ExitCode, type NexusResolveParams } from '@cleocode/contracts';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getAccessor } from '../store/data-accessor.js';
import { getBrainNativeDb } from '../store/memory-sqlite.js';
import { getNexusNativeDb } from '../store/nexus-sqlite.js';
import { nexusGetProject, readRegistry } from './registry.js';

// ── Types ────────────────────────────────────────────────────────────

export interface NexusParsedQuery {
  project: string;
  taskId: string;
  wildcard: boolean;
}

/** Task with project context annotation. */
export type NexusResolvedTask = Task & { _project: string };

// ── Query syntax ─────────────────────────────────────────────────────

/** Regex for a bare task ID (T followed by 3+ digits). */
const TASK_ID_RE = /^T\d{3,}$/;

/** Regex for project:taskId syntax. */
const QUALIFIED_RE = /^([a-z0-9_-]+|\.|\*):T\d{3,}$/;

/**
 * Validate a query string matches expected syntax.
 */
export function validateSyntax(query: string): boolean {
  if (!query) return false;
  return TASK_ID_RE.test(query) || QUALIFIED_RE.test(query);
}

/**
 * Parse a query string into its components.
 * @throws CleoError with NEXUS_INVALID_SYNTAX for bad format.
 */
export function parseQuery(query: string, currentProject?: string): NexusParsedQuery {
  if (!validateSyntax(query)) {
    throw new CleoError(
      ExitCode.NEXUS_INVALID_SYNTAX,
      `Invalid query syntax: ${query}. Expected: T001, project:T001, .:T001, or *:T001`,
    );
  }

  // Check for colon separator
  const colonIdx = query.indexOf(':');
  if (colonIdx === -1) {
    // Bare task ID -- implicit current project
    const project = currentProject ?? getCurrentProject();
    return { project, taskId: query, wildcard: false };
  }

  const prefix = query.substring(0, colonIdx);
  const taskId = query.substring(colonIdx + 1);

  switch (prefix) {
    case '.': {
      const project = currentProject ?? getCurrentProject();
      return { project, taskId, wildcard: false };
    }
    case '*':
      return { project: '*', taskId, wildcard: true };
    default:
      return { project: prefix, taskId, wildcard: false };
  }
}

/**
 * Get the current project name from context.
 * Reads .cleo/project-info.json or falls back to directory name.
 */
export function getCurrentProject(): string {
  // Allow test/env override
  if (process.env['NEXUS_CURRENT_PROJECT']) {
    return process.env['NEXUS_CURRENT_PROJECT'];
  }

  // Try to read from .cleo/project-info.json (matches bash behavior)
  try {
    const infoPath = join(process.cwd(), '.cleo', 'project-info.json');
    if (existsSync(infoPath)) {
      const data = JSON.parse(readFileSync(infoPath, 'utf-8')) as Record<string, unknown>;
      if (typeof data.name === 'string' && data.name.length > 0) {
        return data.name;
      }
    }
  } catch {
    // Fall through to directory name
  }

  // Fallback to cwd directory name
  return basename(process.cwd());
}

/**
 * Resolve a project name to its filesystem path.
 * Handles special cases: "." (current), "*" (wildcard marker).
 */
export async function resolveProjectPath(projectName: string): Promise<string> {
  if (projectName === '*') {
    return 'WILDCARD';
  }

  if (projectName === '.') {
    try {
      const accessor = await getAccessor(process.cwd());
      const count = await accessor.countTasks();
      if (count >= 0) return process.cwd();
      throw new Error('No task data');
    } catch {
      throw new CleoError(
        ExitCode.NEXUS_PROJECT_NOT_FOUND,
        'Current directory is not a CLEO project',
      );
    }
  }

  // Look up in registry
  const project = await nexusGetProject(projectName);
  if (!project) {
    throw new CleoError(
      ExitCode.NEXUS_PROJECT_NOT_FOUND,
      `Project not found in registry: ${projectName}`,
      { fix: `cleo nexus register /path/to/project --name ${projectName}` },
    );
  }

  return project.path;
}

/**
 * Read tasks from a project's task database.
 */
async function readProjectTasks(projectPath: string): Promise<Task[]> {
  const tasksDbPath = join(projectPath, '.cleo', 'tasks.db');
  try {
    const accessor = await getAccessor(projectPath);
    const { tasks } = await accessor.queryTasks({});
    return tasks;
  } catch {
    throw new CleoError(ExitCode.NOT_FOUND, `Project task data not found: ${tasksDbPath}`);
  }
}

/**
 * Resolve a query to task data.
 * For wildcard queries, returns an array of matches from all projects.
 * For named projects, returns a single task with project context.
 */
export async function resolveTask(
  _projectRoot: string,
  params: NexusResolveParams,
): Promise<NexusResolvedTask | NexusResolvedTask[]>;
/** @deprecated Use `resolveTask(projectRoot, params)` — ADR-057 D1 */
export async function resolveTask(
  query: string,
  currentProject?: string,
): Promise<NexusResolvedTask | NexusResolvedTask[]>;
export async function resolveTask(
  projectRootOrQuery: string,
  paramsOrCurrentProject?: NexusResolveParams | string,
): Promise<NexusResolvedTask | NexusResolvedTask[]> {
  let query: string;
  let currentProject: string | undefined;
  if (paramsOrCurrentProject !== undefined && typeof paramsOrCurrentProject === 'object') {
    query = paramsOrCurrentProject.query;
    currentProject = paramsOrCurrentProject.currentProject;
  } else {
    query = projectRootOrQuery;
    currentProject = paramsOrCurrentProject as string | undefined;
  }
  const parsed = parseQuery(query, currentProject);

  if (parsed.wildcard) {
    return resolveWildcard(parsed.taskId);
  }

  // Resolve project path
  const projectPath = await resolveProjectPath(parsed.project);
  const tasks = await readProjectTasks(projectPath);
  const task = tasks.find((t) => t.id === parsed.taskId);

  if (!task) {
    throw new CleoError(
      ExitCode.NOT_FOUND,
      `Task not found: ${parsed.taskId} in project ${parsed.project}`,
    );
  }

  return { ...task, _project: parsed.project };
}

/**
 * Search for a task ID across all registered projects.
 */
async function resolveWildcard(taskId: string): Promise<NexusResolvedTask[]> {
  const registry = await readRegistry();
  if (!registry) return [];

  const results: NexusResolvedTask[] = [];

  for (const project of Object.values(registry.projects)) {
    try {
      const tasks = await readProjectTasks(project.path);
      const match = tasks.find((t) => t.id === taskId);
      if (match) {
        results.push({ ...match, _project: project.name });
      }
    } catch {
      // Skip projects with unreadable task data
    }
  }

  return results;
}

/**
 * Extract the project name from a query without full resolution.
 * Useful for permission checks before task lookup.
 */
export function getProjectFromQuery(query: string, currentProject?: string): string {
  const parsed = parseQuery(query, currentProject);
  return parsed.project;
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

/**
 * Convert a caught error to an EngineResult failure.
 */
function caughtToEngineError<T>(error: unknown, fallbackMsg: string): EngineResult<T> {
  const e = error instanceof Error ? error : null;
  return engineError<T>('E_INTERNAL', e?.message ?? fallbackMsg);
}

/**
 * Resolve a cross-project task query.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusResolve(
  query: string,
  currentProject?: string,
): Promise<EngineResult<Awaited<ReturnType<typeof resolveTask>>>> {
  try {
    if (!validateSyntax(query)) {
      return engineError(
        'E_INVALID_INPUT',
        `Invalid query syntax: ${query}. Expected: T001, project:T001, .:T001, or *:T001`,
      );
    }
    const result = await resolveTask('', { query, currentProject });
    return engineSuccess(result);
  } catch (error) {
    return caughtToEngineError(error, 'Failed to resolve query');
  }
}

/**
 * Query highest-weight symbols/nodes from nexus plasticity or brain page nodes.
 *
 * Prioritizes brain.db page_nodes (quality_score) over nexus_relations (aggregate weight).
 * Supports optional --kind (nexus) or --nodeType (brain) filter.
 * Returns graceful empty result with note when neither DB is available.
 *
 * @task T1569
 */
// SSoT-EXEMPT:engine-migration-T1569
export async function nexusTopEntries(params?: {
  limit?: number;
  kind?: string;
  nodeType?: string;
}): Promise<
  EngineResult<{
    entries: unknown[];
    count: number;
    limit: number;
    kind?: string | null;
    nodeType?: string | null;
    note?: string;
  }>
> {
  try {
    const limit =
      typeof params?.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
        ? Math.floor(params.limit)
        : 20;

    // Brain.db path takes priority: query brain_page_nodes by quality_score.
    const brainDb = getBrainNativeDb();
    if (brainDb !== null && brainDb !== undefined) {
      try {
        const nodeType = params?.nodeType ? String(params.nodeType) : null;
        const sql =
          nodeType === null
            ? `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
                 FROM brain_page_nodes
                ORDER BY quality_score DESC
                LIMIT ?`
            : `SELECT id, node_type, label, quality_score, last_activity_at, metadata_json
                 FROM brain_page_nodes
                WHERE node_type = ?
                ORDER BY quality_score DESC
                LIMIT ?`;
        const bindArgs: (string | number)[] = nodeType === null ? [limit] : [nodeType, limit];
        const rows = brainDb.prepare(sql).all(...bindArgs) as Array<{
          id: string;
          node_type: string | null;
          label: string | null;
          quality_score: number | null;
          last_activity_at: string | null;
          metadata_json: string | null;
        }>;

        const entries = rows.map((r) => ({
          id: r.id,
          node_type: r.node_type ?? 'unknown',
          label: r.label ?? r.id,
          quality_score: r.quality_score ?? 0,
          last_activity_at: r.last_activity_at ?? '',
          metadata_json: r.metadata_json ?? null,
        }));

        return engineSuccess({
          entries,
          count: entries.length,
          limit,
          nodeType,
        });
      } catch {
        // brain_page_nodes table not yet created — fall through to nexus
      }
    }

    // Nexus.db fallback: check if a nexus.db connection is already open.
    const nexusDb = getNexusNativeDb();

    if (!nexusDb) {
      return engineSuccess({
        entries: [],
        count: 0,
        limit,
        kind: params?.kind ? String(params.kind) : null,
        note: 'Neither brain.db nor nexus.db is available. Run "cleo nexus init" to initialize.',
      });
    }

    try {
      const kind = params?.kind ? String(params.kind) : null;
      const sql =
        kind === null
          ? `SELECT r.source_id,
                    SUM(COALESCE(r.weight, 0)) AS totalWeight,
                    COUNT(*)                   AS edgeCount,
                    n.label,
                    n.kind,
                    n.file_path
               FROM nexus_relations r
               LEFT JOIN nexus_nodes n ON n.id = r.source_id
              GROUP BY r.source_id
              ORDER BY totalWeight DESC, edgeCount DESC
              LIMIT ?`
          : `SELECT r.source_id,
                    SUM(COALESCE(r.weight, 0)) AS totalWeight,
                    COUNT(*)                   AS edgeCount,
                    n.label,
                    n.kind,
                    n.file_path
               FROM nexus_relations r
               LEFT JOIN nexus_nodes n ON n.id = r.source_id
              WHERE n.kind = ?
              GROUP BY r.source_id
              ORDER BY totalWeight DESC, edgeCount DESC
              LIMIT ?`;
      const bindArgs: (string | number)[] = kind === null ? [limit] : [kind, limit];
      const rows = nexusDb.prepare(sql).all(...bindArgs) as Array<{
        source_id: string;
        totalWeight: number;
        edgeCount: number;
        label: string | null;
        kind: string | null;
        file_path: string | null;
      }>;

      const entries = rows.map((r) => ({
        nodeId: r.source_id,
        label: r.label ?? r.source_id,
        kind: r.kind ?? 'unknown',
        filePath: r.file_path ?? null,
        totalWeight: r.totalWeight,
        edgeCount: r.edgeCount,
      }));

      const result: {
        entries: unknown[];
        count: number;
        limit: number;
        kind?: string | null;
        note?: string;
      } = {
        entries,
        count: entries.length,
        limit,
        kind,
      };

      if (entries.length === 0) {
        result.note =
          'No high-impact sources detected yet. Code plasticity will accumulate as the system indexes and analyzes dependencies.';
      }

      return engineSuccess(result);
    } catch {
      return engineSuccess({
        entries: [],
        count: 0,
        limit,
        kind: params?.kind ? String(params.kind) : null,
        note: 'Nexus registry not yet initialized. Run "cleo nexus init" to start.',
      });
    }
  } catch (error) {
    return caughtToEngineError(error, 'Failed to get top entries');
  }
}
