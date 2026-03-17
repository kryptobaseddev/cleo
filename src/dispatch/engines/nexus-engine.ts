/**
 * Nexus Engine — Thin wrapper layer for nexus domain operations.
 *
 * Delegates all business logic to src/core/nexus/ and src/core/snapshot/.
 * Each function catches errors and wraps them into EngineResult.
 *
 * Sub-domains:
 *   Registry   - init, register, unregister, sync, reconcile, list, show, status
 *   Query      - resolve, deps, graph, path, blockers, orphans
 *   Discovery  - discover related tasks, search across projects
 *   Sharing    - status, snapshot export/import
 *
 * @task T5704
 * @epic T5701
 */

import {
  blockingAnalysis,
  buildGlobalGraph,
  criticalPath,
  nexusDeps,
  orphanDetection,
} from '../../core/nexus/deps.js';
import { setPermission } from '../../core/nexus/permissions.js';
import { parseQuery, resolveTask, validateSyntax } from '../../core/nexus/query.js';
import {
  type NexusPermissionLevel,
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  readRegistry,
} from '../../core/nexus/registry.js';
import { getSharingStatus } from '../../core/nexus/sharing/index.js';
import { paginate } from '../../core/pagination.js';
import {
  exportSnapshot,
  getDefaultSnapshotPath,
  importSnapshot,
  readSnapshot,
  writeSnapshot,
} from '../../core/snapshot/index.js';
import { getAccessor } from '../../store/data-accessor.js';
import { type EngineResult, engineError, engineSuccess } from './_error.js';

// Re-export EngineResult for consumers
export type { EngineResult };

// ---------------------------------------------------------------------------
// Stop-word set for keyword extraction (used by discovery)
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'to', 'of',
  'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some', 'such',
  'no', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'because',
  'if', 'when', 'this', 'that', 'these', 'those', 'it', 'its',
]);

/**
 * Extract meaningful keywords from text (filters stop words and short tokens).
 */
