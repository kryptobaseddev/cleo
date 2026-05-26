/**
 * Contract tests for bounded WorkGraph context packs, readiness, and scaffold envelopes.
 *
 * @task T10609
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import {
  workGraphContextPackParamsSchema,
  workGraphContextPackSchema,
  workGraphReadinessParamsSchema,
  workGraphReadinessResultSchema,
  workGraphScaffoldApplyParamsSchema,
  workGraphScaffoldApplyResultSchema,
  workGraphScaffoldValidateParamsSchema,
  workGraphScaffoldValidateResultSchema,
  workGraphSliceParamsSchema,
  workGraphSliceSchema,
} from '../workgraph.js';

const taskNode = {
  id: 'T10609',
  type: 'task',
  title: 'Add contracts',
  status: 'pending',
  priority: 'high',
  parentId: 'T10545',
} as const;

const emptyPageInfo = { hasMore: false } as const;

const readyGroups = {
  ready: [
    {
      ...taskNode,
      role: 'worker',
      dependencyBlockers: [],
      gateBlockers: [],
    },
  ],
  blocked: [],
  blockedBy: [],
} as const;

describe('WorkGraph bounded context and scaffold contracts', () => {
  it('validates bounded context packs with graph slices, relation edges, readiness, budget, and omissions', () => {
    expect(
      workGraphContextPackParamsSchema.parse({
        rootId: 'T10545',
        tokenBudget: 1500,
        includeRelations: true,
        includeReadiness: true,
        includeRollup: true,
        limit: 25,
      }),
    ).toEqual({
      rootId: 'T10545',
      tokenBudget: 1500,
      includeRelations: true,
      includeReadiness: true,
      includeRollup: true,
      limit: 25,
    });

    const parsed = workGraphContextPackSchema.parse({
      rootId: 'T10545',
      generatedAt: '2026-05-26T10:00:00.000Z',
      budget: {
        tokenBudget: 1500,
        estimatedTokens: 1200,
        remainingTokens: 300,
        truncated: true,
      },
      slice: {
        rootId: 'T10545',
        direction: 'descendants',
        nodes: [taskNode],
        edges: [{ fromId: 'T10545', toId: 'T10609', kind: 'contains' }],
        pageInfo: { nextCursor: '0002:T10610', hasMore: true },
        omissions: [
          {
            path: 'slice.nodes[25:]',
            reason: 'budget_exceeded',
            message: 'Additional nodes omitted to stay under token budget',
            estimatedTokens: 400,
          },
        ],
      },
      relationEdges: {
        rootId: 'T10609',
        direction: 'both',
        edges: [
          {
            source: 'dependency',
            fromId: 'T10609',
            toId: 'T10608',
            kind: 'depends_on',
          },
          {
            source: 'relation',
            fromId: 'T10538',
            toId: 'T10545',
            kind: 'groups',
            relationType: 'groups',
            reason: 'Saga membership',
          },
        ],
      },
      readiness: {
        rootId: 'T10545',
        role: 'worker',
        ready: true,
        warnings: [],
        groups: readyGroups,
      },
      rollup: {
        rootId: 'T10545',
        direct: { total: 1, byStatus: { pending: 1 }, byType: { task: 1 } },
        subtree: { total: 1, byStatus: { pending: 1 }, byType: { task: 1 } },
        percentDenominator: { basis: 'subtree-total', total: 1, description: 'subtree total' },
        percentages: { done: 0, active: 0, blocked: 0, pending: 100, cancelled: 0 },
        staleProjection: false,
        projectionMismatches: [],
      },
      omissions: [
        { path: 'rollup.history', reason: 'not_requested', message: 'History not requested' },
      ],
    });

    expect(parsed.budget.truncated).toBe(true);
    expect(parsed.relationEdges?.edges.map((edge) => edge.source)).toEqual([
      'dependency',
      'relation',
    ]);
    expect(parsed.readiness?.groups.ready[0]?.id).toBe('T10609');
  });

  it('validates graph slice and readiness envelopes independently', () => {
    expect(
      workGraphSliceParamsSchema.parse({
        rootId: 'T10545',
        direction: 'descendants',
        maxDepth: 2,
        includeRelations: true,
        cursor: '0001:T10609',
        limit: 50,
      }),
    ).toEqual({
      rootId: 'T10545',
      direction: 'descendants',
      maxDepth: 2,
      includeRelations: true,
      cursor: '0001:T10609',
      limit: 50,
    });

    expect(
      workGraphSliceSchema.parse({
        rootId: 'T10545',
        direction: 'descendants',
        nodes: [taskNode],
        edges: [{ fromId: 'T10545', toId: 'T10609', kind: 'contains' }],
        pageInfo: emptyPageInfo,
      }).nodes,
    ).toHaveLength(1);

    expect(
      workGraphReadinessParamsSchema.parse({
        rootId: 'T10545',
        role: 'worker',
        includeGateBlockers: true,
      }),
    ).toEqual({ rootId: 'T10545', role: 'worker', includeGateBlockers: true });

    expect(
      workGraphReadinessResultSchema.parse({
        rootId: 'T10545',
        role: 'worker',
        ready: true,
        warnings: [],
        groups: readyGroups,
      }).ready,
    ).toBe(true);
  });

  it('validates scaffold validate/apply contracts and hierarchy diagnostics', () => {
    const nodes = [
      { id: 'T10545', type: 'epic' },
      { id: 'T10609', type: 'task', parentId: 'T10545' },
    ] as const;
    const edges = [
      {
        source: 'dependency',
        fromId: 'T10609',
        toId: 'T10608',
        kind: 'depends_on',
      },
    ] as const;

    expect(
      workGraphScaffoldValidateParamsSchema.parse({ rootId: 'T10545', nodes, edges, dryRun: true }),
    ).toEqual({ rootId: 'T10545', nodes, edges, dryRun: true });

    expect(
      workGraphScaffoldValidateResultSchema.parse({
        rootId: 'T10545',
        valid: true,
        dryRun: true,
        issues: [{ code: 'W_EXISTING_NODE', message: 'Node already exists', severity: 'warning' }],
        hierarchy: { valid: true, violations: [] },
      }).valid,
    ).toBe(true);

    expect(
      workGraphScaffoldApplyParamsSchema.parse({ rootId: 'T10545', nodes, edges, apply: true }),
    ).toEqual({ rootId: 'T10545', nodes, edges, apply: true });

    expect(
      workGraphScaffoldApplyResultSchema.parse({
        rootId: 'T10545',
        valid: true,
        dryRun: false,
        applied: true,
        nodesChanged: 2,
        edgesChanged: 1,
        issues: [],
        hierarchy: { valid: true, violations: [] },
      }).edgesChanged,
    ).toBe(1);
  });
});
