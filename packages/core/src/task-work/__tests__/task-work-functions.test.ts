/**
 * Tests for currentTask, stopTask, and getWorkHistory.
 *
 * Covers happy paths and edge cases per T1521 audit follow-up.
 * @task T1542
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { currentTask, getWorkHistory, startTask, stopTask } from '../index.js';

// ---------------------------------------------------------------------------
// currentTask
// ---------------------------------------------------------------------------

describe('currentTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns null fields when no task is active', async () => {
    await seedTasks(accessor, []);
    const result = await currentTask(env.tempDir, accessor);

    expect(result.currentTask).toBeNull();
    expect(result.currentPhase).toBeNull();
    expect(result.sessionNote).toBeNull();
    expect(result.nextAction).toBeNull();
  });

  it('returns the active task ID after starting work', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'My active task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    const result = await currentTask(env.tempDir, accessor);

    expect(result.currentTask).toBe('T001');
  });

  it('returns the task phase when task has a phase', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Phased task',
        status: 'pending',
        priority: 'medium',
        phase: 'implementation',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    const result = await currentTask(env.tempDir, accessor);

    expect(result.currentTask).toBe('T001');
    expect(result.currentPhase).toBe('implementation');
  });

  it('returns null currentTask after stopping work', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Stoppable task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await stopTask(env.tempDir, accessor);

    const result = await currentTask(env.tempDir, accessor);
    expect(result.currentTask).toBeNull();
  });

  it('reflects task switch when a second task is started', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'First task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Second task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await startTask('T002', env.tempDir, accessor);

    const result = await currentTask(env.tempDir, accessor);
    expect(result.currentTask).toBe('T002');
  });
});

// ---------------------------------------------------------------------------
// stopTask
// ---------------------------------------------------------------------------

describe('stopTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns null previousTask when no task is active', async () => {
    await seedTasks(accessor, []);
    const result = await stopTask(env.tempDir, accessor);

    expect(result.previousTask).toBeNull();
  });

  it('returns the cleared task ID when an active task is stopped', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task to stop',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    const result = await stopTask(env.tempDir, accessor);

    expect(result.previousTask).toBe('T001');
  });

  it('clears the active task after stopping', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task to stop',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await stopTask(env.tempDir, accessor);

    const state = await currentTask(env.tempDir, accessor);
    expect(state.currentTask).toBeNull();
  });

  it('is idempotent when called twice in a row', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task to stop twice',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await stopTask(env.tempDir, accessor);

    // Second stop should not throw and should return null previousTask
    const result = await stopTask(env.tempDir, accessor);
    expect(result.previousTask).toBeNull();
  });

  it('calling stop with no prior session is a no-op', async () => {
    await seedTasks(accessor, []);

    // Should not throw even with no focus_state
    await expect(stopTask(env.tempDir, accessor)).resolves.toEqual({
      previousTask: null,
    });
  });
});

// ---------------------------------------------------------------------------
// getWorkHistory
// ---------------------------------------------------------------------------

describe('getWorkHistory', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns an empty array when no work has been started', async () => {
    await seedTasks(accessor, []);
    const history = await getWorkHistory(env.tempDir, accessor);

    expect(history).toEqual([]);
  });

  it('records a single started task in history', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'History task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    const history = await getWorkHistory(env.tempDir, accessor);

    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe('T001');
    expect(history[0]?.timestamp).toBeDefined();
  });

  it('records multiple started tasks in reverse chronological order', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'First',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Second',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Third',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await startTask('T002', env.tempDir, accessor);
    await startTask('T003', env.tempDir, accessor);

    const history = await getWorkHistory(env.tempDir, accessor);

    // Most recent first
    expect(history).toHaveLength(3);
    expect(history[0]?.taskId).toBe('T003');
    expect(history[1]?.taskId).toBe('T002');
    expect(history[2]?.taskId).toBe('T001');
  });

  it('each history entry has a taskId and a timestamp string', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Timestamped task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const before = new Date().toISOString();
    await startTask('T001', env.tempDir, accessor);
    const after = new Date().toISOString();

    const history = await getWorkHistory(env.tempDir, accessor);
    expect(history).toHaveLength(1);

    const entry = history[0]!;
    expect(entry.taskId).toBe('T001');
    // Verify timestamp is an ISO string within the test window
    expect(entry.timestamp >= before).toBe(true);
    expect(entry.timestamp <= after).toBe(true);
  });

  it('does not add extra history entries when stopTask is called', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Start then stop',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await stopTask(env.tempDir, accessor);

    const history = await getWorkHistory(env.tempDir, accessor);
    // Only the start event is tracked via session notes
    expect(history).toHaveLength(1);
    expect(history[0]?.taskId).toBe('T001');
  });

  it('accumulates history across multiple start cycles on the same task', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Repeat task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await startTask('T001', env.tempDir, accessor);
    await stopTask(env.tempDir, accessor);
    await startTask('T001', env.tempDir, accessor);

    const history = await getWorkHistory(env.tempDir, accessor);
    // Both start events are recorded
    expect(history).toHaveLength(2);
    expect(history.every((e) => e.taskId === 'T001')).toBe(true);
  });
});
