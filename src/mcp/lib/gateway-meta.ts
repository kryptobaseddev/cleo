/**
 * Gateway metadata factory for MCP domain handlers.
 *
 * Creates LAFS-conformant GatewayMeta objects with all required fields,
 * replacing the inline _meta construction previously duplicated across
 * every domain handler.
 *
 * @epic T4654
 * @task T4655
 */

import { randomUUID } from 'node:crypto';

/**
 * The shape returned by createGatewayMeta. Includes both LAFS canonical
 * fields and CLEO gateway extensions, with an index signature for
 * DomainResponse._meta compatibility.
 *
 * @task T4655
 */
export interface GatewayMetaRecord {
  specVersion: string;
  schemaVersion: string;
  timestamp: string;
  operation: string;
  requestId: string;
  transport: string;
  strict: boolean;
  mvi: string;
  contextVersion: number;
  gateway: string;
  domain: string;
  duration_ms: number;
  [key: string]: unknown;
}

/**
 * Create a fully typed GatewayMeta for MCP domain responses.
 *
 * @param gateway - Gateway name (e.g., 'cleo_query', 'cleo_mutate')
 * @param domain - Domain name (e.g., 'tasks', 'session')
 * @param operation - Operation name (e.g., 'show', 'list')
 * @param startTime - Timestamp from Date.now() at start of request
 * @returns GatewayMeta with all LAFS and CLEO-specific fields
 *
 * @task T4655
 */
export function createGatewayMeta(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): GatewayMetaRecord {
  return {
    // LAFS canonical fields
    specVersion: '1.1.0',
    schemaVersion: '2026.2.0',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    transport: 'mcp',
    strict: true,
    mvi: 'standard',
    contextVersion: 1,
    // CLEO gateway extensions
    gateway,
    domain,
    duration_ms: Date.now() - startTime,
  };
}
