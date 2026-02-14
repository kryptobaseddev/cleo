/**
 * Tests for dependency graph operations.
 * @task T4464
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildGraph,
  getDepsOverview,
  getTaskDeps,
  topologicalSort,
  getExecutionWaves,
  getCriticalPath,
  getImpact,
  detectCycles,
  getTaskTree,
} from '../deps.js';
import type { Task } from '../../../types/task.js';

let testDir: string;
let cleoDir: string;

const baseTasks: Task[] = [
  { id: 'T001', title: 'Foundation', status: 'done', priority: 'high', type: 'task', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T002', title: 'Core', status: 'active', priority: 'high', type: 'task', depends: ['T001'], createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T003', title: 'UI', status: 'pending', priority: 'medium', type: 'task', depends: ['T001'], createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T004', title: 'Integration', status: 'pending', priority: 'high', type: 'task', depends: ['T002', 'T003'], createdAt: '2026-01-01T00:00:00Z' },
];

const makeTodoFile = (tasks: Task[] = baseTasks) => ({
  version: '2.10.0',
  project: { name: 'Test', phases: {} },
  lastUpdated: '2026-01-01T00:00:00Z',
  _meta: { schemaVersion: '2.10.0', specVersion: '0.1.0', checksum: 'abc123', configVersion: '2.0.0' },
  tasks,
});

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-deps-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

async function writeTodo(tasks?: Task[]) {
  await writeFile(
    join(cleoDir, 'todo.json'),
    JSON.stringify(makeTodoFile(tasks)),
  );
}

describe('buildGraph', () => {
  it('builds adjacency graph from tasks', () => {
    const graph = buildGraph(baseTasks);
    expect(graph.size).toBe(4);

    const t001 = graph.get('T001')!;
    expect(t001.depends).toEqual([]);
    expect(t001.dependents).toContain('T002');
    expect(t001.dependents).toContain('T003');

    const t004 = graph.get('T004')!;
    expect(t004.depends).toContain('T002');
    expect(t004.depends).toContain('T003');
  });
});

describe('getDepsOverview', () => {
  it('returns overview of all dependencies', async () => {
    await writeTodo();
    const result = await getDepsOverview();
    expect(result.totalTasks).toBe(4);
    expect(result.withDependencies).toBe(3);
    expect(result.roots).toContain('T001');
    expect(result.leaves).toContain('T004');
  });
});

describe('getTaskDeps', () => {
  it('returns upstream and downstream deps', async () => {
    await writeTodo();
    const result = await getTaskDeps('T002');
    expect(result.upstream).toHaveLength(1);
    expect(result.upstream[0]!.id).toBe('T001');
    expect(result.downstream).toHaveLength(1);
    expect(result.downstream[0]!.id).toBe('T004');
  });

  it('shows blocking deps', async () => {
    await writeTodo();
    const result = await getTaskDeps('T004');
    // T002 is active (not done), so it blocks T004
    expect(result.blockedBy.length).toBeGreaterThan(0);
  });

  it('throws for non-existent task', async () => {
    await writeTodo();
    await expect(getTaskDeps('T999')).rejects.toThrow('not found');
  });
});

describe('topologicalSort', () => {
  it('sorts tasks in dependency order', () => {
    const sorted = topologicalSort(baseTasks);
    const ids = sorted.map(t => t.id);

    // T001 must come before T002 and T003
    expect(ids.indexOf('T001')).toBeLessThan(ids.indexOf('T002'));
    expect(ids.indexOf('T001')).toBeLessThan(ids.indexOf('T003'));

    // T002 and T003 must come before T004
    expect(ids.indexOf('T002')).toBeLessThan(ids.indexOf('T004'));
    expect(ids.indexOf('T003')).toBeLessThan(ids.indexOf('T004'));
  });

  it('throws on circular dependencies', () => {
    const circular: Task[] = [
      { id: 'T001', title: 'A', status: 'pending', priority: 'medium', depends: ['T002'], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'B', status: 'pending', priority: 'medium', depends: ['T001'], createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect(() => topologicalSort(circular)).toThrow('Circular');
  });
});

describe('getExecutionWaves', () => {
  it('groups tasks into parallel waves', async () => {
    await writeTodo();
    const waves = await getExecutionWaves();
    expect(waves.length).toBeGreaterThanOrEqual(1);
    // Wave 1 should contain T002 and T003 (both depend only on T001 which is done)
    // Wave 2 should contain T004
  });
});

describe('getCriticalPath', () => {
  it('finds longest dependency chain', async () => {
    await writeTodo();
    const result = await getCriticalPath('T001');
    expect(result.length).toBeGreaterThan(1);
    expect(result.path[0]!.id).toBe('T001');
  });
});

describe('getImpact', () => {
  it('finds all impacted tasks', async () => {
    await writeTodo();
    const result = await getImpact('T001');
    expect(result).toContain('T002');
    expect(result).toContain('T003');
    expect(result).toContain('T004');
  });
});

describe('detectCycles', () => {
  it('detects no cycles in valid graph', async () => {
    await writeTodo();
    const result = await detectCycles();
    expect(result.hasCycles).toBe(false);
  });
});

describe('getTaskTree', () => {
  it('builds task hierarchy tree', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Child 1', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', position: 1, createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T003', title: 'Child 2', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', position: 2, createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);
    const tree = await getTaskTree('T001');
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(2);
  });
});
