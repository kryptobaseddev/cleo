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
  nexusDiscoverRelated as discoverRelated,
  executeTransfer,
  exportSnapshot,
  getDefaultSnapshotPath,
  getSharingStatus,
  importSnapshot,
  type NexusPermissionLevel,
  nexusDeps,
  nexusGetProject,
  nexusInit,
  nexusList,
  nexusReconcile,
  nexusRegister,
  nexusSync,
  nexusSyncAll,
  nexusUnregister,
  orphanDetection,
  paginate,
  previewTransfer,
  nexusReadRegistry as readRegistry,
  readSnapshot,
  resolveTask,
  searchAcrossProjects,
  setPermission,
  type TransferParams,
  type TransferResult,
  validateSyntax,
  writeSnapshot,
} from '@cleocode/core/internal';
import { cleoErrorToEngineError, type EngineResult, engineError, engineSuccess } from './_error.js';

// Re-export EngineResult for consumers
export type { EngineResult };

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
/**
 * Discover tasks related to a given task query across projects.
 * Delegates all business logic to src/core/nexus/discover.ts.
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
    const result = await discoverRelated(taskQuery, method, limit);
    if ('error' in result) {
      return engineError(result.error.code as 'E_INVALID_INPUT', result.error.message);
    }
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Search for tasks across all registered projects.
 */
/**
 * Search for tasks across all registered projects.
 * Delegates all business logic to src/core/nexus/discover.ts.
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
    const result = await searchAcrossProjects(pattern, projectFilter, limit);
    if ('error' in result) {
      return engineError(
        result.error.code as 'E_INVALID_INPUT' | 'E_NOT_FOUND',
        result.error.message,
      );
    }
    return engineSuccess(result);
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
export async function nexusInitialize(): Promise<EngineResult<{ message: string }>> {
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
    return cleoErrorToEngineError(error, 'E_INTERNAL', `Failed to unregister project: ${name}`);
  }
}

/**
 * Sync a specific project or all projects.
 */
export async function nexusSyncProject(name?: string): Promise<EngineResult<unknown>> {
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

// ---------------------------------------------------------------------------
// Transfer operations
// ---------------------------------------------------------------------------

/**
 * Preview a cross-project task transfer (dry run).
 */
export async function nexusTransferPreview(
  params: TransferParams,
): Promise<EngineResult<TransferResult>> {
  try {
    const result = await previewTransfer(params);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Execute a cross-project task transfer.
 */
export async function nexusTransferExecute(
  params: TransferParams,
): Promise<EngineResult<TransferResult>> {
  try {
    const result = await executeTransfer(params);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
