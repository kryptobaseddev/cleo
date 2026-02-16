/**
 * E2E Task Management Workflow Tests
 *
 * Tests complete task management workflows from client request
 * to CLI execution to response.
 *
 * Scenario 1: Task Management Workflow
 * 1. Create task via cleo_mutate
 * 2. List tasks via cleo_query
 * 3. Update task via cleo_mutate
 * 4. Complete task via cleo_mutate
 * 5. Verify task in archive via cleo_query
 *
 * @task T2937
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupE2ETest,
  cleanupE2ETest,
  getE2EContext,
  extractTaskId,
  verifyResponseFormat,
} from './setup.js';
import type { IntegrationTestContext } from '../integration-setup.js';

describe('E2E: Task Management Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  }, 120000);

  afterAll(async () => {
    await cleanupE2ETest();
  }, 30000);

  it('should complete full task lifecycle', async () => {
    // Step 1: Create task via cleo_mutate
    const createResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['E2E Test Task'],
      flags: {
        description: 'Task created for end-to-end workflow testing',
        json: true,
      },
    });

    expect(createResult.success).toBe(true);
    verifyResponseFormat(createResult, 'cleo_mutate', 'tasks', 'add');

    const taskId = extractTaskId(createResult);
    context.createdTaskIds.push(taskId);

    expect(taskId).toMatch(/^T\d+$/);

    // Step 2: List tasks via cleo_query
    const listResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'list',
      flags: { json: true },
    });

    expect(listResult.success).toBe(true);
    verifyResponseFormat(listResult, 'cleo_query', 'tasks', 'list');

    const tasks = listResult.data as any[];
    expect(Array.isArray(tasks)).toBe(true);

    const createdTask = tasks.find((t: any) => t.id === taskId);
    expect(createdTask).toBeDefined();
    expect(createdTask?.title).toBe('E2E Test Task');

    // Step 3: Update task via cleo_mutate
    const updateResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'update',
      args: [taskId],
      flags: {
        title: 'Updated E2E Test Task',
        notes: 'Updated during workflow test',
        json: true,
      },
    });

    expect(updateResult.success).toBe(true);
    verifyResponseFormat(updateResult, 'cleo_mutate', 'tasks', 'update');

    // Verify update
    const showResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'show',
      args: [taskId],
      flags: { json: true },
    });

    expect(showResult.success).toBe(true);
    expect((showResult.data as any).title).toBe('Updated E2E Test Task');
    // Notes include timestamps, so check that at least one note contains the text
    const notes = (showResult.data as any).notes;
    expect(Array.isArray(notes) ? notes.some((n: string) => n.includes('Updated during workflow test')) : false).toBe(true);

    // Step 4: Complete task via cleo_mutate
    const completeResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'complete',
      args: [taskId],
      flags: {
        notes: 'Workflow test completed successfully',
        json: true,
      },
    });

    expect(completeResult.success).toBe(true);
    verifyResponseFormat(completeResult, 'cleo_mutate', 'tasks', 'complete');

    // Step 5: Verify task was completed by showing it
    const verifyResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'show',
      args: [taskId],
      flags: { json: true },
    });

    expect(verifyResult.success).toBe(true);
    expect((verifyResult.data as any).status).toBe('done');
  });

  it('should handle task hierarchy correctly', async () => {
    // Create parent task
    const parentResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Parent Task'],
      flags: {
        description: 'Parent task for hierarchy test',
        json: true,
      },
    });

    expect(parentResult.success).toBe(true);
    const parentId = extractTaskId(parentResult);
    context.createdTaskIds.push(parentId);

    // Create child task
    const childResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Child Task'],
      flags: {
        description: 'Child task for hierarchy test',
        parent: parentId,
        json: true,
      },
    });

    expect(childResult.success).toBe(true);
    const childId = extractTaskId(childResult);
    context.createdTaskIds.push(childId);

    // Verify hierarchy via list --parent operation
    const childrenResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'list',
      flags: { parent: parentId, json: true },
    });

    expect(childrenResult.success).toBe(true);
    verifyResponseFormat(childrenResult, 'cleo_query', 'tasks', 'list');

    const children = childrenResult.data as any[];
    expect(Array.isArray(children)).toBe(true);
    expect(children.length).toBeGreaterThan(0);
    expect(children.some((c: any) => c.id === childId)).toBe(true);
  });

  it('should handle task search efficiently', async () => {
    // Create task with unique title
    const uniqueTitle = `Searchable Task ${Date.now()}`;
    const createResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: [uniqueTitle],
      flags: {
        description: 'Task for search testing',
        labels: 'search-test',
        json: true,
      },
    });

    expect(createResult.success).toBe(true);
    const taskId = extractTaskId(createResult);
    context.createdTaskIds.push(taskId);

    // Search using find operation (minimal fields)
    const findResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'find',
      args: [uniqueTitle],
      flags: { json: true },
    });

    expect(findResult.success).toBe(true);
    verifyResponseFormat(findResult, 'cleo_query', 'tasks', 'find');

    const results = findResult.data as any[];
    expect(Array.isArray(results)).toBe(true);

    const found = results.find((t: any) => t.id === taskId);
    expect(found).toBeDefined();
    expect(found?.title).toBe(uniqueTitle);

    // Verify minimal fields (find returns minimal context)
    expect(found).toHaveProperty('id');
    expect(found).toHaveProperty('title');
    expect(found).toHaveProperty('status');
    // Should NOT have notes array (minimal response)
  });

  it('should handle task dependencies correctly', async () => {
    // Create blocking task
    const blockerResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Blocker Task'],
      flags: {
        description: 'Must be completed first',
        json: true,
      },
    });

    expect(blockerResult.success).toBe(true);
    const blockerId = extractTaskId(blockerResult);
    context.createdTaskIds.push(blockerId);

    // Create dependent task
    const dependentResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Dependent Task'],
      flags: {
        description: 'Depends on blocker task',
        depends: blockerId,
        json: true,
      },
    });

    expect(dependentResult.success).toBe(true);
    const dependentId = extractTaskId(dependentResult);
    context.createdTaskIds.push(dependentId);

    // Query dependencies via deps command
    const depsResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'deps',
      args: [dependentId],
      flags: { json: true },
    });

    expect(depsResult.success).toBe(true);
    verifyResponseFormat(depsResult, 'cleo_query', 'tasks', 'deps');

    // deps returns {task, upstream, downstream, blockedBy}
    const deps = depsResult.data as any;
    const upstream = deps.upstream_dependencies || deps.upstream || [];
    const upstreamIds = upstream.map((d: any) =>
      typeof d === 'string' ? d : d.id || d.taskId
    );
    expect(upstreamIds).toContain(blockerId);

    // Verify the dependent task shows the blocker in its dependencies
    const showDependent = await context.executor.execute({
      domain: 'tasks',
      operation: 'show',
      args: [dependentId],
      flags: { json: true },
    });

    expect(showDependent.success).toBe(true);
    const dependentTask = showDependent.data as any;
    // The task should reference its dependency
    const dependsOn = dependentTask.depends || dependentTask.dependencies || [];
    expect(dependsOn).toContain(blockerId);
  });
});
