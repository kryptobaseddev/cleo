/**
 * Orchestrate Engine Tests
 *
 * Tests native TypeScript orchestrate operations.
 *
 * @task T4478
 * @task T4854
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
  orchestrateValidate,
  orchestrateSpawn,
  orchestrateHandoff,
  orchestrateStartup,
} from '../orchestrate-engine.js';
import { sessionStart, sessionStatus } from '../session-engine.js';

let TEST_ROOT: string;
let CLEO_DIR: string;

/**
 * Seed tasks into SQLite via the task store (ADR-006).
 */
async function seedTasks(testRoot: string, tasks: any[]): Promise<void> {
  const cleoDir = join(testRoot, '.cleo');
  mkdirSync(cleoDir, { recursive: true });
  const { getDb } = await import('../../../store/sqlite.js');
  const { createTask } = await import('../../../store/task-store.js');
  await getDb(testRoot);

  for (const task of tasks) {
    await createTask(task as any, testRoot);
  }
}

const SAMPLE_TASKS = [
  { id: 'T100', title: 'Epic Task', description: 'Parent epic', status: 'active', priority: 'high', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T101', title: 'First child', description: 'Task 1', status: 'done', priority: 'high', parentId: 'T100', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T102', title: 'Second child', description: 'Task 2', status: 'pending', priority: 'medium', parentId: 'T100', depends: ['T101'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T103', title: 'Third child', description: 'Task 3', status: 'pending', priority: 'high', parentId: 'T100', depends: ['T101'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T104', title: 'Fourth child', description: 'Task 4', status: 'pending', priority: 'low', parentId: 'T100', depends: ['T102', 'T103'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
];

describe('Orchestrate Engine', () => {
  beforeEach(async () => {
    TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-orch-'));
    CLEO_DIR = join(TEST_ROOT, '.cleo');
    await seedTasks(TEST_ROOT, SAMPLE_TASKS);
    const protocolsDir = join(TEST_ROOT, 'protocols');
    mkdirSync(protocolsDir, { recursive: true });
    writeFileSync(join(protocolsDir, 'implementation.md'), '# Implementation Protocol\nUse this for handoff tests.\n');
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../../store/sqlite.js');
      await closeAllDatabases();
    } catch { /* ignore */ }
    await rm(TEST_ROOT, { recursive: true, force: true });
  });

  describe('orchestrateStatus', () => {
    it('should return status for an epic', async () => {
      const result = await orchestrateStatus('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.epicId).toBe('T100');
      expect(data.totalTasks).toBe(4); // 4 children
      expect(data.byStatus.done).toBe(1);
      expect(data.byStatus.pending).toBe(3);
    });

    it('should return error for missing epic', async () => {
      const result = await orchestrateStatus('T999', TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_NOT_FOUND');
    });
  });

  describe('orchestrateAnalyze', () => {
    it('should analyze dependency graph', async () => {
      const result = await orchestrateAnalyze('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.waves).toBeDefined();
      expect(data.waves.length).toBeGreaterThan(0);
      expect(data.circularDependencies).toHaveLength(0);
    });
  });

  describe('orchestrateReady', () => {
    it('should find tasks with met dependencies', async () => {
      const result = await orchestrateReady('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // T102 and T103 depend on T101 (done), so they should be ready
      expect(data.total).toBe(2);
      expect(data.readyTasks.map((t: any) => t.id)).toContain('T102');
      expect(data.readyTasks.map((t: any) => t.id)).toContain('T103');
    });
  });

  describe('orchestrateNext', () => {
    it('should return first ready task', async () => {
      const result = await orchestrateNext('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // getNextTask returns first ready task in array order (T102 comes before T103)
      expect(data.nextTask.id).toBe('T102');
    });
  });

  describe('orchestrateWaves', () => {
    it('should compute dependency waves', async () => {
      const result = await orchestrateWaves('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.totalWaves).toBeGreaterThan(0);
      // Wave 1: T102, T103 (depend on done T101)
      // Wave 2: T104 (depends on T102 and T103)
    });
  });

  describe('orchestrateValidate', () => {
    it('should validate ready task', async () => {
      const result = await orchestrateValidate('T102', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(true);
    });

    it('should report unmet dependencies', async () => {
      const result = await orchestrateValidate('T104', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(false);
      expect((result.data as any).issues.length).toBeGreaterThan(0);
    });

    it('should report done task as not ready', async () => {
      const result = await orchestrateValidate('T101', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).ready).toBe(false);
    });
  });

  describe('orchestrateSpawn', () => {
    it('should generate spawn context for ready task', async () => {
      const result = await orchestrateSpawn('T102', undefined, TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskId).toBe('T102');
      expect((result.data as any).tokenResolution.fullyResolved).toBe(true);
    });

    it('should reject not-ready task', async () => {
      const result = await orchestrateSpawn('T104', undefined, TEST_ROOT);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SPAWN_VALIDATION_FAILED');
    });
  });

  describe('orchestrateStartup', () => {
    it('should initialize orchestration', async () => {
      const result = await orchestrateStartup('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.initialized).toBe(true);
      expect(data.summary.totalTasks).toBe(4);
    });
  });

  describe('orchestrateContext', () => {
    it('should estimate context usage', async () => {
      const result = await orchestrateContext('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      expect((result.data as any).taskCount).toBe(4);
      expect((result.data as any).estimatedTokens).toBeGreaterThan(0);
    });
  });

  describe('orchestrateHandoff', () => {
    it('should execute inject -> end -> spawn in order', async () => {
      const startResult = await sessionStart(TEST_ROOT, {
        scope: 'epic:T100',
        name: 'handoff-predecessor',
      });
      expect(startResult.success).toBe(true);

      const result = await orchestrateHandoff({
        taskId: 'T102',
        protocolType: 'implementation',
        note: 'handoff complete',
      }, TEST_ROOT);

      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.predecessorSessionId).toBeDefined();
      expect(data.endedSessionId).toBe(data.predecessorSessionId);
      expect(data.steps.contextInject.status).toBe('completed');
      expect(data.steps.sessionEnd.status).toBe('completed');
      expect(data.steps.spawn.status).toBe('completed');
      expect(data.idempotency.policy).toBe('non-idempotent');

      const sessionState = await sessionStatus(TEST_ROOT);
      expect(sessionState.success).toBe(true);
      expect(sessionState.data?.hasActiveSession).toBe(false);
    });

    it('should fail with no active session and surface step metadata', async () => {
      const result = await orchestrateHandoff({
        taskId: 'T102',
        protocolType: 'implementation',
      }, TEST_ROOT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SESSION_REQUIRED');
      const details = result.error?.details as any;
      expect(details.failedStep).toBe('session.end');
      expect(details.steps.contextInject.status).toBe('skipped');
      expect(details.steps.spawn.status).toBe('skipped');
    });

    it('should surface partial state when spawn step fails', async () => {
      const startResult = await sessionStart(TEST_ROOT, {
        scope: 'epic:T100',
        name: 'handoff-partial-failure',
      });
      expect(startResult.success).toBe(true);

      const result = await orchestrateHandoff({
        taskId: 'T104',
        protocolType: 'implementation',
      }, TEST_ROOT);

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('E_SPAWN_VALIDATION_FAILED');
      const details = result.error?.details as any;
      expect(details.failedStep).toBe('orchestrate.spawn');
      expect(details.steps.contextInject.status).toBe('completed');
      expect(details.steps.sessionEnd.status).toBe('completed');
      expect(details.steps.spawn.status).toBe('failed');
      expect(details.idempotency.safeRetryFrom).toBe('orchestrate.spawn');

      const sessionState = await sessionStatus(TEST_ROOT);
      expect(sessionState.success).toBe(true);
      expect(sessionState.data?.hasActiveSession).toBe(false);
    });
  });
});
