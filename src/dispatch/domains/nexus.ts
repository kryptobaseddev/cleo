/**
 * Nexus Domain Handler (Dispatch Layer)
 *
 * Placeholder handler for forward compatibility with BRAIN Network.
 * Currently implements 0 operations -- all requests return E_NOT_IMPLEMENTED.
 *
 * @epic T4820
 */

import type { DomainHandler, DispatchResponse } from '../types.js';
import { dispatchMeta } from './_meta.js';
import { getLogger } from '../../core/logger.js';

const logger = getLogger('domain:nexus');

// ---------------------------------------------------------------------------
// NexusHandler
// ---------------------------------------------------------------------------

export class NexusHandler implements DomainHandler {
  async query(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    logger.warn({ operation }, `Nexus domain not yet implemented: ${operation}`);
    return {
      _meta: dispatchMeta('query', 'nexus', operation, startTime),
      success: false,
      error: { code: 'E_NOT_IMPLEMENTED', message: `Nexus domain not yet implemented: ${operation}` },
    };
  }

  async mutate(operation: string, _params?: Record<string, unknown>): Promise<DispatchResponse> {
    const startTime = Date.now();
    logger.warn({ operation }, `Nexus domain not yet implemented: ${operation}`);
    return {
      _meta: dispatchMeta('mutate', 'nexus', operation, startTime),
      success: false,
      error: { code: 'E_NOT_IMPLEMENTED', message: `Nexus domain not yet implemented: ${operation}` },
    };
  }

  getSupportedOperations() {
    return { query: [] as string[], mutate: [] as string[] };
  }
}
