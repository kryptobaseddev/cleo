/**
 * Check Domain Handler (Dispatch Layer)
 *
 * Consolidates validate domain operations into the canonical "check"
 * domain. Handles schema validation, protocol compliance, task validation,
 * manifest checks, output validation, compliance tracking, test operations,
 * and coherence checks.
 *
 * All operations delegate to native engine functions from validate-engine.
 *
 * @epic T4820
 */

import type { WarpChain } from '@cleocode/contracts';
import {
  getLogger,
  getProjectRoot,
  getWorkflowComplianceReport,
  paginate,
  validateChain,
} from '@cleocode/core/internal';

import {
  systemArchiveStats,
  validateCoherenceCheck,
  validateComplianceRecord,
  validateComplianceSummary,
  validateComplianceViolations,
  validateGateVerify,
  validateManifestOp,
  validateOutput,
  validateProtocol,
  validateProtocolConsensus,
  validateProtocolContribution,
  validateProtocolDecomposition,
  validateProtocolImplementation,
  validateProtocolSpecification,
  validateSchemaOp,
  validateTaskOp,
  validateTestCoverage,
  validateTestRun,
  validateTestStatus,
} from '../lib/engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { errorResult, handleErrorResult, unsupportedOp, wrapResult } from './_base.js';
import { dispatchMeta } from './_meta.js';

// ---------------------------------------------------------------------------
// CheckHandler
// ---------------------------------------------------------------------------

