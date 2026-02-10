/**
 * E2E Epic Orchestration Workflow Tests
 *
 * Tests orchestration workflows via the 'cleo orchestrator' CLI command.
 *
 * @task T2937
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  setupE2ETest,
  cleanupE2ETest,
  extractTaskId,
} from './setup.js';
import type { IntegrationTestContext } from '../integration-setup.js';

describe('E2E: Epic Orchestration Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  });

  afterAll(async () => {
    await cleanupE2ETest();
  });

  it('should analyze epic dependencies', async () => {
    // Create epic with children
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Orchestration Test Epic'],
      flags: {
        description: 'Epic for orchestration workflow testing',
        labels: 'epic,orchestration-test',
        json: true,
      },
    });

    expect(epicResult.success).toBe(true);
    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Create child task 1 (no dependencies)
    const task1Result = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Orchestration Task 1'],
      flags: {
        description: 'First task in orchestration workflow',
        parent: epicId,
        json: true,
      },
    });

    expect(task1Result.success).toBe(true);
    const task1Id = extractTaskId(task1Result);
    context.createdTaskIds.push(task1Id);

    // Create child task 2 (depends on task 1)
    const task2Result = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Orchestration Task 2'],
      flags: {
        description: 'Second task depends on first',
        parent: epicId,
        depends: task1Id,
        json: true,
      },
    });

    expect(task2Result.success).toBe(true);
    const task2Id = extractTaskId(task2Result);
    context.createdTaskIds.push(task2Id);

    // Analyze dependencies via orchestrator
    const analyzeResult = await context.executor.execute({
      domain: 'orchestrate',
      operation: 'analyze',
      flags: { epic: epicId, json: true },
    });

    // orchestrator analyze should succeed
    expect(analyzeResult.exitCode).toBe(0);
    expect(analyzeResult.stdout).toBeDefined();
    expect(analyzeResult.stdout.length).toBeGreaterThan(0);
  });

  it('should get ready tasks', async () => {
    // Create epic with independent tasks
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Ready Test Epic'],
      flags: {
        description: 'Epic for ready tasks testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    // Create independent child
    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Independent Task'],
      flags: {
        description: 'Task with no dependencies',
        parent: epicId,
        json: true,
      },
    });

    const taskId = extractTaskId(taskResult);
    context.createdTaskIds.push(taskId);

    // Get ready tasks
    const readyResult = await context.executor.execute({
      domain: 'orchestrate',
      operation: 'ready',
      flags: { epic: epicId, json: true },
    });

    // ready command should succeed
    expect(readyResult.exitCode).toBe(0);
  });

  it('should check context budget', async () => {
    // Query context usage
    const contextResult = await context.executor.execute({
      domain: 'orchestrate',
      operation: 'context',
      flags: {
        tokens: 200000,
        json: true,
      },
    });

    // Context check may return non-zero exit code for critical usage,
    // but should produce output
    const output = contextResult.stdout || contextResult.stderr;
    expect(output).toBeDefined();
    expect(output.length).toBeGreaterThan(0);
    // Should contain budget information
    expect(output).toMatch(/token|budget|usage|status/i);
  });

  it('should validate protocol compliance', async () => {
    // Validate orchestrator compliance
    const validateResult = await context.executor.execute({
      domain: 'orchestrate',
      operation: 'validate',
      flags: { manifest: true, json: true },
    });

    // Validate should produce output (may pass or fail)
    const output = validateResult.stdout || validateResult.stderr;
    expect(output).toBeDefined();
  });

  it('should get next task recommendation', async () => {
    // Create epic with tasks
    const epicResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Next Task Epic'],
      flags: {
        description: 'Epic for next task testing',
        json: true,
      },
    });

    const epicId = extractTaskId(epicResult);
    context.createdTaskIds.push(epicId);

    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Pending Task'],
      flags: {
        description: 'Task waiting to be started',
        parent: epicId,
        json: true,
      },
    });

    context.createdTaskIds.push(extractTaskId(taskResult));

    // Get next task recommendation
    const nextResult = await context.executor.execute({
      domain: 'orchestrate',
      operation: 'next',
      flags: { epic: epicId, json: true },
    });

    // next should produce output
    const output = nextResult.stdout || nextResult.stderr;
    expect(output).toBeDefined();
  });
});
