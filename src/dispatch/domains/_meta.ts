/**
 * Convenience wrapper for dispatch metadata creation.
 *
 * Domain handlers call dispatchMeta() to build DispatchResponse['_meta']
 * without importing the factory directly.
 *
 * @task T4772
 */

import { createDispatchMeta } from '../lib/meta.js';
import type { DispatchResponse, Source } from '../types.js';

/**
 * Build metadata for a dispatch domain response.
 *
 * @param gateway   - Gateway name (e.g., 'query', 'mutate')
 * @param domain    - Domain name (e.g., 'tasks', 'session')
 * @param operation - Operation name (e.g., 'show', 'list')
 * @param startTime - Timestamp from Date.now() at start of request
 * @param source    - Where the request originated ('cli' or 'mcp')
 * @returns Metadata conforming to DispatchResponse['_meta']
 *
 * @task T4772
 */
export function dispatchMeta(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
  source: Source = 'mcp',
): DispatchResponse['_meta'] {
  return createDispatchMeta(gateway, domain, operation, startTime, source);
}
