/**
 * Dispatch-local metadata factory.
 *
 * Generates LAFS-conformant metadata for dispatch layer responses.
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
 * @param source    - Where the request originated
 * @param requestId - Optional pre-generated request ID
 * @param sessionId - Optional session ID to include in metadata
 * @returns Metadata conforming to DispatchResponse['meta']
 *
 * @task T4772
 * @task T4959
 */
export function createDispatchMeta(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
  source: Source = 'cli',
  requestId?: string,
  sessionId?: string | null,
): DispatchResponse['meta'] {
  return {
    gateway: gateway as DispatchResponse['meta']['gateway'],
    domain,
    operation,
    timestamp: new Date().toISOString(),
    duration_ms: Date.now() - startTime,
    source,
    requestId: requestId ?? randomUUID(),
    ...(sessionId != null && { sessionId }),
  };
}
