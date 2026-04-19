/**
 * Unit tests for the shared Tasks → Graph kit adapter.
 *
 * The adapter is pure (no DOM / d3 deps) so all behaviour is covered
 * here without mounting a Svelte component. Vitest runs the studio
 * package in `environment: 'node'` — see `vitest.config.ts`.
 *
 * Coverage:
 *
 * 1. `parseBlockedBy` handles CSV + JSON + trimming + dedupe.
 * 2. `findRootEpicId` walks parent pointers to the outermost epic.
 * 3. `tasksToGraph` emits all 3 edge kinds.
 * 4. `tasksToGraph` scopes to a subtree when `epicScope` is set.
 * 5. `tasksToGraph` filters cancelled epics / archived tasks unless
 *    explicitly included.
 * 6. `tasksToGraph` assigns every node a stable `category` = root epic.
 * 7. Clusters group tasks by root epic (minimum 3 members).
 * 8. `tasksToEgoGraph` emits the 1-hop upstream + downstream and flags
 *    the focal node via `meta.focal`.
 *
 * @task T990
 * @wave 1C
 */

import type { Task, TaskPriority, TaskStatus, TaskType } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';

import type { TaskDependencyEdge } from '../../../server/tasks/explorer-loader.js';
import { findRootEpicId, parseBlockedBy, tasksToEgoGraph, tasksToGraph } from '../tasks-adapter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkTask(partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: partial.id,
    title: partial.title,
    description: partial.description ?? `Desc ${partial.id}`,
    status: (partial.status ?? 'pending') as TaskStatus,
    priority: (partial.priority ?? 'medium') as TaskPriority,
    type: partial.type as TaskType | undefined,
    parentId: partial.parentId,
    labels: partial.labels,
    blockedBy: partial.blockedBy,
    acceptance: partial.acceptance,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: partial.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// parseBlockedBy
// ---------------------------------------------------------------------------

describe('parseBlockedBy', () => {
  it('returns an empty array for null / empty inputs', () => {
    expect(parseBlockedBy(null)).toEqual([]);
    expect(parseBlockedBy(undefined)).toEqual([]);
    expect(parseBlockedBy('')).toEqual([]);
    expect(parseBlockedBy('   ')).toEqual([]);
  });

  it('parses comma-separated id lists', () => {
    expect(parseBlockedBy('T1, T2,  T3')).toEqual(['T1', 'T2', 'T3']);
  });

  it('parses JSON array literals', () => {
    expect(parseBlockedBy('["T1","T2"]')).toEqual(['T1', 'T2']);
  });

  it('deduplicates entries', () => {
    expect(parseBlockedBy('T1,T2,T1')).toEqual(['T1', 'T2']);
    expect(parseBlockedBy('["T1","T2","T1"]')).toEqual(['T1', 'T2']);
  });

  it('falls back to CSV when JSON is malformed', () => {
    expect(parseBlockedBy('[T1,T2]')).toEqual(['[T1', 'T2]']);
  });
});

// ---------------------------------------------------------------------------
// findRootEpicId
// ---------------------------------------------------------------------------

