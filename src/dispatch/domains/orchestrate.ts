/**
 * Orchestrate Domain Handler (Dispatch Layer)
 *
 * Handles multi-agent orchestration: dependency analysis, wave computation,
 * spawn readiness, parallel coordination, and orchestration context.
 * All operations delegate to native engine functions.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';

import {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
  orchestrateBootstrap,
  orchestrateUnblockOpportunities,
  orchestrateCriticalPath,
  orchestrateStartup,
  orchestrateSpawn,
  orchestrateHandoff,
  orchestrateSpawnExecute,
  orchestrateValidate,
  orchestrateParallelStart,
  orchestrateParallelEnd,
  orchestrateCheck,
} from '../lib/engine.js';

import {
  showTessera,
  listTesseraTemplates,
  instantiateTessera,
} from '../../core/lifecycle/tessera-engine.js';
import { showChain } from '../../core/lifecycle/chain-store.js';
import type { WarpChain } from '../../types/warp-chain.js';

// ---------------------------------------------------------------------------
// OrchestrateHandler
// ---------------------------------------------------------------------------

export class OrchestrateHandler implements DomainHandler {
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
      switch (operation) {
        case 'status': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateStatus(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'next': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateNext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'ready': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateReady(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'analyze': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateAnalyze(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'context': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateContext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'waves': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateWaves(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'bootstrap': {
          const speed = params?.speed as 'fast' | 'full' | 'complete' | undefined;
          const result = await orchestrateBootstrap(this.projectRoot, { speed });
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'unblock.opportunities': {
          const result = await orchestrateUnblockOpportunities(this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'critical.path': {
          const result = await orchestrateCriticalPath(this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'tessera.show': {
          const id = params?.id as string;
          if (!id) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'id is required', startTime);
          }
          const template = showTessera(id);
          if (!template) {
            return this.errorResponse('query', operation, 'E_NOT_FOUND',
              `Tessera template "${id}" not found`, startTime);
          }
          return {
            _meta: dispatchMeta('query', 'orchestrate', operation, startTime),
            success: true,
            data: template,
          };
        }

        case 'tessera.list': {
          const templates = listTesseraTemplates();
          return {
            _meta: dispatchMeta('query', 'orchestrate', operation, startTime),
            success: true,
            data: { templates, count: templates.length },
          };
        }

        case 'chain.plan': {
          const chainId = params?.chainId as string;
          if (!chainId) {
            return this.errorResponse('query', operation, 'E_INVALID_INPUT',
              'chainId is required', startTime);
          }

          const chain = await showChain(chainId, this.projectRoot);
          if (!chain) {
            return this.errorResponse('query', operation, 'E_NOT_FOUND',
              `Chain "${chainId}" not found`, startTime);
          }

          return {
            _meta: dispatchMeta('query', 'orchestrate', operation, startTime),
            success: true,
            data: this.buildChainPlan(chain),
          };
        }

        default:
          return this.errorResponse('query', operation, 'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`, startTime);
      }
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
      switch (operation) {
        case 'start': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const result = await orchestrateStartup(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'spawn': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawn(taskId, protocolType, this.projectRoot, tier);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'handoff': {
          const taskId = params?.taskId as string;
          const protocolType = params?.protocolType as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          if (!protocolType) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'protocolType is required', startTime);
          }
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateHandoff({
            taskId,
            protocolType,
            note: params?.note as string | undefined,
            nextAction: params?.nextAction as string | undefined,
            variant: params?.variant as string | undefined,
            tier,
            idempotencyKey: params?.idempotencyKey as string | undefined,
          }, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'spawn.execute': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          const adapterId = params?.adapterId as string | undefined;
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawnExecute(taskId, adapterId, protocolType, this.projectRoot, tier);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'validate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'taskId is required', startTime);
          }
          const result = await orchestrateValidate(taskId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'parallel.start': {
          const epicId = params?.epicId as string;
          const wave = params?.wave as number;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          if (wave === undefined || wave === null) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'wave number is required', startTime);
          }
          const result = await orchestrateParallelStart(epicId, wave, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'parallel.end': {
          const epicId = params?.epicId as string;
          const wave = params?.wave as number;
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          if (wave === undefined || wave === null) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'wave number is required', startTime);
          }
          const result = orchestrateParallelEnd(epicId, wave, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'verify': {
          const result = await orchestrateCheck(this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'tessera.instantiate': {
          const templateId = params?.templateId as string;
          const epicId = params?.epicId as string;
          if (!templateId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'templateId is required', startTime);
          }
          if (!epicId) {
            return this.errorResponse('mutate', operation, 'E_INVALID_INPUT',
              'epicId is required', startTime);
          }
          const template = showTessera(templateId);
          if (!template) {
            return this.errorResponse('mutate', operation, 'E_NOT_FOUND',
              `Tessera template "${templateId}" not found`, startTime);
          }
          const variables = (params?.variables as Record<string, unknown>) ?? {};
          const instance = await instantiateTessera(
            template,
            { templateId, epicId, variables: { epicId, ...variables } },
            this.projectRoot,
          );
          return {
            _meta: dispatchMeta('mutate', 'orchestrate', operation, startTime),
            success: true,
            data: instance,
          };
        }

        default:
          return this.errorResponse('mutate', operation, 'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status', 'next', 'ready', 'analyze', 'context',
        'waves', 'bootstrap', 'unblock.opportunities', 'critical.path',
        'tessera.show', 'tessera.list', 'chain.plan',
      ],
      mutate: [
        'start', 'spawn', 'handoff', 'spawn.execute', 'validate',
        'parallel.start', 'parallel.end', 'verify',
        'tessera.instantiate',
      ],
    };
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
        _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
        success: true,
        data: result.data,
      };
    }
    return {
      _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
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
      _meta: dispatchMeta(gateway, 'orchestrate', operation, startTime),
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
    getLogger('domain:orchestrate').error({ gateway, domain: 'orchestrate', operation, err: error }, message);
    return this.errorResponse(
      gateway, operation,
      'E_INTERNAL_ERROR',
      message,
      startTime,
    );
  }

  private buildChainPlan(chain: WarpChain): {
    chainId: string;
    entryPoint: string;
    exitPoints: string[];
    waves: Array<{ wave: number; stageIds: string[] }>;
    totalStages: number;
    totalGates: number;
  } {
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const stage of chain.shape.stages) {
      indegree.set(stage.id, 0);
      adjacency.set(stage.id, []);
    }

    for (const link of chain.shape.links) {
      const edges = adjacency.get(link.from);
      if (edges) {
        edges.push(link.to);
      }
      indegree.set(link.to, (indegree.get(link.to) ?? 0) + 1);
    }

    const queue = Array.from(indegree.entries())
      .filter(([, count]) => count === 0)
      .map(([stageId]) => stageId);
    const waves: Array<{ wave: number; stageIds: string[] }> = [];
    const remainingInDegree = new Map(indegree);
    let waveNumber = 1;

    while (queue.length > 0) {
      const currentWave = [...queue];
      queue.length = 0;

      waves.push({ wave: waveNumber, stageIds: currentWave });
      waveNumber += 1;

      for (const stageId of currentWave) {
        for (const to of adjacency.get(stageId) ?? []) {
          const next = (remainingInDegree.get(to) ?? 0) - 1;
          remainingInDegree.set(to, next);
          if (next === 0) {
            queue.push(to);
          }
        }
      }
    }

    return {
      chainId: chain.id,
      entryPoint: chain.shape.entryPoint,
      exitPoints: chain.shape.exitPoints,
      waves,
      totalStages: chain.shape.stages.length,
      totalGates: chain.gates.length,
    };
  }
}
