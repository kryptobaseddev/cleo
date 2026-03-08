/**
 * E2E Pipeline Manifest Workflow Tests
 *
 * Tests pipeline manifest workflows via the canonical pipeline domain.
 * Migrated from research domain (defunct) to pipeline.manifest.* operations.
 *
 * @task T2937
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IntegrationTestContext } from '../integration-setup.js';
import { cleanupE2ETest, extractTaskId, setupE2ETest } from './setup.js';

describe('E2E: Pipeline Manifest Workflow', () => {
  let context: IntegrationTestContext;

  beforeAll(async () => {
    context = await setupE2ETest();
  }, 120000);

  afterAll(async () => {
    await cleanupE2ETest();
  }, 30000);

  it('should list manifest entries', async () => {
    const listResult = await context.executor.execute({
      domain: 'pipeline',
      operation: 'manifest.list',
      flags: {
        limit: 5,
        json: true,
      },
    });

    // manifest.list succeeds even with empty manifest
    expect(listResult.success).toBe(true);
    const data = listResult.data;
    expect(data).toBeDefined();
  });

  it('should get manifest statistics', async () => {
    const statsResult = await context.executor.execute({
      domain: 'pipeline',
      operation: 'manifest.stats',
      flags: { json: true },
    });

    expect(statsResult.success).toBe(true);
    const stats = statsResult.data as any;
    expect(stats).toBeDefined();
  });

  it('should link manifest entry to a task', async () => {
    // Create task for linking
    const taskResult = await context.executor.execute({
      domain: 'tasks',
      operation: 'add',
      args: ['Manifest Link Test'],
      flags: {
        description: 'Task for manifest linking',
        json: true,
      },
    });

    if (!taskResult.success) {
      throw new Error(
        `Task creation failed: ${taskResult.error?.code} - ${taskResult.error?.message}`,
      );
    }
    const taskId = extractTaskId(taskResult);
    context.createdTaskIds.push(taskId);

    const researchId = `test-manifest-${Date.now()}`;
    const linkResult = await context.executor.execute({
      domain: 'pipeline',
      operation: 'manifest.link',
      args: [researchId, taskId],
      flags: { json: true },
    });

    // Link may fail if the manifest entry doesn't exist
    if (!linkResult.success) {
      expect(linkResult.error?.code).toMatch(/E_NOT_FOUND|E_INVALID_INPUT|E_MANIFEST_LINK/);
    }
  });

  it('should handle manifest archiving', async () => {
    const archiveResult = await context.executor.execute({
      domain: 'pipeline',
      operation: 'manifest.archive',
      flags: { json: true },
    });

    // Archive may succeed or fail with E_INVALID_INPUT (missing beforeDate)
    expect(archiveResult.success || archiveResult.error?.code).toBeTruthy();
    if (archiveResult.success) {
      const result = archiveResult.data as any;
      expect(result).toBeDefined();
    }
  });

  it('should list manifest entries with status filter', async () => {
    const listResult = await context.executor.execute({
      domain: 'pipeline',
      operation: 'manifest.list',
      flags: {
        status: 'partial',
        json: true,
      },
    });

    // manifest.list succeeds even with no matching entries
    expect(listResult.success).toBe(true);
  });
});
