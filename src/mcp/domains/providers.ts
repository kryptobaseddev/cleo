/**
 * Providers Domain Handler
 *
 * Implements provider operations via CAAMP adapter layer:
 * - Query (3): list, detect, inject.status
 * - Mutate (1): inject
 *
 * Uses caamp-adapter.ts for all CAAMP API calls.
 *
 * @task T4368
 */

import { DomainHandler, DomainResponse } from '../lib/router.js';
import { CLIExecutor } from '../lib/executor.js';
import { createGatewayMeta } from '../lib/gateway-meta.js';
import {
  providerList,
  providerDetect,
  injectionCheck,
  injectionUpdate,
} from '../engine/caamp-adapter.js';

/**
 * Build a response envelope.
 * @task T4368
 * @task T4655
 */
function buildResponse(
  domain: string,
  operation: string,
  result: { success: boolean; data?: unknown; error?: { code: string; message: string } },
): DomainResponse {
  const response: DomainResponse = {
    _meta: createGatewayMeta('cleo_query', domain, operation, Date.now()),
    success: result.success,
  };

  if (result.data) {
    response.data = result.data;
  }
  if (result.error) {
    response.error = {
      code: result.error.code,
      message: result.error.message,
    };
  }

  return response;
}

/**
 * Providers domain handler.
 * @task T4368
 */
export class ProvidersHandler implements DomainHandler {
  // executor reserved for future CLI-mode provider operations
  private executor: CLIExecutor;
  constructor(executor: CLIExecutor) {
    this.executor = executor;
    void this.executor; // reserved for future use
  }

  async query(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    switch (operation) {
      case 'list': {
        const result = providerList();
        return buildResponse('providers', 'list', result);
      }

      case 'detect': {
        const result = providerDetect();
        return buildResponse('providers', 'detect', result);
      }

      case 'inject.status': {
        const filePath = params?.filePath as string;
        if (!filePath) {
          return buildResponse('providers', 'inject.status', {
            success: false,
            error: { code: 'E_INVALID_INPUT', message: 'filePath is required' },
          });
        }
        const result = await injectionCheck(filePath, params?.expectedContent as string);
        return buildResponse('providers', 'inject.status', result);
      }

      default:
        return buildResponse('providers', operation, {
          success: false,
          error: {
            code: 'E_UNKNOWN_OPERATION',
            message: `Unknown providers query operation: ${operation}. Available: list, detect, inject.status`,
          },
        });
    }
  }

  async mutate(operation: string, params?: Record<string, unknown>): Promise<DomainResponse> {
    switch (operation) {
      case 'inject': {
        const filePath = params?.filePath as string;
        const content = params?.content as string;
        if (!filePath || !content) {
          return buildResponse('providers', 'inject', {
            success: false,
            error: { code: 'E_INVALID_INPUT', message: 'filePath and content are required' },
          });
        }
        const result = await injectionUpdate(filePath, content);
        return buildResponse('providers', 'inject', result);
      }

      default:
        return buildResponse('providers', operation, {
          success: false,
          error: {
            code: 'E_UNKNOWN_OPERATION',
            message: `Unknown providers mutate operation: ${operation}. Available: inject`,
          },
        });
    }
  }

  getSupportedOperations(): { query: string[]; mutate: string[] } {
    return {
      query: ['list', 'detect', 'inject.status'],
      mutate: ['inject'],
    };
  }
}
