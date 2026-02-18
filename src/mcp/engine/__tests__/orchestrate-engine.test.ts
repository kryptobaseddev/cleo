/**
 * Orchestrate Engine Tests
 *
 * Tests native TypeScript orchestrate operations.
 *
 * @task T4478
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import {
  orchestrateStatus,
  orchestrateAnalyze,
  orchestrateReady,
  orchestrateNext,
  orchestrateWaves,
  orchestrateContext,
  orchestrateValidate,
  orchestrateSpawn,
  orchestrateStartup,
} from '../orchestrate-engine.js';

const TEST_ROOT = join(process.cwd(), '.test-orchestrate-engine');
const CLEO_DIR = join(TEST_ROOT, '.cleo');

function writeTodoJson(tasks: any[]): void {
  mkdirSync(CLEO_DIR, { recursive: true });
  writeFileSync(
    join(CLEO_DIR, 'todo.json'),
    JSON.stringify({ tasks, _meta: { schemaVersion: '2.6.0' } }, null, 2),
    'utf-8'
  );
}

const SAMPLE_TASKS = [
  { id: 'T100', title: 'Epic Task', description: 'Parent epic', status: 'active', priority: 'high', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T101', title: 'First child', description: 'Task 1', status: 'done', priority: 'high', parentId: 'T100', createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T102', title: 'Second child', description: 'Task 2', status: 'pending', priority: 'medium', parentId: 'T100', depends: ['T101'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T103', title: 'Third child', description: 'Task 3', status: 'pending', priority: 'high', parentId: 'T100', depends: ['T101'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
  { id: 'T104', title: 'Fourth child', description: 'Task 4', status: 'pending', priority: 'low', parentId: 'T100', depends: ['T102', 'T103'], createdAt: '2026-01-01T00:00:00Z', updatedAt: null },
];

describe('Orchestrate Engine', () => {
  beforeEach(() => {
    writeTodoJson(SAMPLE_TASKS);
  });

  afterEach(() => {
    if (existsSync(TEST_ROOT)) {
      rmSync(TEST_ROOT, { recursive: true, force: true });
    }
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
    it('should return highest priority ready task', async () => {
      const result = await orchestrateNext('T100', TEST_ROOT);
      expect(result.success).toBe(true);
      const data = result.data as any;
      // T103 is high priority, T102 is medium
      expect(data.nextTask.id).toBe('T103');
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
      expect(result.error?.code).toBe('E_NOT_READY');
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
});
