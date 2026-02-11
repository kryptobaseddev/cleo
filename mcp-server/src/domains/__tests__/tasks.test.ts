/**
 * Tasks Domain Handler Tests
 *
 * Tests all 19 task operations with proper mocking of CLIExecutor.
 *
 * @task T2916
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { TasksHandler } from '../tasks.js';
import { CLIExecutor } from '../../lib/executor.js';
import type { Task, MinimalTask } from '../../types/index.js';
import { createMockExecutor, createSuccessResult } from '../../__tests__/utils.js';

// Mock CLIExecutor
jest.mock('../../lib/executor.js');

describe('TasksHandler', () => {
  let handler: TasksHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new TasksHandler(mockExecutor);
  });

  describe('Query Operations', () => {
    describe('show', () => {
      it('should get task details', async () => {
        const mockTask: Task = {
          id: 'T2916',
          title: 'Test task',
          description: 'Test description',
          status: 'active',
          created: '2026-02-03',
          updated: '2026-02-03',
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockTask,
          exitCode: 0,
          stdout: JSON.stringify(mockTask),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('show', { taskId: 'T2916' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockTask);
        expect(result._meta.operation).toBe('show');
      });

      it('should return error when taskId missing', async () => {
        const result = await handler.query('show', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
        expect(result.error?.message).toContain('taskId is required');
      });
    });

    describe('list', () => {
      it('should list tasks with filters', async () => {
        const mockTasks: Task[] = [
          {
            id: 'T2916',
            title: 'Task 1',
            description: 'Description 1',
            status: 'active',
            created: '2026-02-03',
            updated: '2026-02-03',
          },
        ];

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockTasks,
          exitCode: 0,
          stdout: JSON.stringify(mockTasks),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('list', { parent: 'T2908', status: 'active' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockTasks);
        expect(mockExecutor.execute).toHaveBeenCalledWith(
          expect.objectContaining({
            domain: 'list',
            flags: expect.objectContaining({ parent: 'T2908', status: 'active' }),
          })
        );
      });
    });

    describe('find', () => {
      it('should search tasks', async () => {
        const mockResults: MinimalTask[] = [
          { id: 'T2916', title: 'Found task', status: 'active' },
        ];

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockResults,
          exitCode: 0,
          stdout: JSON.stringify(mockResults),
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('find', { query: 'test' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockResults);
      });

      it('should return error when query missing', async () => {
        const result = await handler.query('find', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('exists', () => {
      it('should check task existence', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { exists: true, taskId: 'T2916' },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('exists', { taskId: 'T2916' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual({ exists: true, taskId: 'T2916' });
      });
    });

    describe('next', () => {
      it('should get next suggested task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { taskId: 'T2917', title: 'Next task', score: 0.9 },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('next', { epicId: 'T2908' });

        expect(result.success).toBe(true);
      });
    });

    describe('depends', () => {
      it('should get dependencies', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { taskId: 'T2916', depends: ['T2915'], blockedBy: [] },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('depends', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('stats', () => {
      it('should get task statistics', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { total: 10, pending: 5, active: 3, blocked: 1, done: 1 },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('stats', {});

        expect(result.success).toBe(true);
      });
    });

    describe('export', () => {
      it('should export tasks', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { tasks: [] },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('export', { format: 'json' });

        expect(result.success).toBe(true);
      });
    });

    describe('history', () => {
      it('should get task history', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: [{ timestamp: '2026-02-03', action: 'created' }],
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('history', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('lint', () => {
      it('should validate task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: [],
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('lint', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('batch-validate', () => {
      it('should validate multiple tasks', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { T2916: [], T2917: [] },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.query('batch-validate', {
          taskIds: ['T2916', 'T2917'],
        });

        expect(result.success).toBe(true);
      });

      it('should return error when taskIds missing', async () => {
        const result = await handler.query('batch-validate', {});

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });
  });

  describe('Mutate Operations', () => {
    describe('add', () => {
      it('should create new task', async () => {
        const mockTask: Task = {
          id: 'T2917',
          title: 'New task',
          description: 'New description',
          status: 'pending',
          created: '2026-02-03',
          updated: '2026-02-03',
        };

        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: mockTask,
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('add', {
          title: 'New task',
          description: 'New description',
        });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockTask);
      });

      it('should return error when title missing', async () => {
        const result = await handler.mutate('add', { description: 'Description' });

        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('update', () => {
      it('should update task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { id: 'T2916' },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('update', {
          taskId: 'T2916',
          title: 'Updated title',
        });

        expect(result.success).toBe(true);
      });
    });

    describe('complete', () => {
      it('should mark task done', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { taskId: 'T2916', completed: '2026-02-03', archived: false },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('complete', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('delete', () => {
      it('should delete task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { taskId: 'T2916', deleted: true },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('delete', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('archive', () => {
      it('should archive tasks', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { archived: 5, taskIds: ['T1', 'T2', 'T3', 'T4', 'T5'] },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('archive', {});

        expect(result.success).toBe(true);
      });
    });

    describe('restore', () => {
      it('should restore task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { id: 'T2916' },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('restore', { taskId: 'T2916' });

        expect(result.success).toBe(true);
      });
    });

    describe('import', () => {
      it('should import tasks', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { imported: 10, skipped: 2, errors: [] },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('import', { source: 'tasks.json' });

        expect(result.success).toBe(true);
      });
    });

    describe('reorder', () => {
      it('should reorder task', async () => {
        jest.mocked(mockExecutor.execute).mockResolvedValue({
          success: true,
          data: { taskId: 'T2916', newPosition: 3 },
          exitCode: 0,
          stdout: '',
          stderr: '',
          duration: 50,
        });

        const result = await handler.mutate('reorder', { taskId: 'T2916', position: 3 });

        expect(result.success).toBe(true);
      });
    });
  });

  // ===== Regression Tests (T4314, T4315 fixes) =====

  describe('Regression Tests', () => {
    // Regression: T4314 - tasks.next was using default 30s timeout which caused
    // timeouts on large task lists. Now uses 60s timeout.
    it('should set timeout > 30000ms for next operation (T4314)', async () => {
      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: { taskId: 'T2917', title: 'Next task', score: 0.9 },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 50,
      });

      await handler.query('next', {});

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'next',
          timeout: 60000,
          flags: expect.objectContaining({ json: true }),
        })
      );
    });

    // Regression: T4315 - tasks.tree with rootId was passing rootId as positional arg
    // but now correctly uses --parent flag
    it('should pass rootId as --parent flag for tree operation (T4315)', async () => {
      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: { tree: [] },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 50,
      });

      await handler.query('tree', { rootId: 'T3156' });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'tree',
          flags: expect.objectContaining({ json: true, parent: 'T3156' }),
        })
      );
    });

    it('should pass depth flag for tree operation (T4315)', async () => {
      jest.mocked(mockExecutor.execute).mockResolvedValue({
        success: true,
        data: { tree: [] },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 50,
      });

      await handler.query('tree', { rootId: 'T3156', depth: 2 });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          flags: expect.objectContaining({ parent: 'T3156', depth: 2 }),
        })
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle unknown query operation', async () => {
      const result = await handler.query('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle unknown mutate operation', async () => {
      const result = await handler.mutate('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('should handle executor errors', async () => {
      jest.mocked(mockExecutor.execute).mockRejectedValue(new Error('Executor failed'));

      const result = await handler.query('show', { taskId: 'T2916' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
    });
  });

  describe('getSupportedOperations', () => {
    it('should return all supported operations', () => {
      const ops = handler.getSupportedOperations();

      expect(ops.query).toHaveLength(18);
      expect(ops.mutate).toHaveLength(14);
      expect(ops.query).toContain('show');
      expect(ops.query).toContain('get');
      expect(ops.query).toContain('list');
      expect(ops.query).toContain('find');
      expect(ops.query).toContain('tree');
      expect(ops.query).toContain('blockers');
      expect(ops.query).toContain('deps');
      expect(ops.query).toContain('analyze');
      expect(ops.mutate).toContain('add');
      expect(ops.mutate).toContain('create');
      expect(ops.mutate).toContain('update');
      expect(ops.mutate).toContain('complete');
      expect(ops.mutate).toContain('reparent');
      expect(ops.mutate).toContain('promote');
      expect(ops.mutate).toContain('reopen');
      expect(ops.mutate).toContain('unarchive');
    });
  });
});
