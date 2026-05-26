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
  all(...params: readonly string[]): Row[];
};

type PreparedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

type Row = {
  root_id: string;
  depth?: number;
  id: string;
  title: string;
  type: 'epic' | 'task' | 'subtask';
  status: 'pending' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  parent_id: string | null;
};

class FakeDb {
  readonly prepared: PreparedQuery[] = [];

  constructor(private readonly rowsByKind: { ancestors?: Row[]; children?: Row[] }) {}

  prepare(sql: string): Statement<Row> {
    return {
      all: (...params: readonly string[]) => {
        this.prepared.push({ sql, params });
        return sql.includes('ancestor_edges')
          ? (this.rowsByKind.ancestors ?? [])
          : (this.rowsByKind.children ?? []);
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
          status: 'in_progress',
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
            status: 'in_progress',
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
});
