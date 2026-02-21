/**
 * Dispatch-local metadata factory.
 *
 * Replaces the import of createGatewayMeta from MCP lib.
 * Generates LAFS-conformant metadata for dispatch responses.
 *
 * @task T4772
 */

import { randomUUID } from 'node:crypto';
import type { DispatchResponse, Source } from '../types.js';

/**
 * Create metadata for a dispatch response.
 *
 * @param gateway   - Gateway name (e.g., 'query', 'mutate')
 * @param domain    - Domain name (e.g., 'tasks', 'session')
 * @param operation - Operation name (e.g., 'show', 'list')
 * @param startTime - Timestamp from Date.now() at start of request
 * @param source    - Where the request originated ('cli' or 'mcp')
 * @param requestId - Optional pre-generated request ID
 * @returns Metadata conforming to DispatchResponse['_meta']
 *
 * @task T4772
 */
export function createDispatchMeta(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
  source: Source = 'mcp',
  requestId?: string,
): DispatchResponse['_meta'] {
  return {
    gateway: gateway as DispatchResponse['_meta']['gateway'],
    domain,
    operation,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    source,
    requestId: requestId ?? randomUUID(),
  };
}
