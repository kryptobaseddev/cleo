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
import { errorResult, getListParams, handleErrorResult, wrapResult } from './_base.js';
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
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'next': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateNext(epicId, this.projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'ready': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateReady(epicId, this.projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'analyze': {
          const epicId = params?.epicId as string;
          const mode = params?.mode as string | undefined;
          const result = await orchestrateAnalyze(epicId, this.projectRoot, mode);
          return wrapResult(result, 'query', 'orchestrate', 'analyze', startTime);
        }

        case 'context': {
          const epicId = params?.epicId as string | undefined;
          const result = await orchestrateContext(epicId, this.projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'waves': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'query',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateWaves(epicId, this.projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'bootstrap': {
          const speed = params?.speed as 'fast' | 'full' | 'complete' | undefined;
          const result = await orchestrateBootstrap(this.projectRoot, { speed });
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'unblock.opportunities': {
          const result = await orchestrateUnblockOpportunities(this.projectRoot);
          return wrapResult(result, 'query', 'orchestrate', operation, startTime);
        }

        case 'tessera.list': {
          const id = params?.id as string | undefined;
          if (id) {
            const template = showTessera(id);
            if (!template) {
              return errorResult(
                'query',
                'orchestrate',
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
          const { limit, offset } = getListParams(params);
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
          return errorResult(
            'query',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate query: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'query', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('query', 'orchestrate', operation, error, startTime);
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'start': {
          const epicId = params?.epicId as string;
          if (!epicId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const result = await orchestrateStartup(epicId, this.projectRoot);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'spawn': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const protocolType = params?.protocolType as string | undefined;
          const tier = params?.tier as 0 | 1 | 2 | undefined;
          const result = await orchestrateSpawn(taskId, protocolType, this.projectRoot, tier);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'handoff': {
          const taskId = params?.taskId as string;
          const protocolType = params?.protocolType as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          if (!protocolType) {
            return errorResult(
              'mutate',
              'orchestrate',
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
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'spawn.execute': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
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
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'validate': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await orchestrateValidate(taskId, this.projectRoot);
          return wrapResult(result, 'mutate', 'orchestrate', operation, startTime);
        }

        case 'parallel': {
          return routeByParam(params, 'action', {
            start: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = await orchestrateParallelStart(epicId, wave, this.projectRoot);
              return wrapResult(result, 'mutate', 'orchestrate', 'parallel', startTime);
            },
            end: async () => {
              const epicId = params?.epicId as string;
              const wave = params?.wave as number;
              if (!epicId) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'epicId is required',
                  startTime,
                );
              }
              if (wave === undefined || wave === null) {
                return errorResult(
                  'mutate',
                  'orchestrate',
                  'parallel',
                  'E_INVALID_INPUT',
                  'wave number is required',
                  startTime,
                );
              }
              const result = orchestrateParallelEnd(epicId, wave, this.projectRoot);
              return wrapResult(result, 'mutate', 'orchestrate', 'parallel', startTime);
            },
          });
        }

        case 'tessera.instantiate': {
          const templateId = params?.templateId as string;
          const epicId = params?.epicId as string;
          if (!templateId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'templateId is required',
              startTime,
            );
          }
          if (!epicId) {
            return errorResult(
              'mutate',
              'orchestrate',
              operation,
              'E_INVALID_INPUT',
              'epicId is required',
              startTime,
            );
          }
          const template = showTessera(templateId);
          if (!template) {
            return errorResult(
              'mutate',
              'orchestrate',
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
          return errorResult(
            'mutate',
            'orchestrate',
            operation,
            'E_INVALID_OPERATION',
            `Unknown orchestrate mutation: ${operation}`,
            startTime,
          );
      }
    } catch (error) {
      getLogger('domain:orchestrate').error(
        { gateway: 'mutate', domain: 'orchestrate', operation, err: error },
        error instanceof Error ? error.message : String(error),
      );
      return handleErrorResult('mutate', 'orchestrate', operation, error, startTime);
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
}
