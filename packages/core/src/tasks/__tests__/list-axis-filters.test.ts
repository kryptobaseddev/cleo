/**
 * Regression tests for the inert `tasks.list` filter family.
 *
 * Each `it` here FAILS on the pre-T12120 code:
 *  - `--severity` / `--kind` (GH #1245, #1246) had no read path at any of the
 *    seven relay layers, so they returned the whole table instead of a subset.
 *  - an invalid axis value was accepted and silently widened the result set.
 *  - `--children` (GH #1247) is a documented no-op; the equivalence assertion
 *    is a tripwire so a future transitive `--parent` mode cannot ship while
 *    leaving the flag a lie.
 *
 * @task T12120
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { assertTaskAxisFilters } from '../axis-filters.js';
import { listTasks } from '../list.js';

const NOW = new Date().toISOString();

describe('tasks.list axis filters (T12120)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'P0 bug',
        status: 'pending',
        priority: 'medium',
        severity: 'P0',
        kind: 'bug',
        createdAt: NOW,
      },
      {
        id: 'T002',
        title: 'P3 work',
        status: 'pending',
        priority: 'medium',
        severity: 'P3',
        kind: 'work',
        createdAt: NOW,
      },
      {
        id: 'T003',
        title: 'unsevered research',
        status: 'pending',
        priority: 'medium',
        kind: 'research',
        createdAt: NOW,
      },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  describe('severity (GH #1245)', () => {
    it('narrows to the requested severity instead of returning every task', async () => {
      const result = await listTasks({ severity: 'P0' }, env.tempDir, accessor);
      expect(result.tasks.map((t) => t.id)).toEqual(['T001']);
      expect(result.filtered).toBe(1);
    });

    it('distinguishes P0 from P3 — the two were byte-identical before the fix', async () => {
      const p0 = await listTasks({ severity: 'P0' }, env.tempDir, accessor);
      const p3 = await listTasks({ severity: 'P3' }, env.tempDir, accessor);
      expect(p0.tasks.map((t) => t.id)).toEqual(['T001']);
      expect(p3.tasks.map((t) => t.id)).toEqual(['T002']);
      expect(p0.tasks.map((t) => t.id)).not.toEqual(p3.tasks.map((t) => t.id));
    });

    it('accepts a list of severities', async () => {
      const result = await listTasks({ severity: ['P0', 'P3'] }, env.tempDir, accessor);
      expect(result.tasks.map((t) => t.id).sort()).toEqual(['T001', 'T002']);
    });

    it('REJECTS an unknown severity rather than widening to every task', async () => {
      await expect(
        listTasks({ severity: 'BOGUS' as never }, env.tempDir, accessor),
      ).rejects.toThrow(/Invalid --severity value 'BOGUS'/);
    });

    it('leaves the result unfiltered only when the axis is genuinely absent', async () => {
      const result = await listTasks({}, env.tempDir, accessor);
      expect(result.filtered).toBe(3);
    });
  });

  describe('kind (GH #1246)', () => {
    it('narrows to the requested kind', async () => {
      const result = await listTasks({ kind: 'bug' }, env.tempDir, accessor);
      expect(result.tasks.map((t) => t.id)).toEqual(['T001']);
      expect(result.filtered).toBe(1);
    });

    it('distinguishes kinds from one another', async () => {
      const research = await listTasks({ kind: 'research' }, env.tempDir, accessor);
      expect(research.tasks.map((t) => t.id)).toEqual(['T003']);
    });

    it('REJECTS an unknown kind rather than widening to every task', async () => {
      await expect(listTasks({ kind: 'BOGUS' as never }, env.tempDir, accessor)).rejects.toThrow(
        /Invalid --kind value 'BOGUS'/,
      );
    });
  });

  describe('severity + kind compose', () => {
    it('applies both constraints, not just the last one', async () => {
      const match = await listTasks({ severity: 'P0', kind: 'bug' }, env.tempDir, accessor);
      expect(match.tasks.map((t) => t.id)).toEqual(['T001']);

      const noMatch = await listTasks({ severity: 'P0', kind: 'work' }, env.tempDir, accessor);
      expect(noMatch.tasks).toHaveLength(0);
      expect(noMatch.filtered).toBe(0);
    });
  });

  describe('assertTaskAxisFilters', () => {
    it('normalises a single value to a list', () => {
      expect(assertTaskAxisFilters({ severity: 'P1' })).toEqual({ severity: ['P1'] });
    });

    it('returns an empty bag when no axis is supplied', () => {
      expect(assertTaskAxisFilters({})).toEqual({});
    });

    it('names every accepted value in the error, so a typo is self-correcting', () => {
      expect(() => assertTaskAxisFilters({ severity: 'p0' })).toThrow(
        /Accepted: P0 \| P1 \| P2 \| P3/,
      );
      expect(() => assertTaskAxisFilters({ kind: 'chore' })).toThrow(
        /Accepted: work \| research \| experiment \| bug \| spike \| release/,
      );
    });

    it('rejects a list containing one bad value', () => {
      expect(() => assertTaskAxisFilters({ severity: ['P0', 'P9'] })).toThrow(/'P9'/);
    });
  });
});

describe('tasks.list --children is a documented no-op (GH #1247)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    await seedTasks(accessor, [
      { id: 'T100', title: 'epic', type: 'epic', status: 'pending', createdAt: NOW },
      { id: 'T101', title: 'child', parentId: 'T100', status: 'pending', createdAt: NOW },
      { id: 'T102', title: 'grandchild', parentId: 'T101', status: 'pending', createdAt: NOW },
    ]);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /**
   * TRIPWIRE. `--parent` returns DIRECT children only on every path, so
   * `--children` cannot narrow anything — which is why it was never wired.
   * If a transitive `--parent` mode is ever added, this assertion breaks and
   * forces `--children` to be given real meaning in the same change, instead
   * of remaining a flag that `--help` advertises and the query builder ignores.
   */
  it('returns direct children only, with or without the flag', async () => {
    const without = await listTasks({ parentId: 'T100' }, env.tempDir, accessor);
    const with_ = await listTasks({ parentId: 'T100', children: true }, env.tempDir, accessor);

    expect(without.tasks.map((t) => t.id)).toEqual(['T101']);
    expect(with_.tasks.map((t) => t.id)).toEqual(without.tasks.map((t) => t.id));
  });
});
