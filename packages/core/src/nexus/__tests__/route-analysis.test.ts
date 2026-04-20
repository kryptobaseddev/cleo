/**
 * Tests for route-analysis.ts — route mapping and shape checking.
 *
 * @task T1064
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getNexusDb, nexusSchema } from '../../store/nexus-sqlite.js';
import { getRouteMap, shapeCheck } from '../route-analysis.js';

describe('route-analysis', () => {
  let projectId: string;
  let db: ReturnType<typeof getNexusDb>;

  beforeAll(async () => {
    projectId = `test-project-${randomUUID().slice(0, 8)}`;
    db = await getNexusDb();

    // Clean up any stale rows from a previous run that share the same fixed node IDs
    const fixedNodeIds = [
      'src/routes/tasks.ts::getTasksRoute',
      'src/handlers/taskHandler.ts::handleGetTasks',
      'src/tests/tasks.test.ts::testGetTasks',
      'src/client/client.ts::fetchTasks',
    ];
    for (const nodeId of fixedNodeIds) {
      db.delete(nexusSchema.nexusNodes).where(eq(nexusSchema.nexusNodes.id, nodeId)).run();
    }

    // Create synthetic test data: route nodes + handlers + relations

    // Route node for GET /api/v1/tasks
    const routeId = `src/routes/tasks.ts::getTasksRoute`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: routeId,
        projectId,
        kind: 'route',
        label: 'GET /api/v1/tasks',
        name: 'getTasksRoute',
        filePath: 'src/routes/tasks.ts',
        language: 'typescript',
        isExported: true,
        metaJson: JSON.stringify({
          method: 'GET',
          path: '/api/v1/tasks',
          responseShape: 'Task[]',
        }),
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Handler function
    const handlerId = `src/handlers/taskHandler.ts::handleGetTasks`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: handlerId,
        projectId,
        kind: 'function',
        label: 'handleGetTasks',
        name: 'handleGetTasks',
        filePath: 'src/handlers/taskHandler.ts',
        language: 'typescript',
        isExported: false,
        returnType: 'Task[]',
        docSummary: 'Handles GET /tasks requests',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Handles_route relation: handler -> route
    db.insert(nexusSchema.nexusRelations)
      .values({
        id: randomUUID(),
        projectId,
        sourceId: handlerId,
        targetId: routeId,
        type: 'handles_route',
        confidence: 0.95,
        reason: 'Function handles this route',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // External dependency (fetches)
    db.insert(nexusSchema.nexusRelations)
      .values({
        id: randomUUID(),
        projectId,
        sourceId: handlerId,
        targetId: '@cleocode/contracts',
        type: 'fetches',
        confidence: 0.9,
        reason: 'Imports contracts package',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Caller 1 (compatible shape)
    const caller1Id = `src/tests/tasks.test.ts::testGetTasks`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: caller1Id,
        projectId,
        kind: 'function',
        label: 'testGetTasks',
        name: 'testGetTasks',
        filePath: 'src/tests/tasks.test.ts',
        language: 'typescript',
        isExported: false,
        returnType: 'Task[]',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Calls relation: caller1 -> handler
    db.insert(nexusSchema.nexusRelations)
      .values({
        id: randomUUID(),
        projectId,
        sourceId: caller1Id,
        targetId: handlerId,
        type: 'calls',
        confidence: 0.99,
        reason: 'Test calls handler',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Caller 2 (incompatible shape)
    const caller2Id = `src/client/client.ts::fetchTasks`;
    db.insert(nexusSchema.nexusNodes)
      .values({
        id: caller2Id,
        projectId,
        kind: 'function',
        label: 'fetchTasks',
        name: 'fetchTasks',
        filePath: 'src/client/client.ts',
        language: 'typescript',
        isExported: true,
        returnType: 'Promise<TaskResponse>',
        indexedAt: new Date().toISOString(),
      })
      .run();

    // Calls relation: caller2 -> handler
    db.insert(nexusSchema.nexusRelations)
      .values({
        id: randomUUID(),
        projectId,
        sourceId: caller2Id,
        targetId: handlerId,
        type: 'calls',
        confidence: 0.99,
        reason: 'Client calls handler',
        indexedAt: new Date().toISOString(),
      })
      .run();
  });

  afterAll(async () => {
    // Clean up: delete test data
    const cleanDb = await getNexusDb();
    const testNodes = cleanDb
      .select()
      .from(nexusSchema.nexusNodes)
      .where(eq(nexusSchema.nexusNodes.projectId, projectId))
      .all();

    for (const node of testNodes) {
      cleanDb.delete(nexusSchema.nexusNodes).where(eq(nexusSchema.nexusNodes.id, node.id)).run();
    }

    const testRelations = cleanDb
      .select()
      .from(nexusSchema.nexusRelations)
      .where(eq(nexusSchema.nexusRelations.projectId, projectId))
      .all();

    for (const rel of testRelations) {
      cleanDb
        .delete(nexusSchema.nexusRelations)
        .where(eq(nexusSchema.nexusRelations.id, rel.id))
        .run();
    }
  });

  describe('getRouteMap', () => {
    it('should list all routes with handlers and dependencies', async () => {
      const result = await getRouteMap(projectId, process.cwd());

      expect(result.projectId).toBe(projectId);
      expect(result.routeCount).toBeGreaterThan(0);
      expect(result.routes.length).toBeGreaterThan(0);

      const route = result.routes[0];
      expect(route).toHaveProperty('routeId');
      expect(route).toHaveProperty('handlerId');
      expect(route).toHaveProperty('handlerName');
      expect(route.routeMeta).toHaveProperty('method');
    });

    it('should include external dependencies in distinctDeps', async () => {
      const result = await getRouteMap(projectId, process.cwd());

      expect(result.distinctDeps).toContain('@cleocode/contracts');
    });
  });

  describe('shapeCheck', () => {
    it('should find callers and check shape compatibility', async () => {
      const routeId = `src/routes/tasks.ts::getTasksRoute`;
      const result = await shapeCheck(routeId, projectId, process.cwd());

      expect(result.routeId).toBe(routeId);
      expect(result.declaredShape).toBe('Task[]');
      expect(result.callers.length).toBeGreaterThan(0);
    });

    it('should report compatible shape when caller matches handler return type', async () => {
      const routeId = `src/routes/tasks.ts::getTasksRoute`;
      const result = await shapeCheck(routeId, projectId, process.cwd());

      const compatibleCallers = result.callers.filter((c) => c.status === 'compatible');
      expect(compatibleCallers.length).toBeGreaterThan(0);
    });

    it('should report incompatible shape when shapes differ', async () => {
      const routeId = `src/routes/tasks.ts::getTasksRoute`;
      const result = await shapeCheck(routeId, projectId, process.cwd());

      const incompatibleCallers = result.callers.filter((c) => c.status === 'incompatible');
      expect(incompatibleCallers.length).toBeGreaterThan(0);
    });

    it('should throw error for non-existent route', async () => {
      await expect(shapeCheck('non/existent::route', projectId, process.cwd())).rejects.toThrow();
    });
  });
});
