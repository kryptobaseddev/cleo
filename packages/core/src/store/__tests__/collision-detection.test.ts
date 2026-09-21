/**
 * Collision Detection Tests
 *
 * Tests the SQLite-level collision detection in data-safety-central.ts.
 * Verifies that duplicate task IDs are caught before database write.
 *
 * @task T4741
 * @epic T4732
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.stubEnv('CLEO_ROOT', tempDir);
    vi.stubEnv('CLEO_DIR', cleoDir);
    await writeFile(
      join(cleoDir, 'project-info.json'),
      JSON.stringify({
        projectId: 'collision-detection-fixture',
        projectHash: 'collision-detection-fixture',
      }),
    );

    // Reset SQLite singleton
    const { closeDb } = await import('../sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../sqlite.js');
    closeDb();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  async function otherProject(): Promise<string> {
    const root = join(tempDir, 'other');
    await mkdir(join(root, '.cleo'), { recursive: true });
    await writeFile(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'other-project', projectHash: 'other-project' }),
    );
    return root;
  }

  function candidate(id: string): Task {
    return {
      id,
      title: 'Scoped candidate',
      description: 'Synthetic ownership probe',
      status: 'pending',
      priority: 'medium',
      createdAt: '2026-09-19T00:00:00.000Z',
    };
  }

  it('honors an explicit project for collision and write verification against contradictory pins', async () => {
    const other = await otherProject();
    const { createTask } = await import('../tasks-sqlite.js');
    const { checkTaskExists, verifyTaskWrite } = await import('../data-safety-central.js');
    await createTask(candidate('T901'), other, { autoCheckpoint: false, validateSequence: false });
    expect(await checkTaskExists('T901', other, { strictMode: false })).toBe(true);
    expect(await verifyTaskWrite('T901', { title: 'Scoped candidate' }, other)).toBe(true);
    expect(await checkTaskExists('T901', tempDir, { strictMode: false })).toBe(false);
  });

  it('retains the explicit project through a callback await and ambient pin changes', async () => {
    const other = await otherProject();
    const { createTask, getTask } = await import('../tasks-sqlite.js');
    const { safeCreateTask } = await import('../data-safety-central.js');
    const task = candidate('T902');
    await safeCreateTask(
      async () => {
        await Promise.resolve();
        vi.stubEnv('CLEO_ROOT', tempDir);
        vi.stubEnv('CLEO_DIR', cleoDir);
        return createTask(task, undefined, { autoCheckpoint: false, validateSequence: false });
      },
      task,
      other,
      { autoCheckpoint: false, validateSequence: false },
    );
    expect((await getTask(task.id, other))?.title).toBe(task.title);
    expect(await getTask(task.id, tempDir)).toBeNull();
    const persisted = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { DatabaseSync } from 'node:sqlite'; const db=new DatabaseSync(process.argv[1],{readOnly:true}); process.stdout.write(JSON.stringify(db.prepare('SELECT id,title FROM tasks_tasks WHERE id=?').all(process.argv[2])));db.close();",
        join(other, '.cleo/cleo.db'),
        task.id,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    expect(JSON.parse(persisted)).toEqual([{ id: task.id, title: task.title }]);
  });

  it('surfaces the explicit project diagnostic failure instead of reporting no collision', async () => {
    const other = await otherProject();
    const { createTask } = await import('../tasks-sqlite.js');
    const { checkTaskExists } = await import('../data-safety-central.js');
    const { getNativeTasksDb } = await import('../sqlite.js');
    const { captureProjectScope, worktreeScope } = await import('../../project-scope.js');
    await createTask(candidate('T903'), other, { autoCheckpoint: false, validateSequence: false });
    worktreeScope.run(captureProjectScope(other, undefined), () => {
      const db = getNativeTasksDb(other);
      if (!db) throw new Error('Synthetic target handle missing');
      db.exec('ALTER TABLE tasks_tasks RENAME TO unavailable_tasks');
    });
    await expect(checkTaskExists('T903', other, { strictMode: false })).rejects.toThrow();
  });

  describe('checkTaskExists', () => {
    it('should return false for non-existent task', async () => {
      const { checkTaskExists } = await import('../data-safety-central.js');

      const exists = await checkTaskExists('T9999', tempDir, { strictMode: false });
      expect(exists).toBe(false);
    });

    it('should detect existing task ID in strict mode', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      // Create a task first
      await createTask({
        id: 'T001',
        title: 'Existing task',
        description: 'Test task for collision detection',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Should throw in strict mode
      await expect(checkTaskExists('T001', tempDir, { strictMode: true })).rejects.toThrow(
        'collision',
      );
    });

    it('should return true for existing task in non-strict mode', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        description: 'Test task for collision detection',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });

    it('should not detect collision when detection is disabled', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        description: 'Test task for collision detection',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      // Should return false when detection is disabled
      const exists = await checkTaskExists('T001', tempDir, { detectCollisions: false });
      expect(exists).toBe(false);
    });

    it('should include existing task details in error context', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists, SafetyError } = await import('../data-safety-central.js');

      await createTask({
        id: 'T001',
        title: 'Existing task',
        description: 'Test task for collision detection',
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
      const { checkTaskExists } = await import('../data-safety-central.js');

      // Run multiple checks in parallel for non-existent IDs
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          checkTaskExists(`T${i + 100}`, tempDir, { strictMode: false }),
        ),
      );

      // All should return false (no collisions for non-existent tasks)
      expect(results.every((r) => r === false)).toBe(true);
    });

    it('should detect collision from rapid create-then-check', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      // Create task, then immediately check
      await createTask({
        id: 'T001',
        title: 'Quick task',
        description: 'Quick task for race condition test',
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
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      await createTask({
        id: 'T001',
        title: 'Active task',
        description: 'Active task for namespace isolation test',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });

    it('should detect collision in done tasks', async () => {
      const { createTask } = await import('../tasks-sqlite.js');
      const { checkTaskExists } = await import('../data-safety-central.js');

      await createTask({
        id: 'T001',
        title: 'Done task',
        description: 'Done task for namespace isolation test',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      });

      const exists = await checkTaskExists('T001', tempDir, { strictMode: false });
      expect(exists).toBe(true);
    });
  });
});
