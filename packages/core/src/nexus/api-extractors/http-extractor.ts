/**
 * HTTP route contract extractor for NEXUS.
 *
 * Extends T1064's route analysis to extract HTTP contracts with schemas.
 * Queries route nodes from the NEXUS graph and converts them to HttpContract objects.
 *
 * @task T1065 — Contract Registry
 */

import type { HttpContract } from '@cleocode/contracts';
import { and, eq } from 'drizzle-orm';
import type { NexusNodeRow } from '../../store/nexus-schema.js';

/**
 * Extract all HTTP contracts from a project's NEXUS graph.
 *
 * Queries route nodes (kind: 'route') and converts their metadata
 * (path, method, request/response schemas) into HttpContract objects.
 *
 * @param projectId - Project identifier from registry
 * @param _projectRoot - Root directory of the project (unused)
 * @returns Promise resolving to array of HttpContract objects
 */
export async function extractHttpContracts(
  projectId: string,
  _projectRoot: string,
): Promise<HttpContract[]> {
  const { getNexusDb, nexusSchema } = await import('../../store/nexus-sqlite.js');
  const db = await getNexusDb();

  try {
    // Query all route nodes for this project
    const routeNodes: NexusNodeRow[] = db
      .select()
      .from(nexusSchema.nexusNodes)
      .where(
        and(
          eq(nexusSchema.nexusNodes.projectId, projectId),
          eq(nexusSchema.nexusNodes.kind, 'route'),
        ),
      )
      .all();

    const contracts: HttpContract[] = [];

    for (const routeNode of routeNodes) {
      // Parse route metadata from metaJson
      let routeMeta: Record<string, unknown> = {};
      if (routeNode.metaJson) {
        try {
          routeMeta = JSON.parse(routeNode.metaJson) as Record<string, unknown>;
        } catch {
          routeMeta = {};
        }
      }

      // Extract HTTP method and path from metadata
      const method = String(routeMeta['method'] ?? 'UNKNOWN').toUpperCase();
      const path = String(routeMeta['path'] ?? '');

      if (!path) {
        // Skip routes without a path (malformed)
        continue;
      }

      // Extract schemas (defaulting to empty objects if not present)
      const requestSchemaJson =
        typeof routeMeta['requestSchema'] === 'string'
          ? routeMeta['requestSchema']
          : typeof routeMeta['requestSchema'] === 'object'
            ? JSON.stringify(routeMeta['requestSchema'] ?? {})
            : '{}';

      const responseSchemaJson =
        typeof routeMeta['responseSchema'] === 'string'
          ? routeMeta['responseSchema']
          : typeof routeMeta['responseSchema'] === 'object'
            ? JSON.stringify(routeMeta['responseSchema'] ?? {})
            : '{}';

      // Build contract ID: http:<projectId>::<path>::<method>
      const contractId = `http:${projectId}::${path}::${method}`;

      // Get handler function (via handles_route reverse edge)
      const handlersResult = db
        .select()
        .from(nexusSchema.nexusRelations)
        .where(
          and(
            eq(nexusSchema.nexusRelations.projectId, projectId),
            eq(nexusSchema.nexusRelations.targetId, routeNode.id),
            eq(nexusSchema.nexusRelations.type, 'handles_route'),
          ),
        )
        .all();

      // Use first handler's symbol ID as source, or route node's symbol as fallback
      const sourceSymbolId = handlersResult.length > 0 ? handlersResult[0].sourceId : routeNode.id;

      const contract: HttpContract = {
        id: contractId,
        projectId,
        type: 'http',
        method,
        path,
        requestSchemaJson,
        responseSchemaJson,
        sourceSymbolId,
        routeNodeId: routeNode.id,
        confidence: 0.95, // Routes are well-known; high confidence
        description: `HTTP ${method} ${path}`,
      };

      contracts.push(contract);
    }

    return contracts;
  } catch (err) {
    throw new Error(
      `Failed to extract HTTP contracts for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
