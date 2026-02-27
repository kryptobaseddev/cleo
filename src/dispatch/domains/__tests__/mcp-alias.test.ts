/**
 * Tests that tasks.reopen is a distinct operation, not aliased to tasks.restore.
 *
 * The dispatch layer routes 'reopen' to taskReopen() (which handles status
 * transitions for completed/cancelled tasks) rather than taskRestore()
 * (which restores archived tasks).
 *
 * @task T4820
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine functions before importing the handler
vi.mock('../../lib/engine.js', () => ({
  taskShow: vi.fn(),
  taskList: vi.fn(),
  taskFind: vi.fn(),
  taskExists: vi.fn(),
  taskCreate: vi.fn(),
  taskUpdate: vi.fn(),
  taskComplete: vi.fn(),
  taskDelete: vi.fn(),
  taskArchive: vi.fn(),
  taskNext: vi.fn(),
  taskBlockers: vi.fn(),
  taskTree: vi.fn(),
  taskRelates: vi.fn(),
  taskRelatesAdd: vi.fn(),
  taskAnalyze: vi.fn(),
  taskRestore: vi.fn(),
  taskReorder: vi.fn(),
  taskReparent: vi.fn(),
  taskPromote: vi.fn(),
  taskReopen: vi.fn(),
  taskComplexityEstimate: vi.fn(),
  taskDepends: vi.fn(),
  taskCurrentGet: vi.fn(),
  taskStart: vi.fn(),
  taskStop: vi.fn(),
}));

vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { TasksHandler } from '../tasks.js';
import {
  taskReopen,
  taskRestore,
} from '../../lib/engine.js';

describe('tasks.reopen vs tasks.restore', () => {
  let handler: TasksHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TasksHandler();
  });

  it('reopen is listed as a distinct supported operation', () => {
    const ops = handler.getSupportedOperations();
    expect(ops.mutate).toContain('reopen');
    expect(ops.mutate).toContain('restore');
  });

  it('reopen delegates to taskReopen, NOT taskRestore', async () => {
    vi.mocked(taskReopen).mockResolvedValue({
      success: true,
      data: { id: 'T001', status: 'pending' },
    });

    const result = await handler.mutate('reopen', { taskId: 'T001' });

    expect(result.success).toBe(true);
    expect(taskReopen).toHaveBeenCalledWith('/mock/project', 'T001', {
      status: undefined,
      reason: undefined,
    });
    expect(taskRestore).not.toHaveBeenCalled();
  });

  it('restore delegates to taskRestore, NOT taskReopen', async () => {
    vi.mocked(taskRestore).mockResolvedValue({
      success: true,
      data: { id: 'T001', status: 'pending' },
    });

    const result = await handler.mutate('restore', { taskId: 'T001' });

    expect(result.success).toBe(true);
    expect(taskRestore).toHaveBeenCalledWith('/mock/project', 'T001', {
      cascade: undefined,
      notes: undefined,
    });
    expect(taskReopen).not.toHaveBeenCalled();
  });

  it('reopen passes status and reason params', async () => {
    vi.mocked(taskReopen).mockResolvedValue({
      success: true,
      data: { id: 'T001', status: 'active' },
    });

    await handler.mutate('reopen', {
      taskId: 'T001',
      status: 'active',
      reason: 'Need to revisit',
    });

    expect(taskReopen).toHaveBeenCalledWith('/mock/project', 'T001', {
      status: 'active',
      reason: 'Need to revisit',
    });
  });

  it('reopen returns error when taskId missing', async () => {
    const result = await handler.mutate('reopen', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
    expect(taskReopen).not.toHaveBeenCalled();
  });
});