describe('findRootEpicId', () => {
  it('returns the task id itself when the task is an epic without a parent', () => {
    const t = mkTask({ id: 'T1', title: 'Epic', type: 'epic' });
    const byId = new Map<string, Task>([[t.id, t]]);
    expect(findRootEpicId(t, byId)).toBe('T1');
  });

  it('walks to the outermost epic ancestor', () => {
    const root = mkTask({ id: 'E1', title: 'Epic', type: 'epic' });
    const mid = mkTask({ id: 'T1', title: 'Task', parentId: 'E1' });
    const leaf = mkTask({ id: 'S1', title: 'Sub', parentId: 'T1' });
    const byId = new Map([root, mid, leaf].map((t) => [t.id, t]));
    expect(findRootEpicId(leaf, byId)).toBe('E1');
  });

  it('returns null when no epic exists in the chain', () => {
    const root = mkTask({ id: 'T1', title: 'Task' });
    const child = mkTask({ id: 'T2', title: 'Sub', parentId: 'T1' });
    const byId = new Map([root, child].map((t) => [t.id, t]));
    expect(findRootEpicId(child, byId)).toBeNull();
  });

  it('guards against cycles', () => {
    const a = mkTask({ id: 'T1', title: 'A', parentId: 'T2' });
    const b = mkTask({ id: 'T2', title: 'B', parentId: 'T1' });
    const byId = new Map([a, b].map((t) => [t.id, t]));
    // Should not loop forever.
    expect(findRootEpicId(a, byId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// tasksToGraph
// ---------------------------------------------------------------------------

describe('tasksToGraph', () => {
  it('emits nodes + parent edges from the parentId field', () => {
    const epic = mkTask({ id: 'E1', title: 'Epic', type: 'epic' });
    const child = mkTask({ id: 'T1', title: 'Task', parentId: 'E1' });
    const { nodes, edges } = tasksToGraph([epic, child], []);
    expect(nodes.map((n) => n.id)).toEqual(['E1', 'T1']);
    expect(edges.filter((e) => e.kind === 'parent')).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: 'E1',
      target: 'T1',
      kind: 'parent',
    });
  });

  it('emits blocks edges from the blockedBy field (CSV)', () => {
    const a = mkTask({ id: 'T1', title: 'A' });
    const b = mkTask({ id: 'T2', title: 'B', blockedBy: 'T1' });
    const { edges } = tasksToGraph([a, b], []);
    const blocks = edges.filter((e) => e.kind === 'blocks');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ source: 'T1', target: 'T2', kind: 'blocks' });
  });

  it('emits depends edges from the task_dependencies table', () => {
    const a = mkTask({ id: 'T1', title: 'A' });
    const b = mkTask({ id: 'T2', title: 'B' });
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    const { edges } = tasksToGraph([a, b], deps);
    const depends = edges.filter((e) => e.kind === 'depends');
    expect(depends).toHaveLength(1);
    expect(depends[0]).toMatchObject({ source: 'T1', target: 'T2', kind: 'depends' });
  });

  it('scopes to a subtree when epicScope is set', () => {
    const e1 = mkTask({ id: 'E1', title: 'Epic1', type: 'epic' });
    const e2 = mkTask({ id: 'E2', title: 'Epic2', type: 'epic' });
    const t1 = mkTask({ id: 'T1', title: 'T1', parentId: 'E1' });
    const t2 = mkTask({ id: 'T2', title: 'T2', parentId: 'E2' });
    const { nodes } = tasksToGraph([e1, e2, t1, t2], [], { epicScope: 'E1' });
    expect(nodes.map((n) => n.id).sort()).toEqual(['E1', 'T1']);
  });

  it('hides cancelled epics by default and includes them when asked', () => {
    const cancelled = mkTask({
      id: 'E1',
      title: 'Cancelled epic',
      type: 'epic',
      status: 'cancelled',
    });
    const active = mkTask({ id: 'T1', title: 'Active task' });
    const defaultResult = tasksToGraph([cancelled, active], []);
    expect(defaultResult.nodes.map((n) => n.id)).toEqual(['T1']);

    const inclusive = tasksToGraph([cancelled, active], [], { includeCancelled: true });
    expect(inclusive.nodes.map((n) => n.id).sort()).toEqual(['E1', 'T1']);
  });

  it('hides archived tasks by default', () => {
    const archived = mkTask({ id: 'T1', title: 'A', status: 'archived' });
    const live = mkTask({ id: 'T2', title: 'B' });
    const { nodes } = tasksToGraph([archived, live], []);
    expect(nodes.map((n) => n.id)).toEqual(['T2']);
  });

  it('assigns every projected node a category = root epic id', () => {
    const epic = mkTask({ id: 'E1', title: 'Epic', type: 'epic' });
    const child = mkTask({ id: 'T1', title: 'Task', parentId: 'E1' });
    const { nodes } = tasksToGraph([epic, child], []);
    const childNode = nodes.find((n) => n.id === 'T1');
    expect(childNode?.category).toBe('E1');
  });

  it('emits clusters for epics with 3+ descendants', () => {
    const epic = mkTask({ id: 'E1', title: 'Epic', type: 'epic' });
    const kids = [
      mkTask({ id: 'T1', title: '1', parentId: 'E1' }),
      mkTask({ id: 'T2', title: '2', parentId: 'E1' }),
      mkTask({ id: 'T3', title: '3', parentId: 'E1' }),
    ];
    const { clusters } = tasksToGraph([epic, ...kids], []);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].id).toBe('E1');
    expect(clusters[0].memberIds.sort()).toEqual(['E1', 'T1', 'T2', 'T3']);
  });

  it('filters out singleton clusters', () => {
    const epic = mkTask({ id: 'E1', title: 'Epic', type: 'epic' });
    const child = mkTask({ id: 'T1', title: '1', parentId: 'E1' });
    const { clusters } = tasksToGraph([epic, child], []);
    expect(clusters).toHaveLength(0);
  });

  it('attaches blocked=true meta when a pending task has unmet blockers', () => {
    const blocker = mkTask({ id: 'T1', title: 'Blocker', status: 'pending' });
    const blocked = mkTask({ id: 'T2', title: 'Blocked', status: 'pending', blockedBy: 'T1' });
    const { nodes } = tasksToGraph([blocker, blocked], []);
    const blockedNode = nodes.find((n) => n.id === 'T2');
    expect(blockedNode?.meta?.['blocked']).toBe(true);
  });

  it('does not mark a task blocked when its blocker is done', () => {
    const blocker = mkTask({ id: 'T1', title: 'Blocker', status: 'done' });
    const blocked = mkTask({ id: 'T2', title: 'Blocked', status: 'pending', blockedBy: 'T1' });
    const { nodes } = tasksToGraph([blocker, blocked], []);
    const blockedNode = nodes.find((n) => n.id === 'T2');
    expect(blockedNode?.meta?.['blocked']).toBeUndefined();
  });

  it('de-duplicates tasks by id', () => {
    const a = mkTask({ id: 'T1', title: 'Original' });
    const b = mkTask({ id: 'T1', title: 'Duplicate' });
    const { nodes } = tasksToGraph([a, b], []);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].label).toBe('Original');
  });
});

