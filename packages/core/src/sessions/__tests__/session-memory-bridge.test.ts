/**
 * Tests for session-memory-bridge — T1615.
 *
 * Verifies that bridgeSessionToMemory auto-creates a 'session-summary'
 * BRAIN observation and links it to tasks via brain_task_observations.
 *
 * @task T1615
 * @epic T1611
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bridgeSessionToMemory } from '../session-memory-bridge.js';

describe('bridgeSessionToMemory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-bridge-test-'));
    await mkdir(join(tempDir, '.cleo'), { recursive: true });
    await mkdir(join(tempDir, '.cleo', 'backups', 'operational'), { recursive: true });
  });

  afterEach(async () => {
    try {
      const { closeAllDatabases } = await import('../../store/sqlite.js');
      await closeAllDatabases();
    } catch {
      /* module may not be loaded */
    }
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* module may not be loaded */
    }
    await Promise.race([
      rm(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  it('creates a session-summary observation and returns an observationId', async () => {
    const result = await bridgeSessionToMemory(tempDir, {
      sessionId: 'ses_test_001',
      scope: 'global',
      tasksCompleted: ['T100', 'T101'],
      duration: 3600,
    });

    expect(result.observationId).not.toBeNull();
    expect(result.observationId).toMatch(/^O-ses-/);
  });

  it('links completed tasks in brain_task_observations', async () => {
    const result = await bridgeSessionToMemory(tempDir, {
      sessionId: 'ses_test_002',
      scope: 'global',
      tasksCompleted: ['T200', 'T201'],
      tasksCreated: [],
      duration: 1800,
    });

    expect(result.observationId).not.toBeNull();
    expect(result.taskLinksCreated).toBe(2);
  });

  it('links both completed and created tasks, deduplicating overlaps', async () => {
    const result = await bridgeSessionToMemory(tempDir, {
      sessionId: 'ses_test_003',
      scope: 'epic:T300',
      // T301 appears in both — should only be linked once (Set dedup)
      tasksCompleted: ['T301', 'T302'],
      tasksCreated: ['T301', 'T303'],
      duration: 900,
    });

    expect(result.observationId).not.toBeNull();
    // T301, T302, T303 = 3 unique task IDs
    expect(result.taskLinksCreated).toBe(3);
  });

  it('creates observation with correct type and metadata in brain.db', async () => {
    const result = await bridgeSessionToMemory(tempDir, {
      sessionId: 'ses_test_004',
      scope: 'global',
      tasksCompleted: ['T400'],
      duration: 600,
      note: 'Good session',
    });

    expect(result.observationId).not.toBeNull();

    // Verify the observation was written with correct type
    const { getBrainAccessor } = await import('../../store/memory-accessor.js');
    const accessor = await getBrainAccessor(tempDir);
    const obs = await accessor.getObservation(result.observationId!);

    expect(obs).not.toBeNull();
    expect(obs!.type).toBe('session-summary');
    expect(obs!.sourceType).toBe('session-debrief');
    expect(obs!.sourceSessionId).toBe('ses_test_004');
    expect(obs!.narrative).toContain('T400');
    expect(obs!.narrative).toContain('Good session');
  });

  it('returns zero taskLinksCreated when no tasks in session', async () => {
    const result = await bridgeSessionToMemory(tempDir, {
      sessionId: 'ses_test_005',
      scope: 'global',
      tasksCompleted: [],
      tasksCreated: [],
      duration: 60,
    });

    expect(result.observationId).not.toBeNull();
    expect(result.taskLinksCreated).toBe(0);
  });

  it('resolves without throwing for a normal session', async () => {
    // Backward-compat: must not throw even with minimal data
    await expect(
      bridgeSessionToMemory(tempDir, {
        sessionId: 'ses_test_006',
        scope: 'epic:T5417',
        tasksCompleted: ['T5464', 'T5466'],
        duration: 125,
      }),
    ).resolves.toBeDefined();
  });

  it('resolves without throwing for empty task completion list', async () => {
    await expect(
      bridgeSessionToMemory(tempDir, {
        sessionId: 'ses_test_007',
        scope: 'global',
        tasksCompleted: [],
        duration: 59,
      }),
    ).resolves.toBeDefined();
  });
});
