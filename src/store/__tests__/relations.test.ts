/**
 * Tests for task relations persistence (T5168).
 * 
 * These tests verify that relations written to the database are properly
 * reloaded when tasks are loaded, fixing the bug where relations appeared
 * to work during a session but were lost on restart.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createSqliteDataAccessor } from '../sqlite-data-accessor.js';
import type { Task } from '../../types/task.js';

describe('Task Relations Persistence (T5168)', () => {
  let testDir: string;
  let accessor: Awaited<ReturnType<typeof createSqliteDataAccessor>>;

  beforeEach(async () => {
    // Create a temporary directory for each test
    testDir = mkdtempSync(join(tmpdir(), 'cleo-relations-test-'));
    accessor = await createSqliteDataAccessor(testDir);
  });

  afterEach(async () => {
    // Clean up
    await accessor.close();
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('Round-trip persistence', () => {
    it('should persist and reload relations across accessor restarts', async () => {
      // Setup - create two tasks
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      // Add relation
      await accessor.addRelation!('T001', 'T002', 'blocks', 'T001 blocks T002');

      // Verify relation exists before closing
      const taskFileBefore = await accessor.loadTaskFile();
      const taskBefore = taskFileBefore.tasks.find(t => t.id === 'T001');
      expect(taskBefore?.relates).toHaveLength(1);
      expect(taskBefore?.relates?.[0]).toEqual({
        taskId: 'T002',
        type: 'blocks',
        reason: 'T001 blocks T002',
      });

      // Close and reopen accessor (simulates restart)
      await accessor.close();
      accessor = await createSqliteDataAccessor(testDir);

      // Reload and verify
      const taskFileAfter = await accessor.loadTaskFile();
      const taskAfter = taskFileAfter.tasks.find(t => t.id === 'T001');

      expect(taskAfter?.relates).toHaveLength(1);
      expect(taskAfter?.relates?.[0]).toEqual({
        taskId: 'T002',
        type: 'blocks',
        reason: 'T001 blocks T002',
      });
    });

    it('should persist multiple relations for a single task', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task3: Task = {
        id: 'T003',
        title: 'Task 3',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);
      await accessor.upsertSingleTask!(task3);

      // Add multiple relations
      await accessor.addRelation!('T001', 'T002', 'blocks');
      await accessor.addRelation!('T001', 'T003', 'duplicates');

      // Close and reopen
      await accessor.close();
      accessor = await createSqliteDataAccessor(testDir);

      // Verify
      const taskFile = await accessor.loadTaskFile();
      const task = taskFile.tasks.find(t => t.id === 'T001');

      expect(task?.relates).toHaveLength(2);
      expect(task?.relates).toContainEqual({
        taskId: 'T002',
        type: 'blocks',
      });
      expect(task?.relates).toContainEqual({
        taskId: 'T003',
        type: 'duplicates',
      });
    });

    it('should persist relations on archived tasks', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'archived',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);
      await accessor.addRelation!('T001', 'T002', 'related');

      // Close and reopen
      await accessor.close();
      accessor = await createSqliteDataAccessor(testDir);

      // Verify archived task has relation
      const archiveFile = await accessor.loadArchive();
      expect(archiveFile).not.toBeNull();
      const archivedTask = archiveFile?.archivedTasks.find(t => t.id === 'T001');
      expect(archivedTask?.relates).toHaveLength(1);
      expect(archivedTask?.relates?.[0]).toEqual({
        taskId: 'T002',
        type: 'related',
      });
    });
  });

  describe('Relation type validation', () => {
    it('should accept valid relation types', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      // All valid types should work
      const validTypes = ['related', 'blocks', 'duplicates', 'absorbs', 'fixes', 'extends', 'supersedes'];
      for (const type of validTypes) {
        await accessor.addRelation!('T001', 'T002', type);
      }

      const taskFile = await accessor.loadTaskFile();
      const task = taskFile.tasks.find(t => t.id === 'T001');
      expect(task?.relates).toHaveLength(validTypes.length);
    });

    it('should throw on invalid relation type', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      await expect(
        accessor.addRelation('T001', 'T002', 'invalid-type')
      ).rejects.toThrow('Invalid relation type');
    });

    it('should include valid types in error message', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      await expect(
        accessor.addRelation('T001', 'T002', 'bad-type')
      ).rejects.toThrow(/related.*blocks.*duplicates.*absorbs.*fixes.*extends.*supersedes/);
    });
  });

  describe('Duplicate handling', () => {
    it('should handle duplicate relation adds gracefully', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      // Add same relation twice
      await accessor.addRelation!('T001', 'T002', 'blocks');
      await accessor.addRelation!('T001', 'T002', 'blocks');

      const taskFile = await accessor.loadTaskFile();
      const task = taskFile.tasks.find(t => t.id === 'T001');

      // Should only have one relation (onConflictDoNothing)
      expect(task?.relates).toHaveLength(1);
    });
  });

  describe('Reason field', () => {
    it('should persist relation reason', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      await accessor.addRelation!('T001', 'T002', 'blocks', 'This is the reason');

      // Close and reopen
      await accessor.close();
      accessor = await createSqliteDataAccessor(testDir);

      const taskFile = await accessor.loadTaskFile();
      const task = taskFile.tasks.find(t => t.id === 'T001');

      expect(task?.relates?.[0].reason).toBe('This is the reason');
    });

    it('should handle relations without reason', async () => {
      const task1: Task = {
        id: 'T001',
        title: 'Task 1',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };
      const task2: Task = {
        id: 'T002',
        title: 'Task 2',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      };

      await accessor.upsertSingleTask!(task1);
      await accessor.upsertSingleTask!(task2);

      await accessor.addRelation!('T001', 'T002', 'blocks');

      const taskFile = await accessor.loadTaskFile();
      const task = taskFile.tasks.find(t => t.id === 'T001');

      expect(task?.relates?.[0].reason).toBeUndefined();
    });
  });
});
