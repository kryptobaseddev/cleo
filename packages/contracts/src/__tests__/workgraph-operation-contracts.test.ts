/**
 * Contract tests for the PM-Core V2 WorkGraph dispatch surface.
 *
 * @task T10606
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../dispatch/operations-registry.js';
import {
  tasksFrontierParamsSchema,
  tasksFrontierResultSchema,
  tasksRollupParamsSchema,
  tasksRollupResultSchema,
  tasksTraverseParamsSchema,
  tasksTraverseResultSchema,
  tasksTreeParamsSchema,
  tasksTreeResultSchema,
  tasksWorkGraphAuditParamsSchema,
  tasksWorkGraphAuditResultSchema,
} from '../workgraph.js';

const requiredOperations = ['traverse', 'tree', 'rollup', 'frontier', 'workgraph.audit'] as const;

function operation(name: (typeof requiredOperations)[number]) {
  const def = OPERATIONS.find(
    (candidate) => candidate.domain === 'tasks' && candidate.operation === name,
  );
  if (def === undefined) throw new Error(`missing tasks.${name}`);
  return def;
}

describe('WorkGraph operation contract schemas', () => {
  it('validates params and results for every WorkGraph read operation', () => {
    expect(
      tasksTraverseParamsSchema.parse({
        rootId: 'T1',
        direction: 'descendants',
        cursor: '0001:T2',
        limit: 25,
      }),
    ).toEqual({
      rootId: 'T1',
      direction: 'descendants',
      cursor: '0001:T2',
      limit: 25,
    });
    expect(
      tasksTraverseResultSchema.parse({
        rootId: 'T1',
        direction: 'descendants',
        nodes: [],
        edges: [],
        pageInfo: { hasMore: false },
      }).pageInfo.hasMore,
    ).toBe(false);

    expect(tasksTreeParamsSchema.parse({ rootId: 'T1', maxDepth: 2, limit: 10 })).toEqual({
      rootId: 'T1',
      maxDepth: 2,
      limit: 10,
    });
    expect(
      tasksTreeResultSchema.parse({
        rootId: 'T1',
        nodes: [],
        edges: [],
        pageInfo: { hasMore: false },
      }).nodes,
    ).toEqual([]);

    expect(tasksRollupParamsSchema.parse({ rootId: 'T1' })).toEqual({ rootId: 'T1' });
    expect(
      tasksRollupResultSchema.parse({
        rootId: 'T1',
        direct: { total: 0, byStatus: {}, byType: {} },
        subtree: { total: 0, byStatus: {}, byType: {} },
        percentDenominator: { basis: 'subtree-total', total: 0, description: 'subtree total' },
        percentages: { done: 0, active: 0, blocked: 0, pending: 0, cancelled: 0 },
        staleProjection: false,
        projectionMismatches: [],
      }).staleProjection,
    ).toBe(false);

    expect(tasksFrontierParamsSchema.parse({ rootId: 'T1', role: 'worker' })).toEqual({
      rootId: 'T1',
      role: 'worker',
    });
    expect(
      tasksFrontierResultSchema.parse({
        rootId: 'T1',
        role: 'worker',
        groups: { ready: [], blocked: [], blockedBy: [] },
      }).groups.ready,
    ).toEqual([]);

    expect(
      tasksWorkGraphAuditParamsSchema.parse({ rootId: 'T1', includeRelations: true, limit: 5 }),
    ).toEqual({
      rootId: 'T1',
      includeRelations: true,
      limit: 5,
    });
    expect(
      tasksWorkGraphAuditResultSchema.parse({
        rootId: 'T1',
        hierarchy: { valid: true, violations: [] },
        traversal: {
          rootId: 'T1',
          direction: 'descendants',
          nodes: [],
          edges: [],
          pageInfo: { hasMore: false },
        },
        frontier: { rootId: 'T1', groups: { ready: [], blocked: [], blockedBy: [] } },
        rollup: {
          rootId: 'T1',
          direct: { total: 0, byStatus: {}, byType: {} },
          subtree: { total: 0, byStatus: {}, byType: {} },
          percentDenominator: { basis: 'subtree-total', total: 0, description: 'subtree total' },
          percentages: { done: 0, active: 0, blocked: 0, pending: 0, cancelled: 0 },
          staleProjection: false,
          projectionMismatches: [],
        },
        relationEdges: { rootId: 'T1', direction: 'both', edges: [] },
      }).hierarchy.valid,
    ).toBe(true);
  });

  it('publishes operation metadata with explicit pagination params', () => {
    for (const name of requiredOperations) {
      const def = operation(name);
      expect(def.gateway).toBe('query');
      expect(def.domain).toBe('tasks');
      expect(def.idempotent).toBe(true);
      expect(def.params ?? []).not.toEqual([]);
    }

    expect(operation('traverse').requiredParams).toEqual(['rootId', 'direction']);
    expect(operation('tree').requiredParams).toEqual(['rootId']);
    expect(operation('rollup').requiredParams).toEqual(['rootId']);
    expect(operation('frontier').requiredParams).toEqual(['rootId']);
    expect(operation('workgraph.audit').requiredParams).toEqual(['rootId']);

    for (const name of ['traverse', 'tree', 'workgraph.audit'] as const) {
      const params = operation(name).params?.map((param) => param.name) ?? [];
      expect(params).toContain('cursor');
      expect(params).toContain('limit');
    }
  });
});
