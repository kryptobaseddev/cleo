/**
 * Unit tests for the Kanban bucketing logic that drives {@link KanbanTab}
 * (T955 · W1C of T949).
 *
 * vitest runs the studio package in `environment: 'node'` so `.svelte`
 * files are not mountable here (see `packages/studio/vitest.config.ts`).
 * That's fine: the bucketing algorithm is 100% pure — see
 * `packages/studio/src/lib/components/tasks/kanban-bucketing.ts`.
 *
 * Covers the six acceptance criteria from T955 spec:
 *
 * 1. Correct status-column bucketing
 * 2. Within-column epic grouping walks `parentId` to the root epic
 * 3. Root-parented (no-epic) tasks land in the `No epic` group
 * 4. Query / priority / label filters narrow within-column visibility
 * 5. Count header reflects the filtered total
 * 6. `filters.state.status` hides non-selected columns
 *
 * @task T955
 * @epic T949
 */

import type { Task, TaskPriority, TaskStatus, TaskType } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';

import {
  applyKanbanFilters,
  bucketKanbanTasks,
  columnIsVisible,
  findRootEpicId,
  indexTasksById,
  KANBAN_COLUMN_ORDER,
  type KanbanFilterPredicate,
  NO_EPIC_GROUP_ID,
  NO_EPIC_GROUP_TITLE,
  taskMatchesKanbanFilter,
} from '../kanban-bucketing.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Build a minimal {@link Task} literal for tests — every field required. */
function task(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  const status: TaskStatus = overrides.status ?? 'pending';
  const priority: TaskPriority = overrides.priority ?? 'medium';
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? 'desc',
    status,
    priority,
    type: overrides.type,
    parentId: overrides.parentId ?? null,
    labels: overrides.labels ?? [],
    createdAt: overrides.createdAt ?? '2026-04-17T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function epic(id: string, title: string, parentId: string | null = null): Task {
  return task({
    id,
    title,
    parentId,
    type: 'epic' satisfies TaskType,
    status: 'active',
  });
}

/**
 * Default filter predicate matching "no filters active" — used as a base
 * for tests that focus on bucketing and as-reset baseline for filter
 * narrowing tests.
 */
function emptyPredicate(): KanbanFilterPredicate {
  return {
    query: '',
    priority: [],
    labels: [],
    cancelled: true, // allow cancelled through so tests can observe it
    status: [],
  };
}

// ---------------------------------------------------------------------------
// 0. Sanity — column order is stable
// ---------------------------------------------------------------------------

describe('KANBAN_COLUMN_ORDER', () => {
  it('contains exactly the five canonical statuses in operator-specified order', () => {
    expect([...KANBAN_COLUMN_ORDER]).toEqual(['pending', 'active', 'blocked', 'done', 'cancelled']);
  });

  it('does not include archived or proposed (filtered at loader / not surfaced)', () => {
    expect(KANBAN_COLUMN_ORDER).not.toContain('archived');
    expect(KANBAN_COLUMN_ORDER).not.toContain('proposed');
  });
});

// ---------------------------------------------------------------------------
// 1. Status-column bucketing
// ---------------------------------------------------------------------------