function extractKeywords(text: string): string[] {
  return text
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

// ---------------------------------------------------------------------------
// Registry operations
// ---------------------------------------------------------------------------

/**
 * Get nexus status (initialized, project count, last updated).
 */
export async function nexusStatus(): Promise<
  EngineResult<{
    initialized: boolean;
    projectCount: number;
    lastUpdated: string | null;
  }>
> {
  try {
    const registry = await readRegistry();
    const initialized = registry !== null;
    const projectCount = initialized ? Object.keys(registry.projects).length : 0;
    return engineSuccess({
      initialized,
      projectCount,
      lastUpdated: registry?.lastUpdated ?? null,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List all registered projects.
 */
export async function nexusListProjects(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    projects: Awaited<ReturnType<typeof nexusList>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const projects = await nexusList();
    const page = paginate(projects, limit, offset);
    return {
      success: true,
      data: {
        projects: page.items as Awaited<ReturnType<typeof nexusList>>,
        count: projects.length,
        total: projects.length,
        filtered: projects.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Show a single project by name.
 */
export async function nexusShowProject(
  name: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusGetProject>>>> {
  try {
    const project = await nexusGetProject(name);
    if (!project) {
      return engineError('E_NOT_FOUND', `Project not found: ${name}`);
    }
    return engineSuccess(project);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Resolve a cross-project task query.
 */
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
    const result = await resolveTask(query, currentProject);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get cross-project dependencies for a task query.
 */
export async function nexusDepsQuery(
  query: string,
  direction: 'forward' | 'reverse' = 'forward',
): Promise<EngineResult<Awaited<ReturnType<typeof nexusDeps>>>> {
  try {
    const result = await nexusDeps(query, direction);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Build the global dependency graph.
 */
export async function nexusGraph(): Promise<
  EngineResult<Awaited<ReturnType<typeof buildGlobalGraph>>>
> {
  try {
    const graph = await buildGlobalGraph();
    return engineSuccess(graph);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Get the critical path across projects.
 */
export async function nexusCriticalPath(): Promise<
  EngineResult<Awaited<ReturnType<typeof criticalPath>>>
> {
  try {
    const path = await criticalPath();
    return engineSuccess(path);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Analyze blockers for a task query.
 */
export async function nexusBlockers(
  query: string,
): Promise<EngineResult<Awaited<ReturnType<typeof blockingAnalysis>>>> {
  try {
    const analysis = await blockingAnalysis(query);
    return engineSuccess(analysis);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * List orphaned cross-project tasks.
 */
export async function nexusOrphans(
  limit?: number,
  offset?: number,
): Promise<
  EngineResult<{
    orphans: Awaited<ReturnType<typeof orphanDetection>>;
    count: number;
    total: number;
    filtered: number;
    page: ReturnType<typeof paginate>['page'];
  }>
> {
  try {
    const orphans = await orphanDetection();
    const page = paginate(orphans, limit, offset);
    return {
      success: true,
      data: {
        orphans: page.items as Awaited<ReturnType<typeof orphanDetection>>,
        count: orphans.length,
        total: orphans.length,
        filtered: orphans.length,
        page: page.page,
      },
      page: page.page,
    };
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Discovery & Search
// ---------------------------------------------------------------------------

/**
 * Discover tasks related to a given task query across projects.
 */
export async function nexusDiscover(
  taskQuery: string,
  method: string = 'auto',
  limit: number = 10,
): Promise<
  EngineResult<{
    query: string;
    method: string;
    results: Array<{
      project: string;
      taskId: string;
      title: string;
      score: number;
      type: string;
      reason: string;
    }>;
    total: number;
  }>
> {
  try {
    if (!validateSyntax(taskQuery)) {
      return engineError(
        'E_INVALID_INPUT',
        `Invalid query syntax: ${taskQuery}. Expected: T001, project:T001, .:T001, or *:T001`,
      );
    }

    const sourceTask = await resolveTask(taskQuery);
    if (Array.isArray(sourceTask)) {
      return engineError(
        'E_INVALID_INPUT',
        'Wildcard queries not supported for discovery. Specify a single task.',
      );
    }

    const sourceLabels = new Set(sourceTask.labels ?? []);
    const sourceDesc = (sourceTask.description ?? '').toLowerCase();
    const sourceTitle = (sourceTask.title ?? '').toLowerCase();
    const sourceWords = extractKeywords(sourceTitle + ' ' + sourceDesc);
    const parsed = parseQuery(taskQuery);

    const registry = await readRegistry();
    if (!registry) return engineSuccess({ query: taskQuery, method, results: [], total: 0 });

    const candidates: Array<{
      project: string;
      taskId: string;
      title: string;
      score: number;
      type: string;
      reason: string;
    }> = [];

    for (const project of Object.values(registry.projects)) {
      let tasks: Array<{
        id: string;
        title: string;
        description?: string;
        labels?: string[];
        status: string;
      }>;
      try {
        const accessor = await getAccessor(project.path);
        const data = await accessor.loadTaskFile();
        tasks = data.tasks ?? [];
      } catch {
        continue;
      }

      for (const task of tasks) {
        if (task.id === parsed.taskId && project.name === parsed.project) continue;

        let score = 0;
        let matchType = 'none';
        let reason = '';

        if (method === 'labels' || method === 'auto') {
          const taskLabels = task.labels ?? [];
          const overlap = taskLabels.filter((l) => sourceLabels.has(l));
          if (overlap.length > 0) {
            const labelScore = overlap.length / Math.max(sourceLabels.size, taskLabels.length, 1);
            if (method === 'labels' || labelScore > score) {
              score = Math.max(score, labelScore);
              matchType = 'labels';
              reason = `Shared labels: ${overlap.join(', ')}`;
            }
          }
        }

        if (method === 'description' || method === 'auto') {
          const taskDesc = ((task.description ?? '') + ' ' + (task.title ?? '')).toLowerCase();
          const taskWords = extractKeywords(taskDesc);
          const commonWords = sourceWords.filter((w) => taskWords.includes(w));
          if (commonWords.length > 0) {
            const descScore =
              commonWords.length / Math.max(sourceWords.length, taskWords.length, 1);
            if (descScore > score) {
              score = descScore;
              matchType = 'description';
              reason = `Keyword match: ${commonWords.slice(0, 5).join(', ')}`;
            }
          }
        }

        if (score > 0) {
          candidates.push({
            project: project.name,
            taskId: task.id,
            title: task.title,
            score: Math.round(score * 100) / 100,
            type: matchType,
            reason,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    const results = candidates.slice(0, limit);
    return engineSuccess({ query: taskQuery, method, results, total: results.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Search for tasks across all registered projects.
 */
export async function nexusSearch(
  pattern: string,
  projectFilter?: string,
  limit: number = 20,
): Promise<
  EngineResult<{
    pattern: string;
    results: Array<{
      id: string;
      title: string;
      status: string;
      priority?: string;
      description?: string;
      _project: string;
    }>;
    resultCount: number;
  }>
> {
  try {
    // Handle wildcard query syntax (*:T001) - delegate to resolveTask
    if (/^\*:.+$/.test(pattern)) {
      try {
        const result = await resolveTask(pattern);
        const tasks = Array.isArray(result) ? result : [result];
        const results = tasks.slice(0, limit).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description,
          _project: t._project,
        }));
        return engineSuccess({ pattern, results, resultCount: results.length });
      } catch {
        // Fall through to pattern search if resolveTask fails
      }
    }

    const registry = await readRegistry();
    if (!registry) return engineSuccess({ pattern, results: [], resultCount: 0 });

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escaped.replace(/\*/g, '.*');
    let regex: RegExp;
    try {
      regex = new RegExp(regexPattern, 'i');
    } catch {
      return engineError('E_INVALID_INPUT', `Invalid search pattern: ${pattern}`);
    }

    const results: Array<{
      id: string;
      title: string;
      status: string;
      priority?: string;
      description?: string;
      _project: string;
    }> = [];
    const projectEntries = projectFilter
      ? Object.values(registry.projects).filter((p) => p.name === projectFilter)
      : Object.values(registry.projects);

    if (projectFilter && projectEntries.length === 0) {
      return engineError('E_NOT_FOUND', `Project not found in registry: ${projectFilter}`);
    }

    for (const project of projectEntries) {
      let tasks: Array<{
        id: string;
        title: string;
        description?: string;
        status: string;
        priority?: string;
      }>;
      try {
        const accessor = await getAccessor(project.path);
        const data = await accessor.loadTaskFile();
        tasks = data.tasks ?? [];
      } catch {
        continue;
      }

      for (const task of tasks) {
        const matchesId = regex.test(task.id);
        const matchesTitle = regex.test(task.title);
        const matchesDesc = regex.test(task.description ?? '');

        if (matchesId || matchesTitle || matchesDesc) {
          results.push({
            id: task.id,
            title: task.title,
            status: task.status,
            priority: task.priority,
            description: task.description,
            _project: project.name,
          });
        }
      }
    }

    const sliced = results.slice(0, limit);
    return engineSuccess({ pattern, results: sliced, resultCount: sliced.length });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Registry mutation operations
// ---------------------------------------------------------------------------

/**
 * Initialize the nexus.
 */
export async function nexusInitialize(): Promise<
  EngineResult<{ message: string }>
> {
  try {
    await nexusInit();
    return engineSuccess({ message: 'NEXUS initialized successfully' });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Register a project in the nexus.
 */
export async function nexusRegisterProject(
  path: string,
  name?: string,
  permission: NexusPermissionLevel = 'read',
): Promise<EngineResult<{ hash: string; message: string }>> {
  try {
    const hash = await nexusRegister(path, name, permission);
    return engineSuccess({ hash, message: `Project registered with hash: ${hash}` });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Unregister a project from the nexus.
 */
export async function nexusUnregisterProject(
  name: string,
): Promise<EngineResult<{ message: string }>> {
  try {
    await nexusUnregister(name);
    return engineSuccess({ message: `Project unregistered: ${name}` });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Sync a specific project or all projects.
 */
export async function nexusSyncProject(
  name?: string,
): Promise<EngineResult<unknown>> {
  try {
    if (name) {
      await nexusSync(name);
      return engineSuccess({ message: `Project synced: ${name}` });
    }
    const result = await nexusSyncAll();
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Set permission level for a project.
 */
export async function nexusSetPermission(
  name: string,
  level: NexusPermissionLevel,
): Promise<EngineResult<{ message: string }>> {
  try {
    await setPermission(name, level);
    return engineSuccess({ message: `Permission for '${name}' set to '${level}'` });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Reconcile the nexus registry with the filesystem.
 */
export async function nexusReconcileProject(
  projectRoot: string,
): Promise<EngineResult<Awaited<ReturnType<typeof nexusReconcile>>>> {
  try {
    const result = await nexusReconcile(projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Sharing operations
// ---------------------------------------------------------------------------

/**
 * Get sharing status for a project.
 */
export async function nexusShareStatus(
  projectRoot: string,
): Promise<EngineResult<Awaited<ReturnType<typeof getSharingStatus>>>> {
  try {
    const result = await getSharingStatus(projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Export a snapshot of the project's tasks.
 */
export async function nexusShareSnapshotExport(
  projectRoot: string,
  outputPath?: string,
): Promise<
  EngineResult<{
    path: string;
    taskCount: number;
    checksum: string;
  }>
> {
  try {
    const snapshot = await exportSnapshot(projectRoot);
    const resolvedPath = outputPath ?? getDefaultSnapshotPath(projectRoot);
    await writeSnapshot(snapshot, resolvedPath);
    return engineSuccess({
      path: resolvedPath,
      taskCount: snapshot._meta.taskCount,
      checksum: snapshot._meta.checksum,
    });
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Import a snapshot into the project.
 */
export async function nexusShareSnapshotImport(
  projectRoot: string,
  inputPath: string,
): Promise<EngineResult<Awaited<ReturnType<typeof importSnapshot>>>> {
  try {
    const snapshot = await readSnapshot(inputPath);
    const result = await importSnapshot(snapshot, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
