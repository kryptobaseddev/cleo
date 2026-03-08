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

import { execFileSync } from 'node:child_process';
import {
  addChain,
  advanceInstance,
  createInstance,
  listChains,
  showChain,
} from '../../core/lifecycle/chain-store.js';
import { getLogger } from '../../core/logger.js';
import { paginate } from '../../core/pagination.js';
import { getProjectRoot } from '../../core/paths.js';
import type { ListPhasesResult } from '../../core/phases/index.js';
import {
  channelToDistTag,
  describeChannel,
  resolveChannelFromBranch,
} from '../../core/release/channel.js';
import type { ReleaseListOptions } from '../../core/release/release-manifest.js';
import type { GateResult, WarpChain } from '../../types/warp-chain.js';
import {
  lifecycleCheck,
  lifecycleGateFail,
  lifecycleGatePass,
  lifecycleHistory,
  lifecycleProgress,
  lifecycleReset,
  lifecycleSkip,
  lifecycleStatus,
  phaseAdvance,
  phaseComplete,
  phaseDelete,
  // Phase operations
  phaseList,
  phaseRename,
  phaseSet,
  phaseShow,
  phaseStart,
  pipelineManifestAppend,
  pipelineManifestArchive,
  pipelineManifestFind,
  pipelineManifestList,
  // Manifest operations
  pipelineManifestShow,
  pipelineManifestStats,
  releaseCancel,
  releaseList,
  // Release operations
  releaseRollback,
  releaseShip,
  releaseShow,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      // Stage sub-domain
      if (operation.startsWith('stage.')) {
        return await this.queryStage(operation.slice('stage.'.length), params, startTime);
      }

      // Manifest sub-domain
      if (operation.startsWith('manifest.')) {
        return await this.queryManifest(operation.slice('manifest.'.length), params, startTime);
      }

      // Phase sub-domain
      if (operation.startsWith('phase.')) {
        return this.queryPhase(operation.slice('phase.'.length), params, startTime);
      }

      // Release sub-domain (read-only ops: list, show)
      if (operation.startsWith('release.')) {
        return await this.queryRelease(operation.slice('release.'.length), params, startTime);
      }

      // Chain sub-domain (T5405)
      if (operation.startsWith('chain.')) {
        return await this.queryChain(operation.slice('chain.'.length), params, startTime);
      }

      return this.errorResponse(
        'query',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline query: ${operation}`,
        startTime,
      );
    } catch (error) {
      return this.handleError('query', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
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
        return await this.mutateManifest(operation.slice('manifest.'.length), params, startTime);
      }

      // Phase sub-domain
      if (operation.startsWith('phase.')) {
        return this.mutatePhase(operation.slice('phase.'.length), params, startTime);
      }

      // Chain sub-domain (T5405)
      if (operation.startsWith('chain.')) {
        return await this.mutateChain(operation.slice('chain.'.length), params, startTime);
      }

      return this.errorResponse(
        'mutate',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline mutation: ${operation}`,
        startTime,
      );
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'stage.validate',
        'stage.status',
        'stage.history',
        'manifest.show',
        'manifest.list',
        'manifest.find',
        'manifest.stats',
        'release.list',
        'release.show',
        'release.channel.show',
        'phase.show',
        'phase.list',
        'chain.show',
        'chain.list',
      ],
      mutate: [
        'stage.record',
        'stage.skip',
        'stage.reset',
        'stage.gate.pass',
        'stage.gate.fail',
        'release.ship',
        'release.cancel',
        'release.rollback',
        'manifest.append',
        'manifest.archive',
        'phase.set',
        'phase.advance',
        'phase.rename',
        'phase.delete',
        'chain.add',
        'chain.instantiate',
        'chain.advance',
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
          return this.errorResponse(
            'query',
            'stage.validate',
            'E_INVALID_INPUT',
            'epicId and targetStage are required',
            startTime,
          );
        }
        const result = await lifecycleCheck(epicId, targetStage, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.validate', startTime);
      }

      case 'status': {
        const epicId = params?.epicId as string;
        if (!epicId) {
          return this.errorResponse(
            'query',
            'stage.status',
            'E_INVALID_INPUT',
            'epicId is required',
            startTime,
          );
        }
        const result = await lifecycleStatus(epicId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.status', startTime);
      }

      case 'history': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return this.errorResponse(
            'query',
            'stage.history',
            'E_INVALID_INPUT',
            'taskId is required',
            startTime,
          );
        }
        const result = await lifecycleHistory(taskId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'stage.history', startTime);
      }

      default:
        return this.errorResponse(
          'query',
          `stage.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown stage query: ${sub}`,
          startTime,
        );
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
          return this.errorResponse(
            'mutate',
            'stage.record',
            'E_INVALID_INPUT',
            'taskId, stage, and status are required',
            startTime,
          );
        }
        const result = await lifecycleProgress(taskId, stage, status, notes, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.record', startTime);
      }

      case 'skip': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return this.errorResponse(
            'mutate',
            'stage.skip',
            'E_INVALID_INPUT',
            'taskId, stage, and reason are required',
            startTime,
          );
        }
        const result = await lifecycleSkip(taskId, stage, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.skip', startTime);
      }

      case 'reset': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return this.errorResponse(
            'mutate',
            'stage.reset',
            'E_INVALID_INPUT',
            'taskId, stage, and reason are required',
            startTime,
          );
        }
        const result = await lifecycleReset(taskId, stage, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'stage.reset', startTime);
      }

      // Merged: stage.gate routes by action param (pass/fail)
      // Backward-compat aliases: stage.gate.pass, stage.gate.fail
      case 'gate':
      case 'gate.pass':
      case 'gate.fail': {
        const taskId = params?.taskId as string;
        const gateName = params?.gateName as string;
        if (!taskId || !gateName) {
          return this.errorResponse(
            'mutate',
            `stage.${sub}`,
            'E_INVALID_INPUT',
            'taskId and gateName are required',
            startTime,
          );
        }
        // If using backward-compat alias, derive action from sub name
        const effectiveParams =
          sub === 'gate' ? params : { ...params, action: sub === 'gate.pass' ? 'pass' : 'fail' };
        return routeByParam<Promise<DispatchResponse>>(effectiveParams, 'action', {
          pass: async () => {
            const result = await lifecycleGatePass(
              taskId,
              gateName,
              params?.agent as string | undefined,
              params?.notes as string | undefined,
              this.projectRoot,
            );
            return this.wrapEngineResult(result, 'mutate', 'stage.gate', startTime);
          },
          fail: async () => {
            const result = await lifecycleGateFail(
              taskId,
              gateName,
              params?.reason as string | undefined,
              this.projectRoot,
            );
            return this.wrapEngineResult(result, 'mutate', 'stage.gate', startTime);
          },
        });
      }

      default:
        return this.errorResponse(
          'mutate',
          `stage.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown stage mutation: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Release queries (read-only)
  // -----------------------------------------------------------------------

  private async queryRelease(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'list': {
        const result = await releaseList(
          {
            status: params?.status as ReleaseListOptions['status'],
            limit: params?.limit as number | undefined,
            offset: params?.offset as number | undefined,
          },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'release.list', startTime);
      }

      case 'show': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse(
            'query',
            'release.show',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const result = await releaseShow(version, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'release.show', startTime);
      }

      case 'channel.show': {
        let currentBranch = 'unknown';
        try {
          currentBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
            encoding: 'utf-8',
            stdio: 'pipe',
            cwd: this.projectRoot,
          }).trim();
        } catch {
          // git not available or not a git repo — leave as 'unknown'
        }

        const resolvedChannel = resolveChannelFromBranch(currentBranch);
        const distTag = channelToDistTag(resolvedChannel);
        const description = describeChannel(resolvedChannel);

        return this.wrapEngineResult(
          {
            success: true,
            data: {
              branch: currentBranch,
              channel: resolvedChannel,
              distTag,
              description,
            },
          },
          'query',
          'release.channel.show',
          startTime,
        );
      }

      default:
        return this.errorResponse(
          'query',
          `release.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown release query: ${sub}`,
          startTime,
        );
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
      // Release operations consolidated in T5615:
      // prepare/changelog/commit/tag/push/gates.run merged into release.ship

      case 'rollback': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse(
            'mutate',
            'release.rollback',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const reason = params?.reason as string | undefined;
        const result = await releaseRollback(version, reason, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.rollback', startTime);
      }

      case 'cancel': {
        const version = params?.version as string;
        if (!version) {
          return this.errorResponse(
            'mutate',
            'release.cancel',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const result = await releaseCancel(version, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'release.cancel', startTime);
      }

      case 'ship': {
        const version = params?.version as string;
        const epicId = params?.epicId as string;
        if (!version || !epicId) {
          return this.errorResponse(
            'mutate',
            'release.ship',
            'E_INVALID_INPUT',
            'version and epicId are required',
            startTime,
          );
        }
        const remote = params?.remote as string | undefined;
        const dryRun = params?.dryRun as boolean | undefined;
        const bump = params?.bump as boolean | undefined;
        const result = await releaseShip(
          { version, epicId, remote, dryRun, bump },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'mutate', 'release.ship', startTime);
      }

      default:
        return this.errorResponse(
          'mutate',
          `release.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown release mutation: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Manifest queries
  // -----------------------------------------------------------------------

  private async queryManifest(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'show': {
        const entryId = params?.entryId as string;
        if (!entryId) {
          return this.errorResponse(
            'query',
            'manifest.show',
            'E_INVALID_INPUT',
            'entryId is required',
            startTime,
          );
        }
        const result = await pipelineManifestShow(entryId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'manifest.show', startTime);
      }
      case 'list': {
        const result = await pipelineManifestList(
          (params ?? {}) as Parameters<typeof pipelineManifestList>[0],
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'manifest.list', startTime);
      }
      case 'find': {
        const query = params?.query as string;
        if (!query) {
          return this.errorResponse(
            'query',
            'manifest.find',
            'E_INVALID_INPUT',
            'query is required',
            startTime,
          );
        }
        const result = await pipelineManifestFind(
          query,
          {
            confidence: params?.confidence as number | undefined,
            limit: params?.limit as number | undefined,
          },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'manifest.find', startTime);
      }
      case 'stats': {
        const result = await pipelineManifestStats(
          params?.epicId as string | undefined,
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'query', 'manifest.stats', startTime);
      }
      default:
        return this.errorResponse(
          'query',
          `manifest.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown manifest query: ${sub}`,
          startTime,
        );
    }
  }

  private async queryPhase(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'show': {
        const phaseId = params?.phaseId as string | undefined;
        const result = await phaseShow(phaseId, this.projectRoot);
        return this.wrapEngineResult(result, 'query', 'phase.show', startTime);
      }

      case 'list': {
        const result = await phaseList(this.projectRoot);
        if (!result.success || !result.data) {
          return this.wrapEngineResult(result, 'query', 'phase.list', startTime);
        }

        const listData = result.data as ListPhasesResult;
        const { limit, offset } = this.getListParams(params);
        const page = paginate(listData.phases, limit, offset);

        return {
          _meta: dispatchMeta('query', 'pipeline', 'phase.list', startTime),
          success: true,
          data: {
            ...listData,
            phases: page.items,
            total: listData.summary.total,
            filtered: listData.summary.total,
          },
          page: page.page,
        };
      }

      default:
        return this.errorResponse(
          'query',
          `phase.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown phase query: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Manifest mutations
  // -----------------------------------------------------------------------

  private async mutateManifest(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'append': {
        const entry = params?.entry as Parameters<typeof pipelineManifestAppend>[0];
        if (!entry) {
          return this.errorResponse(
            'mutate',
            'manifest.append',
            'E_INVALID_INPUT',
            'entry is required',
            startTime,
          );
        }
        const result = await pipelineManifestAppend(entry, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'manifest.append', startTime);
      }
      case 'archive': {
        const beforeDate = params?.beforeDate as string;
        if (!beforeDate) {
          return this.errorResponse(
            'mutate',
            'manifest.archive',
            'E_INVALID_INPUT',
            'beforeDate is required (ISO-8601: YYYY-MM-DD)',
            startTime,
          );
        }
        const result = await pipelineManifestArchive(beforeDate, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'manifest.archive', startTime);
      }
      default:
        return this.errorResponse(
          'mutate',
          `manifest.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown manifest mutation: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Phase mutations (T5326)
  // -----------------------------------------------------------------------

  private async mutatePhase(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      // Merged: phase.set absorbs phase.start/phase.complete via action param (T5615)
      // Backward-compat aliases: phase.start, phase.complete
      case 'set':
      case 'start':
      case 'complete': {
        const phaseId = params?.phaseId as string;
        if (!phaseId) {
          return this.errorResponse(
            'mutate',
            `phase.${sub}`,
            'E_INVALID_INPUT',
            'phaseId is required',
            startTime,
          );
        }
        // Derive action from sub name for backward-compat aliases
        const effectiveAction = sub === 'set' ? (params?.action as string | undefined) : sub; // 'start' or 'complete'
        if (effectiveAction === 'start') {
          const result = await phaseStart(phaseId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'phase.set', startTime);
        }
        if (effectiveAction === 'complete') {
          const result = await phaseComplete(phaseId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'phase.set', startTime);
        }
        // Default: phase.set behavior
        const result = await phaseSet(
          {
            phaseId,
            rollback: params?.rollback as boolean | undefined,
            force: params?.force as boolean | undefined,
            dryRun: params?.dryRun as boolean | undefined,
          },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'mutate', 'phase.set', startTime);
      }

      case 'advance': {
        const force = params?.force as boolean | undefined;
        const result = await phaseAdvance(force, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'phase.advance', startTime);
      }

      case 'rename': {
        const oldName = params?.oldName as string;
        const newName = params?.newName as string;
        if (!oldName || !newName) {
          return this.errorResponse(
            'mutate',
            'phase.rename',
            'E_INVALID_INPUT',
            'oldName and newName are required',
            startTime,
          );
        }
        const result = await phaseRename(oldName, newName, this.projectRoot);
        return this.wrapEngineResult(result, 'mutate', 'phase.rename', startTime);
      }

      case 'delete': {
        const phaseId = params?.phaseId as string;
        if (!phaseId) {
          return this.errorResponse(
            'mutate',
            'phase.delete',
            'E_INVALID_INPUT',
            'phaseId is required',
            startTime,
          );
        }
        const result = await phaseDelete(
          phaseId,
          {
            reassignTo: params?.reassignTo as string | undefined,
            force: params?.force as boolean | undefined,
          },
          this.projectRoot,
        );
        return this.wrapEngineResult(result, 'mutate', 'phase.delete', startTime);
      }

      default:
        return this.errorResponse(
          'mutate',
          `phase.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown phase mutation: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Chain queries (T5405)
  // -----------------------------------------------------------------------

  private async queryChain(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'show': {
        const chainId = params?.chainId as string;
        if (!chainId) {
          return this.errorResponse(
            'query',
            'chain.show',
            'E_INVALID_INPUT',
            'chainId is required',
            startTime,
          );
        }
        const chain = await showChain(chainId, this.projectRoot);
        if (!chain) {
          return this.errorResponse(
            'query',
            'chain.show',
            'E_NOT_FOUND',
            `Chain "${chainId}" not found`,
            startTime,
          );
        }
        return this.wrapEngineResult(
          { success: true, data: chain },
          'query',
          'chain.show',
          startTime,
        );
      }

      case 'list': {
        const chains = await listChains(this.projectRoot);
        const { limit, offset } = this.getListParams(params);
        const page = paginate(chains, limit, offset);
        return this.wrapEngineResult(
          {
            success: true,
            data: {
              chains: page.items,
              total: chains.length,
              filtered: chains.length,
            },
            page: page.page,
          },
          'query',
          'chain.list',
          startTime,
        );
      }

      default:
        return this.errorResponse(
          'query',
          `chain.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown chain query: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Chain mutations (T5405)
  // -----------------------------------------------------------------------

  private async mutateChain(
    sub: string,
    params: Record<string, unknown> | undefined,
    startTime: number,
  ): Promise<DispatchResponse> {
    switch (sub) {
      case 'add': {
        const chain = params?.chain as WarpChain;
        if (!chain) {
          return this.errorResponse(
            'mutate',
            'chain.add',
            'E_INVALID_INPUT',
            'chain is required',
            startTime,
          );
        }
        await addChain(chain, this.projectRoot);
        return this.wrapEngineResult(
          { success: true, data: { id: chain.id } },
          'mutate',
          'chain.add',
          startTime,
        );
      }

      case 'instantiate': {
        const chainId = params?.chainId as string;
        const epicId = params?.epicId as string;
        if (!chainId || !epicId) {
          return this.errorResponse(
            'mutate',
            'chain.instantiate',
            'E_INVALID_INPUT',
            'chainId and epicId are required',
            startTime,
          );
        }
        let instance: Awaited<ReturnType<typeof createInstance>>;
        try {
          instance = await createInstance(
            {
              chainId,
              epicId,
              variables: params?.variables as Record<string, unknown> | undefined,
              stageToTask: params?.stageToTask as Record<string, string> | undefined,
            },
            this.projectRoot,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            message.includes(`Chain "${chainId}" not found`) ||
            message.includes('FOREIGN KEY constraint failed') ||
            message.includes('SQLITE_CONSTRAINT_FOREIGNKEY')
          ) {
            return this.errorResponse(
              'mutate',
              'chain.instantiate',
              'E_NOT_FOUND',
              `Chain "${chainId}" not found`,
              startTime,
            );
          }
          throw error;
        }
        return this.wrapEngineResult(
          { success: true, data: instance },
          'mutate',
          'chain.instantiate',
          startTime,
        );
      }

      case 'advance': {
        const instanceId = params?.instanceId as string;
        const nextStage = params?.nextStage as string;
        if (!instanceId || !nextStage) {
          return this.errorResponse(
            'mutate',
            'chain.advance',
            'E_INVALID_INPUT',
            'instanceId and nextStage are required',
            startTime,
          );
        }
        const gateResults = (params?.gateResults ?? []) as GateResult[];
        const updated = await advanceInstance(instanceId, nextStage, gateResults, this.projectRoot);
        return this.wrapEngineResult(
          { success: true, data: updated },
          'mutate',
          'chain.advance',
          startTime,
        );
      }

      default:
        return this.errorResponse(
          'mutate',
          `chain.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown chain mutation: ${sub}`,
          startTime,
        );
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: {
      success: boolean;
      data?: unknown;
      page?: import('@cleocode/lafs-protocol').LAFSPage;
      error?: {
        code: string;
        message: string;
        details?: unknown;
        fix?: string;
        alternatives?: Array<{ action: string; command: string }>;
      };
    },
    gateway: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    if (result.success) {
      return {
        _meta: dispatchMeta(gateway, 'pipeline', operation, startTime),
        success: true,
        data: result.data,
        ...(result.page ? { page: result.page } : {}),
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
    getLogger('domain:pipeline').error(
      { gateway, domain: 'pipeline', operation, err: error },
      message,
    );
    return this.errorResponse(gateway, operation, 'E_INTERNAL_ERROR', message, startTime);
  }

  private getListParams(params?: Record<string, unknown>): { limit?: number; offset?: number } {
    return {
      limit: typeof params?.limit === 'number' ? params.limit : undefined,
      offset: typeof params?.offset === 'number' ? params.offset : undefined,
    };
  }
}
