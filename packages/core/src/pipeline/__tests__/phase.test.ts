/**
 * Tests for core/pipeline/phase.ts — thin dispatch-facing wrappers.
 *
 * Verifies that `listPhases` and `showPhase` correctly delegate to
 * `core/phases/` and wrap results in the `{success, data?, error?}` envelope.
 *
 * @task T1522
 * @epic T5701
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { listPhases, showPhase } from '../phase.js';

let env: TestDbEnv;
let accessor: DataAccessor;

const defaultProjectMeta = {
  name: 'Test',
  currentPhase: 'core',
  phases: {
    setup: {
      order: 1,
      name: 'Setup',
      status: 'completed',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-02T00:00:00Z',
    },
    core: { order: 2, name: 'Core', status: 'active', startedAt: '2026-01-02T00:00:00Z' },
    polish: { order: 3, name: 'Polish', status: 'pending' },
  },
  phaseHistory: [],
  releases: [],
};

const defaultTasks: Array<Partial<Task> & { id: string }> = [
  {
    id: 'T001',
    title: 'Task 1',
    status: 'done',
    priority: 'medium',
    phase: 'setup',
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'T002',
    title: 'Task 2',
    status: 'active',
    priority: 'high',
    phase: 'core',
    createdAt: '2026-01-01T00:00:00Z',
  },
];

beforeEach(async () => {
  env = await createTestDb();
  accessor = env.accessor;
});

afterEach(async () => {
  await env.cleanup();
});

async function seedPhaseData(
  overrides: Record<string, unknown> = {},
  tasks?: Array<Partial<Task> & { id: string }>,
) {
  await seedTasks(accessor, tasks ?? defaultTasks);
  await accessor.setMetaValue('project_meta', { ...defaultProjectMeta, ...overrides });
}

describe('listPhases (pipeline wrapper)', () => {
  it('returns success:true with phase data on happy path', async () => {
    await seedPhaseData();
    const result = await listPhases(env.tempDir, accessor);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it('returns all phases in order', async () => {
    await seedPhaseData();
    const result = await listPhases(env.tempDir, accessor);
    expect(result.data!.phases).toHaveLength(3);
    expect(result.data!.phases[0]!.slug).toBe('setup');
    expect(result.data!.phases[1]!.slug).toBe('core');
    expect(result.data!.phases[2]!.slug).toBe('polish');
  });

  it('exposes currentPhase in data', async () => {
    await seedPhaseData();
    const result = await listPhases(env.tempDir, accessor);
    expect(result.data!.currentPhase).toBe('core');
  });

  it('returns success:false with error envelope when project root has no DB', async () => {
    const result = await listPhases('/tmp/cleo-nonexistent-path-xyz-12345');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('E_PHASE_LIST_FAILED');
    expect(typeof result.error!.message).toBe('string');
    expect(result.data).toBeUndefined();
  });
});

describe('showPhase (pipeline wrapper)', () => {
  it('returns success:true with current phase data when no phaseId given', async () => {
    await seedPhaseData();
    const result = await showPhase(env.tempDir, undefined, accessor);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.error).toBeUndefined();
    expect(result.data!.slug).toBe('core');
  });

  it('returns specific phase when phaseId is provided', async () => {
    await seedPhaseData();
    const result = await showPhase(env.tempDir, 'setup', accessor);
    expect(result.success).toBe(true);
    expect(result.data!.slug).toBe('setup');
    expect(result.data!.status).toBe('completed');
  });

  it('returns success:false with error envelope for unknown phaseId', async () => {
    await seedPhaseData();
    const result = await showPhase(env.tempDir, 'nonexistent-phase', accessor);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('E_PHASE_SHOW_FAILED');
    expect(result.data).toBeUndefined();
  });

  it('returns success:false with error envelope when project root has no DB', async () => {
    const result = await showPhase('/tmp/cleo-nonexistent-path-xyz-12345');
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('E_PHASE_SHOW_FAILED');
    expect(result.data).toBeUndefined();
  });
});
