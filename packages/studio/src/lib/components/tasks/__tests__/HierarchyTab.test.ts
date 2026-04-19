/**
 * Unit tests for the T953 Hierarchy tab.
 *
 * The studio vitest harness runs in `environment: 'node'` (no jsdom), so
 * DOM-rendered assertions on the `.svelte` component aren't possible here.
 * Every behaviour that drives the component lives in
 * {@link import('../hierarchy-tree.js')} as pure functions — tested
 * extensively below.
 *
 * In addition to the unit tests on the helpers, we import the default
 * Svelte component export to guarantee the module graph compiles and the
 * barrel doesn't accidentally regress.
 *
 * @task T953
 * @epic T949
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { TaskDependencyEdge } from '../../../server/tasks/explorer-loader.js';
import type { TaskFilterState } from '../../../stores/task-filters.svelte.js';
import HierarchyTabDefault from '../HierarchyTab.svelte';
import {
  buildEpicSubtree,
  buildGlobalTree,
  collectAllIds,
  computeDepCounts,
  flattenTree,
  matchesFilters,
  pruneTree,
  UNPARENTED_BUCKET_ID,
  windowRows,
} from '../hierarchy-tree.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal factory for a {@link Task} with sensible defaults.
 *
 * Every test below seeds only the fields it exercises — everything else is
 * filled from this defaults table. Keeps each test readable without
 * repetition.
 */
function mkTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title'>): Task {
  return {
    id: overrides.id,
    title: overrides.title,
    description: overrides.description ?? `desc-${overrides.id}`,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    type: overrides.type,
    parentId: overrides.parentId,
    position: overrides.position,
    labels: overrides.labels,
    size: overrides.size,
    createdAt: overrides.createdAt ?? '2026-04-19T00:00:00.000Z',
    updatedAt: overrides.updatedAt,
    ...overrides,
  };
}

function emptyFilters(): TaskFilterState {
  return {
    query: '',
    status: [],
    priority: [],
    labels: [],
    epic: null,
    selected: null,
    cancelled: false,
    view: 'hierarchy',
  };
}

/**
 * Seed a three-epic project with mixed parenting, orphans, dependencies,
 * and a cancelled epic. Used across multiple test groups below.
 */
function seedFixture(): { tasks: Task[]; deps: TaskDependencyEdge[] } {
  const tasks: Task[] = [
    // Epic T001 with two children
    mkTask({ id: 'T001', title: 'Epic Alpha', type: 'epic', position: 0 }),
    mkTask({ id: 'T010', title: 'Child one', parentId: 'T001', position: 1 }),
    mkTask({ id: 'T011', title: 'Child two', parentId: 'T001', position: 0 }),
    // Epic T002 with a nested subtask
    mkTask({
      id: 'T002',
      title: 'Epic Bravo',
      type: 'epic',
      position: 1,
      status: 'active',
    }),
    mkTask({
      id: 'T020',
      title: 'Bravo task',
      parentId: 'T002',
      position: 0,
      status: 'done',
    }),
    mkTask({
      id: 'T021',
      title: 'Bravo sub',
      parentId: 'T020',
      position: 0,
      type: 'subtask',
    }),
    // Orphan — parent T999 does not exist in the payload
    mkTask({ id: 'T030', title: 'Orphan task', parentId: 'T999' }),
    // Cancelled epic (filtered out unless `cancelled` is on)
    mkTask({
      id: 'T003',
      title: 'Cancelled epic',
      type: 'epic',
      status: 'cancelled',
      position: 2,
    }),
    mkTask({
      id: 'T040',
      title: 'Child of cancelled',
      parentId: 'T003',
      status: 'pending',
    }),
  ];

  const deps: TaskDependencyEdge[] = [
    // T010 depends on T011 and T020 (T010 is outbound twice; T011/T020 inbound once each)
    { taskId: 'T010', dependsOn: 'T011' },
    { taskId: 'T010', dependsOn: 'T020' },
    // T021 depends on T010 (T010 inbound once; T021 outbound once)
    { taskId: 'T021', dependsOn: 'T010' },
  ];

  return { tasks, deps };
}

// ---------------------------------------------------------------------------
// computeDepCounts
// ---------------------------------------------------------------------------

