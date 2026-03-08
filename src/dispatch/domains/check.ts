/**
 * Check Domain Handler (Dispatch Layer)
 *
 * Consolidates MCP validate domain operations into the canonical "check"
 * domain. Handles schema validation, protocol compliance, task validation,
 * manifest checks, output validation, compliance tracking, test operations,
 * and coherence checks.
 *
 * All operations delegate to native engine functions from validate-engine.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getProjectRoot } from '../../core/paths.js';
import { getLogger } from '../../core/logger.js';
import { paginate } from '../../core/pagination.js';

import {
  validateSchemaOp,
  validateTaskOp,
  validateProtocol,
  validateManifestOp,
  validateOutput,
  validateComplianceSummary,
  validateComplianceViolations,
  validateComplianceRecord,
  validateTestStatus,
  validateTestCoverage,
  validateCoherenceCheck,
  validateTestRun,
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolSpecification,
  validateGateVerify,
  systemArchiveStats,
} from '../lib/engine.js';

import { validateChain } from '../../core/validation/chain-validation.js';
import type { WarpChain } from '../../types/warp-chain.js';

// ---------------------------------------------------------------------------
// CheckHandler
// ---------------------------------------------------------------------------

export class CheckHandler implements DomainHandler {
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
        case 'schema': {
          const type = params?.type as string;
          if (!type) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'type is required', startTime);
          }
          const result = validateSchemaOp(type, params?.data, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'task': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await validateTaskOp(taskId, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'manifest': {
          const result = validateManifestOp(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'output': {
          const filePath = params?.filePath as string;
          if (!filePath) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'filePath is required', startTime);
          }
          const result = validateOutput(filePath, params?.taskId as string | undefined, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'compliance.summary': {
          const detail = params?.detail as boolean | undefined;
          const limit = params?.limit as number | undefined;

          if (detail) {
            const result = validateComplianceViolations(limit, this.projectRoot);
            return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
          }

          const result = validateComplianceSummary(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'test': {
          const format = params?.format as string | undefined; // 'status' (default) or 'coverage'

          if (format === 'coverage') {
            const result = validateTestCoverage(this.projectRoot);
            return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
          }

          // Default to status
          const result = validateTestStatus(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'coherence': {
          const result = await validateCoherenceCheck(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'protocol': {
          const protocolType = params?.protocolType as string | undefined;
          const mode = (params?.mode as 'task' | 'manifest') ?? 'task';

          // Common protocol parameters
          const protocolParams = {
            mode,
            taskId: params?.taskId as string | undefined,
            manifestFile: params?.manifestFile as string | undefined,
            strict: params?.strict as boolean | undefined,
          };

          // Dispatch to specific protocol validators
          switch (protocolType) {
            case 'consensus': {
              const result = await validateProtocolConsensus({
                ...protocolParams,
                votingMatrixFile: params?.votingMatrixFile as string | undefined,
              }, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
            case 'contribution': {
              const result = await validateProtocolContribution(protocolParams, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
            case 'decomposition': {
              const result = await validateProtocolDecomposition({
                ...protocolParams,
                epicId: params?.epicId as string | undefined,
              }, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
            case 'implementation': {
              const result = await validateProtocolImplementation(protocolParams, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
            case 'specification': {
              const result = await validateProtocolSpecification({
                ...protocolParams,
                specFile: params?.specFile as string | undefined,
              }, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
            default: {
              // Generic protocol validation (legacy behavior)
              const taskId = params?.taskId as string;
              if (!taskId) {
                return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'taskId is required for generic protocol check', startTime);
              }
              const result = await validateProtocol(taskId, protocolType, this.projectRoot);
              return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
            }
          }
        }

        case 'gate.status': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          // Read-only access
          const result = await validateGateVerify({ taskId }, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'archive.stats': {
          const result = await systemArchiveStats(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        // T5405: WarpChain validation
        case 'chain.validate': {
          const chain = params?.chain as WarpChain;
          if (!chain) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'chain is required', startTime);
          }
          const chainResult = validateChain(chain);
          return this.wrapEngineResult(
            { success: chainResult.errors.length === 0, data: chainResult },
            'query', 'check', operation, startTime,
          );
        }

        // T5615: grade ops moved from admin to check
        case 'grade': {
          const { gradeSession } = await import('../../core/sessions/session-grade.js');
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'sessionId required', startTime);
          }
          const gradeResult = await gradeSession(sessionId, this.projectRoot);
          return this.wrapEngineResult({ success: true, data: gradeResult }, 'query', 'check', operation, startTime);
        }

        case 'grade.list': {
          const { readGrades } = await import('../../core/sessions/session-grade.js');
          const limit = typeof params?.limit === 'number' ? params.limit : undefined;
          const offset = typeof params?.offset === 'number' ? params.offset : undefined;
          const allGrades = await readGrades(undefined, this.projectRoot);
          const sessionId = params?.sessionId as string | undefined;
          const filteredGrades = sessionId
            ? allGrades.filter((g) => g.sessionId === sessionId)
            : allGrades;
          const page = paginate(filteredGrades, limit, offset);
          return {
            _meta: dispatchMeta('query', 'check', operation, startTime),
            success: true,
            data: {
              grades: page.items,
              total: allGrades.length,
              filtered: filteredGrades.length,
            },
            page: page.page,
          };
        }

        default:
          return this.unsupported('query', 'check', operation, startTime);
      }
    } catch (error) {
      return this.handleError('query', 'check', operation, error, startTime);
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
        case 'compliance.record': {
          const taskId = params?.taskId as string;
          const result = params?.result as string;
          if (!taskId || !result) {
            return this.errorResponse('mutate', 'check', operation, 'E_INVALID_INPUT', 'taskId and result are required', startTime);
          }
          const engineResult = validateComplianceRecord(
            taskId,
            result,
            params?.protocol as string | undefined,
            params?.violations as Array<{ code: string; message: string; severity: string }> | undefined,
            this.projectRoot,
          );
          return this.wrapEngineResult(engineResult, 'mutate', 'check', operation, startTime);
        }

        case 'test.run': {
          const result = validateTestRun(
            params as { scope?: string; pattern?: string; parallel?: boolean } | undefined,
            this.projectRoot,
          );
          return this.wrapEngineResult(result, 'mutate', 'check', operation, startTime);
        }

        case 'gate.set': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('mutate', 'check', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const gateParams = {
            taskId,
            gate: params?.gate as string | undefined,
            value: params?.value as boolean | undefined,
            agent: params?.agent as string | undefined,
            all: params?.all as boolean | undefined,
            reset: params?.reset as boolean | undefined,
          };
          const result = await validateGateVerify(gateParams, this.projectRoot);
          return this.wrapEngineResult(result, 'mutate', 'check', operation, startTime);
        }

        default:
          return this.unsupported('mutate', 'check', operation, startTime);
      }
    } catch (error) {
      return this.handleError('mutate', 'check', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'schema', 'protocol', 'task', 'manifest', 'output',
        'compliance.summary', 'test', 'coherence',
        'gate.status',
        'archive.stats',
        'grade', 'grade.list',
        'chain.validate',
      ],
      mutate: ['compliance.record', 'test.run', 'gate.set'],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown; fix?: string; alternatives?: Array<{ action: string; command: string }> } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? {
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.details as Record<string, unknown> | undefined,
          fix: result.error.fix,
          alternatives: result.error.alternatives,
        }
      } : {}),
    };
  }

  private unsupported(gateway: string, domain: string, operation: string, startTime: number): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INVALID_OPERATION', message: `Unknown ${domain} ${gateway}: ${operation}` },
    };
  }

  private errorResponse(
    gateway: string,
    domain: string,
    operation: string,
    code: string,
    message: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code, message },
    };
  }

  private handleError(gateway: string, domain: string, operation: string, error: unknown, startTime: number): DispatchResponse {
    const message = error instanceof Error ? error.message : String(error);
    getLogger('domain:check').error({ gateway, domain, operation, err: error }, message);
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
