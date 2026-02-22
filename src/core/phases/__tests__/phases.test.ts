/**
 * Tests for phase lifecycle management.
 * @task T4464
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  listPhases,
  showPhase,
  setPhase,
  startPhase,
  completePhase,
  advancePhase,
  renamePhase,
  deletePhase,
} from '../index.js';

let testDir: string;
let cleoDir: string;

const makeTodoFile = (overrides: Record<string, unknown> = {}) => ({
  version: '2.10.0',
  project: {
    name: 'Test',
    currentPhase: 'core',
    phases: {
      setup: { order: 1, name: 'Setup', status: 'completed', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-02T00:00:00Z' },
      core: { order: 2, name: 'Core', status: 'active', startedAt: '2026-01-02T00:00:00Z' },
      polish: { order: 3, name: 'Polish', status: 'pending' },
    },
    ...overrides,
  },
  lastUpdated: '2026-01-01T00:00:00Z',
  _meta: { schemaVersion: '2.10.0', specVersion: '0.1.0', checksum: 'abc123', configVersion: '2.0.0' },
  focus: {},
  tasks: [
    { id: 'T001', title: 'Task 1', status: 'done', priority: 'medium', phase: 'setup', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'T002', title: 'Task 2', status: 'active', priority: 'high', phase: 'core', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'T003', title: 'Task 3', status: 'pending', priority: 'medium', phase: 'polish', createdAt: '2026-01-01T00:00:00Z' },
  ],
});

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-phases-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
});

afterEach(async () => {
  delete process.env['CLEO_DIR'];
  await rm(testDir, { recursive: true, force: true });
});

async function writeTodo(overrides: Record<string, unknown> = {}) {
  await writeFile(
    join(cleoDir, 'tasks.json'),
    JSON.stringify(makeTodoFile(overrides)),
  );
}

describe('listPhases', () => {
  it('lists all phases sorted by order', async () => {
    await writeTodo();
    const result = await listPhases();
    expect(result.phases).toHaveLength(3);
    expect(result.phases[0]!.slug).toBe('setup');
    expect(result.phases[1]!.slug).toBe('core');
    expect(result.phases[2]!.slug).toBe('polish');
    expect(result.currentPhase).toBe('core');
  });

  it('returns summary counts', async () => {
    await writeTodo();
    const result = await listPhases();
    expect(result.summary.completed).toBe(1);
    expect(result.summary.active).toBe(1);
    expect(result.summary.pending).toBe(1);
  });
});

describe('showPhase', () => {
  it('shows current phase details', async () => {
    await writeTodo();
    const result = await showPhase();
    expect(result.slug).toBe('core');
    expect(result.status).toBe('active');
  });

  it('shows specific phase by slug', async () => {
    await writeTodo();
    const result = await showPhase('setup');
    expect(result.slug).toBe('setup');
    expect(result.status).toBe('completed');
  });

  it('throws for non-existent phase', async () => {
    await writeTodo();
    await expect(showPhase('nonexistent')).rejects.toThrow('not found');
  });
});

describe('setPhase', () => {
  it('sets current phase', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'polish' });
    expect(result.previousPhase).toBe('core');
    expect(result.currentPhase).toBe('polish');
  });

  it('rejects rollback without flag', async () => {
    await writeTodo();
    await expect(setPhase({ slug: 'setup' })).rejects.toThrow('rollback');
  });

  it('allows rollback with flag', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'setup', rollback: true, force: true });
    expect(result.isRollback).toBe(true);
  });

  it('detects phase skip', async () => {
    await writeTodo({ currentPhase: 'setup' });
    const result = await setPhase({ slug: 'polish' });
    expect(result.isSkip).toBe(true);
    expect(result.skippedPhases).toBe(1);
  });

  it('supports dry run', async () => {
    await writeTodo();
    const result = await setPhase({ slug: 'polish', dryRun: true });
    expect(result.dryRun).toBe(true);
    // Verify no actual change
    const check = await showPhase();
    expect(check.slug).toBe('core');
  });
});

describe('startPhase', () => {
  it('starts a pending phase', async () => {
    await writeTodo();
    const result = await startPhase('polish');
    expect(result.phase).toBe('polish');
    expect(result.startedAt).toBeDefined();
  });

  it('rejects starting non-pending phase', async () => {
    await writeTodo();
    await expect(startPhase('core')).rejects.toThrow('pending');
  });
});

describe('completePhase', () => {
  it('completes active phase with no incomplete tasks', async () => {
    // Make core have all done tasks
    await writeFile(
      join(cleoDir, 'tasks.json'),
      JSON.stringify({
        ...makeTodoFile(),
        tasks: [
          { id: 'T001', title: 'Task 1', status: 'done', priority: 'medium', phase: 'core', createdAt: '2026-01-01T00:00:00Z' },
        ],
      }),
    );
    const result = await completePhase('core');
    expect(result.phase).toBe('core');
  });

  it('rejects completing phase with incomplete tasks', async () => {
    await writeTodo();
    await expect(completePhase('core')).rejects.toThrow('incomplete');
  });
});

describe('renamePhase', () => {
  it('renames phase and updates task references', async () => {
    await writeTodo();
    const result = await renamePhase('core', 'development');
    expect(result.oldName).toBe('core');
    expect(result.newName).toBe('development');
    expect(result.tasksUpdated).toBe(1);
    expect(result.currentPhaseUpdated).toBe(true);
  });

  it('rejects renaming to existing phase', async () => {
    await writeTodo();
    await expect(renamePhase('core', 'polish')).rejects.toThrow('already exists');
  });
});

describe('deletePhase', () => {
  it('deletes empty phase with force', async () => {
    // Add a phase with no tasks
    await writeFile(
      join(cleoDir, 'tasks.json'),
      JSON.stringify({
        ...makeTodoFile(),
        project: {
          ...makeTodoFile().project,
          phases: {
            ...makeTodoFile().project.phases,
            empty: { order: 4, name: 'Empty', status: 'pending' },
          },
        },
      }),
    );
    const result = await deletePhase('empty', { force: true });
    expect(result.deletedPhase).toBe('empty');
  });

  it('rejects deleting current phase', async () => {
    await writeTodo();
    await expect(deletePhase('core', { force: true })).rejects.toThrow('current');
  });

  it('rejects deleting phase with tasks without reassignment', async () => {
    await writeTodo();
    await expect(deletePhase('polish', { force: true })).rejects.toThrow('orphaned');
  });

  it('requires force flag', async () => {
    // Use a phase with no tasks so orphan check doesn't fire first
    await writeFile(
      join(cleoDir, 'tasks.json'),
      JSON.stringify({
        ...makeTodoFile(),
        project: {
          ...makeTodoFile().project,
          phases: {
            ...makeTodoFile().project.phases,
            empty: { order: 4, name: 'Empty', status: 'pending' },
          },
        },
      }),
    );
    await expect(deletePhase('empty')).rejects.toThrow('force');
  });
});
