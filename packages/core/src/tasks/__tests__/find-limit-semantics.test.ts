/**
 * `--limit 0` must mean "no limit" on `find`, as it always has on `list` (GH #1302).
 *
 * It previously meant `slice(offset, offset + 0)` — ZERO rows. So the same flag,
 * spelled the same way, returned everything on `cleo list` and nothing on
 * `cleo find`, and the envelope stated both answers at once:
 *
 *     {"success":true,"data":{"results":[],"total":260},
 *      "meta":{…,"message":"No matching tasks found"}}
 *
 * Zero rows, reported as success, with a human-readable line asserting the
 * opposite of the `total` beside it in the same object. An agent reads the
 * message and stops.
 *
 * This mattered beyond ergonomics: the truncation warning added for GH #1242 is
 * emitted from the generic `cliOutput`, so it reached `find` too and named
 * `--limit 0` as the remedy — advice that returned an empty set on the very
 * command it was printed for.
 *
 * @epic T12119
 */

import type { Task, TaskQueryFilters } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks } from '../find.js';

function makeTasks(n: number): Task[] {
  const now = new Date().toISOString();
  return Array.from({ length: n }, (_, i) => ({
    id: `T${2000 + i}`,
    title: `worktree provisioning task ${i}`,
    description: 'worktree',
    status: 'pending',
    priority: 'medium',
    type: 'task',
    parentId: null,
    position: i,
    positionVersion: 0,
    size: 'medium',
    createdAt: now,
    updatedAt: now,
  })) as unknown as Task[];
}

function mockAccessor(tasks: Task[]): DataAccessor {
  return {
    queryTasks: async (filters: TaskQueryFilters | undefined) => {
      let list = tasks;
      if (filters?.status) list = list.filter((t) => t.status === filters.status);
      return { tasks: list, total: list.length };
    },
    loadArchive: async () => ({ archivedTasks: [] }),
    loadSingleTask: async (id: string) => tasks.find((t) => t.id === id) ?? null,
  } as unknown as DataAccessor;
}

describe('find pagination — --limit 0 means no limit (GH #1302)', () => {
  const TOTAL = 45;

  it('returns EVERY match for limit 0, not zero rows', async () => {
    const res = await findTasks(
      { query: 'worktree', limit: 0 },
      undefined,
      mockAccessor(makeTasks(TOTAL)),
    );
    // Before the fix this was 0 — `slice(offset, offset + 0)`.
    expect(res.results).toHaveLength(TOTAL);
    expect(res.total).toBe(TOTAL);
  });

  it('still honours an explicit positive limit', async () => {
    const res = await findTasks(
      { query: 'worktree', limit: 5 },
      undefined,
      mockAccessor(makeTasks(TOTAL)),
    );
    expect(res.results).toHaveLength(5);
    expect(res.total).toBe(TOTAL);
  });

  it('still defaults to a page of 20 when no limit is given', async () => {
    const res = await findTasks({ query: 'worktree' }, undefined, mockAccessor(makeTasks(TOTAL)));
    expect(res.results).toHaveLength(20);
    expect(res.total).toBe(TOTAL);
  });

  it('composes limit 0 with a non-zero offset', async () => {
    const res = await findTasks(
      { query: 'worktree', limit: 0, offset: 10 },
      undefined,
      mockAccessor(makeTasks(TOTAL)),
    );
    expect(res.results).toHaveLength(TOTAL - 10);
  });

  it('never reports results and total that contradict each other', async () => {
    // The shape that made this defect invisible: an empty page beside a
    // non-zero total. With limit 0 the page must be the whole set.
    const res = await findTasks(
      { query: 'worktree', limit: 0 },
      undefined,
      mockAccessor(makeTasks(TOTAL)),
    );
    expect(res.results.length === 0 && res.total > 0).toBe(false);
  });
});
