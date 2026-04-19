/**
 * Unit tests for the pure helpers exposed by {@link GraphTab}.
 *
 * We cannot mount the Svelte component itself under `environment: 'node'`
 * (no jsdom), but every piece of business logic — node projection, edge
 * projection, filter application, blocked-halo detection, click handler —
 * is exposed as a pure export on the component module so it can be unit
 * tested here.
 *
 * Covers:
 *
 * 1. `buildGraphNodes` distinguishes epic vs non-epic via `type`.
 * 2. `buildGraphEdges` emits all 3 kinds (`parent`, `blocks`, `depends`).
 * 3. `passesFilter` honours every field in {@link TaskFilterState}.
 * 4. `isBlocked` flags pending tasks whose inbound deps aren't done.
 * 5. `clickNode` invokes `filters.setSelected`.
 * 6. `edgeDash` returns distinct patterns per edge kind (regression guard
 *    for the "preserve 3 edge kinds" acceptance criterion).
 * 7. `nodeFill` returns the canonical palette for every task status.
 *
 * @task T954
 * @epic T949
 */

import type { Task, TaskPriority, TaskStatus } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';

import type { TaskDependencyEdge } from '../../../server/tasks/explorer-loader.js';
import type { TaskFilterState } from '../../../stores/task-filters.svelte.js';
import {
  buildGraphEdges,
  buildGraphNodes,
  clickNode,
  edgeDash,
  edgeStroke,
  isBlocked,
  nodeFill,
  passesFilter,
} from '../GraphTab.svelte';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function task(partial: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: partial.id,
    title: partial.title,
    description: partial.description ?? `Desc ${partial.id}`,
    status: partial.status ?? ('pending' as TaskStatus),
    priority: partial.priority ?? ('medium' as TaskPriority),
    type: partial.type,
    parentId: partial.parentId,
    labels: partial.labels,
    blockedBy: partial.blockedBy,
    acceptance: partial.acceptance,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

function emptyFilters(overrides: Partial<TaskFilterState> = {}): TaskFilterState {
  return {
    query: '',
    status: [],
    priority: [],
    labels: [],
    epic: null,
    selected: null,
    cancelled: false,
    view: 'graph',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildGraphNodes
// ---------------------------------------------------------------------------

describe('buildGraphNodes', () => {
  it('projects every task into a GraphNode preserving the input order', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Epic', type: 'epic' }),
      task({ id: 'T2', title: 'Task A', type: 'task' }),
      task({ id: 'T3', title: 'Subtask A1', type: 'subtask', parentId: 'T2' }),
    ];
    const nodes = buildGraphNodes(tasks, []);
    expect(nodes.map((n) => n.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('distinguishes epic from task via the `type` field', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Epic 1', type: 'epic' }),
      task({ id: 'T2', title: 'Task 1', type: 'task' }),
    ];
    const nodes = buildGraphNodes(tasks, []);
    expect(nodes.find((n) => n.id === 'T1')?.type).toBe('epic');
    expect(nodes.find((n) => n.id === 'T2')?.type).toBe('task');
  });

  it('marks a pending task with an unmet inbound dep as `blocked: true`', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Blocker', status: 'active' }),
      task({ id: 'T2', title: 'Dependent', status: 'pending' }),
    ];
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    const nodes = buildGraphNodes(tasks, deps);
    expect(nodes.find((n) => n.id === 'T2')?.blocked).toBe(true);
    expect(nodes.find((n) => n.id === 'T1')?.blocked).toBe(false);
  });

  it('does NOT mark a task as blocked when all inbound deps are done', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Blocker', status: 'done' }),
      task({ id: 'T2', title: 'Dependent', status: 'pending' }),
    ];
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    const nodes = buildGraphNodes(tasks, deps);
    expect(nodes.find((n) => n.id === 'T2')?.blocked).toBe(false);
  });

  it('normalises missing parentId to null', () => {
    const tasks: Task[] = [task({ id: 'T1', title: 'Root' })];
    const nodes = buildGraphNodes(tasks, []);
    expect(nodes[0]?.parentId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildGraphEdges — 3 edge kinds preserved
// ---------------------------------------------------------------------------

describe('buildGraphEdges', () => {
  it('emits a parent edge from parentId → task for every visible child', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Epic', type: 'epic' }),
      task({ id: 'T2', title: 'Child A', type: 'task', parentId: 'T1' }),
      task({ id: 'T3', title: 'Child B', type: 'task', parentId: 'T1' }),
    ];
    const edges = buildGraphEdges(tasks, [], new Set(['T1', 'T2', 'T3']));
    const parents = edges.filter((e) => e.kind === 'parent');
    expect(parents).toHaveLength(2);
    expect(parents.map((e) => `${e.source}>${e.target}`).sort()).toEqual(['T1>T2', 'T1>T3']);
  });

  it('emits a blocks edge for each CSV-encoded blockedBy id', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Blocker 1' }),
      task({ id: 'T2', title: 'Blocker 2' }),
      task({ id: 'T3', title: 'Blocked', blockedBy: 'T1,T2' }),
    ];
    const edges = buildGraphEdges(tasks, [], new Set(['T1', 'T2', 'T3']));
    const blocks = edges.filter((e) => e.kind === 'blocks');
    expect(blocks).toHaveLength(2);
    expect(blocks.every((e) => e.target === 'T3')).toBe(true);
  });

  it('emits a blocks edge for each JSON-array blockedBy entry', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Blocker' }),
      task({ id: 'T2', title: 'Blocked', blockedBy: '["T1"]' }),
    ];
    const edges = buildGraphEdges(tasks, [], new Set(['T1', 'T2']));
    const blocks = edges.filter((e) => e.kind === 'blocks');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ source: 'T1', target: 'T2', kind: 'blocks' });
  });

  it('emits a depends edge for every task_dependencies row', () => {
    const tasks: Task[] = [task({ id: 'T1', title: 'A' }), task({ id: 'T2', title: 'B' })];
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    const edges = buildGraphEdges(tasks, deps, new Set(['T1', 'T2']));
    const depends = edges.filter((e) => e.kind === 'depends');
    expect(depends).toHaveLength(1);
    expect(depends[0]).toMatchObject({ source: 'T1', target: 'T2', kind: 'depends' });
  });

  it('preserves all 3 edge kinds simultaneously', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Epic', type: 'epic' }),
      task({ id: 'T2', title: 'Child', type: 'task', parentId: 'T1', blockedBy: 'T3' }),
      task({ id: 'T3', title: 'Blocker' }),
    ];
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T3' }];
    const edges = buildGraphEdges(tasks, deps, new Set(['T1', 'T2', 'T3']));
    const kinds = new Set(edges.map((e) => e.kind));
    expect(kinds).toEqual(new Set(['parent', 'blocks', 'depends']));
  });

  it('drops edges whose endpoints are not in the visible set', () => {
    const tasks: Task[] = [
      task({ id: 'T1', title: 'Epic', type: 'epic' }),
      task({ id: 'T2', title: 'Child', type: 'task', parentId: 'T1' }),
    ];
    // T1 hidden → parent edge should be dropped.
    const edges = buildGraphEdges(tasks, [], new Set(['T2']));
    expect(edges).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// passesFilter
// ---------------------------------------------------------------------------

describe('passesFilter (node visibility)', () => {
  it('returns true for an unfiltered default state', () => {
    expect(passesFilter(task({ id: 'T1', title: 'A' }), emptyFilters())).toBe(true);
  });

  it('matches query substring against id', () => {
    const t = task({ id: 'T1234', title: 'Something Else' });
    expect(passesFilter(t, emptyFilters({ query: '123' }))).toBe(true);
    expect(passesFilter(t, emptyFilters({ query: 'nope' }))).toBe(false);
  });

  it('matches query substring against title case-insensitively', () => {
    const t = task({ id: 'T1', title: 'Pomodoro Timer' });
    expect(passesFilter(t, emptyFilters({ query: 'POMO' }))).toBe(true);
    expect(passesFilter(t, emptyFilters({ query: 'timer' }))).toBe(true);
  });

  it('filters by status membership', () => {
    const t = task({ id: 'T1', title: 'A', status: 'active' });
    expect(passesFilter(t, emptyFilters({ status: ['active'] }))).toBe(true);
    expect(passesFilter(t, emptyFilters({ status: ['pending'] }))).toBe(false);
  });

  it('filters by priority membership', () => {
    const t = task({ id: 'T1', title: 'A', priority: 'high' });
    expect(passesFilter(t, emptyFilters({ priority: ['high'] }))).toBe(true);
    expect(passesFilter(t, emptyFilters({ priority: ['low'] }))).toBe(false);
  });

  it('keeps a task that has at least one matching label', () => {
    const t = task({ id: 'T1', title: 'A', labels: ['studio', 'ui'] });
    expect(passesFilter(t, emptyFilters({ labels: ['ui'] }))).toBe(true);
    expect(passesFilter(t, emptyFilters({ labels: ['backend'] }))).toBe(false);
  });

  it('hides cancelled epics by default and surfaces them when cancelled=true', () => {
    const epic = task({ id: 'T1', title: 'E', type: 'epic', status: 'cancelled' });
    expect(passesFilter(epic, emptyFilters({ cancelled: false }))).toBe(false);
    expect(passesFilter(epic, emptyFilters({ cancelled: true }))).toBe(true);
  });

  it('does NOT hide cancelled non-epic tasks (they stay visible with grey colour)', () => {
    const t = task({ id: 'T1', title: 'A', type: 'task', status: 'cancelled' });
    expect(passesFilter(t, emptyFilters({ cancelled: false }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isBlocked
// ---------------------------------------------------------------------------

describe('isBlocked (blocked halo semantics)', () => {
  const tasksById = (list: Task[]): Map<string, Task> => new Map(list.map((t) => [t.id, t]));

  it('returns false for a non-pending task', () => {
    const t = task({ id: 'T1', title: 'A', status: 'active' });
    expect(isBlocked(t, [{ taskId: 'T1', dependsOn: 'T2' }], tasksById([t]))).toBe(false);
  });

  it('returns true for a pending task with a non-done inbound dep', () => {
    const blocker = task({ id: 'T1', title: 'Blocker', status: 'active' });
    const blocked = task({ id: 'T2', title: 'Blocked', status: 'pending' });
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    expect(isBlocked(blocked, deps, tasksById([blocker, blocked]))).toBe(true);
  });

  it('returns false when every inbound dep is done', () => {
    const blocker = task({ id: 'T1', title: 'Blocker', status: 'done' });
    const blocked = task({ id: 'T2', title: 'Blocked', status: 'pending' });
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T1' }];
    expect(isBlocked(blocked, deps, tasksById([blocker, blocked]))).toBe(false);
  });

  it('treats a missing blocker lookup as non-blocking (defensive)', () => {
    const t = task({ id: 'T2', title: 'Orphan', status: 'pending' });
    const deps: TaskDependencyEdge[] = [{ taskId: 'T2', dependsOn: 'T_MISSING' }];
    expect(isBlocked(t, deps, tasksById([t]))).toBe(false);
  });

  it('returns false for a pending task with no inbound deps at all', () => {
    const t = task({ id: 'T1', title: 'Solo', status: 'pending' });
    expect(isBlocked(t, [], tasksById([t]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// clickNode — invokes filters.setSelected
// ---------------------------------------------------------------------------

describe('clickNode', () => {
  it('invokes filters.setSelected with the clicked node id', () => {
    const setSelected = vi.fn<(id: string | null) => void>();
    clickNode({ setSelected }, 'T1234');
    expect(setSelected).toHaveBeenCalledExactlyOnceWith('T1234');
  });
});

// ---------------------------------------------------------------------------
// Edge visual encoding — regression guard for "preserve 3 edge kinds"
// ---------------------------------------------------------------------------

describe('edge visual encoding', () => {
  it('returns a distinct stroke colour for each kind', () => {
    const parent = edgeStroke('parent');
    const blocks = edgeStroke('blocks');
    const depends = edgeStroke('depends');
    expect(new Set([parent, blocks, depends]).size).toBe(3);
  });

  it('returns a distinct dash pattern per kind: parent solid, blocks heavy, depends dotted', () => {
    expect(edgeDash('parent')).toBeNull();
    expect(edgeDash('blocks')).toBe('4 4');
    expect(edgeDash('depends')).toBe('2 3');
  });
});

// ---------------------------------------------------------------------------
// Node visual encoding
// ---------------------------------------------------------------------------

describe('nodeFill', () => {
  it('returns the canonical palette for every supported status', () => {
    expect(nodeFill('pending')).toBe('#f59e0b');
    expect(nodeFill('active')).toBe('#3b82f6');
    expect(nodeFill('blocked')).toBe('#ef4444');
    expect(nodeFill('done')).toBe('#22c55e');
    expect(nodeFill('cancelled')).toBe('#6b7280');
    expect(nodeFill('archived')).toBe('#475569');
    expect(nodeFill('proposed')).toBe('#a855f7');
  });
});