export class CheckHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'schema': {
          const type = params?.type as string;
          if (!type) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'type is required',
              startTime,
            );
          }
          const result = validateSchemaOp(type, params?.data, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'task': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const result = await validateTaskOp(taskId, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'manifest': {
          const result = validateManifestOp(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'output': {
          const filePath = params?.filePath as string;
          if (!filePath) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'filePath is required',
              startTime,
            );
          }
          const result = validateOutput(
            filePath,
            params?.taskId as string | undefined,
            projectRoot,
          );
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'compliance.summary': {
          const detail = params?.detail as boolean | undefined;
          const limit = params?.limit as number | undefined;

          if (detail) {
            const result = validateComplianceViolations(limit, projectRoot);
            return wrapResult(result, 'query', 'check', operation, startTime);
          }

          const result = validateComplianceSummary(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'test': {
          const format = params?.format as string | undefined; // 'status' (default) or 'coverage'

          if (format === 'coverage') {
            const result = validateTestCoverage(projectRoot);
            return wrapResult(result, 'query', 'check', operation, startTime);
          }

          // Default to status
          const result = validateTestStatus(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'coherence': {
          const result = await validateCoherenceCheck(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
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
              const result = await validateProtocolConsensus(
                {
                  ...protocolParams,
                  votingMatrixFile: params?.votingMatrixFile as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'contribution': {
              const result = await validateProtocolContribution(protocolParams, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'decomposition': {
              const result = await validateProtocolDecomposition(
                {
                  ...protocolParams,
                  epicId: params?.epicId as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'implementation': {
              const result = await validateProtocolImplementation(protocolParams, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            case 'specification': {
              const result = await validateProtocolSpecification(
                {
                  ...protocolParams,
                  specFile: params?.specFile as string | undefined,
                },
                projectRoot,
              );
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
            default: {
              // Generic protocol validation (legacy behavior)
              const taskId = params?.taskId as string;
              if (!taskId) {
                return errorResult(
                  'query',
                  'check',
                  operation,
                  'E_INVALID_INPUT',
                  'taskId is required for generic protocol check',
                  startTime,
                );
              }
              const result = await validateProtocol(taskId, protocolType, projectRoot);
              return wrapResult(result, 'query', 'check', operation, startTime);
            }
          }
        }

        case 'gate.status': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          // Read-only access
          const result = await validateGateVerify({ taskId }, projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        case 'archive.stats': {
          const result = await systemArchiveStats(projectRoot);
          return wrapResult(result, 'query', 'check', operation, startTime);
        }

        // T5405: WarpChain validation
        case 'chain.validate': {
          const chain = params?.chain as WarpChain;
          if (!chain) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'chain is required',
              startTime,
            );
          }
          const chainResult = validateChain(chain);
          return wrapResult(
            { success: chainResult.errors.length === 0, data: chainResult },
            'query',
            'check',
            operation,
            startTime,
          );
        }

        // T5615: grade ops moved from admin to check
        case 'grade': {
          const { gradeSession } = await import('@cleocode/core/internal');
          const sessionId = params?.sessionId as string;
          if (!sessionId) {
            return errorResult(
              'query',
              'check',
              operation,
              'E_INVALID_INPUT',
              'sessionId required',
              startTime,
            );
          }
          const gradeResult = await gradeSession(sessionId, projectRoot);
          return wrapResult(
            { success: true, data: gradeResult },
            'query',
            'check',
            operation,
            startTime,
          );
        }

        case 'grade.list': {
          const { readGrades } = await import('@cleocode/core/internal');
          const limit = typeof params?.limit === 'number' ? params.limit : undefined;
          const offset = typeof params?.offset === 'number' ? params.offset : undefined;
          const allGrades = await readGrades(undefined, projectRoot);
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

        // T065: Workflow compliance telemetry — WF-001 through WF-005
        case 'workflow.compliance': {
          const since = params?.since as string | undefined;
          const result = await getWorkflowComplianceReport({
            since,
            cwd: projectRoot,
          });
          return {
            _meta: dispatchMeta('query', 'check', operation, startTime),
            success: true,
            data: result,
          };
        }

        default:
          return unsupportedOp('query', 'check', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'query', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('query', 'check', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const projectRoot = getProjectRoot();
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'compliance.record': {
          const taskId = params?.taskId as string;
          const result = params?.result as string;
          if (!taskId || !result) {
            return errorResult(
              'mutate',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId and result are required',
              startTime,
            );
          }
          const engineResult = validateComplianceRecord(
            taskId,
            result,
            params?.protocol as string | undefined,
            params?.violations as
              | Array<{ code: string; message: string; severity: 'error' | 'warning' }>
              | undefined,
            projectRoot,
          );
          return wrapResult(engineResult, 'mutate', 'check', operation, startTime);
        }

        case 'test.run': {
          const result = validateTestRun(
            params as { scope?: string; pattern?: string; parallel?: boolean } | undefined,
            projectRoot,
          );
          return wrapResult(result, 'mutate', 'check', operation, startTime);
        }

        case 'compliance.sync': {
          const { syncComplianceMetrics } = await import('@cleocode/core/internal');
          const result = await syncComplianceMetrics({
            force: params?.force as boolean | undefined,
            cwd: projectRoot,
          });
          return {
            _meta: dispatchMeta('mutate', 'check', operation, startTime),
            success: (result.success as boolean) ?? true,
            data: result,
          };
        }

        case 'gate.set': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return errorResult(
              'mutate',
              'check',
              operation,
              'E_INVALID_INPUT',
              'taskId is required',
              startTime,
            );
          }
          const gateParams = {
            taskId,
            gate: params?.gate as string | undefined,
            value: params?.value as boolean | undefined,
            agent: params?.agent as string | undefined,
            all: params?.all as boolean | undefined,
            reset: params?.reset as boolean | undefined,
          };
          const result = await validateGateVerify(gateParams, projectRoot);
          return wrapResult(result, 'mutate', 'check', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'check', operation, startTime);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getLogger('domain:check').error(
        { gateway: 'mutate', domain: 'check', operation, err: error },
        message,
      );
      return handleErrorResult('mutate', 'check', operation, error, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Supported operations
  // -----------------------------------------------------------------------

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: [
        'schema',
        'protocol',
        'task',
        'manifest',
        'output',
        'compliance.summary',
        'workflow.compliance',
        'test',
        'coherence',
        'gate.status',
        'archive.stats',
        'grade',
        'grade.list',
        'chain.validate',
      ],
      mutate: ['compliance.record', 'compliance.sync', 'test.run', 'gate.set'],
    };
  }
}
