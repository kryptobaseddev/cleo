/**
 * T10577 WorkGraph containment query service acceptance coverage.
 *
 * Locks batched ancestor/children lookups to `tasks.parent_id` and guards the
 * WorkGraph boundary from Saga/group relation reads.
 *
 * @task T10577
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import { createSqliteWorkGraphContainmentQueryService } from '../index.js';

type Statement<Row> = {
  all(...params: readonly unknown[]): Row[];
};

type PreparedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

type Row = {
  root_id: string;
  depth?: number;
  sort_cursor?: string;
  id: string;
  title: string;
  type: 'saga' | 'epic' | 'task' | 'subtask';
  status: 'pending' | 'active' | 'blocked' | 'done' | 'cancelled' | 'archived' | 'proposed';
  priority: 'low' | 'medium' | 'high' | 'critical';
  parent_id: string | null;
  role?: string | null;
  verification_json?: string | null;
  depends_on?: string | null;
  dep_status?: Row['status'] | null;
};

class FakeDb {
  readonly prepared: PreparedQuery[] = [];

  constructor(
    private readonly rowsByKind: {
      ancestors?: Row[];
      children?: Row[];
      descendants?: Row[];
      frontier?: Row[];
    },
  ) {}

  prepare(sql: string): Statement<Row> {
    return {
      all: (...params: readonly unknown[]) => {
        this.prepared.push({ sql, params: params.map(String) });
        if (sql.includes('ready_frontier_scope')) return this.rowsByKind.frontier ?? [];
        if (sql.includes('ancestor_edges')) return this.rowsByKind.ancestors ?? [];
        if (sql.includes('descendants')) return this.rowsByKind.descendants ?? [];
        return this.rowsByKind.children ?? [];
      },
    };
  }
}

describe('SqliteWorkGraphContainmentQueryService', () => {
  it('loads ancestor chains for multiple roots with one parent_id-only recursive query', () => {
    const db = new FakeDb({
      ancestors: [
        {
          root_id: 'ST1',
          depth: 2,
          id: 'E1',
          title: 'Epic',
          type: 'epic',
          status: 'pending',
          priority: 'high',
          parent_id: null,
        },
        {
          root_id: 'ST1',
          depth: 1,
          id: 'T1',
          title: 'Task',
          type: 'task',
          status: 'active',
          priority: 'medium',
          parent_id: 'E1',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.getAncestors(['ST1', 'T2', 'ST1']);

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.params).toEqual(['ST1', 'T2']);
    expect(db.prepared[0]?.sql).toContain('WITH RECURSIVE input(root_id) AS (VALUES (?), (?))');
    expect(db.prepared[0]?.sql).toContain('root.parent_id');
    expect(db.prepared[0]?.sql).not.toContain('task_relations');
    expect(db.prepared[0]?.sql).not.toContain('groups');
    expect(result).toEqual([
      {
        rootId: 'ST1',
        ancestors: [
          {
            id: 'E1',
            title: 'Epic',
            type: 'epic',
            status: 'pending',
            priority: 'high',
            parentId: undefined,
          },
          {
            id: 'T1',
            title: 'Task',
            type: 'task',
            status: 'active',
            priority: 'medium',
            parentId: 'E1',
          },
        ],
      },
      { rootId: 'T2', ancestors: [] },
    ]);
  });

  it('loads direct children for multiple parents with one parent_id batch query', () => {
    const db = new FakeDb({
      children: [
        {
          root_id: 'E1',
          id: 'T1',
          title: 'Task',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parent_id: 'E1',
        },
        {
          root_id: 'T1',
          id: 'ST1',
          title: 'Subtask',
          type: 'subtask',
          status: 'done',
          priority: 'low',
          parent_id: 'T1',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.getChildren(['E1', 'T1']);

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.params).toEqual(['E1', 'T1']);
    expect(db.prepared[0]?.sql).toContain('WHERE t.parent_id IN (?, ?)');
    expect(db.prepared[0]?.sql).not.toContain('WITH RECURSIVE');
    expect(db.prepared[0]?.sql).not.toContain('task_relations');
    expect(db.prepared[0]?.sql).not.toContain('groups');
    expect(result).toEqual([
      {
        rootId: 'E1',
        children: [
          {
            id: 'T1',
            title: 'Task',
            type: 'task',
            status: 'pending',
            priority: 'medium',
            parentId: 'E1',
          },
        ],
      },
      {
        rootId: 'T1',
        children: [
          {
            id: 'ST1',
            title: 'Subtask',
            type: 'subtask',
            status: 'done',
            priority: 'low',
            parentId: 'T1',
          },
        ],
      },
    ]);
  });

  it('projects a descendant tree with cursor pagination and max depth using one recursive query', () => {
    const db = new FakeDb({
      descendants: [
        {
          root_id: 'E1',
          depth: 1,
          sort_cursor: '00000001:T1',
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'pending',
          priority: 'high',
          parent_id: 'E1',
        },
        {
          root_id: 'E1',
          depth: 2,
          sort_cursor: '00000002:ST1',
          id: 'ST1',
          title: 'Subtask 1',
          type: 'subtask',
          status: 'done',
          priority: 'low',
          parent_id: 'T1',
        },
        {
          root_id: 'E1',
          depth: 2,
          sort_cursor: '00000002:ST2',
          id: 'ST2',
          title: 'Subtask 2',
          type: 'subtask',
          status: 'pending',
          priority: 'medium',
          parent_id: 'T1',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.tree({ rootId: 'E1', maxDepth: 2, limit: 2, cursor: '00000001:T0' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('WITH RECURSIVE descendants');
    expect(db.prepared[0]?.sql).toContain('descendants.depth < ?');
    expect(db.prepared[0]?.sql).toContain('sort_cursor > ?');
    expect(db.prepared[0]?.sql).toContain('LIMIT ?');
    expect(db.prepared[0]?.sql).not.toContain('task_relations');
    expect(db.prepared[0]?.sql).not.toContain('groups');
    expect(db.prepared[0]?.params).toEqual([
      'E1',
      'E1',
      '2',
      '2',
      '00000001:T0',
      '00000001:T0',
      '3',
    ]);
    expect(result).toEqual({
      rootId: 'E1',
      nodes: [
        {
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'pending',
          priority: 'high',
          parentId: 'E1',
          depth: 1,
        },
        {
          id: 'ST1',
          title: 'Subtask 1',
          type: 'subtask',
          status: 'done',
          priority: 'low',
          parentId: 'T1',
          depth: 2,
        },
      ],
      edges: [
        { fromId: 'E1', toId: 'T1', kind: 'contains' },
        { fromId: 'T1', toId: 'ST1', kind: 'contains' },
      ],
      pageInfo: { hasMore: true, nextCursor: '00000002:ST1' },
    });
  });

  it('uses the paginated tree projection for descendant traversal', () => {
    const db = new FakeDb({
      descendants: [
        {
          root_id: 'E1',
          depth: 1,
          sort_cursor: '00000001:T1',
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'pending',
          priority: 'high',
          parent_id: 'E1',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.traverse({ rootId: 'E1', direction: 'descendants', limit: 25 });

    expect(db.prepared).toHaveLength(1);
    expect(result).toEqual({
      rootId: 'E1',
      direction: 'descendants',
      nodes: [
        {
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'pending',
          priority: 'high',
          parentId: 'E1',
          depth: 1,
        },
      ],
      edges: [{ fromId: 'E1', toId: 'T1', kind: 'contains' }],
      pageInfo: { hasMore: false },
    });
  });

  it('summarizes direct and subtree rollup counts with explicit percent denominator rules', () => {
    const db = new FakeDb({
      descendants: [
        {
          root_id: 'E1',
          depth: 1,
          sort_cursor: '00000001:T1',
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'done',
          priority: 'high',
          parent_id: 'E1',
        },
        {
          root_id: 'E1',
          depth: 1,
          sort_cursor: '00000001:T2',
          id: 'T2',
          title: 'Task 2',
          type: 'task',
          status: 'blocked',
          priority: 'medium',
          parent_id: 'E1',
        },
        {
          root_id: 'E1',
          depth: 2,
          sort_cursor: '00000002:ST1',
          id: 'ST1',
          title: 'Subtask 1',
          type: 'subtask',
          status: 'pending',
          priority: 'low',
          parent_id: 'T2',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.summarizeSubtree({ rootId: 'E1' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('WITH RECURSIVE summary_descendants');
    expect(db.prepared[0]?.sql).not.toContain('task_relations');
    expect(result.direct.total).toBe(2);
    expect(result.direct.byStatus).toEqual({ blocked: 1, done: 1 });
    expect(result.subtree.total).toBe(3);
    expect(result.subtree.byStatus).toEqual({ blocked: 1, done: 1, pending: 1 });
    expect(result.subtree.byType).toEqual({ subtask: 1, task: 2 });
    expect(result.percentDenominator).toEqual({
      basis: 'subtree-total',
      description:
        'percentages use subtree.total as the denominator, include archived descendants, and exclude the root node',
      total: 3,
    });
    expect(result.percentages).toEqual({
      active: 0,
      blocked: 33.33,
      cancelled: 0,
      done: 33.33,
      pending: 33.33,
    });
    expect(result.staleProjection).toBe(false);
    expect(result.projectionMismatches).toEqual([]);
  });

  it('flags stale direct-child projections when expected rollup counts disagree with storage', () => {
    const db = new FakeDb({
      descendants: [
        {
          root_id: 'E1',
          depth: 1,
          sort_cursor: '00000001:T1',
          id: 'T1',
          title: 'Task 1',
          type: 'task',
          status: 'done',
          priority: 'high',
          parent_id: 'E1',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.summarizeSubtree({
      rootId: 'E1',
      expectedDirectRollup: { total: 2, byStatus: { done: 2 }, byType: { task: 2 } },
    });

    expect(result.direct.total).toBe(1);
    expect(result.staleProjection).toBe(true);
    expect(result.projectionMismatches).toEqual([
      { actual: 1, expected: 2, field: 'total' },
      { actual: 1, expected: 2, field: 'status:done' },
      { actual: 1, expected: 2, field: 'type:task' },
    ]);
  });

  it('groups role-filtered ready frontier tasks and separates dependency blockers from gate blockers', () => {
    const db = new FakeDb({
      frontier: [
        {
          root_id: 'E1',
          id: 'T-ready',
          title: 'Ready task',
          type: 'task',
          status: 'pending',
          priority: 'high',
          parent_id: 'E1',
          role: 'worker',
          verification_json: JSON.stringify({
            gates: { implemented: false, testsPassed: false, qaPassed: false },
          }),
          depends_on: 'T-done',
          dep_status: 'done',
        },
        {
          root_id: 'E1',
          id: 'T-blocked',
          title: 'Blocked task',
          type: 'task',
          status: 'pending',
          priority: 'medium',
          parent_id: 'E1',
          role: 'worker',
          verification_json: JSON.stringify({
            gates: { implemented: true, testsPassed: false, qaPassed: false },
          }),
          depends_on: 'T-open',
          dep_status: 'active',
        },
      ],
    });

    const service = createSqliteWorkGraphContainmentQueryService(db);
    const result = service.readyFrontier({ rootId: 'E1', role: 'worker' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('ready_frontier_scope');
    expect(db.prepared[0]?.sql).toContain('t.role = ?');
    expect(db.prepared[0]?.params).toEqual(['E1', 'E1', 'worker']);
    expect(result.groups.ready.map((task) => task.id)).toEqual(['T-ready']);
    expect(result.groups.blocked.map((task) => task.id)).toEqual(['T-blocked']);
    expect(result.groups.ready[0]?.gateBlockers.map((blocker) => blocker.gate)).toEqual([
      'implemented',
      'testsPassed',
      'qaPassed',
    ]);
    expect(result.groups.blocked[0]?.dependencyBlockers).toEqual([
      { taskId: 'T-open', status: 'active' },
    ]);
    expect(result.groups.blockedBy).toEqual([
      {
        kind: 'dependency',
        blockerId: 'T-open',
        blocks: ['T-blocked'],
      },
      {
        kind: 'gate',
        gate: 'implemented',
        blocks: ['T-ready'],
      },
      {
        kind: 'gate',
        gate: 'qaPassed',
        blocks: ['T-ready', 'T-blocked'],
      },
      {
        kind: 'gate',
        gate: 'testsPassed',
        blocks: ['T-ready', 'T-blocked'],
      },
    ]);
  });
});
