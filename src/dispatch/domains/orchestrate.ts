/**
 * Orchestrate Domain Handler (Dispatch Layer)
 *
 * Handles multi-agent orchestration: dependency analysis, wave computation,
 * spawn readiness, parallel coordination, and orchestration context.
 * All operations delegate to native engine functions.
 *
 * @epic T4820
 */

import {
  instantiateTessera,
  listTesseraTemplates,
  showTessera,
} from '../../core/lifecycle/tessera-engine.js';
import { getLogger } from '../../core/logger.js';
import { paginate } from '../../core/pagination.js';
import { getProjectRoot } from '../../core/paths.js';
import {
  orchestrateAnalyze,
  orchestrateBootstrap,
  orchestrateContext,
  orchestrateHandoff,
  orchestrateNext,
  orchestrateParallelEnd,
  orchestrateParallelStart,
  orchestrateReady,
  orchestrateSpawn,
  orchestrateSpawnExecute,
  orchestrateStartup,
  orchestrateStatus,
  orchestrateUnblockOpportunities,
  orchestrateValidate,
  orchestrateWaves,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { routeByParam } from './_routing.js';

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

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
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
            return this.errorResponse(
              'query',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateNext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'ready': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse(
              'query',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateReady(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'analyze':
        case 'critical.path': {
          const epicId = params?.epicId as string;
          // critical.path is a backward-compat alias — routes through analyze with mode='critical-path'
          const mode =
            operation === 'critical.path' ? 'critical-path' : (params?.mode as string | undefined);
          const result = await orchestrateAnalyze(epicId, this.projectRoot, mode);
          return this.wrapEngineResult(result, 'query', 'analyze', startTime);
        }

        case 'context': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateContext(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', operation, startTime);
        }

        case 'waves': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse(
              'query',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
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

        case 'tessera.show':
        case 'tessera.list': {
          // tessera.show is a backward-compat alias — tessera.list with id param does single lookup
          const id = params?.id as string | undefined;
          if (id) {
            const template = showTessera(id);
            if (!template) {
              return this.errorResponse(
                'query',
                'tessera.list',
                'E_NOT_FOUND',
                `Tessera template "${id}" not found`,
                startTime,
              );
            }
            return {
              _meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
              success: true,
              data: template,
            };
          }
          const templates = listTesseraTemplates();
          const { limit, offset } = this.getListParams(params);
          const page = paginate(templates, limit, offset);
          return {
            _meta: dispatchMeta('query', 'orchestrate', 'tessera.list', startTime),
            success: true,
            data: {
              templates: page.items,
              count: templates.length,
              total: templates.length,
              filtered: templates.length,
            },
            page: page.page,
          };
        }

        default:
          return this.errorResponse(
            'query',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      return this.handleError('query', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateStartup(epicId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'spawn': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
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
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          if (!protocolType) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'protocolType is required',
              startTime,
            );
          }
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateHandoff(
            {
              taskId,
              protocolType,
              note: params?.note as string | undefined,
              nextAction: params?.nextAction as string | undefined,
              variant: params?.variant as string | undefined,
              tier,
              idempotencyKey: params?.idempotencyKey as string | undefined,
            },
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'spawn.execute': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const adapterId = params?.adapterId as string | undefined;
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawnExecute(
            taskId,
            adapterId,
            protocolType,
            this.projectRoot,
            tier,
          );
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'validate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await orchestrateValidate(taskId, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', operation, startTime);
        }

        case 'parallel':
        case 'parallel.start':
        case 'parallel.end': {
          // parallel.start and parallel.end are backward-compat aliases
          // Registry canonical: orchestrate.parallel with required 'action' param
          const aliasAction =
            operation === 'parallel.start'
              ? 'start'
              : operation === 'parallel.end'
                ? 'end'
                : undefined;
          const effectiveParams = aliasAction ? { ...params, action: aliasAction } : params;

          return routeByParam(effectiveParams, 'action', {
            start: async () => {
              const epicId = effectiveParams?.epicId as string;
              const wave = effectiveParams?.wave as number;
              if (!epicId) {
                return this.errorResponse(
                  'mutate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return this.errorResponse(
                  'mutate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = await orchestrateParallelStart(epicId, wave, this.projectRoot);
              return this.wrapEngineResult(result, 'mutate', 'parallel', startTime);
            },
            end: async () => {
              const epicId = effectiveParams?.epicId as string;
              const wave = effectiveParams?.wave as number;
              if (!epicId) {
                return this.errorResponse(
                  'mutate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return this.errorResponse(
                  'mutate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = orchestrateParallelEnd(epicId, wave, this.projectRoot);
              return this.wrapEngineResult(result, 'mutate', 'parallel', startTime);
            },
          });
        }

        case 'tessera.instantiate': {
          const templateId = params?.templateId as string;
          const epicId = params?.epicId as string;
          if (!templateId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'templateId is required',
              startTime,
            );
          }
          if (!epicId) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const template = showTessera(templateId);
          if (!template) {
            return this.errorResponse(
              'mutate',
              operation,
              'E_NOT_FOUND',
              `Tessera template "${templateId}" not found`,
              startTime,
            );
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
          return this.errorResponse(
            'mutate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      return this.handleError('mutate', operation, error, startTime);
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'status',
        'next',
        'ready',
        'analyze',
        'context',
        'waves',
        'bootstrap',
        'unblock.opportunities',
        'tessera.list',
      ],
      mutate: [
        'start',
        'spawn',
        'handoff',
        'spawn.execute',
        'validate',
        'parallel',
        'tessera.instantiate',
      ],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: {
      success: boolean;
      data?: unknown;
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
    getLogger('domain:orchestrate').error(
      { gateway, domain: 'orchestrate', operation, err: error },
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
