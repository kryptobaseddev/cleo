/**
 * Tests for the `--label` filter on `cleo find` (T9904).
 *
 * Closes GH#393 — `cleo labels <name>` rejected positional and there was no
 * way to "show tasks for label X" via `cleo find` either. T9904 wires both:
 *   - positional `cleo labels <name>` → filter tasks by label
 *   - flag `cleo find --label <name>` → filter tasks by label
 *
 * This file covers the core `findTasks({ label })` behaviour and the
 * `extractInlineFilters` inline `label:value` lift.
 *
 * @task T9904
 */

import type { Task, TaskQueryFilters } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { extractInlineFilters, findTasks } from '../find.js';

/** Build a mock DataAccessor that honours the `label` filter. */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async (filters: TaskQueryFilters | undefined) => {
      let list = tasks;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      if (filters?.label) list = list.filter((t) => (t.labels ?? []).includes(filters.label!));
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
  } as unknown as DataAccessor;
}

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    title: overrides.id,
    description: '',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    size: 'small',
    parentId: null,
    labels: [],
    depends: [],
    acceptance: [],
    createdAt: '2026-04-22T00:00:00Z',
    ...overrides,
  } as Task;
}

describe('findTasks --label', () => {
  it('selects only tasks that carry the requested label', async () => {
    const tasks = [
      makeTask({ id: 'T001', labels: ['bug', 'frontend'] }),
      makeTask({ id: 'T002', labels: ['bug'] }),
      makeTask({ id: 'T003', labels: ['feature'] }),
      makeTask({ id: 'T004' }),
    ];
    const result = await findTasks({ label: 'bug' }, '/mock', mockAccessor(tasks));
    const ids = result.results.map((r) => r.id).sort();
    expect(ids).toEqual(['T001', 'T002']);
  });

  it('returns empty when no task carries the label', async () => {
    const tasks = [
      makeTask({ id: 'T001', labels: ['bug'] }),
      makeTask({ id: 'T002', labels: ['feature'] }),
    ];
    const result = await findTasks({ label: 'nonexistent' }, '/mock', mockAccessor(tasks));
    expect(result.results).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('composes label with status filter (AND)', async () => {
    const tasks = [
      makeTask({ id: 'T001', labels: ['bug'], status: 'pending' }),
      makeTask({ id: 'T002', labels: ['bug'], status: 'done' }),
      makeTask({ id: 'T003', labels: ['feature'], status: 'pending' }),
    ];
    const result = await findTasks(
      { label: 'bug', status: 'pending' },
      '/mock',
      mockAccessor(tasks),
    );
    expect(result.results.map((r) => r.id)).toEqual(['T001']);
  });

  it('label filter alone (no query, no id) is valid filter-only mode', async () => {
    const tasks = [makeTask({ id: 'T001', labels: ['bug'] })];
    // Should NOT throw "query or --id required"
    const result = await findTasks({ label: 'bug' }, '/mock', mockAccessor(tasks));
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe('T001');
  });
});

describe('extractInlineFilters — label:value', () => {
  it('lifts label:value out of a pure-filter query', () => {
    const out = extractInlineFilters({ query: 'label:bug' });
    expect(out.label).toBe('bug');
    expect(out.query).toBeUndefined();
  });

  it('lifts label:value and keeps remaining tokens as fuzzy text', () => {
    const out = extractInlineFilters({ query: 'label:bug login crash' });
    expect(out.label).toBe('bug');
    expect(out.query).toBe('login crash');
  });

  it('explicit --label option wins when both inline and option set', () => {
    const out = extractInlineFilters({ query: 'label:other thing', label: 'bug' });
    expect(out.label).toBe('bug');
    expect(out.query).toBe('thing');
  });
});
