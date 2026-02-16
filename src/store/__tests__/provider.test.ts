/**
 * Tests for StoreProvider abstraction layer.
 * Verifies JSON provider creation and detectStoreEngine behavior.
 *
 * @task T4644
 * @epic T4638
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectStoreEngine, createStoreProvider } from '../provider.js';
import { createJsonStoreProvider } from '../json-provider.js';
import type { TodoFile } from '../../types/task.js';

/** Minimal todo.json for testing. */
function makeTodoFile(tasks: TodoFile['tasks'] = []): TodoFile {
  return {
    version: '2.10.0',
    project: { name: 'test-project', phases: {} },
    lastUpdated: new Date().toISOString(),
    _meta: {
      schemaVersion: '2.10.0',
      checksum: '0000000000000000',
      configVersion: '1.0.0',
    },
    tasks,
  };
}

describe('detectStoreEngine', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-provider-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns json when no config or tasks.db exists', () => {
    const engine = detectStoreEngine(tempDir);
    expect(engine).toBe('json');
  });

  it('returns sqlite when tasks.db exists', async () => {
    await writeFile(join(cleoDir, 'tasks.db'), '');
    const engine = detectStoreEngine(tempDir);
    expect(engine).toBe('sqlite');
  });

  it('respects explicit config setting for json', async () => {
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({
      storage: { engine: 'json' },
    }));
    // Even with tasks.db present, config takes precedence
    await writeFile(join(cleoDir, 'tasks.db'), '');
    const engine = detectStoreEngine(tempDir);
    expect(engine).toBe('json');
  });

  it('respects explicit config setting for sqlite', async () => {
    await writeFile(join(cleoDir, 'config.json'), JSON.stringify({
      storage: { engine: 'sqlite' },
    }));
    const engine = detectStoreEngine(tempDir);
    expect(engine).toBe('sqlite');
  });
});

describe('createStoreProvider (json)', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-provider-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a json provider when engine is json', async () => {
    const provider = await createStoreProvider('json', tempDir);
    expect(provider.engine).toBe('json');
    await provider.close();
  });

  it('json provider getTask returns null for non-existent task', async () => {
    // Create minimal todo.json
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile()));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = await createStoreProvider('json', tempDir);
    const task = await provider.getTask('T999');
    expect(task).toBeNull();
    await provider.close();
  });

  it('json provider listTasks returns empty array for empty project', async () => {
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile()));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = await createStoreProvider('json', tempDir);
    const tasks = await provider.listTasks();
    expect(tasks).toEqual([]);
    await provider.close();
  });

  it('json provider listTasks returns existing tasks', async () => {
    const tasks = [
      { id: 'T001', title: 'First task', status: 'pending' as const, priority: 'medium' as const, createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Second task', status: 'done' as const, priority: 'high' as const, createdAt: new Date().toISOString() },
    ];
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile(tasks)));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = await createStoreProvider('json', tempDir);
    const result = await provider.listTasks();
    expect(result).toHaveLength(2);
    expect(result.map(t => t.id).sort()).toEqual(['T001', 'T002']);
    await provider.close();
  });

  it('json provider listTasks filters by status', async () => {
    const tasks = [
      { id: 'T001', title: 'Pending', status: 'pending' as const, priority: 'medium' as const, createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Done', status: 'done' as const, priority: 'high' as const, createdAt: new Date().toISOString() },
    ];
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile(tasks)));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = await createStoreProvider('json', tempDir);
    const pending = await provider.listTasks({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe('T001');
    await provider.close();
  });

  it('json provider getTask returns task with enriched details', async () => {
    const tasks = [
      { id: 'T001', title: 'Parent', status: 'pending' as const, priority: 'medium' as const, type: 'epic' as const, createdAt: new Date().toISOString() },
      { id: 'T002', title: 'Child', status: 'pending' as const, priority: 'medium' as const, parentId: 'T001', createdAt: new Date().toISOString() },
    ];
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile(tasks)));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = await createStoreProvider('json', tempDir);
    const task = await provider.getTask('T001');
    expect(task).not.toBeNull();
    expect(task!.id).toBe('T001');
    expect(task!.title).toBe('Parent');
    await provider.close();
  });

  it('json provider listSessions returns empty for new project', async () => {
    const provider = await createStoreProvider('json', tempDir);
    const sessions = await provider.listSessions();
    expect(sessions).toEqual([]);
    await provider.close();
  });

  it('json provider close is a no-op', async () => {
    const provider = await createStoreProvider('json', tempDir);
    // Should not throw
    await provider.close();
    await provider.close(); // Double-close should be safe
  });
});

describe('createJsonStoreProvider', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-provider-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns a provider with engine set to json', () => {
    const provider = createJsonStoreProvider(tempDir);
    expect(provider.engine).toBe('json');
  });

  it('implements all StoreProvider methods', () => {
    const provider = createJsonStoreProvider(tempDir);
    expect(typeof provider.createTask).toBe('function');
    expect(typeof provider.getTask).toBe('function');
    expect(typeof provider.updateTask).toBe('function');
    expect(typeof provider.deleteTask).toBe('function');
    expect(typeof provider.listTasks).toBe('function');
    expect(typeof provider.findTasks).toBe('function');
    expect(typeof provider.archiveTask).toBe('function');
    expect(typeof provider.createSession).toBe('function');
    expect(typeof provider.getSession).toBe('function');
    expect(typeof provider.updateSession).toBe('function');
    expect(typeof provider.listSessions).toBe('function');
    expect(typeof provider.endSession).toBe('function');
    expect(typeof provider.setFocus).toBe('function');
    expect(typeof provider.getFocus).toBe('function');
    expect(typeof provider.clearFocus).toBe('function');
    expect(typeof provider.close).toBe('function');
  });

  it('deleteTask returns false for non-existent task', async () => {
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile()));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = createJsonStoreProvider(tempDir);
    const result = await provider.deleteTask('T999');
    expect(result).toBe(false);
  });

  it('archiveTask returns false for non-existent task', async () => {
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile()));
    await writeFile(join(cleoDir, 'todo-log.jsonl'), '');

    const provider = createJsonStoreProvider(tempDir);
    const result = await provider.archiveTask('T999');
    expect(result).toBe(false);
  });
});
