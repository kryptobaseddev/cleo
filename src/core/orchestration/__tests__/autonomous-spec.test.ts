/**
 * Autonomous orchestration spec compliance validation.
 * Tests orchestrator constraints AUTO-001 through AUTO-006, HNDOFF-001, CONT-001.
 *
 * @task T4500
 * @epic T4498
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
  validateSpawnOutput,
  getOrchestratorContext,
  autoDispatch,
  resolveTokens,
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

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-auto-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

async function writeTodo(tasks: Task[]) {
  await writeFile(join(cleoDir, 'todo.json'), JSON.stringify(makeTodoFile(tasks)));
}

// ============================================================
// AUTO-001: Orchestrator MUST only coordinate, not implement
// ============================================================

describe('AUTO-001: Orchestrator coordinates, does not implement', () => {
  it('startOrchestration returns session metadata, not code', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'high', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const session = await startOrchestration('T001');
    // Returns coordination data, not implementation
    expect(session).toHaveProperty('epicId');
    expect(session).toHaveProperty('status');
    expect(session).toHaveProperty('currentWave');
    expect(session).toHaveProperty('completedTasks');
    expect(session).toHaveProperty('spawnedAgents');
    // No code, no file content
    expect(session).not.toHaveProperty('code');
    expect(session).not.toHaveProperty('implementation');
  });
});

// ============================================================
// AUTO-002: Orchestrator MUST delegate ALL work via Task tool
// ============================================================

describe('AUTO-002: All work delegated via spawn', () => {
  it('prepareSpawn generates spawn context for delegation', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Implement feature', status: 'pending', priority: 'high', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const spawn = await prepareSpawn('T002');
    expect(spawn.taskId).toBe('T002');
    expect(spawn.protocol).toBeDefined();
    expect(spawn.prompt).toBeDefined();
    expect(spawn.tokenResolution).toBeDefined();
  });
});

// ============================================================
// AUTO-003: Orchestrator reads manifest summaries only
// ============================================================

describe('AUTO-003: Manifest-only reads', () => {
  it('getOrchestratorContext returns summary counts only', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task A', status: 'done', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T003', title: 'Task B', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T004', title: 'Task C', status: 'blocked', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const ctx = await getOrchestratorContext('T001');
    // Returns aggregate counts, not full task details
    expect(ctx).toHaveProperty('completed');
    expect(ctx).toHaveProperty('inProgress');
    expect(ctx).toHaveProperty('blocked');
    expect(ctx).toHaveProperty('pending');
    expect(ctx).toHaveProperty('completionPercent');
    expect(ctx.totalTasks).toBe(3);
    expect(ctx.completed).toBe(1);
  });
});

// ============================================================
// AUTO-004: Sequential spawning per dependency wave
// ============================================================

describe('AUTO-004: Wave-order spawning', () => {
  it('analyzeEpic returns ordered waves', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Foundation', status: 'done', priority: 'high', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T003', title: 'Build on foundation', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', depends: ['T002'], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T004', title: 'Independent task', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T005', title: 'Final task', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', depends: ['T003', 'T004'], createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const analysis = await analyzeEpic('T001');
    expect(analysis.waves.length).toBeGreaterThan(0);

    // Waves should be numbered sequentially
    for (let i = 0; i < analysis.waves.length; i++) {
      expect(analysis.waves[i]!.wave).toBe(i + 1);
    }
  });

  it('getReadyTasks only returns tasks with all deps met', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task A', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T003', title: 'Task B', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', depends: ['T002'], createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const ready = await getReadyTasks('T001');
    const readyIds = ready.filter(r => r.ready).map(r => r.taskId);

    // T002 has no deps - should be ready
    expect(readyIds).toContain('T002');
    // T003 depends on T002 (pending) - should NOT be ready
    expect(readyIds).not.toContain('T003');
  });
});

// ============================================================
// AUTO-005: Context budget - orchestrator stays lean
// ============================================================

describe('AUTO-005: Context budget compliance', () => {
  it('spawn prompt is reasonably sized', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', description: 'A moderate description', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const spawn = await prepareSpawn('T002');
    // Prompt should be under 10K tokens (~40K chars as rough estimate)
    expect(spawn.prompt.length).toBeLessThan(40000);
  });

  it('orchestrator context summary is compact', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `T${100 + i}`,
        title: `Task ${i}`,
        status: i < 10 ? 'done' : 'pending',
        priority: 'medium' as const,
        type: 'task' as const,
        parentId: 'T001',
        createdAt: '2026-01-01T00:00:00Z',
      })),
    ];
    await writeTodo(tasks);

    const ctx = await getOrchestratorContext('T001');
    const ctxStr = JSON.stringify(ctx);
    // Context summary should be very compact
    expect(ctxStr.length).toBeLessThan(500);
  });
});

// ============================================================
// AUTO-006: Max 3 files per agent scope
// (Validated by spawn - subagent receives bounded scope)
// ============================================================

describe('AUTO-006: Scoped spawn per task', () => {
  it('spawn context is scoped to a single task', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const spawn = await prepareSpawn('T002');
    // Spawn is for exactly one task
    expect(spawn.taskId).toBe('T002');
    // Prompt references the specific task
    expect(spawn.prompt).toContain('T002');
  });
});

// ============================================================
// HNDOFF-001: Manifest-mediated handoffs
// ============================================================

describe('HNDOFF-001: Manifest-mediated handoffs', () => {
  it('validateSpawnOutput checks for manifest entry', async () => {
    const result = await validateSpawnOutput('T002', {
      file: 'output.md',
      manifestEntry: true,
    });
    expect(result.valid).toBe(true);
  });

  it('validateSpawnOutput fails without manifest entry', async () => {
    const result = await validateSpawnOutput('T002', {
      file: 'output.md',
      manifestEntry: false,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No manifest entry appended');
  });

  it('validateSpawnOutput fails without output file', async () => {
    const result = await validateSpawnOutput('T002', {
      manifestEntry: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('No output file specified');
  });
});

// ============================================================
// CONT-001: Token resolution before spawn
// ============================================================

describe('CONT-001: Token resolution', () => {
  it('resolveTokens resolves all known tokens', () => {
    const { resolved, unresolved } = resolveTokens(
      'Task: {{TASK_ID}} Epic: {{EPIC_ID}} Date: {{DATE}}',
      { TASK_ID: 'T002', EPIC_ID: 'T001', DATE: '2026-01-01' },
    );
    expect(resolved).toBe('Task: T002 Epic: T001 Date: 2026-01-01');
    expect(unresolved).toHaveLength(0);
  });

  it('resolveTokens reports unresolved tokens', () => {
    const { resolved, unresolved } = resolveTokens(
      'Task: {{TASK_ID}} Unknown: {{UNKNOWN_TOKEN}}',
      { TASK_ID: 'T002' },
    );
    expect(resolved).toContain('T002');
    expect(resolved).toContain('{{UNKNOWN_TOKEN}}');
    expect(unresolved).toContain('UNKNOWN_TOKEN');
  });

  it('prepareSpawn checks token resolution', async () => {
    const tasks: Task[] = [
      { id: 'T001', title: 'Epic', status: 'active', priority: 'high', type: 'epic', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'T002', title: 'Task', status: 'pending', priority: 'medium', type: 'task', parentId: 'T001', createdAt: '2026-01-01T00:00:00Z' },
    ];
    await writeTodo(tasks);

    const spawn = await prepareSpawn('T002');
    // Built prompts should be fully resolved (no {{TOKEN}} patterns remain)
    expect(spawn.tokenResolution.fullyResolved).toBe(true);
    expect(spawn.tokenResolution.unresolvedTokens).toHaveLength(0);
  });
});

// ============================================================
// DISPATCH: Auto-dispatch correctness
// ============================================================

describe('Auto-dispatch protocol selection', () => {
  const dispatchCases: Array<{ title: string; labels?: string[]; type?: string; expected: string }> = [
    { title: 'Research auth patterns', labels: ['research'], expected: 'research' },
    { title: 'Vote on approach', labels: ['consensus'], expected: 'consensus' },
    { title: 'Write RFC for API', labels: ['specification'], expected: 'specification' },
    { title: 'Decompose into tasks', labels: ['decomposition'], expected: 'decomposition' },
    { title: 'Implement feature', labels: ['implementation'], expected: 'implementation' },
    { title: 'Submit PR', labels: ['contribution'], expected: 'contribution' },
    { title: 'Ship v1.0', labels: ['release'], expected: 'release' },
    { title: 'Epic decompose', type: 'epic', expected: 'decomposition' },
    { title: 'Investigate patterns', expected: 'research' },
    { title: 'Build the auth module', expected: 'implementation' },
    { title: 'Something unrecognized', expected: 'implementation' },
  ];

  for (const tc of dispatchCases) {
    it(`dispatches "${tc.title}" to ${tc.expected}`, () => {
      const task: Task = {
        id: 'T001',
        title: tc.title,
        status: 'pending',
        priority: 'medium',
        labels: tc.labels,
        type: tc.type as Task['type'],
        createdAt: '2026-01-01T00:00:00Z',
      };
      expect(autoDispatch(task)).toBe(tc.expected);
    });
  }
});
