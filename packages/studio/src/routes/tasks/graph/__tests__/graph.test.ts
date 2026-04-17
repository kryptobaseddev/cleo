/**
 * Tests for T879 — Tasks Relations Graph server-side builder.
 *
 * Verifies `_computeGraph`:
 *   (a) Emits parent-id hierarchy edges.
 *   (b) Emits blocked_by overlay edges (handles both CSV and JSON array).
 *   (c) Emits depends edges from task_dependencies.
 *   (d) Excludes archived tasks by default; includes them with
 *       `includeArchived: true`.
 *   (e) Supports `epicSubtree` to restrict the graph to a single epic's
 *       reachable descendants.
 *   (f) Handles empty DBs without crashing.
 *
 * @task T879
 * @epic T876 (owner-labelled T900)
 */

import { createRequire } from 'node:module';
import type { DatabaseSync as _DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _computeGraph, type GraphDbLike } from '../+page.server.js';

const _require = createRequire(import.meta.url);
type DatabaseSync = _DatabaseSyncType;
const { DatabaseSync } = _require('node:sqlite') as {
  DatabaseSync: new (...args: ConstructorParameters<typeof _DatabaseSyncType>) => DatabaseSync;
};

let db: DatabaseSync;

const CREATE_TASKS = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    type TEXT,
    parent_id TEXT,
    pipeline_stage TEXT,
    blocked_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE task_dependencies (
    task_id TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    PRIMARY KEY (task_id, depends_on)
  );
`;

function insertTask(row: {
  id: string;
  title?: string;
  status?: string;
  type?: string;
  parent_id?: string | null;
  blocked_by?: string | null;
}): void {
  db.prepare(
    `INSERT INTO tasks (id, title, status, type, parent_id, blocked_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.title ?? `Task ${row.id}`,
    row.status ?? 'pending',
    row.type ?? 'task',
    row.parent_id ?? null,
    row.blocked_by ?? null,
  );
}

function insertDep(taskId: string, dependsOn: string): void {
  db.prepare(`INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)`).run(
    taskId,
    dependsOn,
  );
}

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  db.exec(CREATE_TASKS);
});

afterEach(() => {
  db.close();
});

describe('_computeGraph (T879)', () => {
  it('returns empty graph for empty DB', () => {
    const g = _computeGraph(db as unknown as GraphDbLike);
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
    expect(g.counts).toEqual({ nodes: 0, parentEdges: 0, blocksEdges: 0, dependsEdges: 0 });
  });

  it('emits parent edges for EPIC→TASK→SUBTASK hierarchy', () => {
    insertTask({ id: 'E1', type: 'epic' });
    insertTask({ id: 'T1', type: 'task', parent_id: 'E1' });
    insertTask({ id: 'S1', type: 'subtask', parent_id: 'T1' });

    const g = _computeGraph(db as unknown as GraphDbLike);

    expect(g.nodes).toHaveLength(3);
    expect(g.edges.filter((e) => e.kind === 'parent')).toEqual([
      { source: 'E1', target: 'T1', kind: 'parent' },
      { source: 'T1', target: 'S1', kind: 'parent' },
    ]);
  });

  it('emits blocked_by edges (CSV format)', () => {
    insertTask({ id: 'A' });
    insertTask({ id: 'B' });
    insertTask({ id: 'C', blocked_by: 'A,B' });

    const g = _computeGraph(db as unknown as GraphDbLike);

    const blocksEdges = g.edges.filter((e) => e.kind === 'blocks');
    expect(blocksEdges).toEqual(
      expect.arrayContaining([
        { source: 'A', target: 'C', kind: 'blocks' },
        { source: 'B', target: 'C', kind: 'blocks' },
      ]),
    );
  });

  it('emits blocked_by edges (JSON array format)', () => {
    insertTask({ id: 'A' });
    insertTask({ id: 'B' });
    insertTask({ id: 'C', blocked_by: '["A","B"]' });

    const g = _computeGraph(db as unknown as GraphDbLike);

    const blocksEdges = g.edges.filter((e) => e.kind === 'blocks');
    expect(blocksEdges).toHaveLength(2);
  });

  it('emits depends edges from task_dependencies', () => {
    insertTask({ id: 'X' });
    insertTask({ id: 'Y' });
    insertDep('Y', 'X'); // Y depends on X

    const g = _computeGraph(db as unknown as GraphDbLike);

    expect(g.edges.filter((e) => e.kind === 'depends')).toEqual([
      { source: 'X', target: 'Y', kind: 'depends' },
    ]);
  });

  it('excludes archived tasks by default', () => {
    insertTask({ id: 'A', status: 'pending' });
    insertTask({ id: 'B', status: 'archived' });

    const g = _computeGraph(db as unknown as GraphDbLike);

    expect(g.nodes.map((n) => n.id)).toEqual(['A']);
  });

  it('includes archived tasks when includeArchived=true', () => {
    insertTask({ id: 'A', status: 'pending' });
    insertTask({ id: 'B', status: 'archived' });

    const g = _computeGraph(db as unknown as GraphDbLike, { includeArchived: true });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['A', 'B']);
  });

  it('restricts graph to a single epic subtree via epicSubtree', () => {
    insertTask({ id: 'E1', type: 'epic' });
    insertTask({ id: 'E2', type: 'epic' });
    insertTask({ id: 'T1', type: 'task', parent_id: 'E1' });
    insertTask({ id: 'T2', type: 'task', parent_id: 'E2' });
    insertTask({ id: 'S1', type: 'subtask', parent_id: 'T1' });

    const g = _computeGraph(db as unknown as GraphDbLike, { epicSubtree: 'E1' });

    expect(g.nodes.map((n) => n.id).sort()).toEqual(['E1', 'S1', 'T1'].sort());
    // No E2/T2 edges should leak in either.
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.source))).toBe(true);
    expect(g.edges.every((e) => g.nodes.some((n) => n.id === e.target))).toBe(true);
  });

  it('filters out overlay edges whose endpoints are not in the node set', () => {
    // When epicSubtree restricts nodes, depends/blocks edges to tasks
    // outside that subtree must be dropped.
    insertTask({ id: 'E1', type: 'epic' });
    insertTask({ id: 'T_in', type: 'task', parent_id: 'E1' });
    insertTask({ id: 'T_out', type: 'task' }); // no parent, not in E1 subtree
    insertDep('T_in', 'T_out'); // T_in depends on T_out

    const g = _computeGraph(db as unknown as GraphDbLike, { epicSubtree: 'E1' });

    // T_out is not in the subtree, so the depends edge is dropped.
    expect(g.edges.filter((e) => e.kind === 'depends')).toEqual([]);
  });

  it('populates counts correctly', () => {
    insertTask({ id: 'E1', type: 'epic' });
    insertTask({ id: 'A', parent_id: 'E1' });
    insertTask({ id: 'B', parent_id: 'E1', blocked_by: 'A' });
    insertDep('B', 'A');

    const g = _computeGraph(db as unknown as GraphDbLike);

    expect(g.counts).toEqual({
      nodes: 3,
      parentEdges: 2,
      blocksEdges: 1,
      dependsEdges: 1,
    });
  });
});
