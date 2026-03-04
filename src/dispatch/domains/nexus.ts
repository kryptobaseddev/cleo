/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Cross-project coordination via the BRAIN Network.
 * Delegates to src/core/nexus/ for all business logic.
 *
 * Also handles multi-contributor sharing operations (snapshot export/import,
 * .gitignore sync, remote management, and push/pull for .cleo/.git).
 *
 * @epic T4820
 * @task T5277
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getLogger } from '../../core/logger.js';
import { getProjectRoot } from '../../core/paths.js';

import {
  nexusInit,
  nexusRegister,
  nexusUnregister,
  nexusList,
  nexusSync,
  nexusSyncAll,
  nexusGetProject,
  readRegistry,
  type NexusPermissionLevel,
} from '../../core/nexus/registry.js';

import {
  resolveTask,
  validateSyntax,
} from '../../core/nexus/query.js';

import {
  nexusDeps,
  buildGlobalGraph,
} from '../../core/nexus/deps.js';

import {
  setPermission,
} from '../../core/nexus/permissions.js';

// Sharing core imports (merged from sharing domain)
import {
  getSharingStatus,
  syncGitignore,
} from '../../core/nexus/sharing/index.js';
import {
  exportSnapshot,
  importSnapshot,
  readSnapshot,
  writeSnapshot,
  getDefaultSnapshotPath,
} from '../../core/snapshot/index.js';
import {
  listRemotes,
  getSyncStatus,
  addRemote,
  removeRemote,
  push as remotePush,
  pull as remotePull,
} from '../../core/remote/index.js';


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
          return this.successResponse('query', operation, startTime, {
            projects,
            count: projects.length,
          });
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

        // Sharing sub-operations (T5277)
        case 'share.status': {
          const result = await getSharingStatus(this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'share.remotes': {
          const remotes = await listRemotes(this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: { remotes },
          };
        }

        case 'share.sync.status': {
          const remote = (params?.remote as string) ?? 'origin';
          const syncStatus = await getSyncStatus(remote, this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'nexus', operation, startTime),
            success: true,
            data: syncStatus,
          };
        }

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

        case 'sync': {
          const name = params?.name as string;
          if (!name) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'name is required', startTime);
          }
          await nexusSync(name);
          return this.successResponse('mutate', operation, startTime, {
            message: `Project synced: ${name}`,
          });
        }

        case 'sync.all': {
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

        // Sharing sub-operations (T5277)
        case 'share.snapshot.export':
        case 'share.snapshot-export': {
          const snapshot = await exportSnapshot(this.projectRoot);
          const outputPath = (params?.outputPath as string) ?? getDefaultSnapshotPath(this.projectRoot);
          await writeSnapshot(snapshot, outputPath);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: true,
            data: {
              path: outputPath,
              taskCount: snapshot._meta.taskCount,
              checksum: snapshot._meta.checksum,
            },
          };
        }

        case 'share.snapshot.import':
        case 'share.snapshot-import': {
          const inputPath = params?.inputPath as string;
          if (!inputPath) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'inputPath is required', startTime);
          }
          const snapshot = await readSnapshot(inputPath);
          const result = await importSnapshot(snapshot, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'share.sync.gitignore':
        case 'share.sync-gitignore': {
          const result = await syncGitignore(this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'share.remote.add':
        case 'share.remote-add': {
          const url = params?.url as string;
          if (!url) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'url is required', startTime);
          }
          const remoteName = (params?.name as string) ?? 'origin';
          await addRemote(url, remoteName, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: true,
            data: { name: remoteName, url },
          };
        }

        case 'share.remote.remove':
        case 'share.remote-remove': {
          const remoteName = (params?.name as string) ?? 'origin';
          await removeRemote(remoteName, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: true,
            data: { name: remoteName },
          };
        }

        case 'share.push': {
          const remote = (params?.remote as string) ?? 'origin';
          const result = await remotePush(remote, {
            force: params?.force as boolean | undefined,
            setUpstream: params?.setUpstream as boolean | undefined,
          }, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: result.success,
            data: result,
            ...(result.success ? {} : {
              error: { code: 'E_PUSH_FAILED', message: result.message },
            }),
          };
        }

        case 'share.pull': {
          const remote = (params?.remote as string) ?? 'origin';
          const result = await remotePull(remote, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
            success: result.success,
            data: result,
            ...(result.success ? {} : {
              error: { code: 'E_PULL_FAILED', message: result.message },
            }),
          };
        }

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
        'status', 'list', 'show', 'query', 'deps', 'graph',
        // Sharing sub-operations (T5277)
        'share.status', 'share.remotes', 'share.sync.status',
      ],
      mutate: [
        'init', 'register', 'unregister', 'sync', 'sync.all', 'permission.set',
        // Sharing sub-operations (T5277)
        'share.snapshot.export', 'share.snapshot.import', 'share.sync.gitignore',
        'share.remote.add', 'share.remote.remove', 'share.push', 'share.pull',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private successResponse(
    gateway: string,
    operation: string,
    startTime: number,
    data: unknown,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'nexus', operation, startTime),
      success: true,
      data,
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