// ---------------------------------------------------------------------------
// tasksToEgoGraph
// ---------------------------------------------------------------------------

describe('tasksToEgoGraph', () => {
  it('returns an empty bundle when the focus id is unknown', () => {
    const a = mkTask({ id: 'T1', title: 'A' });
    const result = tasksToEgoGraph([a], [], { focusId: 'MISSING' });
    expect(result.nodes).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });

  it('emits upstream + downstream within 1 hop by default', () => {
    const a = mkTask({ id: 'T1', title: 'Upstream' });
    const b = mkTask({ id: 'T2', title: 'Focal' });
    const c = mkTask({ id: 'T3', title: 'Downstream' });
    const deps: TaskDependencyEdge[] = [
      { taskId: 'T2', dependsOn: 'T1' },
      { taskId: 'T3', dependsOn: 'T2' },
    ];
    const result = tasksToEgoGraph([a, b, c], deps, { focusId: 'T2' });
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['T1', 'T2', 'T3']);
    const focal = result.nodes.find((n) => n.id === 'T2');
    expect(focal?.meta?.['focal']).toBe(true);
  });

  it('does NOT leak nodes beyond 1 hop unless requested', () => {
    const a = mkTask({ id: 'T1', title: 'Up-up' });
    const b = mkTask({ id: 'T2', title: 'Up' });
    const c = mkTask({ id: 'T3', title: 'Focal' });
    const deps: TaskDependencyEdge[] = [
      { taskId: 'T2', dependsOn: 'T1' },
      { taskId: 'T3', dependsOn: 'T2' },
    ];
    const result = tasksToEgoGraph([a, b, c], deps, { focusId: 'T3' });
    expect(result.nodes.map((n) => n.id).sort()).toEqual(['T2', 'T3']);
  });
});