describe('computeDepCounts', () => {
  it('returns zero counts for an empty edge set', () => {
    const counts = computeDepCounts([]);
    expect(counts.in.size).toBe(0);
    expect(counts.out.size).toBe(0);
  });

  it('tallies inbound + outbound correctly from the fixture', () => {
    const { deps } = seedFixture();
    const counts = computeDepCounts(deps);

    // Inbound (← N): edges where dependsOn === id
    expect(counts.in.get('T011')).toBe(1);
    expect(counts.in.get('T020')).toBe(1);
    expect(counts.in.get('T010')).toBe(1);
    expect(counts.in.get('T021')).toBeUndefined();

    // Outbound (→ N): edges where taskId === id
    expect(counts.out.get('T010')).toBe(2);
    expect(counts.out.get('T021')).toBe(1);
    expect(counts.out.get('T011')).toBeUndefined();
    expect(counts.out.get('T020')).toBeUndefined();
  });

  it('returns 0 for tasks not appearing in either endpoint', () => {
    const counts = computeDepCounts([{ taskId: 'T010', dependsOn: 'T011' }]);
    expect(counts.in.get('T999') ?? 0).toBe(0);
    expect(counts.out.get('T999') ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchesFilters
// ---------------------------------------------------------------------------

describe('matchesFilters', () => {
  it('matches everything when filters are empty', () => {
    const t = mkTask({ id: 'T001', title: 'hello' });
    expect(matchesFilters(t, emptyFilters())).toBe(true);
  });

  it('query matches title (case-insensitive)', () => {
    const t = mkTask({ id: 'T001', title: 'Pomodoro Timer' });
    expect(matchesFilters(t, { ...emptyFilters(), query: 'pomodoro' })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), query: 'XYZ' })).toBe(false);
  });

  it('query matches id (case-insensitive)', () => {
    const t = mkTask({ id: 'T042', title: 'other' });
    expect(matchesFilters(t, { ...emptyFilters(), query: 't042' })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), query: 'T042' })).toBe(true);
  });

  it('status filter narrows to listed statuses', () => {
    const t = mkTask({ id: 'T001', title: 'x', status: 'active' });
    expect(matchesFilters(t, { ...emptyFilters(), status: ['active'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), status: ['done'] })).toBe(false);
  });

  it('priority filter narrows to listed priorities', () => {
    const t = mkTask({ id: 'T001', title: 'x', priority: 'high' });
    expect(matchesFilters(t, { ...emptyFilters(), priority: ['high'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), priority: ['low'] })).toBe(false);
  });

  it('label filter is ANY-match, not ALL-match', () => {
    const t = mkTask({ id: 'T001', title: 'x', labels: ['a', 'b'] });
    expect(matchesFilters(t, { ...emptyFilters(), labels: ['a'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), labels: ['a', 'z'] })).toBe(true);
    expect(matchesFilters(t, { ...emptyFilters(), labels: ['z'] })).toBe(false);
  });

  it('cancelled epics are hidden unless `cancelled` is on', () => {
    const ep = mkTask({
      id: 'T001',
      title: 'x',
      type: 'epic',
      status: 'cancelled',
    });
    expect(matchesFilters(ep, { ...emptyFilters(), cancelled: false })).toBe(false);
    expect(matchesFilters(ep, { ...emptyFilters(), cancelled: true })).toBe(true);
  });

  it('non-epic cancelled tasks are visible regardless of `cancelled` toggle', () => {
    const t = mkTask({
      id: 'T010',
      title: 'x',
      type: 'task',
      status: 'cancelled',
    });
    expect(matchesFilters(t, { ...emptyFilters(), cancelled: false })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildGlobalTree + buildEpicSubtree
// ---------------------------------------------------------------------------

describe('buildGlobalTree', () => {
  it('groups real roots at depth 0 and sorts by (position, id)', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);

    // Three real roots (T001, T002, T003) plus the Unparented bucket.
    expect(roots.map((r) => r.id)).toEqual(['T001', 'T002', 'T003', UNPARENTED_BUCKET_ID]);
    for (const r of roots) {
      expect(r.depth).toBe(0);
    }
  });

  it('orders siblings by position, then id', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);

    const epicAlpha = roots.find((r) => r.id === 'T001');
    // T011 (position 0) before T010 (position 1)
    expect(epicAlpha?.children.map((c) => c.id)).toEqual(['T011', 'T010']);
  });

  it('puts orphans with missing parents under the Unparented bucket', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);

    const bucket = roots.find((r) => r.id === UNPARENTED_BUCKET_ID);
    expect(bucket).toBeDefined();
    expect(bucket?.task).toBeNull();
    expect(bucket?.children.map((c) => c.id)).toEqual(['T030']);
  });

  it('computes dep counts per node from the edge set', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);

    const alpha = roots.find((r) => r.id === 'T001');
    const t010 = alpha?.children.find((c) => c.id === 'T010');
    // T010 depends on T011 and T020 (outbound = 2) and T021 depends on T010 (inbound = 1)
    expect(t010?.depsIn).toBe(1);
    expect(t010?.depsOut).toBe(2);
  });

  it('omits the Unparented bucket when there are no orphans', () => {
    const tasks = [mkTask({ id: 'T001', title: 'root', type: 'epic' })];
    const depCounts = computeDepCounts([]);
    const roots = buildGlobalTree(tasks, depCounts);
    expect(roots.map((r) => r.id)).toEqual(['T001']);
  });
});

