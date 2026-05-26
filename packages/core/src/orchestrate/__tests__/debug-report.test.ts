import { loadTasks, orchestrateReport } from '@cleocode/core/internal';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let TEST_ROOT: string;

beforeEach(async () => {
  TEST_ROOT = mkdtempSync(join(tmpdir(), 'cleo-debug-'));
  mkdirSync(join(TEST_ROOT, '.cleo'), { recursive: true });
  const { getDb, createTask } = await import('@cleocode/core/internal');
  await getDb(TEST_ROOT);
  await createTask(
    {
      id: 'E1',
      title: 'Epic',
      type: 'epic',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    TEST_ROOT,
  );
  await createTask(
    {
      id: 'T1',
      title: 'Ready',
      type: 'task',
      status: 'pending',
      priority: 'high',
      parentId: 'E1',
      depends: [],
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: null,
    },
    TEST_ROOT,
  );
});

afterEach(async () => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('debug', () => {
  it('loadTasks works', async () => {
    const tasks = await loadTasks(TEST_ROOT);
    console.log('loadTasks returned', tasks.length, 'tasks');
    console.log(
      'task IDs:',
      tasks.map((t) => t.id),
    );
    expect(tasks.length).toBeGreaterThan(0);
  });

  it('orchestrateReport debug', async () => {
    const result = await orchestrateReport('E1', TEST_ROOT);
    console.log('RESULT:', JSON.stringify(result, null, 2).slice(0, 3000));
    expect(result.success).toBe(true);
  });
});
