/**
 * Gateway metadata factory for MCP domain handlers.
 *
 * Creates LAFS-conformant GatewayMeta objects with all required fields,
 * replacing the inline _meta construction previously duplicated across
 * every domain handler.
 *
 * Uses the canonical GatewayMeta type from src/types/lafs.ts (which
 * extends LAFSMeta from @cleocode/lafs-protocol) to ensure LAFS v1.2.3
 * conformance.  Transport is 'sdk' per LAFS spec (MCP uses the SDK transport).
 *
 * @epic T4663
 * @task T4700
 */

import { randomUUID } from 'node:crypto';
import type { GatewayMeta } from '../../types/lafs.js';
import { getCurrentSessionId } from '../../core/sessions/context-alert.js';

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
 * @task T4700
 * @epic T4663
 */
export function createGatewayMeta(
  gateway: string,
  domain: string,
  operation: string,
  startTime: number,
): GatewayMetaRecord {
  const sessionId = getCurrentSessionId();
  return {
    // LAFS canonical fields
    specVersion: '1.2.3',
    schemaVersion: '2026.2.1',
    timestamp: new Date().toISOString(),
    operation,
    requestId: randomUUID(),
    transport: 'sdk',
    strict: true,
    mvi: 'standard',
    contextVersion: 1,
    ...(sessionId && { sessionId }),
    // CLEO gateway extensions
    gateway,
    domain,
    duration_ms: Date.now() - startTime,
    'x-cleo-transport': 'stdio',
  };
}