describe('bucketKanbanTasks · column bucketing', () => {
  it('groups tasks into their correct status columns', () => {
    const tasks: Task[] = [
      task({ id: 'T001', title: 'p', status: 'pending' }),
      task({ id: 'T002', title: 'a', status: 'active' }),
      task({ id: 'T003', title: 'b', status: 'blocked' }),
      task({ id: 'T004', title: 'd', status: 'done' }),
      task({ id: 'T005', title: 'c', status: 'cancelled' }),
    ];

    const buckets = bucketKanbanTasks(tasks, indexTasksById(tasks));

    expect(buckets.columns.map((c) => c.status)).toEqual([
      'pending',
      'active',
      'blocked',
      'done',
      'cancelled',
    ]);
    for (const col of buckets.columns) {
      expect(col.taskCount).toBe(1);
    }
    expect(buckets.filteredTotal).toBe(5);
  });

  it('renders empty columns with count 0 when a status has no tasks', () => {
    const tasks: Task[] = [task({ id: 'T001', title: 'only-active', status: 'active' })];
    const buckets = bucketKanbanTasks(tasks, indexTasksById(tasks));

    expect(buckets.columns).toHaveLength(5);
    const active = buckets.columns.find((c) => c.status === 'active');
    const blocked = buckets.columns.find((c) => c.status === 'blocked');
    expect(active?.taskCount).toBe(1);
    expect(blocked?.taskCount).toBe(0);
    expect(blocked?.groups).toHaveLength(0);
  });

  it('silently drops tasks with non-kanban statuses (e.g. proposed)', () => {
    const tasks: Task[] = [
      task({ id: 'T001', title: 'proposed task', status: 'proposed' }),
      task({ id: 'T002', title: 'kept', status: 'active' }),
    ];
    const buckets = bucketKanbanTasks(tasks, indexTasksById(tasks));
    expect(buckets.filteredTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Within-column epic grouping (parentId chain walk)
// ---------------------------------------------------------------------------

describe('findRootEpicId · parent chain traversal', () => {
  it('returns the root epic id when traversing one level of nesting', () => {
    const e1 = epic('T100', 'Top Epic');
    const child = task({ id: 'T101', title: 'child', parentId: 'T100', status: 'pending' });
    const byId = indexTasksById([e1, child]);
    expect(findRootEpicId(child, byId)).toBe('T100');
  });

  it('climbs multiple levels and picks the outermost epic', () => {
    const outer = epic('T100', 'Outer');
    const mid = epic('T200', 'Mid', 'T100');
    const leaf = task({
      id: 'T300',
      title: 'leaf',
      parentId: 'T200',
      status: 'active',
    });
    const byId = indexTasksById([outer, mid, leaf]);
    expect(findRootEpicId(leaf, byId)).toBe('T100');
  });

  it('returns null for a root-level non-epic task', () => {
    const orphan = task({ id: 'T500', title: 'orphan', parentId: null, status: 'pending' });
    const byId = indexTasksById([orphan]);
    expect(findRootEpicId(orphan, byId)).toBeNull();
  });

  it('returns the epic id when the task IS a root epic', () => {
    const e = epic('T100', 'Self-epic');
    const byId = indexTasksById([e]);
    expect(findRootEpicId(e, byId)).toBe('T100');
  });

  it('returns null when parentId points at a missing task', () => {
    const t = task({ id: 'T999', title: 'broken parent', parentId: 'T404', status: 'active' });
    const byId = indexTasksById([t]);
    expect(findRootEpicId(t, byId)).toBeNull();
  });

  it('detects cycles and returns null without infinite-looping', () => {
    const a = task({ id: 'T1', title: 'a', parentId: 'T2', status: 'active' });
    const b = task({ id: 'T2', title: 'b', parentId: 'T1', status: 'active' });
    const byId = indexTasksById([a, b]);
    expect(findRootEpicId(a, byId)).toBeNull();
    expect(findRootEpicId(b, byId)).toBeNull();
  });
});

describe('bucketKanbanTasks · epic sub-grouping', () => {
  it('groups column tasks by their top-level epic id', () => {
    const e1 = epic('T100', 'Epic Alpha');
    const e2 = epic('T200', 'Epic Beta');
    const childA1 = task({ id: 'T101', title: 'a1', parentId: 'T100', status: 'active' });
    const childA2 = task({ id: 'T102', title: 'a2', parentId: 'T100', status: 'active' });
    const childB1 = task({ id: 'T201', title: 'b1', parentId: 'T200', status: 'active' });

    const all = [e1, e2, childA1, childA2, childB1];
    const buckets = bucketKanbanTasks(all, indexTasksById(all));

    const activeCol = buckets.columns.find((c) => c.status === 'active');
    expect(activeCol).toBeDefined();
    // 3 leaf tasks + 2 epics (themselves 'active') = 5 in active column.
    // They group under T100 (epic + 2 children = 3) and T200 (epic + 1 child = 2).
    const groupByEpic = Object.fromEntries(
      (activeCol?.groups ?? []).map((g) => [g.epicId, g.tasks.map((t) => t.id)]),
    );
    expect(groupByEpic['T100']).toEqual(['T100', 'T101', 'T102']);
    expect(groupByEpic['T200']).toEqual(['T200', 'T201']);
  });

  it('orders groups by epic id ascending with NO_EPIC_GROUP_ID last', () => {
    const e1 = epic('T300', 'Third');
    const e2 = epic('T100', 'First');
    const orphan = task({ id: 'T900', title: 'orphan', parentId: null, status: 'active' });
    const c1 = task({ id: 'T101', title: 'in first', parentId: 'T100', status: 'active' });
    const c2 = task({ id: 'T301', title: 'in third', parentId: 'T300', status: 'active' });

    const all = [e1, e2, orphan, c1, c2];
    const buckets = bucketKanbanTasks(all, indexTasksById(all));
    const activeCol = buckets.columns.find((c) => c.status === 'active');

    expect(activeCol?.groups.map((g) => g.epicId)).toEqual(['T100', 'T300', NO_EPIC_GROUP_ID]);
  });
});

// ---------------------------------------------------------------------------
// 3. No-epic fallback
// ---------------------------------------------------------------------------

describe('bucketKanbanTasks · no-epic fallback bucket', () => {
  it('places tasks with no root-epic ancestor into the "No epic" group', () => {
    const tasks: Task[] = [
      task({ id: 'T001', title: 'orphan-a', status: 'pending', parentId: null }),
      task({ id: 'T002', title: 'orphan-b', status: 'pending', parentId: null }),
    ];
    const buckets = bucketKanbanTasks(tasks, indexTasksById(tasks));

    const pending = buckets.columns.find((c) => c.status === 'pending');
    expect(pending?.groups).toHaveLength(1);
    expect(pending?.groups[0]?.epicId).toBe(NO_EPIC_GROUP_ID);
    expect(pending?.groups[0]?.epicTitle).toBe(NO_EPIC_GROUP_TITLE);
    expect(pending?.groups[0]?.tasks.map((t) => t.id)).toEqual(['T001', 'T002']);
  });

  it('places tasks with broken parent pointers into "No epic"', () => {
    const t = task({
      id: 'T050',
      title: 'broken-parent',
      parentId: 'T_gone',
      status: 'blocked',
    });
    const buckets = bucketKanbanTasks([t], indexTasksById([t]));
    const blocked = buckets.columns.find((c) => c.status === 'blocked');
    expect(blocked?.groups[0]?.epicId).toBe(NO_EPIC_GROUP_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. Filter propagation (query / priority / labels)
// ---------------------------------------------------------------------------

describe('taskMatchesKanbanFilter · predicate application', () => {
  const base = task({
    id: 'T123',
    title: 'Pomodoro timer bug',
    priority: 'high',
    labels: ['ui', 'bug'],
    status: 'active',
  });

  it('passes when predicate is empty', () => {
    expect(taskMatchesKanbanFilter(base, emptyPredicate())).toBe(true);
  });

  it('matches query against id (case-insensitive)', () => {
    const p = { ...emptyPredicate(), query: 't123' };
    expect(taskMatchesKanbanFilter(base, p)).toBe(true);
  });

  it('matches query against title (case-insensitive)', () => {
    const p = { ...emptyPredicate(), query: 'POMODORO' };
    expect(taskMatchesKanbanFilter(base, p)).toBe(true);
  });

  it('rejects when query matches neither id nor title', () => {
    const p = { ...emptyPredicate(), query: 'kanban' };
    expect(taskMatchesKanbanFilter(base, p)).toBe(false);
  });

  it('narrows by priority when selection is non-empty', () => {
    const hi = { ...emptyPredicate(), priority: ['high' as TaskPriority] };
    const lo = { ...emptyPredicate(), priority: ['low' as TaskPriority] };
    expect(taskMatchesKanbanFilter(base, hi)).toBe(true);
    expect(taskMatchesKanbanFilter(base, lo)).toBe(false);
  });

  it('narrows by labels (ANY match)', () => {
    const p = { ...emptyPredicate(), labels: ['bug'] };
    expect(taskMatchesKanbanFilter(base, p)).toBe(true);
    const pMiss = { ...emptyPredicate(), labels: ['other'] };
    expect(taskMatchesKanbanFilter(base, pMiss)).toBe(false);
  });

  it('hides cancelled tasks when predicate.cancelled is false', () => {
    const cancelled = task({ id: 'T999', title: 'done-for', status: 'cancelled' });
    const p = { ...emptyPredicate(), cancelled: false };
    expect(taskMatchesKanbanFilter(cancelled, p)).toBe(false);
    expect(taskMatchesKanbanFilter(cancelled, { ...p, cancelled: true })).toBe(true);
  });
});

describe('applyKanbanFilters + bucketKanbanTasks · within-column narrowing', () => {
  it('filter query reduces a column from 3 to 1', () => {
    const e = epic('T100', 'Epic');
    const c1 = task({
      id: 'T101',
      title: 'kanban bug',
      parentId: 'T100',
      status: 'active',
      priority: 'low',
    });
    const c2 = task({
      id: 'T102',
      title: 'kanban enhancement',
      parentId: 'T100',
      status: 'active',
      priority: 'low',
    });
    const c3 = task({
      id: 'T103',
      title: 'unrelated',
      parentId: 'T100',
      status: 'active',
      priority: 'low',
    });
    const all = [e, c1, c2, c3];
    const byId = indexTasksById(all);

    const predicate = { ...emptyPredicate(), query: 'kanban' };
    const filtered = applyKanbanFilters(all, predicate);
    const buckets = bucketKanbanTasks(filtered, byId);

    expect(buckets.filteredTotal).toBe(2);
    const activeCol = buckets.columns.find((c) => c.status === 'active');
    expect(activeCol?.taskCount).toBe(2);
    expect(activeCol?.groups[0]?.tasks.map((t) => t.id)).toEqual(['T101', 'T102']);
  });
});

// ---------------------------------------------------------------------------
// 5. Count header reflects the filtered total
// ---------------------------------------------------------------------------

describe('bucketKanbanTasks · filtered total', () => {
  it('filteredTotal equals the sum of per-column taskCount', () => {
    const tasks: Task[] = [
      task({ id: 'T001', title: 'p1', status: 'pending' }),
      task({ id: 'T002', title: 'p2', status: 'pending' }),
      task({ id: 'T003', title: 'a1', status: 'active' }),
      task({ id: 'T004', title: 'd1', status: 'done' }),
    ];
    const buckets = bucketKanbanTasks(tasks, indexTasksById(tasks));
    const sum = buckets.columns.reduce((acc, c) => acc + c.taskCount, 0);
    expect(buckets.filteredTotal).toBe(sum);
    expect(buckets.filteredTotal).toBe(4);
  });

  it('filteredTotal tracks a filter narrowing operation', () => {
    const tasks: Task[] = [
      task({ id: 'T001', title: 'keep', status: 'pending' }),
      task({ id: 'T002', title: 'drop', status: 'active' }),
    ];
    const predicate = { ...emptyPredicate(), query: 'keep' };
    const filtered = applyKanbanFilters(tasks, predicate);
    const buckets = bucketKanbanTasks(filtered, indexTasksById(tasks));
    expect(buckets.filteredTotal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Column visibility from filters.state.status
// ---------------------------------------------------------------------------

describe('columnIsVisible · status-filter column hiding', () => {
  it('returns true for every status when filter is empty', () => {
    for (const s of KANBAN_COLUMN_ORDER) {
      expect(columnIsVisible(s, emptyPredicate())).toBe(true);
    }
  });

  it('hides columns not present in a non-empty status filter', () => {
    const predicate = { ...emptyPredicate(), status: ['active', 'blocked'] as TaskStatus[] };
    expect(columnIsVisible('active', predicate)).toBe(true);
    expect(columnIsVisible('blocked', predicate)).toBe(true);
    expect(columnIsVisible('pending', predicate)).toBe(false);
    expect(columnIsVisible('done', predicate)).toBe(false);
    expect(columnIsVisible('cancelled', predicate)).toBe(false);
  });
});