describe('buildEpicSubtree', () => {
  it('returns only the scoped epic subtree', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T002');

    expect(roots).toHaveLength(1);
    const epic = roots[0];
    expect(epic.id).toBe('T002');
    // Full descendant walk — grandchildren included.
    const kid = epic.children.find((c) => c.id === 'T020');
    expect(kid?.children.map((c) => c.id)).toEqual(['T021']);
  });

  it('returns [] when the epic id does not exist', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    expect(buildEpicSubtree(tasks, depCounts, 'T999')).toEqual([]);
  });

  it('ignores tasks outside the scoped subtree', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T001');
    const descendantIds = new Set<string>();
    function walk(n: { id: string; children: { id: string; children: unknown[] }[] }): void {
      descendantIds.add(n.id);
      for (const c of n.children) {
        walk(c as { id: string; children: { id: string; children: unknown[] }[] });
      }
    }
    walk(roots[0] as unknown as { id: string; children: { id: string; children: unknown[] }[] });
    expect(descendantIds.has('T020')).toBe(false);
    expect(descendantIds.has('T021')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pruneTree — filter narrowing
// ---------------------------------------------------------------------------

describe('pruneTree', () => {
  it('keeps every node when filters are empty (cancelled epic still hidden by default)', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const pruned = pruneTree(roots, emptyFilters());

    // T003 (cancelled epic) survives because its pending child T040 matches,
    // but T003 itself would be filtered out — however pruneTree keeps the
    // parent chain of any surviving descendant.
    expect(pruned.map((r) => r.id)).toContain('T001');
    expect(pruned.map((r) => r.id)).toContain('T002');
    expect(pruned.map((r) => r.id)).toContain('T003');
  });

  it('narrows to matched nodes + ancestor chain on query', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const pruned = pruneTree(roots, { ...emptyFilters(), query: 'bravo sub' });

    // Only T002 → T020 → T021 should survive.
    expect(pruned.map((r) => r.id)).toEqual(['T002']);
    const t002 = pruned[0];
    expect(t002.children.map((c) => c.id)).toEqual(['T020']);
    expect(t002.children[0].children.map((c) => c.id)).toEqual(['T021']);
  });

  it('drops subtrees with no matches', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const pruned = pruneTree(roots, { ...emptyFilters(), query: 'zzznothing' });
    expect(pruned).toEqual([]);
  });

  it('drops the Unparented bucket when no orphan matches', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const pruned = pruneTree(roots, { ...emptyFilters(), query: 'bravo' });
    expect(pruned.find((r) => r.id === UNPARENTED_BUCKET_ID)).toBeUndefined();
  });

  it('keeps the Unparented bucket when an orphan matches', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const pruned = pruneTree(roots, { ...emptyFilters(), query: 'orphan' });
    const bucket = pruned.find((r) => r.id === UNPARENTED_BUCKET_ID);
    expect(bucket).toBeDefined();
    expect(bucket?.children.map((c) => c.id)).toEqual(['T030']);
  });
});

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------

