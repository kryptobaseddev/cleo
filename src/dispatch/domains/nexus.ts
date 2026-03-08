/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Cross-project coordination via the BRAIN Network.
 * Delegates to src/core/nexus/ for all business logic.
 *
 * Also handles multi-contributor sharing operations (status, snapshot export/import).
 * Git CLI wrappers (remotes, push/pull, gitignore) removed in T5615.
 *
 * @epic T4820
 * @task T5671
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';
import { getLogger } from '../../core/logger.js';
import { getProjectRoot } from '../../core/paths.js';
import { paginate } from '../../core/pagination.js';

import {
  nexusInit,
  nexusRegister,
  nexusUnregister,
  nexusList,
  nexusSync,
  nexusSyncAll,
  nexusGetProject,
  nexusReconcile,
  readRegistry,
  type NexusPermissionLevel,
} from '../../core/nexus/registry.js';

import {
  resolveTask,
  parseQuery,
  validateSyntax,
} from '../../core/nexus/query.js';

import {
  nexusDeps,
  buildGlobalGraph,
  criticalPath,
  blockingAnalysis,
  orphanDetection,
} from '../../core/nexus/deps.js';

import {
  setPermission,
} from '../../core/nexus/permissions.js';

import { getAccessor } from '../../store/data-accessor.js';

// Sharing core imports (merged from sharing domain)
import {
  getSharingStatus,
} from '../../core/nexus/sharing/index.js';
import {
  exportSnapshot,
  importSnapshot,
  readSnapshot,
  writeSnapshot,
  getDefaultSnapshotPath,
} from '../../core/snapshot/index.js';


// ---------------------------------------------------------------------------
// NexusHandler
// ---------------------------------------------------------------------------

export class NexusHandler implements DomainHandler {
  private projectRoot: string;

  constructor() {
    this.projectRoot = getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const registry = await readRegistry();
          const initialized = registry !== null;
          const projectCount = initialized ? Object.keys(registry.projects).length : 0;
          return this.successResponse('query', operation, startTime, {
            initialized,
            projectCount,
            lastUpdated: registry?.lastUpdated ?? null,
          });
        }

        case 'list': {
          const projects = await nexusList();
          const { limit, offset } = this.getListParams(params);
          const page = paginate(projects, limit, offset);
          return this.successResponse('query', operation, startTime, {
            projects: page.items,
            count: projects.length,
            total: projects.length,
            filtered: projects.length,
          }, page.page);
        }

