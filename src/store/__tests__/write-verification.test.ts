/**
 * Write Verification Tests
 *
 * Tests the write verification layer in data-safety.ts that reads back
 * data after writes to confirm persistence.
 *
 * @task T4741
 * @epic T4732
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock git-checkpoint
vi.mock('../git-checkpoint.js', () => ({
  gitCheckpoint: vi.fn().mockResolvedValue(undefined),
}));

describe('Write Verification', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-verify-'));
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

  describe('verifyTaskWrite', () => {
    it('should verify a successfully written task', async () => {
      const { createTask } = await import('../task-store.js');
      const { verifyTaskWrite } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Test Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const verified = await verifyTaskWrite('T001', undefined, tempDir);
      expect(verified).toBe(true);
    });

    it('should fail verification for non-existent task', async () => {
      const { verifyTaskWrite, SafetyError } = await import('../data-safety.js');

      await expect(
        verifyTaskWrite('T999', undefined, tempDir, { strictMode: true }),
      ).rejects.toThrow('not found after write');
    });

    it('should return false for non-existent task in non-strict mode', async () => {
      const { verifyTaskWrite } = await import('../data-safety.js');

      const verified = await verifyTaskWrite('T999', undefined, tempDir, { strictMode: false });
      expect(verified).toBe(false);
    });

    it('should verify expected data fields match', async () => {
      const { createTask } = await import('../task-store.js');
      const { verifyTaskWrite } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Test Task',
        status: 'pending',
        priority: 'high',
        createdAt: new Date().toISOString(),
      });

      const verified = await verifyTaskWrite(
        'T001',
        { title: 'Test Task' },
        tempDir,
      );
      expect(verified).toBe(true);
    });

    it('should skip verification when verifyWrites is disabled', async () => {
      const { verifyTaskWrite } = await import('../data-safety.js');

      // Even for non-existent task, should return true when disabled
      const verified = await verifyTaskWrite('T999', undefined, tempDir, {
        verifyWrites: false,
      });
      expect(verified).toBe(true);
    });
  });

  describe('verifySessionWrite', () => {
    it('should verify a successfully written session', async () => {
      const { createSession } = await import('../session-store.js');
      const { verifySessionWrite } = await import('../data-safety.js');

      await createSession({
        id: 'sess-001',
        name: 'Test Session',
        status: 'active',
        scope: { type: 'epic', epicId: 'T001' },
        agent: 'test',
        notes: [],
        tasksCompleted: [],
        tasksCreated: [],
        startedAt: new Date().toISOString(),
      });

      const verified = await verifySessionWrite('sess-001', tempDir);
      expect(verified).toBe(true);
    });

    it('should fail verification for non-existent session', async () => {
      const { verifySessionWrite } = await import('../data-safety.js');

      await expect(
        verifySessionWrite('sess-nonexistent', tempDir, { strictMode: true }),
      ).rejects.toThrow('not found after write');
    });
  });

  describe('safeCreateTask', () => {
    it('should create task with full safety pipeline', async () => {
      const { createTask, getTask } = await import('../task-store.js');
      const { safeCreateTask } = await import('../data-safety.js');

      const taskData = {
        id: 'T001',
        title: 'Safe task',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: new Date().toISOString(),
      };

      const result = await safeCreateTask(
        () => createTask(taskData),
        taskData as any,
        tempDir,
        { autoCheckpoint: false, validateSequence: false },
      );

      expect(result.id).toBe('T001');

      // Verify it was actually written
      const loaded = await getTask('T001');
      expect(loaded).not.toBeNull();
      expect(loaded!.title).toBe('Safe task');
    });

    it('should detect collision during safe create', async () => {
      const { createTask } = await import('../task-store.js');
      const { safeCreateTask } = await import('../data-safety.js');

      const taskData = {
        id: 'T001',
        title: 'Original',
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt: new Date().toISOString(),
      };

      // First create
      await createTask(taskData);

      // Second create with same ID should detect collision
      await expect(
        safeCreateTask(
          () => createTask({ ...taskData, title: 'Duplicate' }),
          taskData as any,
          tempDir,
          { autoCheckpoint: false, validateSequence: false },
        ),
      ).rejects.toThrow('collision');
    });
  });

  describe('safeUpdateTask', () => {
    it('should update task with write verification', async () => {
      const { createTask, getTask, updateTask } = await import('../task-store.js');
      const { safeUpdateTask } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'Original',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const result = await safeUpdateTask(
        () => updateTask('T001', { title: 'Updated' }),
        'T001',
        { title: 'Updated' },
        tempDir,
        { autoCheckpoint: false },
      );

      expect(result).not.toBeNull();
      const loaded = await getTask('T001');
      expect(loaded!.title).toBe('Updated');
    });
  });

  describe('safeDeleteTask', () => {
    it('should delete task with verification', async () => {
      const { createTask, deleteTask, getTask } = await import('../task-store.js');
      const { safeDeleteTask } = await import('../data-safety.js');

      await createTask({
        id: 'T001',
        title: 'To delete',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const result = await safeDeleteTask(
        () => deleteTask('T001'),
        'T001',
        tempDir,
        { autoCheckpoint: false },
      );

      expect(result).toBe(true);

      // Task should be gone
      const loaded = await getTask('T001');
      expect(loaded).toBeNull();
    });
  });
});
