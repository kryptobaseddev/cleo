/**
 * Collision Detection Tests
 *
 * Tests the SQLite-level collision detection in data-safety.ts.
 * Verifies that duplicate task IDs are caught before database write.
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock git-checkpoint to prevent real git operations
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('Collision Detection', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-collision-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    process.env['CLEO_DIR'] = cleoDir;

    // Reset SQLite singleton
    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('checkTaskExists', () => {
    it('should return false for non-existent task', async () => {
      const { checkTaskExists } = await import('../data-safety.js');

      const exists = await checkTaskExists('T9999', tempDir, { strictMode: false });
      expect(exists).toBe(false);
    });

    it('should detect existing task ID in strict mode', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      // Create a task first
      await createTask({
        id: 'T001',
        title: 'Existing task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Should throw in strict mode
      await expect(
        checkTaskExists('T001', tempDir, { strictMode: true }),
      ).rejects.toThrow('collision');
    });

    it('should return true for existing task in non-strict mode', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });

    it('should not detect collision when detection is disabled', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Should return false when detection is disabled
      const exists = await checkTaskExists('T001', tempDir, { detectCollisions: false });
      expect(exists).toBe(false);
    });

    it('should include existing task details in error context', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists, SafetyError } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      try {
        await checkTaskExists('T001', tempDir, { strictMode: true });
        expect.unreachable('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SafetyError);
        const safetyErr = err as InstanceType<typeof SafetyError>;
        expect(safetyErr.code).toBe('COLLISION_DETECTED');
        expect(safetyErr.details?.taskId).toBe('T001');
      }
    });
  });

  describe('Race Condition Simulation', () => {
    it('should handle rapid successive ID checks without false positives', async () => {
      const { checkTaskExists } = await import('../data-safety.js');

      // Run multiple checks in parallel for non-existent IDs
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          checkTaskExists(`T${i + 100}`, tempDir, { strictMode: false }),
        ),
      );

      // All should return false (no collisions for non-existent tasks)
      expect(results.every(r => r === false)).toBe(true);
    });

    it('should detect collision from rapid create-then-check', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      // Create task, then immediately check
      await createTask({
        id: 'T001',
        title: 'Quick task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Should detect the collision
      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });
  });

  describe('Namespace Isolation', () => {
    it('should detect collision in active tasks', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Active task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });

    it('should detect collision in done tasks', async () => {
      const { createTask } = await import('../task-store.js');
      const { checkTaskExists } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Done task',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });
  });
});