        case 'show': {
          const name = params?.name as string;
          if (!name) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'name is required', startTime);
          }
          const project = await nexusGetProject(name);
          if (!project) {
            return this.errorResponse('query', operation, 'E_NOT_FOUND', `Project not found: ${name}`, startTime);
          }
          return this.successResponse('query', operation, startTime, project);
        }

        case 'resolve':
        case 'query': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          if (!validateSyntax(query)) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', `Invalid query syntax: ${query}. Expected: T001, project:T001, .:T001, or *:T001`, startTime);
          }
          const result = await resolveTask(query, params?.currentProject as string | undefined);
          return this.successResponse('query', operation, startTime, result);
        }

        case 'deps': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const direction = (params?.direction as 'forward' | 'reverse') ?? 'forward';
          const result = await nexusDeps(query, direction);
          return this.successResponse('query', operation, startTime, result);
        }

        case 'graph': {
          const graph = await buildGlobalGraph();
          return this.successResponse('query', operation, startTime, graph);
        }

        case 'path.show': {
          const path = await criticalPath();
          return this.successResponse('query', operation, startTime, path);
        }

        case 'blockers.show': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const analysis = await blockingAnalysis(query);
          return this.successResponse('query', operation, startTime, analysis);
        }

        case 'orphans.list': {
          const orphans = await orphanDetection();
          const { limit, offset } = this.getListParams(params);
          const page = paginate(orphans, limit, offset);
          return this.successResponse('query', operation, startTime, {
            orphans: page.items,
            count: orphans.length,
            total: orphans.length,
            filtered: orphans.length,
          }, page.page);
        }

        case 'discover': {
          const query = params?.query as string;
          if (!query) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'query is required', startTime);
          }
          const method = (params?.method as string) ?? 'auto';
          const limit = (params?.limit as number) ?? 10;
          const results = await this.discoverRelatedTasks(query, method, limit);
          return this.successResponse('query', operation, startTime, {
            query,
            method,
            results,
            total: results.length,
          });
        }

        case 'search': {
          const pattern = params?.pattern as string;
          if (!pattern) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT', 'pattern is required', startTime);
          }
          const projectFilter = params?.project as string | undefined;
          const limit = (params?.limit as number) ?? 20;
          const results = await this.searchAcrossProjects(pattern, projectFilter, limit);
          return this.successResponse('query', operation, startTime, {
            pattern,
            results,
            resultCount: results.length,
          });
        }

        // Sharing: merged entry point via routeByParam (T5671)
        case 'share':
          return routeByParam<Promise<DispatchResponse>>(params, 'action', {
            status: () => this.queryShareStatus(startTime),
          }, 'status');

        // Backward-compat alias
        case 'share.status':
          return this.queryShareStatus(startTime);

        default:
          return this.unsupported('query', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'init': {
          await nexusInit();
          return this.successResponse('mutate', operation, startTime, {
            message: 'NEXUS initialized successfully',
          });
        }

        case 'register': {
          const path = params?.path as string;
          if (!path) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'path is required', startTime);
          }
          const hash = await nexusRegister(
            path,
            params?.name as string | undefined,
            (params?.permission as NexusPermissionLevel) ?? 'read',
          );
          return this.successResponse('mutate', operation, startTime, {
            hash,
            message: `Project registered with hash: ${hash}`,
          });
        }

        case 'unregister': {
          const name = params?.name as string;
          if (!name) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'name is required', startTime);
          }
          await nexusUnregister(name);
          return this.successResponse('mutate', operation, startTime, {
            message: `Project unregistered: ${name}`,
          });
        }

        case 'sync':
        case 'sync.all': {
          const name = params?.name as string | undefined;
          if (name) {
            await nexusSync(name);
            return this.successResponse('mutate', operation, startTime, {
              message: `Project synced: ${name}`,
            });
          }
          const result = await nexusSyncAll();
          return this.successResponse('mutate', operation, startTime, result);
        }

        case 'permission.set': {
          const name = params?.name as string;
          const level = params?.level as string;
          if (!name) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'name is required', startTime);
          }
          if (!level) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'level is required', startTime);
          }
          if (!['read', 'write', 'execute'].includes(level)) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', `Invalid permission level: ${level}. Must be: read, write, or execute`, startTime);
          }
          await setPermission(name, level as NexusPermissionLevel);
          return this.successResponse('mutate', operation, startTime, {
            message: `Permission for '${name}' set to '${level}'`,
          });
        }

        case 'reconcile': {
          const projectRoot = (params?.projectRoot as string) || process.cwd();
          const result = await nexusReconcile(projectRoot);
          return this.successResponse('mutate', operation, startTime, result);
        }

        // Sharing: merged entry point via routeByParam (T5671)
        case 'share':
          return routeByParam<Promise<DispatchResponse>>(params, 'action', {
            export: () => this.mutateShareSnapshotExport(params, startTime),
            import: () => this.mutateShareSnapshotImport(params, startTime),
          });

        // Backward-compat aliases
        case 'share.snapshot.export':
        case 'share.snapshot-export':
          return this.mutateShareSnapshotExport(params, startTime);

        case 'share.snapshot.import':
        case 'share.snapshot-import':
          return this.mutateShareSnapshotImport(params, startTime);

        default:
          return this.unsupported('mutate', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status', 'list', 'show', 'resolve', 'deps', 'graph', 'path.show', 'blockers.show', 'orphans.list', 'discover', 'search',
        'share.status',
      ],
      mutate: [
        'init', 'register', 'unregister', 'sync', 'permission.set', 'reconcile',
        'share.snapshot.export', 'share.snapshot.import',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Discovery & Search engines (moved from CLI, T5323/T5330)
  // -----------------------------------------------------------------------

  private async discoverRelatedTasks(
    taskQuery: string,
    method: string,
    limit: number,
  ): Promise<Array<{ project: string; taskId: string; title: string; score: number; type: string; reason: string }>> {
    if (!validateSyntax(taskQuery)) {
      throw new Error(`Invalid query syntax: ${taskQuery}. Expected: T001, project:T001, .:T001, or *:T001`);
    }

    const sourceTask = await resolveTask(taskQuery);
    if (Array.isArray(sourceTask)) {
      throw new Error('Wildcard queries not supported for discovery. Specify a single task.');
    }

    const sourceLabels = new Set(sourceTask.labels ?? []);
    const sourceDesc = (sourceTask.description ?? '').toLowerCase();
    const sourceTitle = (sourceTask.title ?? '').toLowerCase();
    const sourceWords = this.extractKeywords(sourceTitle + ' ' + sourceDesc);
    const parsed = parseQuery(taskQuery);

    const registry = await readRegistry();
    if (!registry) return [];

    const candidates: Array<{ project: string; taskId: string; title: string; score: number; type: string; reason: string }> = [];

    for (const project of Object.values(registry.projects)) {
      let tasks: Array<{ id: string; title: string; description?: string; labels?: string[]; status: string }>;
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
          const overlap = taskLabels.filter(l => sourceLabels.has(l));
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
          const taskWords = this.extractKeywords(taskDesc);
          const commonWords = sourceWords.filter(w => taskWords.includes(w));
          if (commonWords.length > 0) {
            const descScore = commonWords.length / Math.max(sourceWords.length, taskWords.length, 1);
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
    return candidates.slice(0, limit);
  }

  private async searchAcrossProjects(
    pattern: string,
    projectFilter?: string,
    limit = 20,
  ): Promise<Array<{ id: string; title: string; status: string; priority?: string; description?: string; _project: string }>> {
    // Handle wildcard query syntax (*:T001) - delegate to resolveTask
    if (/^\*:.+$/.test(pattern)) {
      try {
        const result = await resolveTask(pattern);
        const tasks = Array.isArray(result) ? result : [result];
        return tasks.slice(0, limit).map(t => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          description: t.description,
          _project: t._project,
        }));
      } catch {
        // Fall through to pattern search if resolveTask fails
      }
    }

    const registry = await readRegistry();
    if (!registry) return [];

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escaped.replace(/\*/g, '.*');
    let regex: RegExp;
    try {
      regex = new RegExp(regexPattern, 'i');
    } catch {
      throw new Error(`Invalid search pattern: ${pattern}`);
    }

    const results: Array<{ id: string; title: string; status: string; priority?: string; description?: string; _project: string }> = [];
    const projectEntries = projectFilter
      ? Object.values(registry.projects).filter(p => p.name === projectFilter)
      : Object.values(registry.projects);

    if (projectFilter && projectEntries.length === 0) {
      throw new Error(`Project not found in registry: ${projectFilter}`);
    }

    for (const project of projectEntries) {
      let tasks: Array<{ id: string; title: string; description?: string; status: string; priority?: string }>;
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

    return results.slice(0, limit);
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'to', 'of',
      'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through',
      'during', 'before', 'after', 'above', 'below', 'and', 'but', 'or', 'nor',
      'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every', 'all',
      'any', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'only',
      'own', 'same', 'than', 'too', 'very', 'just', 'because', 'if', 'when',
      'this', 'that', 'these', 'those', 'it', 'its',
    ]);

    return text
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w));
  }

  // -----------------------------------------------------------------------
  // Sharing operation helpers (extracted for routeByParam + backward-compat)
  // -----------------------------------------------------------------------

  private async queryShareStatus(startTime: number): Promise<DispatchResponse> {
    const result = await getSharingStatus(this.projectRoot);
    return {
      _meta: dispatchMeta('query', 'nexus', 'share.status', startTime),
      success: true,
      data: result,
    };
  }

  private async mutateShareSnapshotExport(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const snapshot = await exportSnapshot(this.projectRoot);
    const outputPath = (params?.outputPath as string) ?? getDefaultSnapshotPath(this.projectRoot);
    await writeSnapshot(snapshot, outputPath);
    return {
      _meta: dispatchMeta('mutate', 'nexus', 'share.snapshot.export', startTime),
      success: true,
      data: {
        path: outputPath,
        taskCount: snapshot._meta.taskCount,
        checksum: snapshot._meta.checksum,
      },
    };
  }

  private async mutateShareSnapshotImport(
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    const inputPath = params?.inputPath as string;
    if (!inputPath) {
      return this.errorResponse('mutate', 'share.snapshot.import', 'E_INVALID_INPUT', 'inputPath is required', startTime);
    }
    const snapshot = await readSnapshot(inputPath);
    const result = await importSnapshot(snapshot, this.projectRoot);
    return {
      _meta: dispatchMeta('mutate', 'nexus', 'share.snapshot.import', startTime),
      success: true,
      data: result,
    };
  }

  // -----------------------------------------------------------------------
  // Response helpers
  // -----------------------------------------------------------------------

  private successResponse(
    gateway: string,
    operation: string,
    startTime: number,
    data: unknown,
    page?: import('@cleocode/lafs-protocol').LAFSPage,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'nexus', operation, startTime),
      success: true,
      data,
      ...(page ? { page } : {}),
    };
  }

  private getListParams(params?: Record<string, unknown>): { limit?: number; offset?: number } {
    return {
      limit: typeof params?.limit === 'number' ? params.limit : undefined,
      offset: typeof params?.offset === 'number' ? params.offset : undefined,
    };
  }

  private unsupported(gateway: string, operation: string, startTime: number): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'nexus', operation, startTime),
      success: false,
      error: { code: 'E_INVALID_OPERATION', message: `Unknown nexus ${gateway}: ${operation}` },
    };
  }

  private errorResponse(
    gateway: string,
    operation: string,
    code: string,
    message: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'nexus', operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(gateway: string, operation: string, error: unknown, startTime: number): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:nexus').error({ gateway, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, 'nexus', operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
