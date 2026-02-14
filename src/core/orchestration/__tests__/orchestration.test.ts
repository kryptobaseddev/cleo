/**
 * Tests for orchestration and skill dispatch.
 * @task T4466
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  startOrchestration,
  analyzeEpic,
  getReadyTasks,
  getNextTask,
  prepareSpawn,
  autoDispatch,
  resolveTokens,
  getOrchestratorContext,
} from '../index.js';
import type { Task } from '../../../types/task.js';

let testDir: string;
let cleoDir: string;

const makeTodoFile = (tasks: Task[]) => ({
  version: '2.10.0',
  project: { name: 'Test', phases: {} },
  lastUpdated: '2026-01-01T00:00:00Z',
  _meta: { schemaVersion: '2.10.0', specVersion: '0.1.0', checksum: 'abc123', configVersion: '2.0.0' },
  tasks,
});

const epicTasks: Task[] = [
  { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T002', title: 'Implement auth', status: 'done', priority: 'high', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T003', title: 'Build UI', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', depends: ['T002'], createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T004', title: 'Research patterns', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', labels: ['research'], createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T005', title: 'Test integration', status: 'blocked', priority: 'high', type: 'task', parentId: 'T001', depends: ['T003'], createdAt: '2026-01-01T00:00:00Z' },
];

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-orch-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

async function writeTodo(tasks: Task[] = epicTasks) {
  await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile(tasks)));
}

describe('startOrchestration', () => {
  it('creates orchestrator session for epic', async () => {
    await writeTodo();
    const session = await startOrchestration('T001');
    expect(session.epicId).toBe('T001');
    expect(session.status).toBe('active');
  });

  it('rejects non-epic tasks', async () => {
    await writeTodo();
    await expect(startOrchestration('T002')).rejects.toThrow('not an epic');
  });

  it('rejects non-existent tasks', async () => {
    await writeTodo();
    await expect(startOrchestration('T999')).rejects.toThrow('not found');
  });
});

describe('analyzeEpic', () => {
  it('analyzes dependency structure', async () => {
    await writeTodo();
    const result = await analyzeEpic('T001');
    expect(result.epicId).toBe('T001');
    expect(result.totalTasks).toBe(4);
    expect(result.completedTasks).toContain('T002');
    expect(result.readyTasks.length).toBeGreaterThan(0);
  });
});

describe('getReadyTasks', () => {
  it('returns tasks with all deps met', async () => {
    await writeTodo();
    const ready = await getReadyTasks('T001');
    // T003 depends on T002 (done), so it should be ready
    // T004 has no deps, should be ready
    const readyIds = ready.filter(r => r.ready).map(r => r.taskId);
    expect(readyIds).toContain('T003');
    expect(readyIds).toContain('T004');
  });

  it('marks blocked tasks with blockers', async () => {
    await writeTodo();
    const ready = await getReadyTasks('T001');
    const t005 = ready.find(r => r.taskId === 'T005');
    expect(t005?.ready).toBe(false);
    expect(t005?.blockers).toContain('T003');
  });
});

describe('getNextTask', () => {
  it('returns next ready task', async () => {
    await writeTodo();
    const next = await getNextTask('T001');
    expect(next).not.toBeNull();
    expect(next!.ready).toBe(true);
  });
});

describe('prepareSpawn', () => {
  it('prepares spawn context', async () => {
    await writeTodo();
    const context = await prepareSpawn('T003');
    expect(context.taskId).toBe('T003');
    expect(context.protocol).toBe('implementation');
    expect(context.prompt).toContain('T003');
    expect(context.tokenResolution.fullyResolved).toBe(true);
  });
});

describe('autoDispatch', () => {
  it('dispatches by label', () => {
    const task: Task = { id: 'T001', title: 'Something', status: 'pending', priority: 'medium', labels: ['research'], createdAt: '2026-01-01T00:00:00Z' };
    expect(autoDispatch(task)).toBe('research');
  });

  it('dispatches by type (epic)', () => {
    const task: Task = { id: 'T001', title: 'Something', status: 'pending', priority: 'medium', type: 'epic', createdAt: '2026-01-01T00:00:00Z' };
    expect(autoDispatch(task)).toBe('decomposition');
  });

  it('dispatches by keyword', () => {
    const task: Task = { id: 'T001', title: 'Implement auth module', status: 'pending', priority: 'medium', createdAt: '2026-01-01T00:00:00Z' };
    expect(autoDispatch(task)).toBe('implementation');
  });

  it('falls back to implementation', () => {
    const task: Task = { id: 'T001', title: 'Something generic', status: 'pending', priority: 'medium', createdAt: '2026-01-01T00:00:00Z' };
    expect(autoDispatch(task)).toBe('implementation');
  });
});

describe('resolveTokens', () => {
  it('resolves known tokens', () => {
    const result = resolveTokens('Task: {{TASK_ID}}, Epic: {{EPIC_ID}}', {
      TASK_ID: 'T001',
      EPIC_ID: 'T000',
    });
    expect(result.resolved).toBe('Task: T001, Epic: T000');
    expect(result.unresolved).toEqual([]);
  });

  it('reports unresolved tokens', () => {
    const result = resolveTokens('Task: {{TASK_ID}} Date: {{DATE}}', {
      TASK_ID: 'T001',
    });
    expect(result.resolved).toContain('T001');
    expect(result.unresolved).toContain('DATE');
  });
});

describe('getOrchestratorContext', () => {
  it('returns context summary', async () => {
    await writeTodo();
    const ctx = await getOrchestratorContext('T001');
    expect(ctx.epicId).toBe('T001');
    expect(ctx.totalTasks).toBe(4);
    expect(ctx.completed).toBe(1);
    expect(ctx.completionPercent).toBe(25);
  });
});
