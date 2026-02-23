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
} from '../lib/engine.js';

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

        case 'protocol': {
          const taskId = params?.taskId as string;
          if (!taskId) {
            return this.errorResponse('query', 'check', operation, 'E_INVALID_INPUT', 'taskId is required', startTime);
          }
          const result = await validateProtocol(taskId, params?.protocolType as string | undefined, this.projectRoot);
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
          const result = validateComplianceSummary(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'compliance.violations': {
          const result = validateComplianceViolations(params?.limit as number | undefined, this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'test.status': {
          const result = validateTestStatus(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'test.coverage': {
          const result = validateTestCoverage(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
        }

        case 'coherence.check': {
          const result = await validateCoherenceCheck(this.projectRoot);
          return this.wrapEngineResult(result, 'query', 'check', operation, startTime);
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
        'compliance.summary', 'compliance.violations',
        'test.status', 'test.coverage', 'coherence.check',
      ],
      mutate: ['compliance.record', 'test.run'],
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private wrapEngineResult(
    result: { success: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } },
    gateway: string,
    domain: string,
    operation: string,
    startTime: number,
  ): DispatchResponse {
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: result.success,
      ...(result.success ? { data: result.data } : {}),
      ...(result.error ? { error: { code: result.error.code, message: result.error.message, details: result.error.details as Record<string, unknown> | undefined } } : {}),
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
    return {
      _meta: dispatchMeta(gateway, domain, operation, startTime),
      success: false,
      error: { code: 'E_INTERNAL', message },
    };
  }
}
