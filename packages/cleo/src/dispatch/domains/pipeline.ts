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
import type { GateResult, WarpChain } from '@cleocode/contracts';
import {
  addChain,
  advanceInstance,
  buildStageGuidance,
  channelToDistTag,
  createInstance,
  describeChannel,
  formatStageGuidance,
  getLogger,
  getProjectRoot,
  isValidStage,
  type ListPhasesResult,
  listChains,
  paginate,
  type ReleaseListOptions,
  resolveChannelFromBranch,
  type Stage,
  showChain,
} from '@cleocode/core/internal';
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
import { errorResult, getListParams, handleErrorResult, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// PipelineHandler
// ---------------------------------------------------------------------------

export class PipelineHandler implements DomainHandler {
  private get projectRoot(): string {
    return getProjectRoot();
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

      return errorResult(
        'query',
        'pipeline',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline query: ${operation}`,
        startTime,
      );
    } catch (error) {
      getLogger('domain:pipeline').error(
        { gateway: 'query', domain: 'pipeline', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'pipeline', operation, error, startTime);
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

      return errorResult(
        'mutate',
        'pipeline',
        operation,
        'E_INVALID_OPERATION',
        `Unknown pipeline mutation: ${operation}`,
        startTime,
      );
    } catch (error) {
      getLogger('domain:pipeline').error(
        { gateway: 'mutate', domain: 'pipeline', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'pipeline', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'stage.validate',
        'stage.status',
        'stage.history',
        'stage.guidance',
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
          return errorResult(
            'query',
            'pipeline',
            'stage.validate',
            'E_INVALID_INPUT',
            'epicId and targetStage are required',
            startTime,
          );
        }
        const result = await lifecycleCheck(epicId, targetStage, this.projectRoot);
        return wrapResult(result, 'query', 'pipeline', 'stage.validate', startTime);
      }

      case 'status': {
        const epicId = params?.epicId as string;
        if (!epicId) {
          return errorResult(
            'query',
            'pipeline',
            'stage.status',
            'E_INVALID_INPUT',
            'epicId is required',
            startTime,
          );
        }
        const result = await lifecycleStatus(epicId, this.projectRoot);
        return wrapResult(result, 'query', 'pipeline', 'stage.status', startTime);
      }

      case 'history': {
        const taskId = params?.taskId as string;
        if (!taskId) {
          return errorResult(
            'query',
            'pipeline',
            'stage.history',
            'E_INVALID_INPUT',
            'taskId is required',
            startTime,
          );
        }
        const result = await lifecycleHistory(taskId, this.projectRoot);
        return wrapResult(result, 'query', 'pipeline', 'stage.history', startTime);
      }

      case 'guidance': {
        // Phase 2 + Phase 4: stage-aware prompt guidance sourced from real
        // SKILL.md files (ct-cleo, ct-orchestrator + stage-specific skill).
        // Resolves stage from: (a) explicit stage param, or
        // (b) epicId → lifecycleStatus → active stage.
        let stage = params?.stage as string | undefined;
        const epicId = params?.epicId as string | undefined;
        const format = (params?.format as string | undefined) ?? 'markdown';

        if (!stage && epicId) {
          const statusResult = await lifecycleStatus(epicId, this.projectRoot);
          if (statusResult.success) {
            const data = statusResult.data as
              | { currentStage?: string; activeStage?: string }
              | undefined;
            stage = data?.currentStage ?? data?.activeStage;
          }
        }

        if (!stage) {
          return errorResult(
            'query',
            'pipeline',
            'stage.guidance',
            'E_INVALID_INPUT',
            'Either stage or epicId (with an active pipeline stage) is required',
            startTime,
          );
        }

        if (!isValidStage(stage)) {
          return errorResult(
            'query',
            'pipeline',
            'stage.guidance',
            'E_INVALID_INPUT',
            `Unknown stage: ${stage}`,
            startTime,
          );
        }

        const guidance = buildStageGuidance(stage as Stage, this.projectRoot);
        const data =
          format === 'json'
            ? { stage: guidance.stage, guidance }
            : {
                stage: guidance.stage,
                name: guidance.name,
                order: guidance.order,
                primarySkill: guidance.primarySkill,
                loadedSkills: guidance.loadedSkills,
                requiredGates: guidance.requiredGates,
                expectedArtifacts: guidance.expectedArtifacts,
                source: guidance.source,
                prompt: formatStageGuidance(guidance),
              };

        return wrapResult(
          { success: true, data },
          'query',
          'pipeline',
          'stage.guidance',
          startTime,
        );
      }

      default:
        return errorResult(
          'query',
          'pipeline',
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
          return errorResult(
            'mutate',
            'pipeline',
            'stage.record',
            'E_INVALID_INPUT',
            'taskId, stage, and status are required',
            startTime,
          );
        }
        const result = await lifecycleProgress(taskId, stage, status, notes, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'stage.record', startTime);
      }

      case 'skip': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return errorResult(
            'mutate',
            'pipeline',
            'stage.skip',
            'E_INVALID_INPUT',
            'taskId, stage, and reason are required',
            startTime,
          );
        }
        const result = await lifecycleSkip(taskId, stage, reason, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'stage.skip', startTime);
      }

      case 'reset': {
        const taskId = params?.taskId as string;
        const stage = params?.stage as string;
        const reason = params?.reason as string;
        if (!taskId || !stage || !reason) {
          return errorResult(
            'mutate',
            'pipeline',
            'stage.reset',
            'E_INVALID_INPUT',
            'taskId, stage, and reason are required',
            startTime,
          );
        }
        const result = await lifecycleReset(taskId, stage, reason, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'stage.reset', startTime);
      }

      case 'gate.pass': {
        const taskId = params?.taskId as string;
        const gateName = params?.gateName as string;
        if (!taskId || !gateName) {
          return errorResult(
            'mutate',
            'pipeline',
            'stage.gate.pass',
            'E_INVALID_INPUT',
            'taskId and gateName are required',
            startTime,
          );
        }
        const result = await lifecycleGatePass(
          taskId,
          gateName,
          params?.agent as string | undefined,
          params?.notes as string | undefined,
          this.projectRoot,
        );
        return wrapResult(result, 'mutate', 'pipeline', 'stage.gate.pass', startTime);
      }

      case 'gate.fail': {
        const taskId = params?.taskId as string;
        const gateName = params?.gateName as string;
        if (!taskId || !gateName) {
          return errorResult(
            'mutate',
            'pipeline',
            'stage.gate.fail',
            'E_INVALID_INPUT',
            'taskId and gateName are required',
            startTime,
          );
        }
        const result = await lifecycleGateFail(
          taskId,
          gateName,
          params?.reason as string | undefined,
          this.projectRoot,
        );
        return wrapResult(result, 'mutate', 'pipeline', 'stage.gate.fail', startTime);
      }

      default:
        return errorResult(
          'mutate',
          'pipeline',
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
        return wrapResult(result, 'query', 'pipeline', 'release.list', startTime);
      }

      case 'show': {
        const version = params?.version as string;
        if (!version) {
          return errorResult(
            'query',
            'pipeline',
            'release.show',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const result = await releaseShow(version, this.projectRoot);
        return wrapResult(result, 'query', 'pipeline', 'release.show', startTime);
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

        return wrapResult(
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
          'pipeline',
          'release.channel.show',
          startTime,
        );
      }

      default:
        return errorResult(
          'query',
          'pipeline',
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
          return errorResult(
            'mutate',
            'pipeline',
            'release.rollback',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const reason = params?.reason as string | undefined;
        const result = await releaseRollback(version, reason, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'release.rollback', startTime);
      }

      case 'cancel': {
        const version = params?.version as string;
        if (!version) {
          return errorResult(
            'mutate',
            'pipeline',
            'release.cancel',
            'E_INVALID_INPUT',
            'version is required',
            startTime,
          );
        }
        const result = await releaseCancel(version, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'release.cancel', startTime);
      }

      case 'ship': {
        const version = params?.version as string;
        const epicId = params?.epicId as string;
        if (!version || !epicId) {
          return errorResult(
            'mutate',
            'pipeline',
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
        return wrapResult(result, 'mutate', 'pipeline', 'release.ship', startTime);
      }

      default:
        return errorResult(
          'mutate',
          'pipeline',
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
          return errorResult(
            'query',
            'pipeline',
            'manifest.show',
            'E_INVALID_INPUT',
            'entryId is required',
            startTime,
          );
        }
        const result = await pipelineManifestShow(entryId, this.projectRoot);
        return wrapResult(result, 'query', 'pipeline', 'manifest.show', startTime);
      }
      case 'list': {
        const result = await pipelineManifestList(
          (params ?? {}) as Parameters<typeof pipelineManifestList>[0],
          this.projectRoot,
        );
        return wrapResult(result, 'query', 'pipeline', 'manifest.list', startTime);
      }
      case 'find': {
        const query = params?.query as string;
        if (!query) {
          return errorResult(
            'query',
            'pipeline',
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
        return wrapResult(result, 'query', 'pipeline', 'manifest.find', startTime);
      }
      case 'stats': {
        const result = await pipelineManifestStats(
          params?.epicId as string | undefined,
          this.projectRoot,
        );
        return wrapResult(result, 'query', 'pipeline', 'manifest.stats', startTime);
      }
      default:
        return errorResult(
          'query',
          'pipeline',
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
        return wrapResult(result, 'query', 'pipeline', 'phase.show', startTime);
      }

      case 'list': {
        const result = await phaseList(this.projectRoot);
        if (!result.success || !result.data) {
          return wrapResult(result, 'query', 'pipeline', 'phase.list', startTime);
        }

        const listData = result.data as ListPhasesResult;
        const phases = listData.phases ?? [];
        const total = listData.summary?.total ?? phases.length;
        const { limit, offset } = getListParams(params);
        const page = paginate(phases, limit, offset);

        return {
          _meta: dispatchMeta('query', 'pipeline', 'phase.list', startTime),
          success: true,
          data: {
            ...listData,
            phases: page.items,
            total,
            filtered: total,
          },
          page: page.page,
        };
      }

      default:
        return errorResult(
          'query',
          'pipeline',
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
          return errorResult(
            'mutate',
            'pipeline',
            'manifest.append',
            'E_INVALID_INPUT',
            'entry is required',
            startTime,
          );
        }
        const result = await pipelineManifestAppend(entry, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'manifest.append', startTime);
      }
      case 'archive': {
        const beforeDate = params?.beforeDate as string;
        if (!beforeDate) {
          return errorResult(
            'mutate',
            'pipeline',
            'manifest.archive',
            'E_INVALID_INPUT',
            'beforeDate is required (ISO-8601: YYYY-MM-DD)',
            startTime,
          );
        }
        const result = await pipelineManifestArchive(beforeDate, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'manifest.archive', startTime);
      }
      default:
        return errorResult(
          'mutate',
          'pipeline',
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
      case 'set': {
        const phaseId = params?.phaseId as string;
        if (!phaseId) {
          return errorResult(
            'mutate',
            'pipeline',
            'phase.set',
            'E_INVALID_INPUT',
            'phaseId is required',
            startTime,
          );
        }
        const action = params?.action as string | undefined;
        if (action === 'start') {
          const result = await phaseStart(phaseId, this.projectRoot);
          return wrapResult(result, 'mutate', 'pipeline', 'phase.set', startTime);
        }
        if (action === 'complete') {
          const result = await phaseComplete(phaseId, this.projectRoot);
          return wrapResult(result, 'mutate', 'pipeline', 'phase.set', startTime);
        }
        const result = await phaseSet(
          {
            phaseId,
            rollback: params?.rollback as boolean | undefined,
            force: params?.force as boolean | undefined,
            dryRun: params?.dryRun as boolean | undefined,
          },
          this.projectRoot,
        );
        return wrapResult(result, 'mutate', 'pipeline', 'phase.set', startTime);
      }

      case 'advance': {
        const force = params?.force as boolean | undefined;
        const result = await phaseAdvance(force, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'phase.advance', startTime);
      }

      case 'rename': {
        const oldName = params?.oldName as string;
        const newName = params?.newName as string;
        if (!oldName || !newName) {
          return errorResult(
            'mutate',
            'pipeline',
            'phase.rename',
            'E_INVALID_INPUT',
            'oldName and newName are required',
            startTime,
          );
        }
        const result = await phaseRename(oldName, newName, this.projectRoot);
        return wrapResult(result, 'mutate', 'pipeline', 'phase.rename', startTime);
      }

      case 'delete': {
        const phaseId = params?.phaseId as string;
        if (!phaseId) {
          return errorResult(
            'mutate',
            'pipeline',
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
        return wrapResult(result, 'mutate', 'pipeline', 'phase.delete', startTime);
      }

      default:
        return errorResult(
          'mutate',
          'pipeline',
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
          return errorResult(
            'query',
            'pipeline',
            'chain.show',
            'E_INVALID_INPUT',
            'chainId is required',
            startTime,
          );
        }
        const chain = await showChain(chainId, this.projectRoot);
        if (!chain) {
          return errorResult(
            'query',
            'pipeline',
            'chain.show',
            'E_NOT_FOUND',
            `Chain "${chainId}" not found`,
            startTime,
          );
        }
        return wrapResult(
          { success: true, data: chain },
          'query',
          'pipeline',
          'chain.show',
          startTime,
        );
      }

      case 'list': {
        const chains = await listChains(this.projectRoot);
        const { limit, offset } = getListParams(params);
        const page = paginate(chains, limit, offset);
        return wrapResult(
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
          'pipeline',
          'chain.list',
          startTime,
        );
      }

      default:
        return errorResult(
          'query',
          'pipeline',
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
          return errorResult(
            'mutate',
            'pipeline',
            'chain.add',
            'E_INVALID_INPUT',
            'chain is required',
            startTime,
          );
        }
        await addChain(chain, this.projectRoot);
        return wrapResult(
          { success: true, data: { id: chain.id } },
          'mutate',
          'pipeline',
          'chain.add',
          startTime,
        );
      }

      case 'instantiate': {
        const chainId = params?.chainId as string;
        const epicId = params?.epicId as string;
        if (!chainId || !epicId) {
          return errorResult(
            'mutate',
            'pipeline',
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
            return errorResult(
              'mutate',
              'pipeline',
              'chain.instantiate',
              'E_NOT_FOUND',
              `Chain "${chainId}" not found`,
              startTime,
            );
          }
          throw error;
        }
        return wrapResult(
          { success: true, data: instance },
          'mutate',
          'pipeline',
          'chain.instantiate',
          startTime,
        );
      }

      case 'advance': {
        const instanceId = params?.instanceId as string;
        const nextStage = params?.nextStage as string;
        if (!instanceId || !nextStage) {
          return errorResult(
            'mutate',
            'pipeline',
            'chain.advance',
            'E_INVALID_INPUT',
            'instanceId and nextStage are required',
            startTime,
          );
        }
        const gateResults = (params?.gateResults ?? []) as GateResult[];
        const updated = await advanceInstance(instanceId, nextStage, gateResults, this.projectRoot);
        return wrapResult(
          { success: true, data: updated },
          'mutate',
          'pipeline',
          'chain.advance',
          startTime,
        );
      }

      default:
        return errorResult(
          'mutate',
          'pipeline',
          `chain.${sub}`,
          'E_INVALID_OPERATION',
          `Unknown chain mutation: ${sub}`,
          startTime,
        );
    }
  }
}
