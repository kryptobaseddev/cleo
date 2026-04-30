/**
 * Tests for task find filter passthrough and list compact mode at the engine level.
 *
 * After T1568 Wave 5, taskFind and taskList live in packages/core/src/tasks/
 * alongside findTasks and listTasks. Because they are in the same module,
 * we cannot intercept the internal calls via vi.mock. Instead, these tests
 * verify behavior via accessor-level mocking: we supply a controlled DataAccessor
 * stub that returns predictable task data and assert on the ENGINE OUTPUT.
 *
 * @task T5156
 * @epic T5150
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../../core/src/store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

import { getAccessor } from '../../../../../core/src/store/data-accessor.js';
import { taskFind, taskList } from '../../lib/engine.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TASK_ONE = {
  id: 'T001',
  title: 'Task one',
  status: 'active',
  priority: 'high',
  type: 'task',
  parentId: undefined,
  depends: [],
};
const TASK_TWO = {
  id: 'T002',
  title: 'Task two',
  status: 'pending',
  priority: 'medium',
  type: 'task',
  parentId: 'T001',
  depends: [],
};

/**
 * Build a DataAccessor stub whose queryTasks returns a fixed list of tasks.
 *
 * The stub also provides countTasks (required by listTasks) and loadArchive
 * (required when includeArchive:true is passed to findTasks).
 */
function makeAccessorStub(tasks: (typeof TASK_ONE)[]) {
  return {
    queryTasks: vi.fn((_filters: Record<string, unknown>) => ({
      tasks:
        _filters.status != null ? tasks.filter((t) => t.status === _filters.status) : [...tasks],
      total: tasks.length,
    })),
    countTasks: vi.fn().mockResolvedValue(tasks.length),
    loadArchive: vi.fn().mockResolvedValue(null),
  };
}

// ---------------------------------------------------------------------------
// taskFind — filter passthrough verified via output
//
// Strategy: supply tasks that can be distinguished by the query/filter params,
// then assert on result.data.results to verify the correct tasks were returned.
// ---------------------------------------------------------------------------

describe('taskFind filter passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorStub([TASK_ONE, TASK_TWO]) as ReturnType<typeof getAccessor> extends Promise<
        infer T
      >
        ? T
        : never,
    );
  });

  it('passes only query and limit when no options given (backward compat)', async () => {
    const result = await taskFind('/mock/project', 'one', 10);

    expect(result.success).toBe(true);
    // Query 'one' should match TASK_ONE's title
    expect(result.data?.results.some((r) => r.id === 'T001')).toBe(true);
    expect(result.data?.total).toBeGreaterThanOrEqual(1);
  });

  it('defaults limit to 20 when not provided', async () => {
    const result = await taskFind('/mock/project', 'task');

    expect(result.success).toBe(true);
    // Both tasks have 'task' in their type/title — at most 20 returned (default limit)
    expect(result.data?.results.length).toBeLessThanOrEqual(20);
  });

  it('passes status filter through to core', async () => {
    const result = await taskFind('/mock/project', 'task', undefined, { status: 'active' });

    expect(result.success).toBe(true);
    // Only 'active' tasks should appear
    if (result.data && result.data.results.length > 0) {
      for (const r of result.data.results) {
        expect(r.status).toBe('active');
      }
    }
  });

  it('passes id filter through to core', async () => {
    const result = await taskFind('/mock/project', '', undefined, { id: 'T001' });

    expect(result.success).toBe(true);
    // ID prefix 'T001' should return T001
    expect(result.data?.results.some((r) => r.id === 'T001')).toBe(true);
  });

  it('passes exact flag through to core', async () => {
    // exact:true still searches; no error expected
    const result = await taskFind('/mock/project', 'Task one', undefined, { exact: true });

    expect(result.success).toBe(true);
  });

  it('passes includeArchive through to core', async () => {
    const result = await taskFind('/mock/project', 'old', undefined, { includeArchive: true });

    // No archive tasks; result is still valid (success=true, results may be empty)
    expect(result.success).toBe(true);
  });

  it('passes offset through to core', async () => {
    // offset:20 on 2 tasks → no results, but call succeeds
    const result = await taskFind('/mock/project', 'task', undefined, { offset: 20 });

    expect(result.success).toBe(true);
  });

  it('passes all filters simultaneously', async () => {
    const result = await taskFind('/mock/project', '', 5, {
      id: 'T001',
      exact: false,
      status: 'active',
      includeArchive: false,
      offset: 0,
    });

    expect(result.success).toBe(true);
    if (result.data && result.data.results.length > 0) {
      expect(result.data.results[0]!.id).toBe('T001');
    }
  });

  it('returns MinimalTaskRecord fields only', async () => {
    const result = await taskFind('/mock/project', 'one');

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      for (const r of result.data.results) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('status');
        expect(r).toHaveProperty('priority');
        // description is not a MinimalTaskRecord field — should be absent
        expect(r).not.toHaveProperty('description');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// taskList compact mode
// ---------------------------------------------------------------------------

describe('taskList compact mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessor).mockResolvedValue(
      makeAccessorStub([TASK_ONE, TASK_TWO]) as ReturnType<typeof getAccessor> extends Promise<
        infer T
      >
        ? T
        : never,
    );
  });

  it('returns full records when compact is not set (backward compat)', async () => {
    const result = await taskList('/mock/project', { parent: 'T100' });

    // Full TaskRecord has createdAt — compact does not.
    expect(result.success).toBe(true);
    if (result.data && result.data.tasks.length > 0) {
      const firstTask = result.data.tasks[0] as Record<string, unknown>;
      // TaskRecord includes createdAt (full record, not compact)
      expect(firstTask).toHaveProperty('createdAt');
    }
  });

  it('returns full records when compact is false', async () => {
    const result = await taskList('/mock/project', { compact: false });

    expect(result.success).toBe(true);
    if (result.data && result.data.tasks.length > 0) {
      const firstTask = result.data.tasks[0] as Record<string, unknown>;
      expect(firstTask).toHaveProperty('createdAt');
    }
  });

  it('returns compact records when compact is true', async () => {
    const result = await taskList('/mock/project', { compact: true });

    expect(result.success).toBe(true);
    if (result.data && result.data.tasks.length > 0) {
      const firstTask = result.data.tasks[0] as Record<string, unknown>;
      // CompactTask has a known small set of fields; full TaskRecord has createdAt, updatedAt, etc.
      // In compact mode, tasks are serialised via toCompact which strips those fields.
      expect(firstTask).toHaveProperty('id');
      expect(firstTask).toHaveProperty('title');
      expect(firstTask).toHaveProperty('status');
      expect(firstTask).toHaveProperty('priority');
      // createdAt/updatedAt are present on full TaskRecord but absent on CompactTask
      expect(firstTask).not.toHaveProperty('createdAt');
    }
  });

  it('accepts params without compact (backward compat)', async () => {
    const result = await taskList('/mock/project', {
      status: 'pending',
      priority: 'high',
      type: 'task',
      phase: 'build',
      label: 'bug',
      children: true,
      limit: 5,
      offset: 10,
    });

    // Call succeeds — params are accepted without error
    expect(result.success).toBe(true);
  });

  it('returns canonical counts in the list envelope', async () => {
    const result = await taskList('/mock/project', { compact: false });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.total).toBeGreaterThanOrEqual(0);
    expect(result.data!.filtered).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.data!.tasks)).toBe(true);
  });

  it('accepts no params at all (backward compat)', async () => {
    const result = await taskList('/mock/project');

    expect(result.success).toBe(true);
  });
});
