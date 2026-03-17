/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Cross-project coordination via the BRAIN Network.
 * Delegates to nexus-engine which wraps src/core/nexus/ for all business logic.
 *
 * Also handles multi-contributor sharing operations (status, snapshot export/import).
 * Git CLI wrappers (remotes, push/pull, gitignore) removed in T5615.
 *
 * @epic T4820
 * @task T5704
 */

import type { NexusPermissionLevel } from '../../core/nexus/registry.js';
import { getLogger } from '../../core/logger.js';
import { getProjectRoot } from '../../core/paths.js';
import {
  nexusBlockers,
  nexusCriticalPath,
  nexusDepsQuery,
  nexusDiscover,
  nexusGraph,
  nexusInitialize,
  nexusListProjects,
  nexusOrphans,
  nexusReconcileProject,
  nexusRegisterProject,
  nexusResolve,
  nexusSearch,
  nexusSetPermission,
  nexusShareSnapshotExport,
  nexusShareSnapshotImport,
  nexusShareStatus,
  nexusShowProject,
  nexusStatus,
  nexusSyncProject,
  nexusUnregisterProject,
} from '../engines/nexus-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, getListParams, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const result = await nexusStatus();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'list': {
          const { limit, offset } = getListParams(params);
          const result = await nexusListProjects(limit, offset);
          if (!result.success) {
            return wrapResult(result, 'query', 'nexus', operation, startTime);
          }
          return {
            _meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: {
              projects: result.data!.projects,
              count: result.data!.count,
              total: result.data!.total,
              filtered: result.data!.filtered,
            },
            page: result.data!.page,
          };
        }

        case 'show': {
          const name = params?.name as string;
          if (!name) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          const result = await nexusShowProject(name);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'resolve': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await nexusResolve(query, params?.currentProject as string | undefined);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'deps': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const direction = (params?.direction as 'forward' | 'reverse') ?? 'forward';
          const result = await nexusDepsQuery(query, direction);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'graph': {
          const result = await nexusGraph();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'path.show': {
          const result = await nexusCriticalPath();
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'blockers.show': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const result = await nexusBlockers(query);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'orphans.list': {
          const { limit, offset } = getListParams(params);
          const result = await nexusOrphans(limit, offset);
          if (!result.success) {
            return wrapResult(result, 'query', 'nexus', operation, startTime);
          }
          return {
            _meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: {
              orphans: result.data!.orphans,
              count: result.data!.count,
              total: result.data!.total,
              filtered: result.data!.filtered,
            },
            page: result.data!.page,
          };
        }

        case 'discover': {
          const query = params?.query as string;
          if (!query) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'query is required',
              startTime,
            );
          }
          const method = (params?.method as string) ?? 'auto';
          const limit = (params?.limit as number) ?? 10;
          const result = await nexusDiscover(query, method, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'search': {
          const pattern = params?.pattern as string;
          if (!pattern) {
            return errorResult(
              'query',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'pattern is required',
              startTime,
            );
          }
          const projectFilter = params?.project as string | undefined;
          const limit = (params?.limit as number) ?? 20;
          const result = await nexusSearch(pattern, projectFilter, limit);
          return wrapResult(result, 'query', 'nexus', operation, startTime);
        }

        case 'share.status': {
          const result = await nexusShareStatus(this.projectRoot);
          return wrapResult(result, 'query', 'nexus', 'share.status', startTime);
        }

        default:
          return unsupportedOp('query', 'nexus', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'query', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'nexus', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'init': {
          const result = await nexusInitialize();
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'register': {
          const path = params?.path as string;
          if (!path) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'path is required',
              startTime,
            );
          }
          const result = await nexusRegisterProject(
            path,
            params?.name as string | undefined,
            (params?.permission as NexusPermissionLevel) ?? 'read',
          );
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'unregister': {
          const name = params?.name as string;
          if (!name) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          const result = await nexusUnregisterProject(name);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'sync': {
          const name = params?.name as string | undefined;
          const result = await nexusSyncProject(name);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'permission.set': {
          const name = params?.name as string;
          const level = params?.level as string;
          if (!name) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'name is required',
              startTime,
            );
          }
          if (!level) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              'level is required',
              startTime,
            );
          }
          if (!['read', 'write', 'execute'].includes(level)) {
            return errorResult(
              'mutate',
              'nexus',
              operation,
              'E_INVALID_INPUT',
              `Invalid permission level: ${level}. Must be: read, write, or execute`,
              startTime,
            );
          }
          const result = await nexusSetPermission(name, level as NexusPermissionLevel);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'reconcile': {
          const projectRoot = (params?.projectRoot as string) || process.cwd();
          const result = await nexusReconcileProject(projectRoot);
          return wrapResult(result, 'mutate', 'nexus', operation, startTime);
        }

        case 'share.snapshot.export': {
          const outputPath = params?.outputPath as string | undefined;
          const result = await nexusShareSnapshotExport(this.projectRoot, outputPath);
          return wrapResult(result, 'mutate', 'nexus', 'share.snapshot.export', startTime);
        }

        case 'share.snapshot.import': {
          const inputPath = params?.inputPath as string;
          if (!inputPath) {
            return errorResult(
              'mutate',
              'nexus',
              'share.snapshot.import',
              'E_INVALID_INPUT',
              'inputPath is required',
              startTime,
            );
          }
          const result = await nexusShareSnapshotImport(this.projectRoot, inputPath);
          return wrapResult(result, 'mutate', 'nexus', 'share.snapshot.import', startTime);
        }

        default:
          return unsupportedOp('mutate', 'nexus', operation, startTime);
      }
    } catch (error) {
      getLogger('domain:nexus').error(
        { gateway: 'mutate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'nexus', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'share.status',
        'status',
        'list',
        'show',
        'resolve',
        'deps',
        'graph',
        'path.show',
        'blockers.show',
        'orphans.list',
        'discover',
        'search',
      ],
      mutate: [
        'share.snapshot.export',
        'share.snapshot.import',
        'init',
        'register',
        'unregister',
        'sync',
        'permission.set',
        'reconcile',
      ],
    };
  }
}
