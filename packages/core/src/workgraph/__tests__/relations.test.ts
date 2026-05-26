/**
 * T10582 WorkGraph relation edge query service acceptance coverage.
 *
 * Locks direction filters, relation reasons, and relation-vs-dependency source
 * separation for direct WorkGraph edge reads.
 *
 * @task T10582
 * @saga T10538
 */

import { describe, expect, it } from 'vitest';
import { createSqliteWorkGraphRelationQueryService } from '../index.js';

type RelationRow = {
  task_id: string;
  related_to: string;
  relation_type:
    | 'related'
    | 'blocks'
    | 'duplicates'
    | 'absorbs'
    | 'fixes'
    | 'extends'
    | 'supersedes'
    | 'groups';
  reason: string | null;
};

type DependencyRow = {
  task_id: string;
  depends_on: string;
};

type Row = RelationRow | DependencyRow;

type Statement = {
  all(...params: readonly unknown[]): Row[];
};

type PreparedQuery = {
  readonly sql: string;
  readonly params: readonly string[];
};

class FakeDb {
  readonly prepared: PreparedQuery[] = [];

  constructor(
    private readonly rowsByTable: {
      relations?: RelationRow[];
      dependencies?: DependencyRow[];
    },
  ) {}

  prepare(sql: string): Statement {
    return {
      all: (...params: readonly unknown[]) => {
        this.prepared.push({ sql, params: params.map(String) });
        if (sql.includes('FROM task_dependencies')) return this.rowsByTable.dependencies ?? [];
        return this.rowsByTable.relations ?? [];
      },
    };
  }
}

describe('SqliteWorkGraphRelationQueryService', () => {
  it('lists outgoing task_relations with stored reasons and without dependencies by default', () => {
    const db = new FakeDb({
      relations: [
        {
          task_id: 'T1',
          related_to: 'T2',
          relation_type: 'blocks',
          reason: 'T2 cannot start until the API shape lands',
        },
      ],
      dependencies: [{ task_id: 'T1', depends_on: 'T0' }],
    });

    const service = createSqliteWorkGraphRelationQueryService(db);
    const result = service.listRelationEdges({ rootId: 'T1', direction: 'out' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('FROM task_relations');
    expect(db.prepared[0]?.sql).toContain('WHERE task_id = ?');
    expect(db.prepared[0]?.sql).not.toContain('task_dependencies');
    expect(db.prepared[0]?.params).toEqual(['T1']);
    expect(result).toEqual({
      rootId: 'T1',
      direction: 'out',
      edges: [
        {
          fromId: 'T1',
          toId: 'T2',
          kind: 'blocks',
          source: 'relation',
          relationType: 'blocks',
          reason: 'T2 cannot start until the API shape lands',
        },
      ],
    });
  });

  it('lists incoming relation edges and maps null reasons to undefined', () => {
    const db = new FakeDb({
      relations: [
        {
          task_id: 'T9',
          related_to: 'T1',
          relation_type: 'groups',
          reason: null,
        },
      ],
    });

    const service = createSqliteWorkGraphRelationQueryService(db);
    const result = service.listRelationEdges({ rootId: 'T1', direction: 'in' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('WHERE related_to = ?');
    expect(db.prepared[0]?.params).toEqual(['T1']);
    expect(result.edges).toEqual([
      {
        fromId: 'T9',
        toId: 'T1',
        kind: 'groups',
        source: 'relation',
        relationType: 'groups',
        reason: undefined,
      },
    ]);
  });

  it('defaults to both directions and preserves advisory relation semantics', () => {
    const db = new FakeDb({
      relations: [
        { task_id: 'T1', related_to: 'T2', relation_type: 'fixes', reason: 'bug fix linkage' },
        { task_id: 'T3', related_to: 'T1', relation_type: 'duplicates', reason: 'same scope' },
      ],
    });

    const service = createSqliteWorkGraphRelationQueryService(db);
    const result = service.listRelationEdges({ rootId: 'T1' });

    expect(db.prepared).toHaveLength(1);
    expect(db.prepared[0]?.sql).toContain('WHERE (task_id = ? OR related_to = ?)');
    expect(db.prepared[0]?.params).toEqual(['T1', 'T1']);
    expect(result.direction).toBe('both');
    expect(result.edges).toEqual([
      {
        fromId: 'T1',
        toId: 'T2',
        kind: 'relates_to',
        source: 'relation',
        relationType: 'fixes',
        reason: 'bug fix linkage',
      },
      {
        fromId: 'T3',
        toId: 'T1',
        kind: 'relates_to',
        source: 'relation',
        relationType: 'duplicates',
        reason: 'same scope',
      },
    ]);
  });

  it('keeps dependencies opt-in and tags them separately from relation rows', () => {
    const db = new FakeDb({
      relations: [
        { task_id: 'T1', related_to: 'T2', relation_type: 'related', reason: 'see also' },
      ],
      dependencies: [{ task_id: 'T1', depends_on: 'T0' }],
    });

    const service = createSqliteWorkGraphRelationQueryService(db);
    const result = service.listRelationEdges({
      rootId: 'T1',
      direction: 'both',
      includeDependencies: true,
    });

    expect(db.prepared).toHaveLength(2);
    expect(db.prepared[0]?.sql).toContain('FROM task_relations');
    expect(db.prepared[1]?.sql).toContain('FROM task_dependencies');
    expect(db.prepared[1]?.sql).toContain('WHERE (task_id = ? OR depends_on = ?)');
    expect(result.edges).toEqual([
      {
        fromId: 'T1',
        toId: 'T2',
        kind: 'relates_to',
        source: 'relation',
        relationType: 'related',
        reason: 'see also',
      },
      {
        fromId: 'T1',
        toId: 'T0',
        kind: 'depends_on',
        source: 'dependency',
      },
    ]);
  });
});
