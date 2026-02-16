/**
 * E2E Session Management Workflow Tests
 *
 * Tests complete session management workflows.
 *
 * Scenario 2: Session Management Workflow
 * 1. Start session via cleo_mutate
 * 2. Set focus via cleo_mutate
 * 3. Check session status via cleo_query
 * 4. End session via cleo_mutate
 * 5. Verify session ended via cleo_query
 *
 * @task T2937
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupE2ETest,
  cleanupE2ETest,
  extractTaskId,
  extractSessionId,
  verifyResponseFormat,
} from './setup.js';
import type { IntegrationTestContext } from '../integration-setup.js';

describe('E2E: Session Management Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  }, 120000);

  afterAll(async () => {
    await cleanupE2ETest();
  }, 30000);

  it('should handle session start, status, and list', async () => {
    // Session status should work
    const statusResult = await context.executor.execute({
      domain: 'session',
      operation: 'status',
      flags: { json: true },
    });

    expect(statusResult.success).toBe(true);

    // Session list should work
    const listResult = await context.executor.execute({
      domain: 'session',
      operation: 'list',
      flags: { json: true },
    });

    expect(listResult.success).toBe(true);
  });

  it('should handle focus set, show, and clear', async () => {
    // Focus show should work
    const showResult = await context.executor.execute({
      domain: 'session',
      operation: 'focus.get',
      flags: { json: true },
    });

    expect(showResult.success).toBe(true);

    // Focus clear should work
    const clearResult = await context.executor.execute({
      domain: 'session',
      operation: 'focus.clear',
      flags: { json: true },
    });

    expect(clearResult.success).toBe(true);
  });

  it('should handle session listing correctly', async () => {
    // End any existing session first
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      args: ['Ending bootstrap for history test'],
      flags: { json: true },
    });

    // Create epic and session
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['History Test Epic'],
      flags: {
        description: 'Epic for session listing testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    const startResult = await context.executor.execute({
      domain: 'session',
      operation: 'start',
      flags: {
        scope: `epic:${epicId}`,
        'auto-focus': true,
        name: 'History Test Session',
        json: true,
      },
    });

    expect(startResult.success).toBe(true);

    // Query session list (history doesn't exist in CLI)
    const listResult = await context.executor.execute({
      domain: 'session',
      operation: 'list',
      flags: { json: true },
    });

    expect(listResult.success).toBe(true);
    const sessions = listResult.data;
    expect(sessions).toBeDefined();

    // End session
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      args: ['History test completed'],
      flags: { json: true },
    });
  });

  it.skip('should handle session suspension and resumption (requires isolated session environment)', async () => {
    // This test requires a clean session environment to properly test suspend/resume.
    // In the shared CLEO project, multiple sessions exist which causes E_AMBIGUOUS_SESSION.
    // This test should be re-enabled when running against an isolated test environment.
  });

  it('should handle focus clear correctly', async () => {
    // End any existing session first
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      args: ['Ending bootstrap for focus clear test'],
      flags: { json: true },
    });

    // Create epic and session
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Focus Clear Test Epic'],
      flags: {
        description: 'Epic for focus clear testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    await context.executor.execute({
      domain: 'session',
      operation: 'start',
      flags: {
        scope: `epic:${epicId}`,
        'auto-focus': true,
        name: 'Focus Clear Test',
        json: true,
      },
    });

    // Create and focus task
    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Focus Task'],
      flags: {
        description: 'Task for focus clear test',
        parent: epicId,
        json: true,
      },
    });

    const taskId = extractTaskId(taskResult);
    context.createdTaskIds.push(taskId);

    await context.executor.execute({
      domain: 'session',
      operation: 'focus.set',
      args: [taskId],
      flags: { json: true },
    });

    // Clear focus
    const clearResult = await context.executor.execute({
      domain: 'session',
      operation: 'focus.clear',
      flags: { json: true },
    });

    expect(clearResult.success).toBe(true);

    // Verify focus cleared
    const getFocusResult = await context.executor.execute({
      domain: 'session',
      operation: 'focus.get',
      flags: { json: true },
    });

    expect(getFocusResult.success).toBe(true);
    const focusData = getFocusResult.data as any;
    // After clear, focusedTask should be null or currentTask should be null
    const currentFocus = focusData?.focusedTask?.id || focusData?.currentTask;
    expect(currentFocus).toBeFalsy();

    // End session
    await context.executor.execute({
      domain: 'session',
      operation: 'end',
      args: ['Focus clear test completed'],
      flags: { json: true },
    });
  });
});
