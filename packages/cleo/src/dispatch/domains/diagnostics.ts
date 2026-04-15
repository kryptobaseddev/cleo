/**
 * Diagnostics Domain Handler (Dispatch Layer)
 *
 * Handles operations for `cleo diagnostics`:
 *   query:  status
 *   mutate: enable, disable, analyze, export
 *
 * @task T624
 */

import {
  diagnosticsAnalyze,
  diagnosticsDisable,
  diagnosticsEnable,
  diagnosticsExport,
  diagnosticsStatus,
} from '../engines/diagnostics-engine.js';
import type { DispatchResponse, DomainHandler } from '../types.js';
import { handleErrorResult, unsupportedOp, wrapResult } from './_base.js';

// ---------------------------------------------------------------------------
// DiagnosticsHandler
// ---------------------------------------------------------------------------

export class DiagnosticsHandler implements DomainHandler {
  // -----------------------------------------------------------------------
  // Query
  // -----------------------------------------------------------------------

  async query(operation: string, params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'status': {
          const result = await diagnosticsStatus();
          return wrapResult(result, 'query', 'diagnostics', operation, startTime);
        }

        case 'analyze': {
          const days = typeof params?.days === 'number' ? params.days : 30;
          const pushToBrain = params?.noBrain !== true;
          const result = await diagnosticsAnalyze(days, pushToBrain);
          return wrapResult(result, 'query', 'diagnostics', operation, startTime);
        }

        case 'export': {
          const days = typeof params?.days === 'number' ? params.days : undefined;
          const result = await diagnosticsExport(days);
          return wrapResult(result, 'query', 'diagnostics', operation, startTime);
        }

        default:
          return unsupportedOp('query', 'diagnostics', operation, startTime);
      }
    } catch (err: unknown) {
      return handleErrorResult('query', 'diagnostics', operation, err, startTime);
    }
  }

  // -----------------------------------------------------------------------
  // Mutate
  // -----------------------------------------------------------------------

  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();

    try {
      switch (operation) {
        case 'enable': {
          const result = await diagnosticsEnable();
          return wrapResult(result, 'mutate', 'diagnostics', operation, startTime);
        }

        case 'disable': {
          const result = await diagnosticsDisable();
          return wrapResult(result, 'mutate', 'diagnostics', operation, startTime);
        }

        default:
          return unsupportedOp('mutate', 'diagnostics', operation, startTime);
      }
    } catch (err: unknown) {
      return handleErrorResult('mutate', 'diagnostics', operation, err, startTime);
    }
  }

  /** Declared operations for introspection and validation. */
  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['status', 'analyze', 'export'],
      mutate: ['enable', 'disable'],
    };
  }
}
