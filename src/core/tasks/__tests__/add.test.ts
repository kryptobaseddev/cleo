/**
 * Tests for task creation (add).
 * @task T4460
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  addTask,
  validateTitle,
  validateStatus,
  validatePriority,
  validateTaskType,
  validateSize,
  validateLabels,
  validatePhaseFormat,
  generateTaskId,
  inferTaskType,
  getTaskDepth,
  getNextPosition,
  findRecentDuplicate,
  validateParent,
} from '../add.js';
import type { Task } from '../../../types/task.js';

describe('validateTitle', () => {
  it('accepts valid titles', () => {
    expect(() => validateTitle('Implement auth')).not.toThrow();
    expect(() => validateTitle('Fix bug #123')).not.toThrow();
  });

  it('rejects empty titles', () => {
    expect(() => validateTitle('')).toThrow('title is required');
    expect(() => validateTitle('   ')).toThrow('title is required');
  });

  it('rejects titles over 200 characters', () => {
    expect(() => validateTitle('a'.repeat(201))).toThrow('200 characters');
  });
});

describe('validateStatus', () => {
  it('accepts valid statuses', () => {
    expect(() => validateStatus('pending')).not.toThrow();
    expect(() => validateStatus('active')).not.toThrow();
    expect(() => validateStatus('done')).not.toThrow();
  });

  it('rejects invalid statuses', () => {
    expect(() => validateStatus('invalid')).toThrow('Invalid status');
  });
});

describe('validatePriority', () => {
  it('accepts valid priorities', () => {
    expect(() => validatePriority('critical')).not.toThrow();
    expect(() => validatePriority('low')).not.toThrow();
  });

  it('rejects invalid priorities', () => {
    expect(() => validatePriority('urgent')).toThrow('Invalid priority');
  });
});

describe('validateTaskType', () => {
  it('accepts epic, task, subtask', () => {
    expect(() => validateTaskType('epic')).not.toThrow();
    expect(() => validateTaskType('task')).not.toThrow();
    expect(() => validateTaskType('subtask')).not.toThrow();
  });

  it('rejects invalid types', () => {
    expect(() => validateTaskType('story')).toThrow('Invalid task type');
  });
});

describe('validateSize', () => {
  it('accepts small, medium, large', () => {
    expect(() => validateSize('small')).not.toThrow();
    expect(() => validateSize('medium')).not.toThrow();
    expect(() => validateSize('large')).not.toThrow();
  });

  it('rejects invalid sizes', () => {
    expect(() => validateSize('xl')).toThrow('Invalid size');
  });
});

describe('validateLabels', () => {
  it('accepts valid labels', () => {
    expect(() => validateLabels(['bug', 'v0.5.0', 'security'])).not.toThrow();
  });

  it('rejects invalid label format', () => {
    expect(() => validateLabels(['UPPERCASE'])).toThrow('Invalid label format');
    expect(() => validateLabels(['has space'])).toThrow('Invalid label format');
  });
});

describe('validatePhaseFormat', () => {
  it('accepts valid phase slugs', () => {
    expect(() => validatePhaseFormat('testing')).not.toThrow();
    expect(() => validatePhaseFormat('phase-1')).not.toThrow();
  });

  it('rejects invalid formats', () => {
    expect(() => validatePhaseFormat('Phase1')).toThrow('Invalid phase format');
    expect(() => validatePhaseFormat('123')).toThrow('Invalid phase format');
  });
});

describe('generateTaskId', () => {
  it('generates T001 for empty task list', () => {
    expect(generateTaskId([])).toBe('T001');
  });

  it('generates next sequential ID', () => {
    const tasks = [
      { id: 'T001' },
      { id: 'T003' },
    ] as Task[];
    expect(generateTaskId(tasks)).toBe('T004');
  });

  it('considers archived tasks', () => {
    const tasks = [{ id: 'T001' }] as Task[];
    const archived = [{ id: 'T005' }];
    expect(generateTaskId(tasks, archived)).toBe('T006');
  });
});

describe('inferTaskType', () => {
  it('returns task for root level', () => {
    expect(inferTaskType(null, [])).toBe('task');
  });

  it('returns task for epic parent', () => {
    const tasks = [{ id: 'T001', type: 'epic' }] as Task[];
    expect(inferTaskType('T001', tasks)).toBe('task');
  });

  it('returns subtask for task parent', () => {
    const tasks = [{ id: 'T001', type: 'task' }] as Task[];
    expect(inferTaskType('T001', tasks)).toBe('subtask');
  });
});

describe('getTaskDepth', () => {
  it('returns 0 for root tasks', () => {
    const tasks = [{ id: 'T001', parentId: null }] as Task[];
    expect(getTaskDepth('T001', tasks)).toBe(0);
  });

  it('returns correct depth for nested tasks', () => {
    const tasks = [
      { id: 'T001', parentId: null },
      { id: 'T002', parentId: 'T001' },
      { id: 'T003', parentId: 'T002' },
    ] as Task[];
    expect(getTaskDepth('T003', tasks)).toBe(2);
  });
});

describe('getNextPosition', () => {
  it('returns 1 for empty parent', () => {
    expect(getNextPosition(null, [])).toBe(1);
  });

  it('returns max + 1', () => {
    const tasks = [
      { id: 'T001', parentId: 'T000', position: 1 },
      { id: 'T002', parentId: 'T000', position: 3 },
    ] as Task[];
    expect(getNextPosition('T000', tasks)).toBe(4);
  });
});

describe('validateParent', () => {
  it('throws if parent not found', () => {
    expect(() => validateParent('T999', [])).toThrow('Parent task not found');
  });

  it('throws if parent is subtask', () => {
    const tasks = [{ id: 'T001', type: 'subtask' }] as Task[];
    expect(() => validateParent('T001', tasks)).toThrow('subtasks cannot have children');
  });
});

describe('findRecentDuplicate', () => {
  it('returns null when no duplicate', () => {
    expect(findRecentDuplicate('New task', undefined, [])).toBeNull();
  });

  it('detects recent duplicate by title', () => {
    const now = new Date().toISOString();
    const tasks = [{ id: 'T001', title: 'Test task', createdAt: now }] as Task[];
    expect(findRecentDuplicate('Test task', undefined, tasks))?.toEqual(
      expect.objectContaining({ id: 'T001' }),
    );
  });

  it('ignores old tasks outside window', () => {
    const old = new Date(Date.now() - 120000).toISOString();
    const tasks = [{ id: 'T001', title: 'Test task', createdAt: old }] as Task[];
    expect(findRecentDuplicate('Test task', undefined, tasks, 60)).toBeNull();
  });
});

describe('addTask (integration)', () => {
  let tempDir: string;
  let cleoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-test-'));
    cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });
    await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });

    // Create minimal todo.json
    const todoData = {
      version: '2.10.0',
      project: { name: 'test', phases: {}, currentPhase: null },
      lastUpdated: new Date().toISOString(),
      _meta: {
        schemaVersion: '2.10.0',
        checksum: '0000000000000000',
        configVersion: '1.0.0',
      },
      tasks: [],
    };
    await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(todoData, null, 2));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('creates a task with default values', async () => {
    const result = await addTask({ title: 'Test task' }, tempDir);
    expect(result.task.id).toBe('T001');
    expect(result.task.title).toBe('Test task');
    expect(result.task.status).toBe('pending');
    expect(result.task.priority).toBe('medium');
    expect(result.task.type).toBe('task');
    expect(result.duplicate).toBeUndefined();
  });

  it('creates a task with all options', async () => {
    const result = await addTask({
      title: 'Full task',
      status: 'active',
      priority: 'high',
      type: 'epic',
      size: 'large',
      description: 'A detailed description',
      labels: ['bug', 'security'],
    }, tempDir);

    expect(result.task.status).toBe('active');
    expect(result.task.priority).toBe('high');
    expect(result.task.type).toBe('epic');
    expect(result.task.size).toBe('large');
    expect(result.task.description).toBe('A detailed description');
    expect(result.task.labels).toEqual(['bug', 'security']);
  });

  it('generates sequential IDs', async () => {
    const r1 = await addTask({ title: 'Task 1' }, tempDir);
    const r2 = await addTask({ title: 'Task 2' }, tempDir);
    expect(r1.task.id).toBe('T001');
    expect(r2.task.id).toBe('T002');
  });

  it('detects duplicates', async () => {
    await addTask({ title: 'Duplicate me' }, tempDir);
    const r2 = await addTask({ title: 'Duplicate me' }, tempDir);
    expect(r2.duplicate).toBe(true);
    expect(r2.task.id).toBe('T001'); // Returns existing
  });

  it('handles dry run', async () => {
    const result = await addTask({ title: 'Dry run task', dryRun: true }, tempDir);
    expect(result.dryRun).toBe(true);
    expect(result.task.id).toBe('T001');

    // Should not persist
    const r2 = await addTask({ title: 'Next task' }, tempDir);
    expect(r2.task.id).toBe('T001'); // Same ID since dry run didn't persist
  });

  it('validates parent hierarchy', async () => {
    // Create parent
    await addTask({ title: 'Parent', type: 'epic' }, tempDir);

    // Create child
    const child = await addTask({ title: 'Child', parentId: 'T001' }, tempDir);
    expect(child.task.parentId).toBe('T001');
    expect(child.task.type).toBe('task');
  });

  it('rejects invalid parent', async () => {
    await expect(
      addTask({ title: 'Child', parentId: 'T999' }, tempDir),
    ).rejects.toThrow('Parent task not found');
  });
});
