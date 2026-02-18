/**
 * Gateway metadata factory for MCP domain handlers.
 *
 * Creates LAFS-conformant GatewayMeta objects with all required fields,
 * replacing the inline _meta construction previously duplicated across
 * every domain handler.
 *
 * Uses the canonical GatewayMeta type from src/types/lafs.ts (which
 * extends LAFSMeta from @cleocode/lafs-protocol) to ensure LAFS v1.1
 * conformance.  The transport value 'mcp' is not yet in the upstream
 * LAFSTransport union — we cast through `string` until lafs-protocol
 * >=1.2 adds it.
 *
 * @epic T4654
 * @task T4655
 */

import { randomUUID } from 'node:crypto';
import type { GatewayMeta } from '../../types/lafs.js';

/**
 * GatewayMeta with an index signature for DomainResponse._meta
 * compatibility.  All domain handlers receive this from
 * createGatewayMeta().
 *
 * @task T4655
 */
export type GatewayMetaRecord = GatewayMeta & Record<string, unknown>;

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
    schemaVersion: '2026.2.1',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    // 'mcp' is the correct transport for MCP gateway; cast through string
    // until @cleocode/lafs-protocol >=1.2 adds 'mcp' to LAFSTransport.
    transport: 'mcp' as unknown as GatewayMeta['transport'],
    strict: true,
    mvi: 'standard',
    contextVersion: 1,
    // CLEO gateway extensions
    gateway,
    domain,
    duration_ms: Date.now() - startTime,
  };
}
