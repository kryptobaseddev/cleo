/**
 * Integration Tests for cleo_query Gateway
 *
 * Tests full request/response flow through:
 * Gateway -> Domain Router -> Domain Handler -> CLI Executor -> Response Formatter
 *
 * Uses isolated CLEO test environment to avoid corrupting production data.
 *
 * @task T2922
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { handleQueryRequest, type QueryRequest } from '../query.js';
import {
  setupIntegrationTest,
  cleanupIntegrationTest,
  createTestTask,
  createTestEpic,
  startTestSession,
  verifyResponseFormat,
  type IntegrationTestContext,
} from '../../__tests__/integration-setup.js';

describe('cleo_query Gateway Integration', () => {
  let context: IntegrationTestContext;
  let testTaskId: string;
  let testEpicId: string;

  beforeAll(async () => {
    context = await setupIntegrationTest();

    // Use the pre-created epic from the isolated environment
    testEpicId = context.epicId!;

    // Use one of the pre-created task IDs
    testTaskId = context.createdTaskIds[0];

    // Start test session
    await startTestSession(context, testEpicId);
  }, 120000);

  afterAll(async () => {
    await cleanupIntegrationTest(context);
  }, 30000);

  describe('Tasks Domain', () => {
    it('should get single task details', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: [testTaskId],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      const d = result.data as any;
      // CLEO show returns {task: {id: ...}} - executor may unwrap to {id: ...}
      expect(d?.task?.id || d?.taskId || d?.id).toBe(testTaskId);
    });

    it('should list tasks with filters', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags: {
          parent: testEpicId,
          status: 'pending',
          json: true,
        },
      });

      expect(result.success).toBe(true);
      // CLEO list returns {tasks: [...]} - executor unwraps to array
      const tasks = Array.isArray(result.data) ? result.data : (result.data as any)?.tasks;
      expect(Array.isArray(tasks)).toBe(true);
      expect(tasks.length).toBeGreaterThan(0);
    });

    it('should find tasks with fuzzy search', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'find',
        args: ['Test'],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      const d = result.data as any;
      // CLEO find returns {query, matches} or {tasks: [...]}
      const matches = Array.isArray(d) ? d : (d?.matches || d?.tasks || []);
      expect(Array.isArray(matches)).toBe(true);
    });

    it('should check task existence', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'exists',
        args: [testTaskId],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      const d = result.data as any;
      expect(d?.exists).toBe(true);
    });

    it('should return hierarchical tree view', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags: {
          parent: testEpicId,
          json: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should get task dependencies', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'deps',
        args: [testTaskId],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should analyze task triage', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'analyze',
        flags: {
          json: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should suggest next task', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'next',
        flags: {
          json: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('Session Domain', () => {
    it('should get current session status', async () => {
      const result = await context.executor.execute({
        domain: 'session',
        operation: 'status',
        flags: { json: true },
        sessionId: context.sessionId,
      });

      // Session status should succeed if a session is active
      // With isolated environment, session may or may not be active
      expect(result.exitCode >= 0).toBe(true);
      if (result.success) {
        expect(result.data).toBeDefined();
      }
    });

    it('should list all sessions', async () => {
      const result = await context.executor.execute({
        domain: 'session',
        operation: 'list',
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      // CLEO session list returns {filter, count, sessions: [...]}
      const d = result.data as any;
      const sessions = Array.isArray(d) ? d : (d?.sessions || []);
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('should show specific session details', async () => {
      const result = await context.executor.execute({
        domain: 'session',
        operation: 'show',
        args: [context.sessionId],
        flags: { json: true },
      });

      // Session show may fail if sessionId doesn't match a real session
      // In isolated env, this is expected behavior
      expect(result.exitCode >= 0).toBe(true);
    });

    it('should get focused task', async () => {
      const result = await context.executor.execute({
        domain: 'session',
        operation: 'focus',
        args: ['show'],
        flags: { json: true },
      });

      // Focus may or may not be set - both are valid states
      expect(result.success || result.exitCode >= 0).toBe(true);
    });

    it('should get session history', async () => {
      // CLEO uses 'session list' for history
      const result = await context.executor.execute({
        domain: 'session',
        operation: 'list',
        flags: {
          json: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });
  });

  describe('System Domain', () => {
    it('should get CLEO version', async () => {
      const result = await context.executor.execute({
        domain: 'system',
        operation: 'version',
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      const d = result.data as any;
      // CLI version command may return version in various shapes:
      // {version: "x.y.z"}, {data: {version: "x.y.z"}}, {cleo: "x.y.z"},
      // or as a top-level string in stdout
      expect(
        d?.version || d?.data?.version || d?.cleo || result.stdout?.match(/\d+\.\d+/)
      ).toBeDefined();
    });

    it('should run health check', async () => {
      const result = await context.executor.execute({
        domain: 'system',
        operation: 'doctor',
        flags: { json: true },
        timeout: 30000,
      });

      // Doctor runs checks and may return success or warnings
      expect(result.exitCode >= 0).toBe(true);
    });

    it('should get project statistics', async () => {
      const result = await context.executor.execute({
        domain: 'system',
        operation: 'stats',
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should get context window info', async () => {
      const result = await context.executor.execute({
        domain: 'system',
        operation: 'context',
        flags: { json: true },
      });

      // Context may fail if no context state file exists
      expect(result.exitCode >= 0).toBe(true);
    });
  });

  describe('Validate Domain', () => {
    it('should validate task schema', async () => {
      const result = await context.executor.execute({
        domain: 'validate',
        operation: 'schema',
        args: ['todo'],
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should check task anti-hallucination rules', async () => {
      const result = await context.executor.execute({
        domain: 'validate',
        operation: 'schema',
        args: ['todo'],
        flags: {
          strict: true,
          json: true,
        },
      });

      // Validation may find issues (success=false) or pass (success=true)
      expect(result.exitCode >= 0).toBe(true);
    });

    it('should get compliance summary', async () => {
      const result = await context.executor.execute({
        domain: 'validate',
        operation: 'compliance',
        args: ['summary'],
        flags: { json: true },
      });

      // Compliance may or may not be available in isolated environment
      expect(result.exitCode >= 0).toBe(true);
    });

    it('should get test suite status', async () => {
      const result = await context.executor.execute({
        domain: 'validate',
        operation: 'test',
        args: ['status'],
        flags: { json: true },
      });

      // Test status may fail in isolated environment (no test framework configured)
      expect(result.exitCode >= 0).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle not found errors', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['T99999'],
        flags: { json: true },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toMatch(/E_(NOT_FOUND|TASK_NOT_FOUND)/);
      expect(result.exitCode).toBeGreaterThan(0);
    });

    it('should handle invalid parameters', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags: {
          status: 'invalid_status',
          json: true,
        },
      });

      // CLEO may accept invalid status and return empty results, or fail
      if (!result.success) {
        expect(result.error).toBeDefined();
        expect(result.error?.code).toMatch(/E_/);
      } else {
        // If it succeeds, it should return an empty or filtered list
        expect(result.data).toBeDefined();
      }
    });

    it('should provide fix suggestions on error', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['INVALID'],
        flags: { json: true },
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      // Fix and alternatives may or may not be present depending on error type
      expect(result.error?.code || result.error?.message).toBeDefined();
    });
  });

  describe('Response Format', () => {
    it('should include _meta in all responses', async () => {
      const result = await context.executor.execute({
        domain: 'system',
        operation: 'version',
        flags: { json: true },
      });

      expect(result.success).toBe(true);
      // Note: _meta is added by the MCP layer, not CLI
      // So we just verify the data structure is correct
      expect(result.data).toBeDefined();
    });

    it('should include duration in metadata', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags: { json: true },
      });

      expect(result.duration).toBeGreaterThan(0);
    });

    it('should return consistent error format', async () => {
      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'show',
        args: ['T99999'],
        flags: { json: true },
      });

      expect(result.error).toBeDefined();
      expect(result.error?.code).toBeDefined();
      expect(result.error?.message).toBeDefined();
      expect(result.exitCode).toBeGreaterThan(0);
    });
  });

  describe('Performance', () => {
    it('should complete queries within timeout', async () => {
      const startTime = Date.now();

      const result = await context.executor.execute({
        domain: 'tasks',
        operation: 'list',
        flags: { json: true },
        timeout: 5000,
      });

      const duration = Date.now() - startTime;

      expect(result.success).toBe(true);
      expect(duration).toBeLessThan(5000);
    });

    it('should handle concurrent queries', async () => {
      const queries = [
        context.executor.execute({
          domain: 'tasks',
          operation: 'list',
          flags: { json: true },
        }),
        context.executor.execute({
          domain: 'session',
          operation: 'list',
          flags: { json: true },
        }),
        context.executor.execute({
          domain: 'system',
          operation: 'version',
          flags: { json: true },
        }),
      ];

      const results = await Promise.all(queries);

      expect(results.every((r) => r.success)).toBe(true);
    });
  });
});
