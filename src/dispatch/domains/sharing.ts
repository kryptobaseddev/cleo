/**
 * Sharing Domain Handler (Dispatch Layer)
 *
 * Handles multi-contributor sharing operations: snapshot export/import,
 * .gitignore sync, remote management, and push/pull for .cleo/.git.
 *
 * Query operations: status, remotes, sync.status
 * Mutate operations: snapshot.export, snapshot.import, sync.gitignore,
 *   remote.add, remote.remove, push, pull
 *
 * All operations delegate to core modules:
 *   - src/core/sharing/index.ts  (getSharingStatus, syncGitignore)
 *   - src/core/snapshot/index.ts (exportSnapshot, importSnapshot, readSnapshot, writeSnapshot, getDefaultSnapshotPath)
 *   - src/core/remote/index.ts   (listRemotes, getSyncStatus, addRemote, removeRemote, push, pull)
 *
 * @epic T4820
 * @task T4883
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('domain:sharing');
import {
  getSharingStatus,
  syncGitignore,
} from '../../core/sharing/index.js';
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
// SharingHandler
// ---------------------------------------------------------------------------

export class SharingHandler implements DomainHandler {
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
          const result = await getSharingStatus(this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'sharing', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'remotes': {
          const remotes = await listRemotes(this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'sharing', operation, startTime),
            success: true,
            data: { remotes },
          };
        }

        case 'sync.status':
        case 'sync-status': {
          const remote = (params?.remote as string) ?? 'origin';
          const syncStatus = await getSyncStatus(remote, this.projectRoot);
          return {
            _meta: dispatchMeta('query', 'sharing', operation, startTime),
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
        case 'snapshot.export':
        case 'snapshot-export': {
          const snapshot = await exportSnapshot(this.projectRoot);
          const outputPath = (params?.outputPath as string) ?? getDefaultSnapshotPath(this.projectRoot);
          await writeSnapshot(snapshot, outputPath);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: true,
            data: {
              path: outputPath,
              taskCount: snapshot._meta.taskCount,
              checksum: snapshot._meta.checksum,
            },
          };
        }

        case 'snapshot.import':
        case 'snapshot-import': {
          const inputPath = params?.inputPath as string;
          if (!inputPath) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'inputPath is required', startTime);
          }
          const snapshot = await readSnapshot(inputPath);
          const result = await importSnapshot(snapshot, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'sync.gitignore':
        case 'sync-gitignore': {
          const result = await syncGitignore(this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: true,
            data: result,
          };
        }

        case 'remote.add':
        case 'remote-add': {
          const url = params?.url as string;
          if (!url) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT', 'url is required', startTime);
          }
          const name = (params?.name as string) ?? 'origin';
          await addRemote(url, name, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: true,
            data: { name, url },
          };
        }

        case 'remote.remove':
        case 'remote-remove': {
          const remoteName = (params?.name as string) ?? 'origin';
          await removeRemote(remoteName, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: true,
            data: { name: remoteName },
          };
        }

        case 'push': {
          const remote = (params?.remote as string) ?? 'origin';
          const result = await remotePush(remote, {
            force: params?.force as boolean | undefined,
            setUpstream: params?.setUpstream as boolean | undefined,
          }, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
            success: result.success,
            data: result,
            ...(result.success ? {} : {
              error: { code: 'E_PUSH_FAILED', message: result.message },
            }),
          };
        }

        case 'pull': {
          const remote = (params?.remote as string) ?? 'origin';
          const result = await remotePull(remote, this.projectRoot);
          return {
            _meta: dispatchMeta('mutate', 'sharing', operation, startTime),
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
      query: ['status', 'remotes', 'sync.status'],
      mutate: [
        'snapshot.export', 'snapshot.import', 'sync.gitignore',
        'remote.add', 'remote.remove', 'push', 'pull',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private unsupported(gateway: string, operation: string, startTime: number): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, 'sharing', operation, startTime),
      success: false,
      error: { code: 'E_INVALID_OPERATION', message: `Unknown sharing ${gateway}: ${operation}` },
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
      _meta: dispatchMeta(gateway, 'sharing', operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(gateway: string, operation: string, error: unknown, startTime: number): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ gateway, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, 'sharing', operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
