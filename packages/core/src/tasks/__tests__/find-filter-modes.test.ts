/**
 * Unit tests for find-filter ergonomics (T1187-followup / v2026.4.114).
 *
 * Two user-facing improvements under test:
 *
 * 1. Filter-only search — `findTasks({ status: 'pending' })` (no query/id)
 *    returns every matching task. Previously rejected with
 *    "Search query or --id is required".
 *
 * 2. Inline `key:value` token parsing — users who type
 *    `cleo find "status:pending"` expecting a filter instead of a fuzzy
 *    query now get the filter lifted automatically.
 *
 * Both behaviours match the ergonomics users naturally reach for and
 * eliminate the confusing "returns unrelated matches" state that happens
 * when a filter token is treated as free text.
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { extractInlineFilters, findTasks } from '../find.js';

/** Build a mock DataAccessor wrapping an in-memory array. */
function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async (filters) => {
      let list = tasks;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
    // Unused in these tests — cast via unknown to satisfy the interface.
  } as unknown as DataAccessor;
}

function makeTask(overrides: Partial<Task>): Task {
  return {
    id: 'TX',
    title: 't',
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

describe('extractInlineFilters', () => {
  it('lifts status:value out of a pure-filter query', () => {
    const out = extractInlineFilters({ query: 'status:pending' });
    expect(out.status).toBe('pending');
    expect(out.query).toBeUndefined();
  });

  it('lifts role:value out of a pure-filter query', () => {
    const out = extractInlineFilters({ query: 'role:research' });
    expect(out.role).toBe('research');
    expect(out.query).toBeUndefined();
  });

  it('lifts id:value out of a pure-filter query', () => {
    const out = extractInlineFilters({ query: 'id:T123' });
    expect(out.id).toBe('T123');
    expect(out.query).toBeUndefined();
  });

  it('keeps free-text portion when mixed with a filter token', () => {
    const out = extractInlineFilters({ query: 'status:pending migration' });
    expect(out.status).toBe('pending');
    expect(out.query).toBe('migration');
  });

  it('preserves unrecognised key:value tokens as fuzzy query words', () => {
    const out = extractInlineFilters({ query: 'owner:alice migration' });
    expect(out.status).toBeUndefined();
    expect(out.role).toBeUndefined();
    expect(out.query).toBe('owner:alice migration');
  });

  it('does not override an explicit filter already supplied via flags', () => {
    const out = extractInlineFilters({ query: 'status:done', status: 'pending' });
    expect(out.status).toBe('pending'); // explicit flag wins
    expect(out.query).toBeUndefined();
  });

  it('is a no-op when query is undefined', () => {
    const input = { status: 'pending' as const };
    expect(extractInlineFilters(input)).toEqual(input);
  });

  it('handles multiple filter tokens in the same query', () => {
    const out = extractInlineFilters({ query: 'status:pending role:research' });
    expect(out.status).toBe('pending');
    expect(out.role).toBe('research');
    expect(out.query).toBeUndefined();
  });
});

describe('findTasks — filter-only mode', () => {
  it('returns all filter-matched tasks when only --status is supplied', async () => {
    const tasks = [
      makeTask({ id: 'T1', title: 'a', status: 'pending' }),
      makeTask({ id: 'T2', title: 'b', status: 'done' }),
      makeTask({ id: 'T3', title: 'c', status: 'pending' }),
    ];
    const result = await findTasks({ status: 'pending' }, undefined, mockAccessor(tasks));
    expect(result.results.map((r) => r.id).sort()).toEqual(['T1', 'T3']);
    expect(result.total).toBe(2);
  });

  it('still rejects when neither query nor id nor filter is supplied', async () => {
    await expect(findTasks({}, undefined, mockAccessor([]))).rejects.toThrow(
      /query.*--id.*filter/i,
    );
  });

  it('filter-only mode sets score=50 for stable pagination', async () => {
    const tasks = [
      makeTask({ id: 'T1', title: 'a', status: 'pending' }),
      makeTask({ id: 'T2', title: 'b', status: 'pending' }),
    ];
    const result = await findTasks({ status: 'pending' }, undefined, mockAccessor(tasks));
    expect(result.results.every((r) => r.score === 50)).toBe(true);
  });
});

describe('findTasks — inline key:value query parsing', () => {
  it('treats `status:pending` in the query as a filter, not fuzzy text', async () => {
    const tasks = [
      makeTask({ id: 'T1', title: 'status:pending in title', status: 'done' }),
      makeTask({ id: 'T2', title: 'genuinely pending', status: 'pending' }),
    ];
    const result = await findTasks({ query: 'status:pending' }, undefined, mockAccessor(tasks));
    // T2 returned (status=pending filter); T1 filtered OUT despite matching text.
    expect(result.results.map((r) => r.id)).toEqual(['T2']);
  });

  it('combined `status:pending migration` filters AND fuzzy-matches', async () => {
    const tasks = [
      makeTask({ id: 'T1', title: 'migration docs', status: 'pending' }),
      makeTask({ id: 'T2', title: 'pipeline', status: 'pending' }),
      makeTask({ id: 'T3', title: 'migration docs', status: 'done' }),
    ];
    const result = await findTasks(
      { query: 'status:pending migration' },
      undefined,
      mockAccessor(tasks),
    );
    expect(result.results.map((r) => r.id)).toEqual(['T1']);
  });
});
