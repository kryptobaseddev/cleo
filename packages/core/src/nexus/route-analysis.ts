/**
 * Route map and shape-check analysis for NEXUS code graph.
 *
 * Route nodes represent API/HTTP endpoints in the code graph.
 * This module provides primitives to:
 * - Map all routes to their handler functions and downstream dependencies
 * - Check response shape compatibility between handlers and callers
 *
 * @task T1064 — Route-Map and Shape-Check Commands
 */

import type {
  RouteMapEntry,
  RouteMapResult,
  ShapeCheckCaller,
  ShapeCheckResult,
} from '@cleocode/contracts/nexus-route-ops.js';
import { and, eq } from 'drizzle-orm';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import type { NexusNodeRow, NexusRelationRow } from '../store/nexus-schema.js';

/**
 * Query all route nodes in the project and their handler relations.
 *
 * For each route, resolve:
 * - handles_route reverse-relation to find handler functions
 * - fetches forward-relations from handlers to external deps
 * - calls relations to find downstream callers
 *
 * @param projectId - Project identifier from registry
 * @param _projectRoot - Root directory of the project (unused, kept for signature)
 * @returns Promise resolving to route map entries
 */
export async function getRouteMap(
  projectId: string,
  _projectRoot: string,
): Promise<RouteMapResult> {
  const { getNexusDb, nexusSchema } = await import('../store/nexus-sqlite.js');
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

    const routes: RouteMapEntry[] = [];
    const distinctDeps = new Set<string>();

    for (const routeNode of routeNodes) {
      // Find handler (handles_route reverse edge: handler -> route)
      const handlersResult: NexusRelationRow[] = db
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

      // Each route should have at least one handler; process all handlers found
      for (const handlerRel of handlersResult) {
        // Resolve handler node
        const handlerNode: NexusNodeRow | undefined = db
          .select()
          .from(nexusSchema.nexusNodes)
          .where(eq(nexusSchema.nexusNodes.id, handlerRel.sourceId))
          .get();

        if (!handlerNode) continue;

        // Find fetches dependencies from this handler
        const fetchesResult: NexusRelationRow[] = db
          .select()
          .from(nexusSchema.nexusRelations)
          .where(
            and(
              eq(nexusSchema.nexusRelations.projectId, projectId),
              eq(nexusSchema.nexusRelations.sourceId, handlerNode.id),
              eq(nexusSchema.nexusRelations.type, 'fetches'),
            ),
          )
          .all();

        const fetchedDeps = fetchesResult.map((rel) => {
          distinctDeps.add(rel.targetId);
          return {
            target: rel.targetId,
            relationType: 'fetches',
            confidence: rel.confidence,
          };
        });

        // Count callers of this handler (incoming calls)
        const callersResult: NexusRelationRow[] = db
          .select()
          .from(nexusSchema.nexusRelations)
          .where(
            and(
              eq(nexusSchema.nexusRelations.projectId, projectId),
              eq(nexusSchema.nexusRelations.targetId, handlerNode.id),
              eq(nexusSchema.nexusRelations.type, 'calls'),
            ),
          )
          .all();

        // Parse route metadata
        let routeMeta: Record<string, unknown> = {};
        if (routeNode.metaJson) {
          try {
            routeMeta = JSON.parse(routeNode.metaJson) as Record<string, unknown>;
          } catch {
            routeMeta = {};
          }
        }

        routes.push({
          routeId: routeNode.id,
          handlerId: handlerNode.id,
          handlerName: handlerNode.name ?? handlerNode.label,
          handlerFile: handlerNode.filePath ?? '',
          language: handlerNode.language ?? 'unknown',
          routeMeta,
          fetchedDeps,
          callerCount: callersResult.length,
        });
      }
    }

    return {
      projectId,
      routes,
      routeCount: routeNodes.length,
      handlerCount: routes.length,
      distinctDeps: Array.from(distinctDeps),
    };
  } catch (err) {
    throw new Error(
      `Failed to get route map for project ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Check response shape compatibility between a route and its callers.
 *
 * Compares:
 * - Route's declared shape (from meta_json or return type)
 * - Each caller's expected shape (inferred from usage or return annotation)
 *
 * Currently limited to meta_json shape string equality due to lack of AST analysis.
 * A full implementation would require parsing type annotations and inferring shapes
 * from call sites, which is deferred to T1534 (AST-based shape inference).
 *
 * @param routeSymbol - Route symbol ID (format: `<filePath>::<routeName>`)
 * @param projectId - Project identifier from registry
 * @param _projectRoot - Root directory of the project (unused, kept for signature)
 * @returns Promise resolving to shape check result
 */
export async function shapeCheck(
  routeSymbol: string,
  projectId: string,
  _projectRoot: string,
): Promise<ShapeCheckResult> {
  const { getNexusDb, nexusSchema } = await import('../store/nexus-sqlite.js');
  const db = await getNexusDb();

  try {
    // Resolve route node
    const routeNode: NexusNodeRow | undefined = db
      .select()
      .from(nexusSchema.nexusNodes)
      .where(
        and(
          eq(nexusSchema.nexusNodes.projectId, projectId),
          eq(nexusSchema.nexusNodes.id, routeSymbol),
        ),
      )
      .get();

    if (!routeNode || routeNode.kind !== 'route') {
      throw new Error(`Route node not found: ${routeSymbol}`);
    }

    // Parse route's declared shape from meta_json
    let declaredShape = 'unknown';
    if (routeNode.metaJson) {
      try {
        const meta = JSON.parse(routeNode.metaJson) as Record<string, unknown>;
        if (typeof meta['responseShape'] === 'string') {
          declaredShape = meta['responseShape'];
        }
      } catch {
        // Continue with 'unknown' if meta_json parse fails
      }
    }

    // Find handler (handles_route reverse edge)
    const handlersResult: NexusRelationRow[] = db
      .select()
      .from(nexusSchema.nexusRelations)
      .where(
        and(
          eq(nexusSchema.nexusRelations.projectId, projectId),
          eq(nexusSchema.nexusRelations.targetId, routeSymbol),
          eq(nexusSchema.nexusRelations.type, 'handles_route'),
        ),
      )
      .all();

    if (handlersResult.length === 0) {
      throw new Error(`No handler found for route: ${routeSymbol}`);
    }

    // Use the first handler (typically there is only one per route)
    const handlerRel = handlersResult[0];
    const handlerNode: NexusNodeRow | undefined = db
      .select()
      .from(nexusSchema.nexusNodes)
      .where(eq(nexusSchema.nexusNodes.id, handlerRel.sourceId))
      .get();

    if (!handlerNode) {
      throw new Error(`Handler node not found: ${handlerRel.sourceId}`);
    }

    // Find all callers of this handler (calls relation targeting handler)
    const callersResult: NexusRelationRow[] = db
      .select()
      .from(nexusSchema.nexusRelations)
      .where(
        and(
          eq(nexusSchema.nexusRelations.projectId, projectId),
          eq(nexusSchema.nexusRelations.targetId, handlerNode.id),
          eq(nexusSchema.nexusRelations.type, 'calls'),
        ),
      )
      .all();

    // Resolve caller nodes and infer expected shapes
    const callers: ShapeCheckCaller[] = [];
    let compatibleCount = 0;
    let incompatibleCount = 0;

    for (const callerRel of callersResult) {
      const callerNode: NexusNodeRow | undefined = db
        .select()
        .from(nexusSchema.nexusNodes)
        .where(eq(nexusSchema.nexusNodes.id, callerRel.sourceId))
        .get();

      if (!callerNode) continue;

      // Infer expected shape from caller's return type
      const expectedShape = callerNode.returnType ?? 'unknown';

      // Simple string equality comparison
      // A full implementation would do structural type checking
      const status = expectedShape === declaredShape ? 'compatible' : 'incompatible';
      if (status === 'compatible') compatibleCount++;
      if (status === 'incompatible') incompatibleCount++;

      const diagnosis =
        status === 'compatible'
          ? `Caller expects ${expectedShape}, handler declares ${declaredShape}`
          : `Caller expects ${expectedShape}, handler declares ${declaredShape} — mismatch`;

      callers.push({
        callerId: callerNode.id,
        callerName: callerNode.name ?? callerNode.label,
        callerFile: callerNode.filePath ?? '',
        expectedShape,
        status,
        diagnosis,
      });
    }

    // Determine overall status and recommendation
    let overallStatus: 'compatible' | 'incompatible' | 'partial' | 'unknown' = 'unknown';
    let recommendation = '';

    if (callers.length === 0) {
      overallStatus = 'unknown';
      recommendation = 'No callers found. Route appears to be unused.';
    } else if (incompatibleCount === 0) {
      overallStatus = 'compatible';
      recommendation = `All ${compatibleCount} callers are compatible with the route's declared shape.`;
    } else if (compatibleCount === 0) {
      overallStatus = 'incompatible';
      recommendation = `All ${incompatibleCount} callers have incompatible shapes. Consider updating the route's response type.`;
    } else {
      overallStatus = 'partial';
      recommendation = `${compatibleCount} compatible, ${incompatibleCount} incompatible. May have multiple handler implementations.`;
    }

    return {
      routeId: routeSymbol,
      handlerId: handlerNode.id,
      declaredShape,
      callers,
      compatibleCount,
      incompatibleCount,
      overallStatus,
      recommendation,
    };
  } catch (err) {
    throw new Error(
      `Failed to check shape for route ${routeSymbol}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// EngineResult-returning wrappers (T1569 / ADR-057 / ADR-058)
// ---------------------------------------------------------------------------

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusRouteMap(
  projectId: string,
  projectRoot: string,
): Promise<EngineResult<RouteMapResult>> {
  try {
    const result = await getRouteMap(projectId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}

// SSoT-EXEMPT:engine-migration-T1569
export async function nexusShapeCheck(
  routeSymbol: string,
  projectId: string,
  projectRoot: string,
): Promise<EngineResult<ShapeCheckResult>> {
  try {
    const result = await shapeCheck(routeSymbol, projectId, projectRoot);
    return engineSuccess(result);
  } catch (error) {
    return engineError('E_INTERNAL', error instanceof Error ? error.message : String(error));
  }
}
