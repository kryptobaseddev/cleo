/**
 * Orchestrate Domain Handler Tests
 *
 * @task T2917
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OrchestrateHandler } from '../orchestrate.js';
import { CLIExecutor } from '../../lib/executor.js';
import { createMockExecutor } from '../../__tests__/utils.js';

describe('OrchestrateHandler', () => {
  let handler: OrchestrateHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new OrchestrateHandler(mockExecutor);
  });

  describe('getSupportedOperations', () => {
    it('returns correct query operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.query).toEqual(['status', 'ready', 'next', 'waves', 'context', 'progress', 'skill.list', 'analyze', 'bootstrap', 'critical-path', 'unblock-opportunities']);
    });

    it('returns correct mutate operations', () => {
      const ops = handler.getSupportedOperations();
      expect(ops.mutate).toEqual(['start', 'spawn', 'pause', 'resume', 'abort', 'analyze', 'validate', 'parallel.start', 'parallel.end', 'startup', 'check', 'skill.inject']);
    });
  });

  describe('query operations', () => {
    describe('status', () => {
      it('gets orchestrator status', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            state: 'running',
            currentWave: 1,
            totalWaves: 3,
            completedTasks: 2,
            remainingTasks: 5,
            parallelActive: 2,
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('status', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect(result.data).toEqual(mockResult.data);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'status',
          flags: { epic: 'T2908', json: true },
        });
      });

      it('requires epicId', async () => {
        const result = await handler.query('status', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('ready', () => {
      it('gets ready tasks', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            wave: 1,
            tasks: [
              { taskId: 'T2910', title: 'Task 1', canSpawnParallel: true },
              { taskId: 'T2911', title: 'Task 2', canSpawnParallel: true },
            ],
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('ready', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.tasks).toHaveLength(2);
      });
    });

    describe('next', () => {
      it('gets next task to spawn', async () => {
        const mockResult = {
          success: true,
          data: {
            taskId: 'T2910',
            title: 'Next task',
            skill: 'ct-task-executor',
            priority: 'high',
            wave: 1,
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('next', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.taskId).toBe('T2910');
      });
    });

    describe('waves', () => {
      it('gets dependency waves', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            waves: [
              { wave: 1, tasks: ['T2910', 'T2911'], parallelSafe: true },
              { wave: 2, tasks: ['T2912'], parallelSafe: false },
            ],
            criticalPath: ['T2910', 'T2912'],
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('waves', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.waves).toHaveLength(2);
      });
    });

    describe('context', () => {
      it('gets context usage', async () => {
        const mockResult = {
          success: true,
          data: {
            tokens: 5000,
            limit: 200000,
            percentage: 2.5,
            status: 'ok',
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('context', {});

        expect(result.success).toBe(true);
        expect((result.data as any)?.status).toBe('ok');
      });

      it('accepts optional tokens parameter', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.query('context', { tokens: 10000 });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'context',
          flags: { json: true, tokens: 10000 },
        });
      });
    });

    describe('progress', () => {
      it('gets progress report', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            totalTasks: 10,
            completedTasks: 3,
            inProgressTasks: 2,
            blockedTasks: 1,
            percentComplete: 30,
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.query('progress', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.percentComplete).toBe(30);
      });
    });
  });

  describe('mutate operations', () => {
    describe('start', () => {
      it('starts orchestrator', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            sessionId: 'session_123',
            state: 'running',
            initialWave: 1,
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('start', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.epicId).toBe('T2908');
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'start',
          flags: { epic: 'T2908', json: true },
        });
      });

      it('accepts optional name and autoFocus', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('start', {
          epicId: 'T2908',
          name: 'Test Session',
          autoFocus: true,
        });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'start',
          flags: { epic: 'T2908', name: 'Test Session', 'auto-focus': true, json: true },
        });
      });

      it('requires epicId', async () => {
        const result = await handler.mutate('start', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('spawn', () => {
      it('spawns subagent', async () => {
        const mockResult = {
          success: true,
          data: {
            taskId: 'T2910',
            skill: 'ct-task-executor',
            prompt: 'Task prompt...',
            metadata: {
              epicId: 'T2908',
              wave: 1,
              tokensResolved: true,
            },
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('spawn', { taskId: 'T2910' });

        expect(result.success).toBe(true);
        expect((result.data as any)?.taskId).toBe('T2910');
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'spawn',
          args: ['T2910'],
          flags: { json: true },
        });
      });

      it('accepts optional skill and model', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('spawn', {
          taskId: 'T2910',
          skill: 'ct-test-writer-bats',
          model: 'claude-opus-4-5',
        });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'spawn',
          args: ['T2910'],
          flags: { skill: 'ct-test-writer-bats', model: 'claude-opus-4-5', json: true },
        });
      });

      it('requires taskId', async () => {
        const result = await handler.mutate('spawn', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('pause', () => {
      it('pauses orchestration', async () => {
        const mockResult = { success: true, data: { epicId: 'T2908', state: 'paused' } };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('pause', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'pause',
          flags: { epic: 'T2908', json: true },
        });
      });

      it('accepts optional reason', async () => {
        const mockResult = { success: true, data: {} };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        await handler.mutate('pause', { epicId: 'T2908', reason: 'Blocker found' });

        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'pause',
          flags: { epic: 'T2908', reason: 'Blocker found', json: true },
        });
      });
    });

    describe('resume', () => {
      it('resumes orchestration', async () => {
        const mockResult = { success: true, data: { epicId: 'T2908', state: 'running' } };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('resume', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'resume',
          flags: { epic: 'T2908', json: true },
        });
      });
    });

    describe('abort', () => {
      it('aborts orchestration', async () => {
        const mockResult = { success: true, data: { epicId: 'T2908', state: 'aborted' } };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('abort', {
          epicId: 'T2908',
          reason: 'Critical issue',
        });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'abort',
          flags: { epic: 'T2908', reason: 'Critical issue', json: true },
        });
      });

      it('requires epicId and reason', async () => {
        let result = await handler.mutate('abort', { epicId: 'T2908' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');

        result = await handler.mutate('abort', { reason: 'Test' });
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });

    describe('analyze', () => {
      it('analyzes dependencies', async () => {
        const mockResult = {
          success: true,
          data: {
            epicId: 'T2908',
            totalTasks: 10,
            waves: 3,
            criticalPath: ['T2910', 'T2912'],
          },
        };
        vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

        const result = await handler.mutate('analyze', { epicId: 'T2908' });

        expect(result.success).toBe(true);
        expect(mockExecutor.execute).toHaveBeenCalledWith({
          domain: 'orchestrator',
          operation: 'analyze',
          args: ['T2908'],
          flags: { json: true },
        });
      });

      it('requires epicId', async () => {
        const result = await handler.mutate('analyze', {});
        expect(result.success).toBe(false);
        expect(result.error?.code).toBe('E_INVALID_INPUT');
      });
    });
  });

  describe('error handling', () => {
    it('handles unknown query operation', async () => {
      const result = await handler.query('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles unknown mutate operation', async () => {
      const result = await handler.mutate('unknown', {});
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
    });

    it('handles executor errors', async () => {
      vi.mocked(mockExecutor.execute).mockRejectedValue(new Error('Executor failed'));

      const result = await handler.query('status', { epicId: 'T2908' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
    });

    it('falls back to native engine when no executor', async () => {
      const handlerNoExecutor = new OrchestrateHandler();
      const result = await handlerNoExecutor.query('status', { epicId: 'T2908' });
      // Without executor, native engine handles the request
      // E_NOT_FOUND is expected since the epic doesn't exist in test env
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('response format', () => {
    it('includes proper metadata in success response', async () => {
      const mockResult = { success: true, data: { epicId: 'T2908' } };
      vi.mocked(mockExecutor.execute).mockResolvedValue(mockResult as any);

      const result = await handler.query('status', { epicId: 'T2908' });

      expect(result._meta).toBeDefined();
      expect(result._meta.gateway).toBe('cleo_query');
      expect(result._meta.domain).toBe('orchestrate');
      expect(result._meta.operation).toBe('status');
      expect(result._meta.version).toBe('1.0.0');
      expect(result._meta.timestamp).toBeDefined();
      expect(result._meta.duration_ms).toBeGreaterThanOrEqual(0);
    });

    it('includes proper metadata in error response', async () => {
      const result = await handler.query('status', {});

      expect(result._meta).toBeDefined();
      expect(result._meta.gateway).toBe('cleo_query');
      expect(result._meta.domain).toBe('orchestrate');
      expect(result._meta.operation).toBe('status');
    });
  });
});
