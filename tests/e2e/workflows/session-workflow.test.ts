import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchRaw, resetCliDispatcher } from '../../../src/dispatch/adapters/cli.js';

// Mock engine imports
vi.mock('../../../src/dispatch/lib/engine.js', () => ({
  // Session engine
  sessionStart: vi.fn(),
  sessionEnd: vi.fn(),
  sessionResume: vi.fn(),
  sessionStatus: vi.fn(),
  sessionSuspend: vi.fn(),
  sessionList: vi.fn(),
  // Task engine
  taskComplete: vi.fn(),
  taskStart: vi.fn(),
  taskStop: vi.fn(),
  taskCurrentGet: vi.fn(),
}));

import {
  sessionEnd,
  sessionResume,
  sessionStart,
  taskComplete,
  taskCurrentGet,
  taskStart,
  taskStop,
} from '../../../src/dispatch/lib/engine.js';

describe('Session Workflow E2E Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCliDispatcher();
  });

  describe('Full Session Workflow', () => {
    it('should execute session workflow: start -> task workflow -> complete -> end', async () => {
      // Step 1: Start session (session.start) - returns Session
      vi.mocked(sessionStart).mockResolvedValueOnce({
        success: true,
        data: {
          id: 'session_e2e_1',
          name: 'E2E Test Session',
          scope: {
            type: 'epic',
            rootTaskId: 'T2400',
          },
          startedAt: '2026-02-06T10:00:00Z',
          status: 'active',
          taskWork: {
            taskId: null,
            setAt: null,
          },
        },
      });

      const startResult = await dispatchRaw('mutate', 'session', 'start', {
        scope: 'epic:T2400',
        name: 'E2E Test Session',
      });

      expect(startResult.success).toBe(true);
      expect(startResult.data).toMatchObject({
        id: 'session_e2e_1',
        status: 'active',
      });

      // Step 2: Start working on a task (tasks.start) - returns { taskId, previousTask }
      vi.mocked(taskStart).mockResolvedValueOnce({
        success: true,
        data: {
          taskId: 'T2405',
          previousTask: null,
        },
      });

      const taskStartResult = await dispatchRaw('mutate', 'tasks', 'start', {
        taskId: 'T2405',
      });

      expect(taskStartResult.success).toBe(true);
      expect(taskStartResult.data).toMatchObject({
        taskId: 'T2405',
        previousTask: null,
      });

      // Step 3: Verify current task status (tasks.current) - returns { currentTask, currentPhase }
      vi.mocked(taskCurrentGet).mockResolvedValueOnce({
        success: true,
        data: {
          currentTask: 'T2405',
          currentPhase: null,
        },
      });

      const currentResult = await dispatchRaw('query', 'tasks', 'current', {});

      expect(currentResult.success).toBe(true);
      expect(currentResult.data).toMatchObject({
        currentTask: 'T2405',
      });

      // Step 4: Complete the task (tasks.complete) - returns { task }
      vi.mocked(taskComplete).mockResolvedValueOnce({
        success: true,
        data: {
          task: {
            id: 'T2405',
            title: 'Test Task',
            description: 'A test task',
            status: 'done',
            priority: 'medium',
            createdAt: '2026-02-06T09:00:00Z',
            updatedAt: '2026-02-06T11:00:00Z',
            completedAt: '2026-02-06T11:00:00Z',
          },
          autoCompleted: [],
        },
      });

      const completeResult = await dispatchRaw('mutate', 'tasks', 'complete', {
        taskId: 'T2405',
        notes: 'Done',
      });

      expect(completeResult.success).toBe(true);
      expect(completeResult.data).toHaveProperty('task');
      expect((completeResult.data as { task: { id: string } }).task.id).toBe('T2405');

      // Step 5: Stop the current task (tasks.stop) - returns { cleared, previousTask }
      vi.mocked(taskStop).mockResolvedValueOnce({
        success: true,
        data: {
          cleared: true,
          previousTask: 'T2405',
        },
      });

      const taskStopResult = await dispatchRaw('mutate', 'tasks', 'stop', {});

      expect(taskStopResult.success).toBe(true);
      expect(taskStopResult.data).toMatchObject({
        cleared: true,
        previousTask: 'T2405',
      });

      // Step 6: End session (session.end) - returns { sessionId, ended }
      vi.mocked(sessionEnd).mockResolvedValueOnce({
        success: true,
        data: {
          sessionId: 'session_e2e_1',
          ended: true,
        },
      });

      const endResult = await dispatchRaw('mutate', 'session', 'end', {
        notes: 'Session completed',
      });

      expect(endResult.success).toBe(true);
      expect(endResult.data).toMatchObject({
        sessionId: 'session_e2e_1',
        ended: true,
      });

      // All 6 steps executed
      expect(sessionStart).toHaveBeenCalledTimes(1);
      expect(taskStart).toHaveBeenCalledTimes(1);
      expect(taskCurrentGet).toHaveBeenCalledTimes(1);
      expect(taskComplete).toHaveBeenCalledTimes(1);
      expect(taskStop).toHaveBeenCalledTimes(1);
      expect(sessionEnd).toHaveBeenCalledTimes(1);
    });

    it('should require scope for session start', async () => {
      vi.mocked(sessionStart).mockResolvedValueOnce({
        success: false,
        error: {
          code: 'E_INVALID_INPUT',
          message: 'Session scope is required',
        },
      });

      const result = await dispatchRaw('mutate', 'session', 'start', {
        name: 'No Scope Session',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_INVALID_INPUT');
    });

    it('should handle session not found on resume', async () => {
      vi.mocked(sessionResume).mockResolvedValueOnce({
        success: false,
        error: {
          code: 'E_NOT_FOUND',
          message: "Session 'session_999' not found",
          exitCode: 4,
        },
      });

      const result = await dispatchRaw('mutate', 'session', 'resume', {
        sessionId: 'session_999',
      });

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
      expect(result.error?.message).toContain('session_999');
    });
  });
});
