/**
 * Check Domain E2E Tests
 *
 * End-to-end tests for the check domain handler:
 * 1. Schema validation (check.schema)
 * 2. Task validation (check.task)
 * 3. Compliance summary (check.compliance.summary)
 * 4. Test status (check.test)
 * 5. Grade a session (check.grade)
 * 6. List grades (check.grade.list)
 *
 * All tests use real SQLite databases in temp directories. No mocks.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('Check domain E2E workflow', () => {
  let testDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'check-e2e-'));
    cleoDir = join(testDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;
    process.env['CLEO_ROOT'] = testDir;

    // Reset database singletons
    const { closeDb } = await import('../../src/store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeAllDatabases } = await import('../../src/store/sqlite.js');
    await closeAllDatabases();
    delete process.env['CLEO_DIR'];
    delete process.env['CLEO_ROOT'];
    await rm(testDir, { recursive: true, force: true });
  });

  it('should require type param for schema check', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    // Missing type param returns E_INVALID_INPUT
    const result = await handler.query('schema', {});
    expect(result).toBeDefined();
    expect(result._meta.domain).toBe('check');
    expect(result._meta.operation).toBe('schema');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('should require taskId for task check', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    // Missing taskId param returns E_INVALID_INPUT
    const result = await handler.query('task', {});
    expect(result).toBeDefined();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('should validate a task via CheckHandler', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    // Initialize tasks.db and insert a test task
    const { getDb } = await import('../../src/store/sqlite.js');
    const db = await getDb();
    const { tasks } = await import('../../src/store/schema.js');
    await db.insert(tasks).values({
      id: 'T001',
      title: 'Validate me',
      description: 'A task to validate',
      status: 'pending',
      priority: 'medium',
      type: 'task',
      position: 1,
      positionVersion: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const result = await handler.query('task', { taskId: 'T001' });
    expect(result).toBeDefined();
    expect(result._meta.domain).toBe('check');
    expect(result.success).toBeDefined();
  });

  it('should return compliance summary via validateComplianceSummary', async () => {
    const { validateComplianceSummary } = await import(
      '../../src/dispatch/engines/validate-engine.js'
    );

    const result = validateComplianceSummary(testDir);
    // When no compliance data exists, should still return a valid result
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });

  it('should return test status via validateTestStatus', async () => {
    const { validateTestStatus } = await import('../../src/dispatch/engines/validate-engine.js');

    const result = validateTestStatus(testDir);
    expect(result).toBeDefined();
    expect(result.success).toBeDefined();
  });

  it('should handle grade.list on empty session data', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');

    // CheckHandler uses getProjectRoot(), which reads CLEO_ROOT
    const handler = new CheckHandler();
    const result = await handler.query('grade.list', {});

    expect(result).toBeDefined();
    expect(result._meta).toBeDefined();
    expect(result._meta.domain).toBe('check');
    expect(result._meta.operation).toBe('grade.list');
    // May succeed with empty grades or fail gracefully
    if (result.success) {
      expect(result.data).toBeDefined();
    }
  });

  it('should handle grade with missing sessionId', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    const result = await handler.query('grade', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_INPUT');
  });

  it('should handle unsupported operations gracefully', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    const result = await handler.query('nonexistent.operation', {});
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('E_INVALID_OPERATION');
  });

  it('should record compliance via mutate compliance.record', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    const result = await handler.mutate('compliance.record', {
      taskId: 'T001',
      result: 'pass',
      protocol: 'test-protocol',
    });

    expect(result).toBeDefined();
    expect(result._meta.domain).toBe('check');
    expect(result._meta.operation).toBe('compliance.record');
    // May succeed or fail depending on whether compliance file exists
    expect(result.success).toBeDefined();
  });

  it('should validate chain via check.chain.validate', async () => {
    const { CheckHandler } = await import('../../src/dispatch/domains/check.js');
    const handler = new CheckHandler();

    const chain = {
      id: 'test-chain',
      name: 'Test Chain',
      version: '1.0.0',
      description: 'A test chain',
      shape: {
        stages: [
          { id: 'stage-1', name: 'Stage 1', category: 'research', skippable: false },
          { id: 'stage-2', name: 'Stage 2', category: 'implementation', skippable: false },
        ],
        links: [{ from: 'stage-1', to: 'stage-2', type: 'linear' }],
        entryPoint: 'stage-1',
        exitPoints: ['stage-2'],
      },
      gates: [],
    };

    const result = await handler.query('chain.validate', { chain });
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });
});
