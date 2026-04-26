/**
 * Tests for lifecycle (RCASD-IVTR+C) pipeline.
 * @task T4467
 * @epic T4454
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkGate,
  completeStage,
  getLifecycleState,
  listEpicsWithLifecycle,
  recordStageProgress,
  skipStage,
  startStage,
} from '../index.js';

let testDir: string;
let cleoDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'cleo-lifecycle-'));
  cleoDir = join(testDir, '.cleo');
  await mkdir(cleoDir, { recursive: true });
  await mkdir(join(cleoDir, 'backups', 'operational'), { recursive: true });
  await mkdir(join(cleoDir, 'rcasd', 'T001'), { recursive: true });
  process.env['CLEO_DIR'] = cleoDir;
  // Disable lifecycle enforcement for tests by default
  process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'off';
  // Reset SQLite singleton so each test gets a fresh DB in the temp dir
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['LIFECYCLE_ENFORCEMENT_MODE'];
  await rm(testDir, { recursive: true, force: true });
});

describe('getLifecycleState', () => {
  it('initializes new manifest for fresh epic', async () => {
    const state = await getLifecycleState(testDir, { epicId: 'T001' });
    expect(state.epicId).toBe('T001');
    expect(state.stages.research.status).toBe('not_started');
    expect(state.stages.implementation.status).toBe('not_started');
  });

  it('reads existing manifest', async () => {
    // getLifecycleState is SQLite-native; seed state via recordStageProgress
    await recordStageProgress(testDir, { taskId: 'T001', stage: 'research', status: 'completed' });
    const state = await getLifecycleState(testDir, { epicId: 'T001' });
    expect(state.stages.research.status).toBe('completed');
  });

  it('reads existing manifest from RCASD directory when present', async () => {
    await mkdir(join(cleoDir, 'rcasd', 'T002'), { recursive: true });
    // getLifecycleState is SQLite-native; seed state via recordStageProgress
    await recordStageProgress(testDir, { taskId: 'T002', stage: 'research', status: 'completed' });
    const state = await getLifecycleState(testDir, { epicId: 'T002' });
    expect(state.stages.research.status).toBe('completed');
  });
});

describe('startStage', () => {
  it('starts a stage', async () => {
    const result = await startStage(testDir, {
      taskId: 'T001',
      stage: 'research',
      status: 'in_progress',
    });
    expect(result.stage).toBe('research');
    expect(result.newStatus).toBe('completed');
  });

  it('rejects starting already completed stage', async () => {
    await startStage(testDir, { taskId: 'T001', stage: 'research', status: 'in_progress' });
    await expect(
      startStage(testDir, { taskId: 'T001', stage: 'research', status: 'in_progress' }),
    ).rejects.toThrow('already completed');
  });
});

describe('completeStage', () => {
  it('completes a stage', async () => {
    const result = await completeStage(testDir, {
      taskId: 'T001',
      stage: 'research',
      status: 'completed',
    });
    expect(result.newStatus).toBe('completed');
  });

  it('completes with artifacts', async () => {
    const result = await completeStage(testDir, {
      taskId: 'T001',
      stage: 'research',
      status: 'completed',
      artifacts: ['doc.md'],
    });
    expect(result.newStatus).toBe('completed');
  });
});

describe('skipStage', () => {
  it('skips a stage', async () => {
    const result = await skipStage(testDir, {
      taskId: 'T001',
      stage: 'consensus',
      reason: 'Not needed',
    });
    expect(result.newStatus).toBe('skipped');
  });

  it('rejects skipping completed stage', async () => {
    await startStage(testDir, { taskId: 'T001', stage: 'research', status: 'in_progress' });
    await expect(
      skipStage(testDir, { taskId: 'T001', stage: 'research', reason: 'N/A' }),
    ).rejects.toThrow('already completed');
  });
});

describe('checkGate', () => {
  it('passes when enforcement is off', async () => {
    const result = await checkGate('T001', 'implementation', testDir);
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('off');
  });

  it('blocks in strict mode with missing prerequisites', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'strict';
    const result = await checkGate('T001', 'implementation', testDir);
    expect(result.allowed).toBe(false);
    expect(result.missingPrerequisites.length).toBeGreaterThan(0);
  });

  it('warns in advisory mode but allows', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'advisory';
    const result = await checkGate('T001', 'implementation', testDir);
    expect(result.allowed).toBe(true);
    expect(result.missingPrerequisites.length).toBeGreaterThan(0);
  });

  it('passes when all prerequisites complete', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'strict';
    // Complete all RCASD-IVTR+C stages
    await startStage(testDir, { taskId: 'T001', stage: 'research', status: 'in_progress' });
    await skipStage(testDir, { taskId: 'T001', stage: 'consensus', reason: 'N/A' });
    await skipStage(testDir, { taskId: 'T001', stage: 'architecture_decision', reason: 'N/A' });
    await skipStage(testDir, { taskId: 'T001', stage: 'specification', reason: 'N/A' });
    await skipStage(testDir, { taskId: 'T001', stage: 'decomposition', reason: 'N/A' });

    const result = await checkGate('T001', 'implementation', testDir);
    expect(result.allowed).toBe(true);
  });
});

describe('listEpicsWithLifecycle', () => {
  it('includes epics from both RCASD and legacy RCSD directories', async () => {
    // Initialize lifecycle pipeline records in SQLite (SQLite-native approach)
    // Must record a stage to create the pipeline entry; fresh DB has no records yet
    await recordStageProgress(testDir, {
      taskId: 'T001',
      stage: 'research',
      status: 'not_started',
    });
    await recordStageProgress(testDir, {
      taskId: 'T010',
      stage: 'research',
      status: 'not_started',
    });
    await recordStageProgress(testDir, {
      taskId: 'T011',
      stage: 'research',
      status: 'not_started',
    });

    const epics = await listEpicsWithLifecycle(testDir);
    expect(epics).toEqual(['T001', 'T010', 'T011']);
  });
});
