import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine functions before importing the handler
vi.mock('../../../mcp/engine/index.js', () => ({
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

// Mock getProjectRoot
vi.mock('../../../core/paths.js', () => ({
  getProjectRoot: vi.fn(() => '/mock/project'),
}));

import { TasksHandler } from '../tasks.js';
import {
  taskShow,
  taskList,
  taskFind,
  taskExists,
  taskCreate,
  taskUpdate,
  taskComplete,
  taskDelete,
  taskArchive,
  taskNext,
  taskBlockers,
  taskTree,
  taskRelates,
  taskRelatesAdd,
  taskAnalyze,
  taskRestore,
  taskReorder,
  taskReparent,
  taskPromote,
  taskReopen,
  taskComplexityEstimate,
  taskDepends,
  taskCurrentGet,
  taskStart,
  taskStop,
} from '../../../mcp/engine/index.js';

describe('TasksHandler', () => {
  let handler: TasksHandler;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new TasksHandler();
  });

  // -----------------------------------------------------------------------
  // getSupportedOperations
  // -----------------------------------------------------------------------

  describe('getSupportedOperations', () => {
    it('should list all query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toEqual([
        'show', 'list', 'find', 'exists', 'tree', 'blockers',
        'depends', 'analyze', 'next', 'relates', 'complexity.estimate', 'current',
      ]);
    });

    it('should list all mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual([
        'add', 'update', 'complete', 'delete', 'archive', 'restore',
        'reparent', 'promote', 'reorder', 'reopen', 'relates.add',
        'uncancel', 'start', 'stop',
      ]);
    });
  });

  // -----------------------------------------------------------------------
  // Query operations
  // -----------------------------------------------------------------------

  describe('query', () => {
    it('show - delegates to taskShow', async () => {
      const mockData = { id: 'T001', title: 'Test' };
      vi.mocked(taskShow).mockResolvedValue({ success: true, data: mockData });

      const result = await handler.query('show', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockData);
      expect(taskShow).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('show - returns error when taskId missing', async () => {
      const result = await handler.query('show', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('list - delegates to taskList', async () => {
      const mockData = [{ id: 'T001' }];
      vi.mocked(taskList).mockResolvedValue({ success: true, data: mockData });

      const result = await handler.query('list', { status: 'pending' });

      expect(result.success).toBe(true);
      expect(taskList).toHaveBeenCalledWith('/mock/project', { status: 'pending' });
    });

    it('find - delegates to taskFind', async () => {
      const mockData = [{ id: 'T001', title: 'Test' }];
      vi.mocked(taskFind).mockResolvedValue({ success: true, data: mockData });

      const result = await handler.query('find', { query: 'test', limit: 10 });

      expect(result.success).toBe(true);
      expect(taskFind).toHaveBeenCalledWith('/mock/project', 'test', 10);
    });

    it('exists - delegates to taskExists', async () => {
      vi.mocked(taskExists).mockResolvedValue({ success: true, data: { exists: true, taskId: 'T001' } });

      const result = await handler.query('exists', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ exists: true, taskId: 'T001' });
    });

    it('tree - delegates to taskTree', async () => {
      vi.mocked(taskTree).mockResolvedValue({ success: true, data: { tree: [], totalNodes: 0 } });

      const result = await handler.query('tree', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskTree).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('blockers - delegates to taskBlockers', async () => {
      vi.mocked(taskBlockers).mockResolvedValue({ success: true, data: { blockedTasks: [] } });

      const result = await handler.query('blockers', { analyze: true });

      expect(result.success).toBe(true);
      expect(taskBlockers).toHaveBeenCalledWith('/mock/project', { analyze: true });
    });

    it('depends - delegates to taskDepends', async () => {
      vi.mocked(taskDepends).mockResolvedValue({ success: true, data: { taskId: 'T001', upstream: [], downstream: [] } });

      const result = await handler.query('depends', { taskId: 'T001', direction: 'both' });

      expect(result.success).toBe(true);
      expect(taskDepends).toHaveBeenCalledWith('/mock/project', 'T001', 'both');
    });

    it('analyze - delegates to taskAnalyze', async () => {
      vi.mocked(taskAnalyze).mockResolvedValue({ success: true, data: {} });

      const result = await handler.query('analyze', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskAnalyze).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('next - delegates to taskNext', async () => {
      vi.mocked(taskNext).mockResolvedValue({ success: true, data: { suggestions: [] } });

      const result = await handler.query('next', { count: 5 });

      expect(result.success).toBe(true);
      expect(taskNext).toHaveBeenCalledWith('/mock/project', { count: 5 });
    });

    it('relates - delegates to taskRelates', async () => {
      vi.mocked(taskRelates).mockResolvedValue({ success: true, data: { taskId: 'T001', relations: [], count: 0 } });

      const result = await handler.query('relates', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskRelates).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('complexity.estimate - delegates to taskComplexityEstimate', async () => {
      vi.mocked(taskComplexityEstimate).mockResolvedValue({ success: true, data: { size: 'small', score: 3 } });

      const result = await handler.query('complexity.estimate', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskComplexityEstimate).toHaveBeenCalledWith('/mock/project', { taskId: 'T001' });
    });

    it('current - delegates to taskCurrentGet', async () => {
      vi.mocked(taskCurrentGet).mockResolvedValue({ success: true, data: { taskId: 'T001' } });

      const result = await handler.query('current');

      expect(result.success).toBe(true);
      expect(taskCurrentGet).toHaveBeenCalledWith('/mock/project');
    });

    it('unsupported operation returns error', async () => {
      const result = await handler.query('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles engine exceptions gracefully', async () => {
      vi.mocked(taskShow).mockRejectedValue(new Error('Connection failed'));

      const result = await handler.query('show', { taskId: 'T001' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
      expect(result.error?.message).toBe('Connection failed');
    });
  });

  // -----------------------------------------------------------------------
  // Mutate operations
  // -----------------------------------------------------------------------

  describe('mutate', () => {
    it('add - delegates to taskCreate', async () => {
      const mockTask = { id: 'T001', title: 'New Task' };
      vi.mocked(taskCreate).mockResolvedValue({ success: true, data: mockTask });

      const result = await handler.mutate('add', { title: 'New Task', description: 'Desc' });

      expect(result.success).toBe(true);
      expect(taskCreate).toHaveBeenCalledWith('/mock/project', expect.objectContaining({ title: 'New Task' }));
    });

    it('add - returns error when title missing', async () => {
      const result = await handler.mutate('add', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('update - delegates to taskUpdate', async () => {
      vi.mocked(taskUpdate).mockResolvedValue({ success: true, data: { id: 'T001' } });

      const result = await handler.mutate('update', { taskId: 'T001', title: 'Updated' });

      expect(result.success).toBe(true);
      expect(taskUpdate).toHaveBeenCalledWith('/mock/project', 'T001', expect.objectContaining({ title: 'Updated' }));
    });

    it('complete - delegates to taskComplete', async () => {
      vi.mocked(taskComplete).mockResolvedValue({ success: true, data: { id: 'T001' } });

      const result = await handler.mutate('complete', { taskId: 'T001', notes: 'Done' });

      expect(result.success).toBe(true);
      expect(taskComplete).toHaveBeenCalledWith('/mock/project', 'T001', 'Done');
    });

    it('delete - delegates to taskDelete', async () => {
      vi.mocked(taskDelete).mockResolvedValue({ success: true, data: { deleted: true, taskId: 'T001' } });

      const result = await handler.mutate('delete', { taskId: 'T001', force: true });

      expect(result.success).toBe(true);
      expect(taskDelete).toHaveBeenCalledWith('/mock/project', 'T001', true);
    });

    it('archive - delegates to taskArchive', async () => {
      vi.mocked(taskArchive).mockResolvedValue({ success: true, data: { archived: 2, taskIds: ['T001', 'T002'] } });

      const result = await handler.mutate('archive', {});

      expect(result.success).toBe(true);
      expect(taskArchive).toHaveBeenCalledWith('/mock/project', undefined, undefined);
    });

    it('restore - delegates to taskRestore', async () => {
      vi.mocked(taskRestore).mockResolvedValue({ success: true, data: { task: 'T001', restored: ['T001'], count: 1 } });

      const result = await handler.mutate('restore', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskRestore).toHaveBeenCalledWith('/mock/project', 'T001', { cascade: undefined, notes: undefined });
    });

    it('reparent - delegates to taskReparent', async () => {
      vi.mocked(taskReparent).mockResolvedValue({ success: true, data: { task: 'T001', reparented: true } });

      const result = await handler.mutate('reparent', { taskId: 'T001', newParentId: 'T002' });

      expect(result.success).toBe(true);
      expect(taskReparent).toHaveBeenCalledWith('/mock/project', 'T001', 'T002');
    });

    it('promote - delegates to taskPromote', async () => {
      vi.mocked(taskPromote).mockResolvedValue({ success: true, data: { task: 'T001', promoted: true } });

      const result = await handler.mutate('promote', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskPromote).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('reorder - delegates to taskReorder', async () => {
      vi.mocked(taskReorder).mockResolvedValue({ success: true, data: { task: 'T001', reordered: true } });

      const result = await handler.mutate('reorder', { taskId: 'T001', position: 3 });

      expect(result.success).toBe(true);
      expect(taskReorder).toHaveBeenCalledWith('/mock/project', 'T001', 3);
    });

    it('reopen - delegates to taskReopen', async () => {
      vi.mocked(taskReopen).mockResolvedValue({ success: true, data: { task: 'T001', reopened: true } });

      const result = await handler.mutate('reopen', { taskId: 'T001', status: 'pending' });

      expect(result.success).toBe(true);
      expect(taskReopen).toHaveBeenCalledWith('/mock/project', 'T001', { status: 'pending', reason: undefined });
    });

    it('relates.add - delegates to taskRelatesAdd', async () => {
      vi.mocked(taskRelatesAdd).mockResolvedValue({ success: true, data: { from: 'T001', to: 'T002', type: 'blocks', added: true } });

      const result = await handler.mutate('relates.add', { taskId: 'T001', relatedId: 'T002', type: 'blocks' });

      expect(result.success).toBe(true);
      expect(taskRelatesAdd).toHaveBeenCalledWith('/mock/project', 'T001', 'T002', 'blocks', undefined);
    });

    it('relates.add - returns error when params missing', async () => {
      const result = await handler.mutate('relates.add', { taskId: 'T001' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('uncancel - delegates to taskRestore', async () => {
      vi.mocked(taskRestore).mockResolvedValue({ success: true, data: { task: 'T001', restored: ['T001'], count: 1 } });

      const result = await handler.mutate('uncancel', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskRestore).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('start - delegates to taskStart', async () => {
      vi.mocked(taskStart).mockResolvedValue({ success: true, data: { taskId: 'T001' } });

      const result = await handler.mutate('start', { taskId: 'T001' });

      expect(result.success).toBe(true);
      expect(taskStart).toHaveBeenCalledWith('/mock/project', 'T001');
    });

    it('stop - delegates to taskStop', async () => {
      vi.mocked(taskStop).mockResolvedValue({ success: true, data: {} });

      const result = await handler.mutate('stop');

      expect(result.success).toBe(true);
      expect(taskStop).toHaveBeenCalledWith('/mock/project');
    });

    it('unsupported operation returns error', async () => {
      const result = await handler.mutate('nonexistent');

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles engine exceptions gracefully', async () => {
      vi.mocked(taskCreate).mockRejectedValue(new Error('Disk full'));

      const result = await handler.mutate('add', { title: 'New Task' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL');
    });

    it('wraps engine error responses correctly', async () => {
      vi.mocked(taskShow).mockResolvedValue({
        success: false,
        error: { code: 'E_NOT_FOUND', message: 'Task not found' },
      });

      const result = await handler.query('show', { taskId: 'T999' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
      expect(result.error?.message).toBe('Task not found');
    });
  });
});
