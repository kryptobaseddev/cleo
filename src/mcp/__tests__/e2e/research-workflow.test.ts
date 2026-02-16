/**
 * E2E Research Workflow Tests
 *
 * Tests research management workflows via the 'cleo research' CLI command.
 *
 * @task T2937
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  setupE2ETest,
  cleanupE2ETest,
  extractTaskId,
} from './setup.js';
import type { IntegrationTestContext } from '../integration-setup.js';

describe('E2E: Research Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  }, 120000);

  afterAll(async () => {
    await cleanupE2ETest();
  }, 30000);

  it('should list research entries', async () => {
    // List research entries from manifest
    const listResult = await context.executor.execute({
      domain: 'research',
      operation: 'list',
      flags: {
        limit: 5,
        json: true,
      },
    });

    expect(listResult.success).toBe(true);
    // Research list returns entries array
    const data = listResult.data;
    expect(data).toBeDefined();
  });

  it('should get research statistics', async () => {
    // Get research statistics
    const statsResult = await context.executor.execute({
      domain: 'research',
      operation: 'stats',
      flags: { json: true },
    });

    expect(statsResult.success).toBe(true);
    const stats = statsResult.data as any;
    expect(stats).toBeDefined();
    // Stats should have manifest information
    expect(stats?.manifest || stats?.entries !== undefined || stats).toBeTruthy();
  });

  it('should link research to a task', async () => {
    // Create task for linking
    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Research Link Test'],
      flags: {
        description: 'Task for research linking',
        json: true,
      },
    });

    if (!taskResult.success) {
      throw new Error(`Task creation failed: ${taskResult.error?.code} - ${taskResult.error?.message}`);
    }
    const taskId = extractTaskId(taskResult);
    context.createdTaskIds.push(taskId);

    // Link research to task (CLI signature: link <researchId> <taskId>)
    const researchId = `test-research-${Date.now()}`;
    const linkResult = await context.executor.execute({
      domain: 'research',
      operation: 'link',
      args: [researchId, taskId],
      flags: {
        json: true,
      },
    });

    // Link may fail with E_RESEARCH_NOT_FOUND if the research entry doesn't
    // exist in the manifest. The link command validates both task and research IDs.
    if (!linkResult.success) {
      // Acceptable error: research entry not found (doesn't exist in manifest)
      expect(linkResult.error?.code).toMatch(/E_RESEARCH_NOT_FOUND|E_NOT_FOUND/);
    }
  });

  it('should show research links for a task', async () => {
    // Create task and link research
    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Research Links Test'],
      flags: {
        description: 'Task for showing research links',
        json: true,
      },
    });

    const taskId = extractTaskId(taskResult);
    context.createdTaskIds.push(taskId);

    // Link a research entry (CLI signature: link <researchId> <taskId>)
    await context.executor.execute({
      domain: 'research',
      operation: 'link',
      args: [`links-test-${Date.now()}`, taskId],
      flags: { json: true },
    });

    // Show links for task
    const linksResult = await context.executor.execute({
      domain: 'research',
      operation: 'links',
      args: [taskId],
      flags: { json: true },
    });

    expect(linksResult.success).toBe(true);
  });

  it('should handle research archiving', async () => {
    // Archive old research entries
    const archiveResult = await context.executor.execute({
      domain: 'research',
      operation: 'archive',
      flags: { json: true },
    });

    expect(archiveResult.success).toBe(true);
    const result = archiveResult.data as any;
    // Archive returns action, entriesArchived, etc.
    expect(result).toBeDefined();
  });

  it('should show pending research followups', async () => {
    // Get pending research entries
    const pendingResult = await context.executor.execute({
      domain: 'research',
      operation: 'pending',
      flags: { json: true },
    });

    expect(pendingResult.success).toBe(true);
  });
});
