/**
 * Tests for focus management.
 * @task T4462
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { showFocus, setFocus, clearFocus, getFocusHistory } from '../index.js';
import type { TodoFile } from '../../../types/task.js';

describe('Focus', () => {
  let tempDir: string;
  let cleoDir: string;

  const makeTodoFile = (tasks: TodoFile['tasks'], focus?: TodoFile['focus']): TodoFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    focus,
    tasks,
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('showFocus', () => {
    it('returns null when no focus set', async () => {
      const data = makeTodoFile([]);
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const result = await showFocus(tempDir);
      expect(result.currentTask).toBeNull();
    });

    it('returns current focus', async () => {
      const data = makeTodoFile(
        [{ id: 'T001', title: 'Task', status: 'active', priority: 'medium', createdAt: new Date().toISOString() }],
        { currentTask: 'T001', currentPhase: null },
      );
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const result = await showFocus(tempDir);
      expect(result.currentTask).toBe('T001');
    });
  });

  describe('setFocus', () => {
    it('sets focus to a task', async () => {
      const data = makeTodoFile([
        { id: 'T001', title: 'Target task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      ]);
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const result = await setFocus('T001', tempDir);
      expect(result.taskId).toBe('T001');
      expect(result.taskTitle).toBe('Target task');
      expect(result.previousTask).toBeNull();
    });

    it('returns previous focus task', async () => {
      const data = makeTodoFile(
        [
          { id: 'T001', title: 'Old focus', status: 'active', priority: 'medium', createdAt: new Date().toISOString() },
          { id: 'T002', title: 'New focus', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
        ],
        { currentTask: 'T001' },
      );
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const result = await setFocus('T002', tempDir);
      expect(result.previousTask).toBe('T001');
    });

    it('throws if task not found', async () => {
      const data = makeTodoFile([]);
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      await expect(setFocus('T999', tempDir)).rejects.toThrow('Task not found');
    });
  });

  describe('clearFocus', () => {
    it('clears current focus', async () => {
      const data = makeTodoFile(
        [{ id: 'T001', title: 'Task', status: 'active', priority: 'medium', createdAt: new Date().toISOString() }],
        { currentTask: 'T001' },
      );
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const result = await clearFocus(tempDir);
      expect(result.previousTask).toBe('T001');

      const show = await showFocus(tempDir);
      expect(show.currentTask).toBeNull();
    });
  });

  describe('getFocusHistory', () => {
    it('returns focus history from session notes', async () => {
      const data = makeTodoFile(
        [{ id: 'T001', title: 'Task', status: 'active', priority: 'medium', createdAt: new Date().toISOString() }],
        {
          currentTask: 'T001',
          sessionNotes: [
            { note: 'Focus set to T001: Task', timestamp: '2026-01-01T00:00:00Z' },
            { note: 'Focus set to T002: Other', timestamp: '2026-01-01T01:00:00Z' },
          ],
        },
      );
      await writeFile(join(cleoDir, 'tasks.json'), JSON.stringify(data));

      const history = await getFocusHistory(tempDir);
      expect(history).toHaveLength(2);
      expect(history[0]!.taskId).toBe('T002'); // Most recent first
      expect(history[1]!.taskId).toBe('T001');
    });
  });
});
