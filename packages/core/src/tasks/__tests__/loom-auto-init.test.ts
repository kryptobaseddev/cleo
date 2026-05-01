/**
 * Tests for LOOM auto-init on epic creation (T1634).
 *
 * Verifies:
 * (a) `cleo add --type epic` auto-initializes LOOM (lifecycle pipeline exists after add)
 * (b) `initLoomForEpic` is idempotent — re-running on an already-initialized epic is a no-op
 * (c) `backfillEpicLoom` populates LOOM for existing un-LOOMed epics
 *
 * @task T1634
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLifecycleStatus } from '../../lifecycle/index.js';
import { initLoomForEpic } from '../../orchestrate/lifecycle-ops.js';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import { backfillEpicLoom } from '../backfill-epic-loom.js';

describe('LOOM auto-init on epic creation (T1634)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  // (a) Epic creation auto-initializes LOOM
  it('auto-initializes LOOM pipeline when an epic is created via addTask', async () => {
    // LOOM init is fire-and-forget inside addTask, so we await the task creation
    // and then check lifecycle status.
    const result = await addTask(
      {
        title: 'My Test Epic',
        description: 'Epic created to verify LOOM auto-init',
        type: 'epic',
      },
      env.tempDir,
      accessor,
    );
    const epicId = result.task.id;
    expect(epicId).toBe('T001');

    // Fire-and-forget microtasks need to flush before we read the DB.
    // Yield to allow the promise chain to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Allow an additional macrotask tick for the dynamic import + async chain.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    const status = await getLifecycleStatus(env.tempDir, { epicId });
    expect(status.initialized).toBe(true);
    // The lifecycle pipeline is initialized (research/in_progress).
    // currentStage tracks the *last completed or skipped* stage; since research
    // is in_progress (not completed), currentStage is null and nextStage is 'research'.
    expect(status.nextStage).toBe('research');
  });

  // (b) Idempotent — re-running initLoomForEpic on already-initialized epic is a no-op
  it('initLoomForEpic is idempotent — second call skips re-init', async () => {
    const result = await addTask(
      {
        title: 'Idempotent Epic',
        description: 'Testing idempotency of LOOM init',
        type: 'epic',
      },
      env.tempDir,
      accessor,
    );
    const epicId = result.task.id;
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Allow macrotask tick for dynamic import chain to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    // First explicit call after auto-init
    const first = await initLoomForEpic(epicId, env.tempDir);
    // Already initialized by the fire-and-forget hook in addTask
    expect(first.alreadyInitialized).toBe(true);
    expect(first.initialized).toBe(false);
    expect(first.error).toBeUndefined();

    // Second explicit call — still idempotent
    const second = await initLoomForEpic(epicId, env.tempDir);
    expect(second.alreadyInitialized).toBe(true);
    expect(second.initialized).toBe(false);

    // Status must still show exactly one initialization
    const status = await getLifecycleStatus(env.tempDir, { epicId });
    expect(status.initialized).toBe(true);
    // research stage is in_progress → nextStage is 'research'
    expect(status.nextStage).toBe('research');
  });

  // initLoomForEpic returns initialized:true on fresh epic
  it('initLoomForEpic returns initialized:true when called on un-LOOMed epic', async () => {
    // Insert a bare epic via addTask but let the fire-and-forget run first,
    // then call initLoomForEpic explicitly to confirm it returns true only once.
    //
    // We need an epic that has NOT been auto-LOOMed yet — use a direct DB insert
    // by calling addTask and immediately calling initLoomForEpic before the
    // microtask queue settles. However, this is inherently racy.
    //
    // Instead: insert a "fake" second epic ID directly so initLoomForEpic
    // is the FIRST to initialize it.
    const { getDb } = await import('../../store/sqlite.js');
    const db = await getDb(env.tempDir);
    const { tasks: tasksTable } = await import('../../store/tasks-schema.js');
    const now = new Date().toISOString();
    await db
      .insert(tasksTable)
      .values({
        id: 'T999',
        title: 'Bare Epic',
        description: 'Inserted without auto-init',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        position: 99,
        positionVersion: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const result = await initLoomForEpic('T999', env.tempDir);
    expect(result.initialized).toBe(true);
    expect(result.alreadyInitialized).toBe(false);
    expect(result.error).toBeUndefined();

    const status = await getLifecycleStatus(env.tempDir, { epicId: 'T999' });
    expect(status.initialized).toBe(true);
  });

  // Non-epic types should not have LOOM initialized
  it('does not initialize LOOM for non-epic tasks', async () => {
    // First create an epic parent (required in lifecycle strict mode — but config is 'off')
    const epicResult = await addTask(
      { title: 'Parent Epic', description: 'Parent epic for hierarchy', type: 'epic' },
      env.tempDir,
      accessor,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const taskResult = await addTask(
      {
        title: 'Child Task',
        description: 'Regular task — no LOOM expected',
        type: 'task',
        parentId: epicResult.task.id,
      },
      env.tempDir,
      accessor,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    const status = await getLifecycleStatus(env.tempDir, { epicId: taskResult.task.id });
    // Tasks (non-epic) should NOT have a lifecycle pipeline
    expect(status.initialized).toBe(false);
  });
});

describe('backfillEpicLoom (T1634)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
    resetDbState();
  });

  it('populates LOOM for existing un-LOOMed epics', async () => {
    // Insert two bare epics directly into the DB (bypassing addTask auto-init hook).
    const { getDb } = await import('../../store/sqlite.js');
    const db = await getDb(env.tempDir);
    const { tasks: tasksTable } = await import('../../store/tasks-schema.js');
    const now = new Date().toISOString();
    for (const id of ['T100', 'T101']) {
      await db
        .insert(tasksTable)
        .values({
          id,
          title: `Bare Epic ${id}`,
          description: 'Inserted without auto-init',
          type: 'epic',
          status: 'pending',
          priority: 'medium',
          pipelineStage: 'research',
          position: Number(id.slice(1)),
          positionVersion: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const backfillResult = await backfillEpicLoom(env.tempDir);

    expect(backfillResult.total).toBe(2);
    expect(backfillResult.initialized).toBe(2);
    expect(backfillResult.skipped).toBe(0);
    expect(backfillResult.errors).toBe(0);

    for (const id of ['T100', 'T101']) {
      const status = await getLifecycleStatus(env.tempDir, { epicId: id });
      expect(status.initialized).toBe(true);
    }
  });

  it('backfillEpicLoom skips already-initialized epics (idempotent)', async () => {
    // Create one epic via addTask (which auto-inits LOOM)
    const result = await addTask(
      {
        title: 'Already LOOMed',
        description: 'Epic that already has LOOM from addTask hook',
        type: 'epic',
      },
      env.tempDir,
      accessor,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Verify LOOM is already initialized
    const priorStatus = await getLifecycleStatus(env.tempDir, { epicId: result.task.id });
    expect(priorStatus.initialized).toBe(true);

    // Run backfill — should skip this epic
    const backfillResult = await backfillEpicLoom(env.tempDir);
    expect(backfillResult.total).toBe(1);
    expect(backfillResult.skipped).toBe(1);
    expect(backfillResult.initialized).toBe(0);
    expect(backfillResult.errors).toBe(0);
  });

  it('backfillEpicLoom skips done/cancelled epics', async () => {
    // Insert a done epic and a cancelled epic directly
    const { getDb } = await import('../../store/sqlite.js');
    const db = await getDb(env.tempDir);
    const { tasks: tasksTable } = await import('../../store/tasks-schema.js');
    const now = new Date().toISOString();
    // T877 invariant: status=done requires pipeline_stage=contribution;
    //                 status=cancelled requires pipeline_stage=cancelled.
    const terminalFixtures = [
      { id: 'T200', status: 'done' as const, pipelineStage: 'contribution' as const },
      { id: 'T201', status: 'cancelled' as const, pipelineStage: 'cancelled' as const },
    ];
    for (const { id, status, pipelineStage } of terminalFixtures) {
      await db
        .insert(tasksTable)
        .values({
          id,
          title: `Terminal Epic ${id}`,
          description: 'Terminal epic — should be excluded from backfill',
          type: 'epic',
          status,
          priority: 'medium',
          pipelineStage,
          position: Number(id.slice(1)),
          positionVersion: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const backfillResult = await backfillEpicLoom(env.tempDir);
    // No active epics — done/cancelled are excluded
    expect(backfillResult.total).toBe(0);
    expect(backfillResult.initialized).toBe(0);
  });
});
