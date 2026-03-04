/**
 * Tests for phase lifecycle management.
 * @task T4464
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  listPhases,
  showPhase,
  setPhase,
  startPhase,
  completePhase,
  renamePhase,
  deletePhase,
} from '../index.js';
import { createTestDb, makeTaskFile, type TestDbEnv } from '../../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../../store/data-accessor.js';
import type { Task } from '../../../types/task.js';

let env: TestDbEnv;
let accessor: DataAccessor;

const defaultProjectMeta = {
  name: 'Test',
  currentPhase: 'core',
  phases: {
    setup: { order: 1, name: 'Setup', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z' },
    core: { order: 2, name: 'Core', status: 'active', startedAt: '2026-01-02T00:00:00Z' },
    polish: { order: 3, name: 'Polish', status: 'pending' },
  },
  phaseHistory: [],
  releases: [],
};

const defaultTasks: Array<Partial<Task> & { id: string }> = [
  { id: 'T001', title: 'Task 1', status: 'done', priority: 'medium', phase: 'setup', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T002', title: 'Task 2', status: 'active', priority: 'high', phase: 'core', createdAt: '2026-01-01T00:00:00Z' },
  { id: 'T003', title: 'Task 3', status: 'pending', priority: 'medium', phase: 'polish', createdAt: '2026-01-01T00:00:00Z' },
];

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
});

afterEach(async () => {
  await env.cleanup();
});

async function writeTodo(overrides: Record<string, unknown> = {}, tasks?: Array<Partial<Task> & { id: string }>) {
  const taskFile = makeTaskFile(tasks ?? defaultTasks);
  taskFile.project = { ...defaultProjectMeta, ...overrides } as typeof taskFile.project;
  await accessor.saveTaskFile(taskFile);
}

describe('listPhases', () => {
  it('lists all phases sorted by order', async () => {
    await writeTodo();
    const result = await listPhases(env.tempDir, accessor);
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.slug).toBe('setup');
    expect(result.phases[1]!.slug).toBe('core');
    expect(result.phases[2]!.slug).toBe('polish');
    expect(result.currentPhase).toBe('core');
  });

  it('returns summary counts', async () => {
    await writeTodo();
    const result = await listPhases(env.tempDir, accessor);
    expect(result.summary.completed).toBe(1);
    expect(result.summary.active).toBe(1);
    expect(result.summary.pending).toBe(1);
  });
});

describe('showPhase', () => {
  it('shows current phase details', async () => {
    await writeTodo();
    const result = await showPhase(undefined, env.tempDir, accessor);
    expect(result.slug).toBe('core');
    expect(result.status).toBe('active');
  });

  it('shows specific phase by slug', async () => {
    await writeTodo();
    const result = await showPhase('setup', env.tempDir, accessor);
    expect(result.slug).toBe('setup');
    expect(result.status).toBe('completed');
  });

  it('throws for non-existent phase', async () => {
    await writeTodo();
    await expect(showPhase('nonexistent', env.tempDir, accessor)).rejects.toThrow('not found');
  });
});

describe('setPhase', () => {
  it('sets current phase', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'polish' }, env.tempDir, accessor);
    expect(result.previousPhase).toBe('core');
    expect(result.currentPhase).toBe('polish');
  });

  it('rejects rollback without flag', async () => {
    await writeTodo();
    await expect(setPhase({ slug: 'setup' }, env.tempDir, accessor)).rejects.toThrow('rollback');
  });

  it('allows rollback with flag', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'setup', rollback: true, force: true }, env.tempDir, accessor);
    expect(result.isRollback).toBe(true);
  });

  it('detects phase skip', async () => {
    await writeTodo({ currentPhase: 'setup' });
    const result = await setPhase({ slug: 'polish' }, env.tempDir, accessor);
    expect(result.isSkip).toBe(true);
    expect(result.skippedPhases).toBe(1);
  });

  it('supports dry run', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'polish', dryRun: true }, env.tempDir, accessor);
    expect(result.dryRun).toBe(true);
    // Verify no actual change
    const check = await showPhase(undefined, env.tempDir, accessor);
    expect(check.slug).toBe('core');
  });
});

describe('startPhase', () => {
  it('starts a pending phase', async () => {
    await writeTodo();
    const result = await startPhase('polish', env.tempDir, accessor);
    expect(result.phase).toBe('polish');
    expect(result.startedAt).toBeDefined();
  });

  it('rejects starting non-pending phase', async () => {
    await writeTodo();
    await expect(startPhase('core', env.tempDir, accessor)).rejects.toThrow('pending');
  });
});

describe('completePhase', () => {
  it('completes active phase with no incomplete tasks', async () => {
    // Make core have all done tasks
    const taskFile = makeTaskFile([
      { id: 'T001', title: 'Task 1', status: 'done', priority: 'medium', phase: 'core', createdAt: '2026-01-01T00:00:00Z' },
    ]);
    taskFile.project = { ...defaultProjectMeta } as typeof taskFile.project;
    await accessor.saveTaskFile(taskFile);

    const result = await completePhase('core', env.tempDir, accessor);
    expect(result.phase).toBe('core');
  });

  it('rejects completing phase with incomplete tasks', async () => {
    await writeTodo();
    await expect(completePhase('core', env.tempDir, accessor)).rejects.toThrow('incomplete');
  });
});

describe('renamePhase', () => {
  it('renames phase and updates task references', async () => {
    await writeTodo();
    const result = await renamePhase('core', 'development', env.tempDir, accessor);
    expect(result.oldName).toBe('core');
    expect(result.newName).toBe('development');
    expect(result.tasksUpdated).toBe(1);
    expect(result.currentPhaseUpdated).toBe(true);
  });

  it('rejects renaming to existing phase', async () => {
    await writeTodo();
    await expect(renamePhase('core', 'polish', env.tempDir, accessor)).rejects.toThrow('already exists');
  });
});

describe('deletePhase', () => {
  it('deletes empty phase with force', async () => {
    // Add a phase with no tasks
    const taskFile = makeTaskFile(defaultTasks);
    taskFile.project = {
      ...defaultProjectMeta,
      phases: {
        ...defaultProjectMeta.phases,
        empty: { order: 4, name: 'Empty', status: 'pending' },
      },
    } as typeof taskFile.project;
    await accessor.saveTaskFile(taskFile);

    const result = await deletePhase('empty', { force: true }, env.tempDir, accessor);
    expect(result.deletedPhase).toBe('empty');
  });

  it('rejects deleting current phase', async () => {
    await writeTodo();
    await expect(deletePhase('core', { force: true }, env.tempDir, accessor)).rejects.toThrow('current');
  });

  it('rejects deleting phase with tasks without reassignment', async () => {
    await writeTodo();
    await expect(deletePhase('polish', { force: true }, env.tempDir, accessor)).rejects.toThrow('orphaned');
  });

  it('requires force flag', async () => {
    // Use a phase with no tasks
    const taskFile = makeTaskFile(defaultTasks);
    taskFile.project = {
      ...defaultProjectMeta,
      phases: {
        ...defaultProjectMeta.phases,
        empty: { order: 4, name: 'Empty', status: 'pending' },
      },
    } as typeof taskFile.project;
    await accessor.saveTaskFile(taskFile);

    await expect(deletePhase('empty', {}, env.tempDir, accessor)).rejects.toThrow('force');
  });
});
