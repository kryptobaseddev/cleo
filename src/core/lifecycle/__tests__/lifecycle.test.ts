/**
 * Tests for lifecycle (RCSD) pipeline.
 * @task T4467
 * @epic T4454
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getLifecycleState,
  listEpicsWithLifecycle,
  startStage,
  completeStage,
  skipStage,
  checkGate,
  recordStageProgress,
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
  const { closeDb } = await import('../../../store/sqlite.js');
  closeDb();
});

afterEach(async () => {
  const { closeDb } = await import('../../../store/sqlite.js');
  closeDb();
  delete process.env['CLEO_DIR'];
  delete process.env['LIFECYCLE_ENFORCEMENT_MODE'];
  await rm(testDir, { recursive: true, force: true });
});

describe('getLifecycleState', () => {
  it('initializes new manifest for fresh epic', async () => {
    const state = await getLifecycleState('T001');
    expect(state.epicId).toBe('T001');
    expect(state.stages.research.status).toBe('not_started');
    expect(state.stages.implementation.status).toBe('not_started');
  });

  it('reads existing manifest', async () => {
    // getLifecycleState is SQLite-native; seed state via recordStageProgress
    await recordStageProgress('T001', 'research', 'completed');
    const state = await getLifecycleState('T001');
    expect(state.stages.research.status).toBe('completed');
  });

  it('reads existing manifest from RCASD directory when present', async () => {
    await mkdir(join(cleoDir, 'rcasd', 'T002'), { recursive: true });
    // getLifecycleState is SQLite-native; seed state via recordStageProgress
    await recordStageProgress('T002', 'research', 'completed');
    const state = await getLifecycleState('T002');
    expect(state.stages.research.status).toBe('completed');
  });
});

describe('startStage', () => {
  it('starts a stage', async () => {
    const result = await startStage('T001', 'research');
    expect(result.stage).toBe('research');
    expect(result.newStatus).toBe('completed');
  });

  it('rejects starting already completed stage', async () => {
    await startStage('T001', 'research');
    await expect(startStage('T001', 'research')).rejects.toThrow('already completed');
  });
});

describe('completeStage', () => {
  it('completes a stage', async () => {
    const result = await completeStage('T001', 'research');
    expect(result.newStatus).toBe('completed');
  });

  it('completes with artifacts', async () => {
    const result = await completeStage('T001', 'research', ['doc.md']);
    expect(result.newStatus).toBe('completed');
  });
});

describe('skipStage', () => {
  it('skips a stage', async () => {
    const result = await skipStage('T001', 'consensus', 'Not needed');
    expect(result.newStatus).toBe('skipped');
  });

  it('rejects skipping completed stage', async () => {
    await startStage('T001', 'research');
    await expect(skipStage('T001', 'research', 'N/A')).rejects.toThrow('already completed');
  });
});

describe('checkGate', () => {
  it('passes when enforcement is off', async () => {
    const result = await checkGate('T001', 'implementation');
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe('off');
  });

  it('blocks in strict mode with missing prerequisites', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'strict';
    const result = await checkGate('T001', 'implementation');
    expect(result.allowed).toBe(false);
    expect(result.missingPrerequisites.length).toBeGreaterThan(0);
  });

  it('warns in advisory mode but allows', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'advisory';
    const result = await checkGate('T001', 'implementation');
    expect(result.allowed).toBe(true);
    expect(result.missingPrerequisites.length).toBeGreaterThan(0);
  });

  it('passes when all prerequisites complete', async () => {
    process.env['LIFECYCLE_ENFORCEMENT_MODE'] = 'strict';
    // Complete all RCSD stages
    await startStage('T001', 'research');
    await skipStage('T001', 'consensus', 'N/A');
    await skipStage('T001', 'architecture_decision', 'N/A');
    await skipStage('T001', 'specification', 'N/A');
    await skipStage('T001', 'decomposition', 'N/A');

    const result = await checkGate('T001', 'implementation');
    expect(result.allowed).toBe(true);
  });
});

describe('listEpicsWithLifecycle', () => {
  it('includes epics from both RCASD and RCSD directories', async () => {
    // Initialize lifecycle pipeline records in SQLite (SQLite-native approach)
    // Must record a stage to create the pipeline entry; fresh DB has no records yet
    await recordStageProgress('T001', 'research', 'not_started');
    await recordStageProgress('T010', 'research', 'not_started');
    await recordStageProgress('T011', 'research', 'not_started');

    const epics = await listEpicsWithLifecycle();
    expect(epics).toEqual(['T001', 'T010', 'T011']);
  });
});
