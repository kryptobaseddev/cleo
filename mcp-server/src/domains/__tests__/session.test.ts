/**
 * Session Domain Handler Tests
 *
 * Tests all 12 session operations:
 * - Query: status, list, show, focus-show, history, stats
 * - Mutate: start, end, resume, switch, focus-set, focus-clear, archive, cleanup
 *
 * @task T2930
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SessionHandler } from '../session.js';
import { CLIExecutor } from '../../lib/executor.js';
import type { DomainResponse } from '../../lib/router.js';
import { createMockExecutor } from '../../__tests__/utils.js';

describe('SessionHandler', () => {
  let handler: SessionHandler;
  let mockExecutor: CLIExecutor;

  beforeEach(() => {
    mockExecutor = createMockExecutor();
    handler = new SessionHandler(mockExecutor);
  });

  // ===== Query Operations =====

  describe('Query Operations', () => {
    it('should get session status', async () => {
      const mockResponse = {
        success: true,
        data: {
          current: {
            id: 'session_123',
            name: 'Test Session',
            scope: 'epic:T001',
            started: '2026-02-03T12:00:00Z',
            status: 'active',
            focusedTask: 'T2930',
          },
          hasFocus: true,
          focusedTask: 'T2930',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('status', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'status',
        flags: { json: true },
      });
    });

    it('should list all sessions', async () => {
      const mockResponse = {
        success: true,
        data: [
          {
            id: 'session_123',
            name: 'Test Session 1',
            scope: 'epic:T001',
            started: '2026-02-03T12:00:00Z',
            status: 'active',
          },
          {
            id: 'session_124',
            name: 'Test Session 2',
            scope: 'epic:T002',
            started: '2026-02-03T13:00:00Z',
            ended: '2026-02-03T14:00:00Z',
            status: 'ended',
          },
        ],
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('list', { active: true });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      // Fixed: active=true now maps to --status active, not --active boolean
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'list',
        flags: { json: true, status: 'active' },
      });
    });

    it('should show session details', async () => {
      const mockResponse = {
        success: true,
        data: {
          id: 'session_123',
          name: 'Test Session',
          scope: 'epic:T001',
          started: '2026-02-03T12:00:00Z',
          status: 'active',
          focusedTask: 'T2930',
          notes: ['Started work', 'Completed T2929'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('show', { sessionId: 'session_123' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'show',
        args: ['session_123'],
        flags: { json: true },
      });
    });

    it('should require sessionId for show', async () => {
      const result = await handler.query('show', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('sessionId is required');
    });

    it('should get focused task', async () => {
      const mockResponse = {
        success: true,
        data: {
          taskId: 'T2930',
          since: '2026-02-03T12:00:00Z',
          sessionId: 'session_123',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('focus-show', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'focus',
        operation: 'show',
        flags: { json: true },
      });
    });

    it('should get session history', async () => {
      const mockResponse = {
        success: true,
        data: [
          {
            sessionId: 'session_123',
            name: 'Session 1',
            started: '2026-02-03T12:00:00Z',
            ended: '2026-02-03T14:00:00Z',
            tasksCompleted: 5,
            duration: '2h 0m',
          },
        ],
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('history', { limit: 10 });

      expect(result.success).toBe(true);
      expect(Array.isArray(result.data)).toBe(true);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'history',
        flags: { json: true, limit: 10 },
      });
    });

    it('should get session stats', async () => {
      const mockResponse = {
        success: true,
        data: {
          totalSessions: 42,
          activeSessions: 1,
          completedTasks: 156,
          averageDuration: '2h 15m',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('stats', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'stats',
        args: [],
        flags: { json: true },
      });
    });

    it('should handle unknown query operations', async () => {
      const result = await handler.query('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('Unknown query operation');
    });
  });

  // ===== Mutate Operations =====

  describe('Mutate Operations', () => {
    it('should start new session', async () => {
      const mockResponse = {
        success: true,
        data: {
          id: 'session_123',
          name: 'New Session',
          scope: 'epic:T001',
          started: '2026-02-03T12:00:00Z',
          status: 'active',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('start', {
        scope: 'epic:T001',
        name: 'New Session',
        autoFocus: true,
      });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'start',
        flags: {
          json: true,
          scope: 'epic:T001',
          name: 'New Session',
          'auto-focus': true,
        },
      });
    });

    it('should require scope for start', async () => {
      const result = await handler.mutate('start', { name: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('scope is required');
    });

    it('should end current session', async () => {
      const mockResponse = {
        success: true,
        data: {
          session: {
            id: 'session_123',
            name: 'Test Session',
            scope: 'epic:T001',
            started: '2026-02-03T12:00:00Z',
            ended: '2026-02-03T14:00:00Z',
            status: 'ended',
          },
          summary: {
            duration: '2h 0m',
            tasksCompleted: 5,
            tasksCreated: 3,
          },
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('end', { notes: 'Completed work' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'end',
        flags: { json: true, note: 'Completed work' },
      });
    });

    it('should resume existing session', async () => {
      const mockResponse = {
        success: true,
        data: {
          id: 'session_123',
          name: 'Test Session',
          scope: 'epic:T001',
          started: '2026-02-03T12:00:00Z',
          status: 'active',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('resume', { sessionId: 'session_123' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'resume',
        args: ['session_123'],
        flags: { json: true },
      });
    });

    it('should require sessionId for resume', async () => {
      const result = await handler.mutate('resume', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('sessionId is required');
    });

    it('should switch to different session', async () => {
      const mockResponse = {
        success: true,
        data: {
          id: 'session_124',
          name: 'Other Session',
          scope: 'epic:T002',
          started: '2026-02-03T13:00:00Z',
          status: 'active',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('switch', { sessionId: 'session_124' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'switch',
        args: ['session_124'],
        flags: { json: true },
      });
    });

    it('should set focused task', async () => {
      const mockResponse = {
        success: true,
        data: {
          taskId: 'T2930',
          sessionId: 'session_123',
          timestamp: '2026-02-03T12:00:00Z',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('focus-set', { taskId: 'T2930' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'focus',
        operation: 'set',
        args: ['T2930'],
        flags: { json: true },
      });
    });

    it('should require taskId for focus-set', async () => {
      const result = await handler.mutate('focus-set', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
      expect(result.error?.message).toContain('taskId is required');
    });

    it('should clear focused task', async () => {
      const mockResponse = {
        success: true,
        data: {
          cleared: true,
          previousTask: 'T2930',
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('focus-clear', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'focus',
        operation: 'clear',
        flags: { json: true },
      });
    });

    it('should archive old sessions', async () => {
      const mockResponse = {
        success: true,
        data: {
          cleaned: 5,
          sessionIds: ['session_100', 'session_101', 'session_102', 'session_103', 'session_104'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('archive', { olderThan: '2026-01-01' });

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'archive',
        flags: { json: true, 'older-than': '2026-01-01' },
      });
    });

    it('should cleanup ended sessions', async () => {
      const mockResponse = {
        success: true,
        data: {
          cleaned: 3,
          sessionIds: ['session_200', 'session_201', 'session_202'],
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.mutate('cleanup', {});

      expect(result.success).toBe(true);
      expect(result.data).toEqual(mockResponse.data);
      expect(mockExecutor.execute).toHaveBeenCalledWith({
        domain: 'session',
        operation: 'cleanup',
        flags: { json: true },
      });
    });

    it('should handle unknown mutate operations', async () => {
      const result = await handler.mutate('unknown', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_OPERATION');
      expect(result.error?.message).toContain('Unknown mutate operation');
    });
  });

  // ===== Regression Tests (T4311 fixes) =====

  describe('Regression Tests', () => {
    // Regression: T4311 - session.list was passing --active boolean flag
    // instead of --status active when filtering active sessions
    it('should use --status active flag, not --active boolean (T4311)', async () => {
      const mockResponse = {
        success: true,
        data: [
          {
            id: 'session_123',
            name: 'Active Session',
            scope: 'epic:T001',
            started: '2026-02-03T12:00:00Z',
            status: 'active',
          },
        ],
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      await handler.query('list', { active: true });

      expect(mockExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: 'session',
          operation: 'list',
          flags: expect.objectContaining({ status: 'active' }),
        })
      );
      // Should NOT have the boolean 'active' flag
      const callArgs = (mockExecutor.execute as any).mock.calls[0][0];
      expect(callArgs.flags).not.toHaveProperty('active');
    });

    // Regression: T4311 - session.list with limit was not slicing results
    it('should slice results when limit is provided (T4311)', async () => {
      const mockResponse = {
        success: true,
        data: [
          { id: 'session_1', name: 'Session 1', status: 'active' },
          { id: 'session_2', name: 'Session 2', status: 'active' },
          { id: 'session_3', name: 'Session 3', status: 'ended' },
          { id: 'session_4', name: 'Session 4', status: 'ended' },
          { id: 'session_5', name: 'Session 5', status: 'ended' },
        ],
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('list', { limit: 2 });

      expect(result.success).toBe(true);
      // Result data should be sliced to 2 items
      expect(Array.isArray(result.data)).toBe(true);
      expect((result.data as any[]).length).toBe(2);
    });

    // Regression: T4311 - limit should also work with sessions sub-object format
    it('should slice sessions sub-object when limit is provided (T4311)', async () => {
      const mockResponse = {
        success: true,
        data: {
          sessions: [
            { id: 'session_1', name: 'Session 1' },
            { id: 'session_2', name: 'Session 2' },
            { id: 'session_3', name: 'Session 3' },
          ],
          count: 3,
        },
        exitCode: 0,
        stdout: '',
        stderr: '',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockResponse);

      const result = await handler.query('list', { limit: 1 });

      expect(result.success).toBe(true);
      const data = result.data as { sessions: unknown[]; count: number };
      expect(data.sessions.length).toBe(1);
    });
  });

  // ===== Error Handling =====

  describe('Error Handling', () => {
    it('should handle executor errors', async () => {
      const mockError = {
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          exitCode: 4,
          message: 'Session not found',
        },
        exitCode: 4,
        stdout: '',
        stderr: 'Session not found',
        duration: 100,
      };

      (mockExecutor.execute as any).mockResolvedValue(mockError);

      const result = await handler.query('show', { sessionId: 'session_999' });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
      expect(result.error?.message).toBe('Session not found');
    });

    it('should handle unexpected errors', async () => {
      (mockExecutor.execute as any).mockRejectedValue(new Error('Unexpected error'));

      const result = await handler.query('status', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INTERNAL_ERROR');
      expect(result.error?.message).toContain('Unexpected error');
    });
  });

  // ===== Supported Operations =====

  describe('getSupportedOperations', () => {
    it('should return all supported operations', () => {
      const ops = handler.getSupportedOperations();

      expect(ops.query).toEqual(['status', 'list', 'show', 'focus-show', 'focus.get', 'history', 'stats']);
      expect(ops.mutate).toEqual([
        'start',
        'end',
        'resume',
        'switch',
        'focus-set',
        'focus.set',
        'focus-clear',
        'focus.clear',
        'archive',
        'cleanup',
        'suspend',
        'gc',
      ]);
    });
  });

  // ===== Handler Without Executor =====

  describe('Handler Without Executor', () => {
    it('should return error when executor is not provided', async () => {
      const handlerNoExecutor = new SessionHandler();

      // With dual-mode routing, status runs natively and returns E_NOT_INITIALIZED
      // when CLEO project is not initialized (different from old "not initialized with executor")
      const result = await handlerNoExecutor.query('status', {});

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_INITIALIZED');
      expect(result.error?.message).toContain('not initialized');
    });
  });
});