describe('flattenTree', () => {
  it('yields only roots when no nodes are expanded', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const rows = flattenTree(roots, new Set());

    // Every root + the Unparented bucket, but no children beneath.
    expect(rows.map((r) => r.id)).toEqual(['T001', 'T002', 'T003', UNPARENTED_BUCKET_ID]);
    for (const r of rows) {
      expect(r.expanded).toBe(false);
    }
  });

  it('expanded subtrees emit children depth-first', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T002');
    const rows = flattenTree(roots, new Set(['T002', 'T020']));

    expect(rows.map((r) => r.id)).toEqual(['T002', 'T020', 'T021']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
  });

  it('populates isEpic and hasChildren flags', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T002');
    const rows = flattenTree(roots, new Set(['T002', 'T020']));

    expect(rows[0].isEpic).toBe(true);
    expect(rows[0].hasChildren).toBe(true);
    expect(rows[2].isEpic).toBe(false);
    expect(rows[2].hasChildren).toBe(false);
  });

  it('computes descendantCount recursively', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T002');
    const rows = flattenTree(roots, new Set(['T002', 'T020']));
    // T002 → T020 → T021 → 2 descendants beneath T002
    expect(rows[0].descendantCount).toBe(2);
    // T020 → T021 → 1 descendant
    expect(rows[1].descendantCount).toBe(1);
    // T021 is a leaf
    expect(rows[2].descendantCount).toBe(0);
  });

  it('carries dep counts through the flat rows', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildEpicSubtree(tasks, depCounts, 'T001');
    const rows = flattenTree(roots, new Set(['T001']));

    const t010 = rows.find((r) => r.id === 'T010');
    expect(t010?.depsIn).toBe(1);
    expect(t010?.depsOut).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// collectAllIds
// ---------------------------------------------------------------------------

describe('collectAllIds', () => {
  it('includes every node across every depth', () => {
    const { tasks, deps } = seedFixture();
    const depCounts = computeDepCounts(deps);
    const roots = buildGlobalTree(tasks, depCounts);
    const ids = collectAllIds(roots);

    // Every seed task ID should be present, plus the unparented bucket
    expect(ids.has('T001')).toBe(true);
    expect(ids.has('T010')).toBe(true);
    expect(ids.has('T011')).toBe(true);
    expect(ids.has('T002')).toBe(true);
    expect(ids.has('T020')).toBe(true);
    expect(ids.has('T021')).toBe(true);
    expect(ids.has('T003')).toBe(true);
    expect(ids.has('T040')).toBe(true);
    expect(ids.has('T030')).toBe(true);
    expect(ids.has(UNPARENTED_BUCKET_ID)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// windowRows — virtualization
// ---------------------------------------------------------------------------

describe('windowRows', () => {
  // Build a large flat-list fixture (200 synthetic rows) for windowing tests.
  function buildLargeRowList(n: number) {
    const tasks: Task[] = [];
    for (let i = 0; i < n; i++) {
      tasks.push(mkTask({ id: `T${String(i).padStart(4, '0')}`, title: `Task ${i}` }));
    }
    const depCounts = computeDepCounts([]);
    const roots = buildGlobalTree(tasks, depCounts);
    const rows = flattenTree(roots, new Set());
    return rows;
  }

  it('returns the full list when total is small', () => {
    const rows = buildLargeRowList(10);
    const w = windowRows(rows, { scrollTop: 0, viewportHeight: 400, rowHeight: 32 });
    expect(w.startIndex).toBe(0);
    expect(w.visible).toHaveLength(10);
    expect(w.totalRows).toBe(10);
  });

  it('slices the viewport + buffer when total is large', () => {
    const rows = buildLargeRowList(500);
    const rowHeight = 32;
    const viewportHeight = 320; // 10 rows
    const scrollTop = 32 * 100; // row 100 is first visible
    const w = windowRows(rows, { scrollTop, viewportHeight, rowHeight, buffer: 50 });

    // First visible row is 100, buffer 50 above -> startIndex = 50
    expect(w.startIndex).toBe(50);
    // Visible ~= 10, buffer 50 above + 50 below -> ~110 rows.
    expect(w.visible.length).toBeGreaterThanOrEqual(100);
    expect(w.visible.length).toBeLessThanOrEqual(120);
    expect(w.totalRows).toBe(500);
  });

  it('clamps to 0 at the top', () => {
    const rows = buildLargeRowList(500);
    const w = windowRows(rows, {
      scrollTop: 0,
      viewportHeight: 320,
      rowHeight: 32,
      buffer: 50,
    });
    expect(w.startIndex).toBe(0);
  });

  it('clamps to total at the bottom', () => {
    const rows = buildLargeRowList(100);
    const rowHeight = 32;
    const w = windowRows(rows, {
      scrollTop: 32 * 90,
      viewportHeight: 320,
      rowHeight,
      buffer: 50,
    });
    expect(w.startIndex + w.visible.length).toBeLessThanOrEqual(100);
    expect(w.visible[w.visible.length - 1].id).toBe('T0099');
  });

  it('returns empty slice for empty input', () => {
    const w = windowRows([], { scrollTop: 0, viewportHeight: 400, rowHeight: 32 });
    expect(w.startIndex).toBe(0);
    expect(w.visible).toEqual([]);
    expect(w.totalRows).toBe(0);
  });

  it('degrades gracefully when rowHeight or viewportHeight is invalid', () => {
    const rows = buildLargeRowList(5);
    const w = windowRows(rows, { scrollTop: 0, viewportHeight: 0, rowHeight: 0 });
    expect(w.visible).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Component smoke
// ---------------------------------------------------------------------------

describe('HierarchyTab component module', () => {
  it('exports a default Svelte component constructor', () => {
    expect(HierarchyTabDefault).toBeTruthy();
    expect(['function', 'object']).toContain(typeof HierarchyTabDefault);
  });
});
