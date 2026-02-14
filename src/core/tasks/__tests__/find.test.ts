/**
 * Tests for task search (find).
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findTasks, fuzzyScore } from '../find.js';
import type { TodoFile } from '../../../types/task.js';

describe('fuzzyScore', () => {
  it('returns 100 for exact match', () => {
    expect(fuzzyScore('hello', 'hello')).toBe(100);
  });

  it('returns high score for contains', () => {
    expect(fuzzyScore('auth', 'implement authentication')).toBeGreaterThan(60);
  });

  it('returns 0 for no match', () => {
    expect(fuzzyScore('xyz', 'abc')).toBe(0);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('AUTH', 'authentication')).toBeGreaterThan(0);
  });
});

describe('findTasks', () => {
  let tempDir: string;
  let cleoDir: string;

  const makeTodoFile = (tasks: TodoFile['tasks']): TodoFile => ({
    version: '2.10.0',
    project: { name: 'test', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    tasks,
  });

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('requires query or id', async () => {
    const data = makeTodoFile([]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    await expect(findTasks({}, tempDir)).rejects.toThrow('query or --id is required');
  });

  it('finds tasks by fuzzy query', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Implement authentication', status: 'pending', priority: 'high', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Fix database query', status: 'done', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T003', title: 'Update docs', status: 'pending', priority: 'low', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await findTasks({ query: 'auth' }, tempDir);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]!.id).toBe('T001');
    expect(result.searchType).toBe('fuzzy');
  });

  it('finds tasks by ID prefix', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Task 1', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T010', title: 'Task 10', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T100', title: 'Task 100', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await findTasks({ id: 'T01' }, tempDir);
    expect(result.results).toHaveLength(1); // T010 starts with T01
    expect(result.results[0]!.id).toBe('T010');
    expect(result.searchType).toBe('id');
  });

  it('finds tasks by exact title', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Exact Match', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Not Exact Match', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await findTasks({ query: 'Exact Match', exact: true }, tempDir);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('T001');
    expect(result.searchType).toBe('exact');
  });

  it('returns minimal fields only', async () => {
    const data = makeTodoFile([
      {
        id: 'T001',
        title: 'Task with lots of data',
        status: 'pending',
        priority: 'high',
        description: 'Long description here',
        notes: ['Note 1', 'Note 2'],
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await findTasks({ query: 'lots' }, tempDir);
    const found = result.results[0]!;
    expect(found.id).toBe('T001');
    expect(found.title).toBeDefined();
    expect(found.status).toBeDefined();
    expect(found.priority).toBeDefined();
    expect(found.score).toBeDefined();
    // Should NOT include heavy fields
    expect((found as Record<string, unknown>)['description']).toBeUndefined();
    expect((found as Record<string, unknown>)['notes']).toBeUndefined();
  });

  it('filters by status', async () => {
    const data = makeTodoFile([
      { id: 'T001', title: 'Done task', status: 'done', priority: 'medium', createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Pending task', status: 'pending', priority: 'medium', createdAt: new Date().toISOString() },
    ]);
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(data));

    const result = await findTasks({ query: 'task', status: 'pending' }, tempDir);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.id).toBe('T002');
  });
});
