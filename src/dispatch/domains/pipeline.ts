/**
 * Pipeline Domain Handler (Dispatch Layer)
 *
 * Consolidates legacy lifecycle and release domains into a single "pipeline"
 * domain with dot-prefixed operation names. All operations delegate to
 * native engine functions.
 *
 * Sub-domains:
 *   stage.*    - RCASD-IVTR+C lifecycle stage management
 *   release.*  - Release lifecycle (prepare, changelog, commit, tag, push)
 *   manifest.* - Research manifest (JSONL) operations
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

import {
  lifecycleStatus,
  lifecycleHistory,
  lifecycleGates,
  lifecyclePrerequisites,
  lifecycleCheck,
  lifecycleProgress,
  lifecycleSkip,
  lifecycleReset,
  lifecycleGatePass,
  lifecycleGateFail,
  releasePrepare,
  releaseChangelog,
  releaseCommit,
  releaseTag,
  releasePush,
  releaseGatesRun,
  releaseRollback,
} from '../lib/engine.js';

import {
  pipelineManifestShow,
  pipelineManifestList,
  pipelineManifestFind,
  pipelineManifestPending,
  pipelineManifestStats,
  pipelineManifestAppend,
  pipelineManifestArchive,
} from '../../core/memory/pipeline-manifest-compat.js';

// ---------------------------------------------------------------------------
// PipelineHandler
// ---------------------------------------------------------------------------

export class PipelineHandler implements DomainHandler {
  private projectRoot: string;

  constructor() {
    this.projectRoot = getProjectRoot();
  }

  // -----------------------------------------------------------------------
  // DomainHandler interface
  // -----------------------------------------------------------------------

  async query(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      // Stage sub-domain
      if (operation.startsWith('stage.')) {
        return await this.queryStage(operation.slice('stage.'.length), params, startTime);
      }

      // Manifest sub-domain
      if (operation.startsWith('manifest.')) {
        return this.queryManifest(operation.slice('manifest.'.length), params, startTime);
      }

      return this.errorResponse('query', operation, 'E_INVALID_OPERATION',
        `Unknown pipeline query: ${operation}`, startTime);
    } catch (error) {
      return this.handleError('query', operation, error, startTime);
    }
  }

  async mutate(
    operation: string,
    params?: Record<string, unknown>,
  ): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      // Stage sub-domain
      if (operation.startsWith('stage.')) {
        return await this.mutateStage(operation.slice('stage.'.length), params, startTime);
      }

      // Release sub-domain
      if (operation.startsWith('release.')) {
        return this.mutateRelease(operation.slice('release.'.length), params, startTime);
      }

      // Manifest sub-domain
      if (operation.startsWith('manifest.')) {
        return this.mutateManifest(operation.slice('manifest.'.length), params, startTime);
      }

      return this.errorResponse('mutate', operation, 'E_INVALID_OPERATION',
        `Unknown pipeline mutation: ${operation}`, startTime);
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'stage.validate', 'stage.status', 'stage.history',
        'stage.gates', 'stage.prerequisites',
        'manifest.show', 'manifest.list', 'manifest.find',
        'manifest.pending', 'manifest.stats',
      ],
      mutate: [
        'stage.record', 'stage.skip', 'stage.reset',
        'stage.gate.pass', 'stage.gate.fail',
        'release.prepare', 'release.changelog', 'release.commit',
        'release.tag', 'release.push', 'release.gates.run',
        'release.rollback',
        'manifest.append', 'manifest.archive',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Stage queries
  // -----------------------------------------------------------------------

  private async queryStage(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'validate': {
        const epicId = params?.epicId as string;
        const targetStage = params?.targetStage as string;
        if (!epicId || !targetStage) {
          return this.errorResponse('query', 'stage.validate', 'E_INVALID_INPUT',
            'epicId and targetStage are required', startTime);
        }
        const result = await lifecycleCheck(epicId, targetStage, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.validate', startTime);
      }

      case 'status': {
        const epicId = params?.epicId as string;
        if (!epicId) {
          return this.errorResponse('query', 'stage.status', 'E_INVALID_INPUT',
            'epicId is required', startTime);
        }
        const result = await lifecycleStatus(epicId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.status', startTime);
      }

      case 'history': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return this.errorResponse('query', 'stage.history', 'E_INVALID_INPUT',
            'taskId is required', startTime);
        }
        const result = await lifecycleHistory(taskId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.history', startTime);
      }

      case 'gates': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return this.errorResponse('query', 'stage.gates', 'E_INVALID_INPUT',
            'taskId is required', startTime);
        }
        const result = await lifecycleGates(taskId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.gates', startTime);
      }

      case 'prerequisites': {
        const targetStage = params?.targetStage as string;
        if (!targetStage) {
          return this.errorResponse('query', 'stage.prerequisites', 'E_INVALID_INPUT',
            'targetStage is required', startTime);
        }
        const result = await lifecyclePrerequisites(targetStage, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.prerequisites', startTime);
      }

      default:
        return this.errorResponse('query', `stage.${sub}`, 'E_INVALID_OPERATION',
          `Unknown stage query: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Stage mutations
  // -----------------------------------------------------------------------

  private async mutateStage(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'record': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const status = params?.status as string;
        const notes = params?.notes as string | undefined;
        if (!taskId || !stage || !status) {
          return this.errorResponse('mutate', 'stage.record', 'E_INVALID_INPUT',
            'taskId, stage, and status are required', startTime);
        }
        const result = await lifecycleProgress(taskId, stage, status, notes, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.record', startTime);
      }

      case 'skip': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return this.errorResponse('mutate', 'stage.skip', 'E_INVALID_INPUT',
            'taskId, stage, and reason are required', startTime);
        }
        const result = await lifecycleSkip(taskId, stage, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.skip', startTime);
      }

      case 'reset': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return this.errorResponse('mutate', 'stage.reset', 'E_INVALID_INPUT',
            'taskId, stage, and reason are required', startTime);
        }
        const result = await lifecycleReset(taskId, stage, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.reset', startTime);
      }

      case 'gate.pass': {
        const taskId = params?.taskId as string;
        const gateName = params?.gateName as string;
        const agent = params?.agent as string | undefined;
        const notes = params?.notes as string | undefined;
        if (!taskId || !gateName) {
          return this.errorResponse('mutate', 'stage.gate.pass', 'E_INVALID_INPUT',
            'taskId and gateName are required', startTime);
        }
        const result = await lifecycleGatePass(taskId, gateName, agent, notes, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.gate.pass', startTime);
      }

      case 'gate.fail': {
        const taskId = params?.taskId as string;
        const gateName = params?.gateName as string;
        const reason = params?.reason as string | undefined;
        if (!taskId || !gateName) {
          return this.errorResponse('mutate', 'stage.gate.fail', 'E_INVALID_INPUT',
            'taskId and gateName are required', startTime);
        }
        const result = await lifecycleGateFail(taskId, gateName, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.gate.fail', startTime);
      }

      default:
        return this.errorResponse('mutate', `stage.${sub}`, 'E_INVALID_OPERATION',
          `Unknown stage mutation: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Release mutations
  // -----------------------------------------------------------------------

  private async mutateRelease(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'prepare': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.prepare', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const tasks = params?.tasks as string[] | undefined;
        const notes = params?.notes as string | undefined;
        const result = await releasePrepare(version, tasks, notes, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.prepare', startTime);
      }

      case 'changelog': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.changelog', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const result = await releaseChangelog(version, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.changelog', startTime);
      }

      case 'commit': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.commit', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const result = await releaseCommit(version, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.commit', startTime);
      }

      case 'tag': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.tag', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const result = await releaseTag(version, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.tag', startTime);
      }

      case 'push': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.push', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const remote = params?.remote as string | undefined;
        const explicitPush = params?.explicitPush as boolean | undefined;
        const result = await releasePush(version, remote, this.projectRoot, { explicitPush: explicitPush ?? true });
        return this.wrapEngineResult(result, 'mutate', 'release.push', startTime);
      }

      case 'gates.run': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.gates.run', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const result = await releaseGatesRun(version, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.gates.run', startTime);
      }

      case 'rollback': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse('mutate', 'release.rollback', 'E_INVALID_INPUT',
            'version is required', startTime);
        }
        const reason = params?.reason as string | undefined;
        const result = await releaseRollback(version, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.rollback', startTime);
      }

      default:
        return this.errorResponse('mutate', `release.${sub}`, 'E_INVALID_OPERATION',
          `Unknown release mutation: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Manifest queries
  // -----------------------------------------------------------------------

  private queryManifest(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'show': {
        const entryId = params?.entryId as string;
        if (!entryId) {
          return this.errorResponse('query', 'manifest.show', 'E_INVALID_INPUT', 'entryId is required', startTime);
        }
        const result = pipelineManifestShow(entryId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'manifest.show', startTime);
      }
      case 'list': {
        const result = pipelineManifestList(
          (params ?? {}) as Parameters<typeof pipelineManifestList>[0],
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'manifest.list', startTime);
      }
      case 'find': {
        const query = params?.query as string;
        if (!query) {
          return this.errorResponse('query', 'manifest.find', 'E_INVALID_INPUT', 'query is required', startTime);
        }
        const result = pipelineManifestFind(
          query,
          { confidence: params?.confidence as number | undefined, limit: params?.limit as number | undefined },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'manifest.find', startTime);
      }
      case 'pending': {
        const result = pipelineManifestPending(params?.epicId as string | undefined, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'manifest.pending', startTime);
      }
      case 'stats': {
        const result = pipelineManifestStats(params?.epicId as string | undefined, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'manifest.stats', startTime);
      }
      default:
        return this.errorResponse('query', `manifest.${sub}`, 'E_INVALID_OPERATION',
          `Unknown manifest query: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Manifest mutations
  // -----------------------------------------------------------------------

  private mutateManifest(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'append': {
        const entry = params?.entry as Parameters<typeof pipelineManifestAppend>[0];
        if (!entry) {
          return this.errorResponse('mutate', 'manifest.append', 'E_INVALID_INPUT', 'entry is required', startTime);
        }
        const result = pipelineManifestAppend(entry, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'manifest.append', startTime);
      }
      case 'archive': {
        const beforeDate = params?.beforeDate as string;
        if (!beforeDate) {
          return this.errorResponse('mutate', 'manifest.archive', 'E_INVALID_INPUT', 'beforeDate is required (ISO-8601: YYYY-MM-DD)', startTime);
        }
        const result = pipelineManifestArchive(beforeDate, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'manifest.archive', startTime);
      }
      default:
        return this.errorResponse('mutate', `manifest.${sub}`, 'E_INVALID_OPERATION',
          `Unknown manifest mutation: ${sub}`, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; fix?: string; alternatives?: Array<{ action: string; command: string }> } },
    gateway: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    if (result.success) {
      return {
        _meta: dispatchMeta(gateway, 'pipeline', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: dispatchMeta(gateway, 'pipeline', operation, startTime),
      success: false,
      error: {
        code: result.error?.code || 'E_UNKNOWN',
        message: result.error?.message || 'Unknown error',
        fix: result.error?.fix,
        alternatives: result.error?.alternatives,
      },
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
      _meta: dispatchMeta(gateway, 'pipeline', operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(
    gateway: string,
    operation: string,
    error: unknown,
    startTime: number,
  ): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:pipeline').error({ gateway, domain: 'pipeline', operation, err: error }, message);
    return this.errorResponse(
      gateway, operation,
      'E_INTERNAL_ERROR',
      message,
      startTime,
    );
  }
}
