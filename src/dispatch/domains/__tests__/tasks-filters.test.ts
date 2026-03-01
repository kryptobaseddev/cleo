/**
 * Tests for task find filter passthrough and list compact mode at the engine level.
 *
 * Mocks getAccessor to isolate the engine from the real database, then verifies
 * that taskFind and taskList correctly pass new optional parameters through
 * to core functions, and that backward compatibility is preserved.
 *
 * @task T5156
 * @epic T5150
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock getAccessor — must be before imports
vi.mock('../../../store/data-accessor.js', () => ({
  getAccessor: vi.fn(),
}));

// Mock core list/find modules
vi.mock('../../../core/tasks/list.js', () => ({
  listTasks: vi.fn(),
  toCompact: vi.fn((t: Record<string, unknown>) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
  })),
}));

vi.mock('../../../core/tasks/find.js', () => ({
  findTasks: vi.fn(),
}));

import { getAccessor } from '../../../store/data-accessor.js';
import { listTasks as coreListTasks, toCompact } from '../../../core/tasks/list.js';
import { findTasks as coreFindTasks } from '../../../core/tasks/find.js';
import { taskList, taskFind } from '../../engines/task-engine.js';

const MOCK_TASKS = [
  { id: 'T001', title: 'Task one', status: 'active', priority: 'high', description: 'First', parentId: undefined },
  { id: 'T002', title: 'Task two', status: 'pending', priority: 'medium', description: 'Second', parentId: 'T001' },
];

const mockAccessor = { loadTaskFile: vi.fn() };

describe('taskFind filter passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessor).mockResolvedValue(mockAccessor as never);
    vi.mocked(coreFindTasks).mockResolvedValue({
      results: MOCK_TASKS as never[],
      total: 2,
    });
  });

  it('passes only query and limit when no options given (backward compat)', async () => {
    const result = await taskFind('/mock/project', 'test', 10);

    expect(result.success).toBe(true);
    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'test',
        limit: 10,
      }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('defaults limit to 20 when not provided', async () => {
    await taskFind('/mock/project', 'test');

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 20 }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes status filter through to core', async () => {
    await taskFind('/mock/project', 'test', undefined, { status: 'active' });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active' }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes id filter through to core', async () => {
    await taskFind('/mock/project', '', undefined, { id: 'T00' });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'T00' }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes exact flag through to core', async () => {
    await taskFind('/mock/project', 'exact match', undefined, { exact: true });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ exact: true }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes includeArchive through to core', async () => {
    await taskFind('/mock/project', 'old', undefined, { includeArchive: true });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ includeArchive: true }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes offset through to core', async () => {
    await taskFind('/mock/project', 'page', undefined, { offset: 20 });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 20 }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('passes all filters simultaneously', async () => {
    await taskFind('/mock/project', 'multi', 5, {
      id: 'T1',
      exact: false,
      status: 'pending',
      includeArchive: true,
      offset: 10,
    });

    expect(coreFindTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'multi',
        limit: 5,
        id: 'T1',
        exact: false,
        status: 'pending',
        includeArchive: true,
        offset: 10,
      }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('returns MinimalTaskRecord fields only', async () => {
    const result = await taskFind('/mock/project', 'test');

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      for (const r of result.data.results) {
        expect(r).toHaveProperty('id');
        expect(r).toHaveProperty('title');
        expect(r).toHaveProperty('status');
        expect(r).toHaveProperty('priority');
        expect(r).toHaveProperty('parentId');
        // description should be stripped in the MinimalTaskRecord projection
        expect(r).not.toHaveProperty('description');
      }
    }
  });
});

describe('taskList compact mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAccessor).mockResolvedValue(mockAccessor as never);
    vi.mocked(coreListTasks).mockResolvedValue({
      tasks: MOCK_TASKS as never[],
      total: 2,
    });
  });

  it('returns full records when compact is not set (backward compat)', async () => {
    const result = await taskList('/mock/project', { parent: 'T100' });

    expect(result.success).toBe(true);
    expect(toCompact).not.toHaveBeenCalled();
  });

  it('returns full records when compact is false', async () => {
    const result = await taskList('/mock/project', { compact: false });

    expect(result.success).toBe(true);
    expect(toCompact).not.toHaveBeenCalled();
  });

  it('calls toCompact for each task when compact is true', async () => {
    const result = await taskList('/mock/project', { compact: true });

    expect(result.success).toBe(true);
    expect(toCompact).toHaveBeenCalledTimes(2);
  });

  it('accepts params without compact (backward compat)', async () => {
    const result = await taskList('/mock/project', { status: 'pending', limit: 5 });

    expect(result.success).toBe(true);
    expect(coreListTasks).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending', limit: 5 }),
      '/mock/project',
      expect.anything(),
    );
  });

  it('accepts no params at all (backward compat)', async () => {
    const result = await taskList('/mock/project');

    expect(result.success).toBe(true);
    expect(coreListTasks).toHaveBeenCalled();
  });
});
