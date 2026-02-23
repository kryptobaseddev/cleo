/**
 * Pipeline Domain Handler (Dispatch Layer)
 *
 * Consolidates legacy lifecycle and release domains into a single "pipeline"
 * domain with dot-prefixed operation names. All operations delegate to
 * native engine functions.
 *
 * Sub-domains:
 *   stage.*   - RCSD-IVTR lifecycle stage management
 *   release.* - Release lifecycle (prepare, changelog, commit, tag, push)
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
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
        return this.queryStage(operation.slice('stage.'.length), params, startTime);
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
        return this.mutateStage(operation.slice('stage.'.length), params, startTime);
      }

      // Release sub-domain
      if (operation.startsWith('release.')) {
        return this.mutateRelease(operation.slice('release.'.length), params, startTime);
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
      ],
      mutate: [
        'stage.record', 'stage.skip', 'stage.reset',
        'stage.gate.pass', 'stage.gate.fail',
        'release.prepare', 'release.changelog', 'release.commit',
        'release.tag', 'release.push', 'release.gates.run',
        'release.rollback',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Stage queries
  // -----------------------------------------------------------------------

  private queryStage(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
    switch (sub) {
      case 'validate': {
        const epicId = params?.epicId as string;
        const targetStage = params?.targetStage as string;
        if (!epicId || !targetStage) {
          return this.errorResponse('query', 'stage.validate', 'E_INVALID_INPUT',
            'epicId and targetStage are required', startTime);
        }
        const result = lifecycleCheck(epicId, targetStage, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.validate', startTime);
      }

      case 'status': {
        const epicId = params?.epicId as string;
        if (!epicId) {
          return this.errorResponse('query', 'stage.status', 'E_INVALID_INPUT',
            'epicId is required', startTime);
        }
        const result = lifecycleStatus(epicId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.status', startTime);
      }

      case 'history': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return this.errorResponse('query', 'stage.history', 'E_INVALID_INPUT',
            'taskId is required', startTime);
        }
        const result = lifecycleHistory(taskId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.history', startTime);
      }

      case 'gates': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return this.errorResponse('query', 'stage.gates', 'E_INVALID_INPUT',
            'taskId is required', startTime);
        }
        const result = lifecycleGates(taskId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.gates', startTime);
      }

      case 'prerequisites': {
        const targetStage = params?.targetStage as string;
        if (!targetStage) {
          return this.errorResponse('query', 'stage.prerequisites', 'E_INVALID_INPUT',
            'targetStage is required', startTime);
        }
        const result = lifecyclePrerequisites(targetStage, this.projectRoot);
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

  private mutateStage(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): DispatchResponse {
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
        const result = lifecycleProgress(taskId, stage, status, notes, this.projectRoot);
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
        const result = lifecycleSkip(taskId, stage, reason, this.projectRoot);
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
        const result = lifecycleReset(taskId, stage, reason, this.projectRoot);
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
        const result = lifecycleGatePass(taskId, gateName, agent, notes, this.projectRoot);
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
        const result = lifecycleGateFail(taskId, gateName, reason, this.projectRoot);
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
        const result = await releasePush(version, remote, this.projectRoot);
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
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
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
    return this.errorResponse(
      gateway, operation,
      'E_INTERNAL_ERROR',
      error instanceof Error ? error.message : String(error),
      startTime,
    );
  }
}
