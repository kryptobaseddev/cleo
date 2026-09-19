/**
 * Tests for task listing.
 * @task T4460
 * @epic T4454
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectMvi } from '../../dispatch/mvi-projection.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { findTasks, taskFind } from '../find.js';
import { listTasks, taskList, toCompact } from '../list.js';

describe('listTasks', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('applies the default safe page size when no limit is specified', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'done',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({}, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.filtered).toBe(2);
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(0);
      expect(result.page.hasMore).toBe(false);
    }
  });

  it('filters by status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'done',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ status: 'pending' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
    expect(result.filtered).toBe(1);
  });

  it('filters by priority', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'low',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'critical',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ priority: 'critical' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
  });

  it('filters by parent', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Child 1',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Child 2',
        status: 'pending',
        priority: 'medium',
        parentId: 'T001',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T004',
        title: 'Other',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ parentId: 'T001' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(2);
  });

  it('filters by label', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Bug fix',
        status: 'pending',
        priority: 'high',
        labels: ['bug', 'security'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Feature',
        status: 'pending',
        priority: 'medium',
        labels: ['feature'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks({ label: 'bug' }, env.tempDir, accessor);
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T001');
  });

  it('applies all supported non-pagination filters together', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Epic',
        status: 'active',
        priority: 'high',
        type: 'epic',
        phase: 'build',
        labels: ['platform'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Matching child',
        status: 'pending',
        priority: 'critical',
        type: 'task',
        phase: 'build',
        parentId: 'T001',
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Wrong phase',
        status: 'pending',
        priority: 'critical',
        type: 'task',
        phase: 'design',
        parentId: 'T001',
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await listTasks(
      {
        status: 'pending',
        priority: 'critical',
        type: 'task',
        parentId: 'T001',
        phase: 'build',
        label: 'bug',
        children: true,
      },
      env.tempDir,
      accessor,
    );

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]!.id).toBe('T002');
    expect(result.total).toBe(3);
    expect(result.filtered).toBe(1);
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(0);
      expect(result.page.hasMore).toBe(false);
    }
  });

  it('paginates results', async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const page1 = await listTasks({ limit: 3, offset: 0 }, env.tempDir, accessor);
    expect(page1.tasks).toHaveLength(3);
    expect(page1.page.mode).toBe('offset');
    if (page1.page.mode === 'offset') {
      expect(page1.page.total).toBe(10);
      expect(page1.page.hasMore).toBe(true);
    }

    const page2 = await listTasks({ limit: 3, offset: 3 }, env.tempDir, accessor);
    expect(page2.tasks).toHaveLength(3);
    expect(page2.page.mode).toBe('offset');
    if (page2.page.mode === 'offset') {
      expect(page2.page.offset).toBe(3);
      expect(page2.page.hasMore).toBe(true);
    }

    const lastPage = await listTasks({ limit: 3, offset: 9 }, env.tempDir, accessor);
    expect(lastPage.tasks).toHaveLength(1);
    expect(lastPage.page.mode).toBe('offset');
    if (lastPage.page.mode === 'offset') {
      expect(lastPage.page.hasMore).toBe(false);
    }
  });

  it('applies the default safe page size when offset is provided without limit', async () => {
    const tasks = Array.from({ length: 80 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const result = await listTasks({ offset: 10 }, env.tempDir, accessor);

    expect(result.tasks).toHaveLength(10);
    expect(result.tasks[0]!.id).toBe('T011');
    expect(result.page.mode).toBe('offset');
    if (result.page.mode === 'offset') {
      expect(result.page.limit).toBe(10);
      expect(result.page.offset).toBe(10);
      expect(result.page.total).toBe(80);
      expect(result.page.hasMore).toBe(true);
    }
  });

  it('returns the full dataset only when limit=0 is explicitly requested', async () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      id: `T${String(i + 1).padStart(3, '0')}`,
      title: `Task ${i + 1}`,
      status: 'pending' as const,
      priority: 'medium' as const,
      position: i + 1,
      createdAt: new Date().toISOString(),
    }));
    await seedTasks(accessor, tasks);

    const result = await listTasks({ limit: 0 }, env.tempDir, accessor);

    expect(result.tasks).toHaveLength(12);
    expect(result.page.mode).toBe('none');
  });
  it('shares archive eligibility, parent filtering, and explicit population facts with find', async () => {
    await seedTasks(accessor, [
      {
        id: 'T201',
        title: 'cohort parent',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T202',
        title: 'cohort ordinary',
        parentId: 'T201',
        status: 'pending',
        priority: 'medium',
        kind: 'bug',
        labels: ['scope'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T203',
        title: 'cohort archived',
        parentId: 'T201',
        status: 'archived',
        priority: 'medium',
        kind: 'bug',
        labels: ['scope'],
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T204',
        title: 'cohort unrelated archive',
        status: 'archived',
        priority: 'medium',
        kind: 'bug',
        labels: ['scope'],
        createdAt: new Date().toISOString(),
      },
    ]);
    const list = await listTasks(
      { parentId: 'T201', label: 'scope', kind: 'bug', includeArchive: true, limit: 1 },
      env.tempDir,
      accessor,
    );
    const find = await findTasks(
      {
        query: 'cohort',
        parent: 'T201',
        label: 'scope',
        kind: 'bug',
        includeArchive: true,
        limit: 1,
      },
      env.tempDir,
      accessor,
    );
    expect(list.population).toEqual({
      matched: 2,
      returned: 1,
      truncated: true,
      limit: 1,
      offset: 0,
      archive: 'included',
    });
    expect(find.population).toEqual(list.population);
    const listed = await listTasks(
      { parentId: 'T201', includeArchive: true, limit: 0 },
      env.tempDir,
      accessor,
    );
    const found = await findTasks(
      { parent: 'T201', includeArchive: true, limit: 0 },
      env.tempDir,
      accessor,
    );
    expect(listed.tasks.map((t) => t.id).sort()).toEqual(['T202', 'T203']);
    expect(found.results.map((t) => t.id).sort()).toEqual(['T202', 'T203']);
    const archived = await findTasks(
      { status: 'archived', parent: 'T201', includeArchive: true, limit: 0 },
      env.tempDir,
      accessor,
    );
    expect(archived.results.map((t) => t.id)).toEqual(['T203']);
    expect(archived.population.archive).toBe('only');
    const ordinary = await findTasks({ parent: 'T201', limit: 0 }, env.tempDir, accessor);
    expect(ordinary.results.map((t) => t.id)).toEqual(['T202']);
    expect(ordinary.population.archive).toBe('excluded');
  });

  it('limit zero with an offset returns every remaining match without the generic 50-row ceiling', async () => {
    await seedTasks(
      accessor,
      Array.from({ length: 72 }, (_, i) => ({
        id: `T${300 + i}`,
        title: 'large population',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      })),
    );
    const list = await listTasks({ limit: 0, offset: 3 }, env.tempDir, accessor);
    const find = await findTasks(
      { query: 'large population', limit: 0, offset: 3 },
      env.tempDir,
      accessor,
    );
    expect(list.tasks).toHaveLength(69);
    expect(find.results).toHaveLength(69);
    expect(list.population).toEqual({
      matched: 72,
      returned: 69,
      truncated: true,
      limit: null,
      offset: 3,
      archive: 'excluded',
    });
    expect(find.population).toEqual(list.population);
  });

  it('rejects invalid pagination instead of silently changing the requested population', async () => {
    for (const limit of [-1, 1.5, Number.NaN]) {
      await expect(listTasks({ limit }, env.tempDir, accessor)).rejects.toThrow(
        /non-negative integers/,
      );
      await expect(findTasks({ status: 'pending', limit }, env.tempDir, accessor)).rejects.toThrow(
        /non-negative integers/,
      );
    }
  });
  it.each([
    'compact',
    'lowFind',
    'sdkFind',
    'sdkList',
  ] as const)('discloses upstream SDK omissions for %s before fields are lost (T12199)', async (surface) => {
    await seedTasks(accessor, [
      {
        id: 'T880',
        title: 'disclosure fixture',
        description: '解析🌱',
        acceptance: ['preserve authority', 'verify actual scope'],
        notes: ['historical evidence'],
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const source = await accessor.loadSingleTask('T880');
    if (!source) throw new Error('fixture missing');
    const direct = toCompact(source);
    const low = await findTasks({ query: 'disclosure' }, env.tempDir, accessor);
    const sdkFind = await taskFind(env.tempDir, 'disclosure');
    const sdkList = await taskList(env.tempDir, { compact: true });
    expect(sdkFind.success).toBe(true);
    expect(sdkList.success).toBe(true);
    const rows = {
      compact: direct,
      lowFind: low.results[0],
      sdkFind: sdkFind.data?.results[0],
      sdkList: sdkList.data?.tasks[0],
    };
    for (const row of [rows[surface]]) {
      if (!row) throw new Error('projection lost fixture');
      expect(row).not.toHaveProperty('description');
      expect(row).not.toHaveProperty('acceptance');
      expect(row._withheld?.description).toBe(Buffer.byteLength('解析🌱', 'utf8'));
      expect(row._withheld?.acceptance).toBe(
        Buffer.byteLength(JSON.stringify(source.acceptance), 'utf8'),
      );
      for (const key of Object.keys(source)) {
        if (!Object.hasOwn(row, key)) expect(row._withheld).toHaveProperty(key);
      }
      for (const key of Object.keys(row._withheld ?? {}))
        expect(Object.hasOwn(row, key)).toBe(false);
      const projected = projectMvi({ ...row }, 'task');
      expect(projected._withheld).toMatchObject(row._withheld ?? {});
    }
    expect(sdkFind.data?.results[0]._withheld).toHaveProperty('score');
    const full = await taskFind(env.tempDir, 'disclosure', 0, { verbose: true });
    expect(full.data?.results[0]).toHaveProperty('description', '解析🌱');
    expect(full.data?.results[0]).not.toHaveProperty('_withheld');
  });
});
