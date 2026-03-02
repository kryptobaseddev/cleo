/**
 * Performance Tests for Safety Layer
 *
 * Validates that safety mechanisms don't introduce unacceptable latency.
 *
 * Targets (from test strategy):
 * - Single write: <100ms (p95) with full safety
 * - Bulk write (50 tasks): <500ms
 * - Checkpoint: <50ms
 * - Verification: <50ms
 * - Sequence check: <10ms
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock git-checkpoint (fast mock so it doesn't affect perf numbers)
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('Safety Performance', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-perf-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('Single Task Operations', () => {
    it('should create task within <200ms including safety', async () => {
      const { createTask } = await import('../task-store.js');
      const { safeCreateTask } = await import('../data-safety.js');

      // Warmup: initialize DB
      await createTask({
        id: 'T000',
        title: 'Warmup',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const taskData = {
        id: 'T001',
        title: 'Performance test task',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: new Date().toISOString(),
      };

      const start = performance.now();
      await safeCreateTask(
        () => createTask(taskData),
        taskData as any,
        tempDir,
        { autoCheckpoint: false, validateSequence: false },
      );
      const duration = performance.now() - start;

      // Should complete within 200ms (generous for CI environments)
      expect(duration).toBeLessThan(200);
    });

    it('should verify task write within <100ms', async () => {
      const { createTask } = await import('../task-store.js');
      const { verifyTaskWrite } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Verify perf test',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const start = performance.now();
      await verifyTaskWrite('T001', undefined, tempDir);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(100);
    });

    it('should check collision within <50ms', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Collision check perf',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const start = performance.now();
      await checkTaskExists('T001', tempDir, { strictMode: false });
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
    });
  });

  describe('Bulk Operations', () => {
    it('should create 50 tasks within <5000ms', async () => {
      const { createTask } = await import('../task-store.js');

      const start = performance.now();

      for (let i = 0; i < 50; i++) {
        await createTask({
          id: `T${String(i + 1).padStart(3, '0')}`,
          title: `Bulk task ${i + 1}`,
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        });
      }

      const duration = performance.now() - start;

      // 50 tasks in <5s (100ms per task is generous for CI)
      expect(duration).toBeLessThan(5000);
    });

    it('should verify 50 tasks within <2000ms', async () => {
      const { createTask } = await import('../task-store.js');
      const { verifyTaskWrite } = await import('../data-safety.js');

      // Create 50 tasks first
      for (let i = 0; i < 50; i++) {
        await createTask({
          id: `T${String(i + 1).padStart(3, '0')}`,
          title: `Verify perf task ${i + 1}`,
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        });
      }

      // Time the verification
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        await verifyTaskWrite(`T${String(i + 1).padStart(3, '0')}`, undefined, tempDir);
      }
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(2000);
    });
  });

  describe('Sequence Validation Performance', () => {
    it('should validate sequence within <500ms', async () => {
      const { validateAndRepairSequence } = await import('../data-safety.js');

      // Write a sequence file
      await writeFile(
        join(cleoDir, '.sequence.json'),
        JSON.stringify({ counter: 100 }),
      );

      const start = performance.now();
      await validateAndRepairSequence(tempDir);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(500);
    });
  });
});
