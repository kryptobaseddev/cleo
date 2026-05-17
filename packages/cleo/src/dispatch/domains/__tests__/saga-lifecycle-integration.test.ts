/**
 * End-to-end saga lifecycle integration test (T9522 / ADR-073).
 *
 * Exercises the full 8-step saga lifecycle against a real tasks.db in a
 * temporary project directory. No mocks — all 5 saga ops run through the
 * real TasksHandler dispatch pipeline.
 *
 * Steps asserted:
 *   1. saga.create  → success, id captured, label='saga', type='epic'
 *   2. tasks.add    → eid1 (epic A)
 *   3. tasks.add    → eid2 (epic B)
 *   4. saga.add     → link eid1 into saga (task_relations type='groups')
 *   5. saga.add     → link eid2 into saga
 *   6. saga.members → returns [{epicId: eid1}, {epicId: eid2}] (sorted)
 *   7. saga.rollup  → {total:2, done:0, active:0, blocked:0, pending:2, completionPct:0}
 *   8. mark eid1 done via taskUpdate (status-only, lifecycle mode=off in Vitest)
 *      then saga.rollup → {total:2, done:1, pending:1, completionPct:50}
 *
 * @task T9522
 * @see ADR-073 — Above-Epic Naming (Saga, prefix SG-)
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TasksHandler } from '../tasks.js';

// ---------------------------------------------------------------------------
// Types for dispatch data shapes (saga ops)
// ---------------------------------------------------------------------------

interface SagaCreateData {
  task: { id: string; labels?: string[]; type?: string };
  duplicate: boolean;
}

interface SagaAddData {
  sagaId: string;
  epicId: string;
  added: boolean;
}

interface SagaMember {
  epicId: string;
  type: string;
  reason?: string;
}

interface SagaMembersData {
  sagaId: string;
  members: SagaMember[];
  total: number;
}

interface SagaRollupData {
  sagaId: string;
  total: number;
  done: number;
  active: number;
  blocked: number;
  pending: number;
  completionPct: number;
}

interface TaskAddData {
  task: { id: string; type?: string; title?: string };
  duplicate: boolean;
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let tempDir: string;

describe('T9522: saga lifecycle end-to-end integration', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-saga-lifecycle-'));
    const cleoDir = join(tempDir, '.cleo');
    await mkdir(cleoDir, { recursive: true });

    // Write a minimal config that disables all enforcement so tests can
    // create tasks without acceptance-criteria boilerplate. The saga
    // lifecycle assertions are the focus — enforcement is tested elsewhere.
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        lifecycle: { mode: 'off' },
        enforcement: {
          acceptance: { mode: 'off' },
          session: { requiredForMutate: false },
        },
      }),
      'utf-8',
    );

    process.env['CLEO_DIR'] = cleoDir;
  });

  afterEach(async () => {
    const { closeDb, closeAllDatabases } = await import('@cleocode/core/internal');
    try {
      closeDb();
    } catch {
      // ignore close errors
    }
    try {
      await closeAllDatabases();
    } catch {
      // ignore close errors
    }
    delete process.env['CLEO_DIR'];
    // Use Promise.race with a generous timeout to avoid blocking if fs cleanup
    // is slow on Node 24 (SQLite WAL sidecars may need a moment to release).
    await Promise.race([
      rm(tempDir, { recursive: true, force: true }).catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ]);
  });

  // -------------------------------------------------------------------------
  // Main lifecycle flow (steps 1–8 in a single ordered test)
  // -------------------------------------------------------------------------

  it('full 8-step saga lifecycle: create → add × 2 → members → rollup → mark done → re-rollup', async () => {
    const handler = new TasksHandler();

    // -----------------------------------------------------------------------
    // Step 1: saga.create — creates an Epic with label='saga'
    // -----------------------------------------------------------------------
    const createResp = await handler.mutate('saga.create', {
      title: 'Test Saga',
    });

    expect(createResp.success, 'saga.create must succeed').toBe(true);
    expect(createResp.error).toBeUndefined();

    const createData = createResp.data as SagaCreateData;
    const sid = createData.task.id;
    expect(sid).toBeTruthy();
    expect(sid).toMatch(/^T\d+$/);
    expect(createData.task.labels).toContain('saga');
    expect(createData.task.type).toBe('epic');

    // -----------------------------------------------------------------------
    // Step 2: tasks.add — create Member Epic A
    // -----------------------------------------------------------------------
    const addA = await handler.mutate('add', {
      title: 'Member Epic A',
      type: 'epic',
    });

    expect(addA.success, 'add epic A must succeed').toBe(true);
    const addDataA = addA.data as TaskAddData;
    const eid1 = addDataA.task.id;
    expect(eid1).toBeTruthy();
    expect(eid1).toMatch(/^T\d+$/);

    // -----------------------------------------------------------------------
    // Step 3: tasks.add — create Member Epic B
    // -----------------------------------------------------------------------
    const addB = await handler.mutate('add', {
      title: 'Member Epic B',
      type: 'epic',
    });

    expect(addB.success, 'add epic B must succeed').toBe(true);
    const addDataB = addB.data as TaskAddData;
    const eid2 = addDataB.task.id;
    expect(eid2).toBeTruthy();
    expect(eid2).toMatch(/^T\d+$/);
    expect(eid2).not.toBe(eid1);

    // -----------------------------------------------------------------------
    // Step 4: saga.add — link eid1 → saga
    // -----------------------------------------------------------------------
    const linkA = await handler.mutate('saga.add', {
      sagaId: sid,
      epicId: eid1,
    });

    expect(linkA.success, 'saga.add eid1 must succeed').toBe(true);
    expect(linkA.error).toBeUndefined();
    const linkDataA = linkA.data as SagaAddData;
    expect(linkDataA.sagaId).toBe(sid);
    expect(linkDataA.epicId).toBe(eid1);
    expect(linkDataA.added).toBe(true);

    // -----------------------------------------------------------------------
    // Step 5: saga.add — link eid2 → saga
    // -----------------------------------------------------------------------
    const linkB = await handler.mutate('saga.add', {
      sagaId: sid,
      epicId: eid2,
    });

    expect(linkB.success, 'saga.add eid2 must succeed').toBe(true);
    const linkDataB = linkB.data as SagaAddData;
    expect(linkDataB.sagaId).toBe(sid);
    expect(linkDataB.epicId).toBe(eid2);

    // -----------------------------------------------------------------------
    // Step 6: saga.members — returns both epics (order-agnostic)
    // -----------------------------------------------------------------------
    const membersResp = await handler.query('saga.members', { sagaId: sid });

    expect(membersResp.success, 'saga.members must succeed').toBe(true);
    const membersData = membersResp.data as SagaMembersData;
    expect(membersData.sagaId).toBe(sid);
    expect(membersData.total).toBe(2);

    const memberIds = membersData.members.map((m) => m.epicId).sort();
    expect(memberIds).toEqual([eid1, eid2].sort());

    for (const member of membersData.members) {
      expect(member.type).toBe('groups');
    }

    // -----------------------------------------------------------------------
    // Step 7: saga.rollup — baseline: 2 pending, 0 done
    // -----------------------------------------------------------------------
    const rollup1 = await handler.query('saga.rollup', { sagaId: sid });

    expect(rollup1.success, 'saga.rollup (baseline) must succeed').toBe(true);
    const rollupData1 = rollup1.data as SagaRollupData;
    expect(rollupData1.sagaId).toBe(sid);
    expect(rollupData1.total).toBe(2);
    expect(rollupData1.done).toBe(0);
    expect(rollupData1.active).toBe(0);
    expect(rollupData1.blocked).toBe(0);
    expect(rollupData1.pending).toBe(2);
    expect(rollupData1.completionPct).toBe(0);

    // -----------------------------------------------------------------------
    // Step 8a: mark eid1 done via taskUpdate (status-only path)
    //
    // In Vitest, lifecycle.mode defaults to 'off' (process.env.VITEST is set),
    // so taskUpdate with status='done' alone routes directly through completeTask
    // without acceptance or verification gate enforcement.
    // -----------------------------------------------------------------------
    const { taskUpdate } = await import('@cleocode/core/internal');
    const updateResult = await taskUpdate(tempDir, eid1, { status: 'done' });

    expect(updateResult.success, 'taskUpdate status=done must succeed').toBe(true);
    expect(updateResult.data?.task.status).toBe('done');

    // -----------------------------------------------------------------------
    // Step 8b: re-run rollup — 1 done, 1 pending, 50% completion
    // -----------------------------------------------------------------------
    const rollup2 = await handler.query('saga.rollup', { sagaId: sid });

    expect(rollup2.success, 'saga.rollup (post-done) must succeed').toBe(true);
    const rollupData2 = rollup2.data as SagaRollupData;
    expect(rollupData2.total).toBe(2);
    expect(rollupData2.done).toBe(1);
    expect(rollupData2.pending).toBe(1);
    expect(rollupData2.completionPct).toBe(50);
  });

  // -------------------------------------------------------------------------
  // Error path: saga.add rejects non-saga IDs
  // -------------------------------------------------------------------------

  it('saga.add rejects an epicId whose type is not epic', async () => {
    const handler = new TasksHandler();

    // Create a saga
    const sagaResp = await handler.mutate('saga.create', { title: 'Error Test Saga' });
    expect(sagaResp.success).toBe(true);
    const { task: sagaTask } = sagaResp.data as SagaCreateData;

    // Create a plain task (type defaults to 'task')
    const plainResp = await handler.mutate('add', { title: 'Plain Task (not epic)' });
    expect(plainResp.success).toBe(true);
    const { task: plainTask } = plainResp.data as TaskAddData;

    // saga.add should reject
    const linkResp = await handler.mutate('saga.add', {
      sagaId: sagaTask.id,
      epicId: plainTask.id,
    });

    expect(linkResp.success).toBe(false);
    expect(linkResp.error?.code).toMatch(/^E_/);
  });

  // -------------------------------------------------------------------------
  // saga.members returns empty list when no members linked
  // -------------------------------------------------------------------------

  it('saga.members returns total=0 for a newly created saga', async () => {
    const handler = new TasksHandler();

    const sagaResp = await handler.mutate('saga.create', { title: 'Empty Saga' });
    expect(sagaResp.success).toBe(true);
    const { task } = sagaResp.data as SagaCreateData;

    const membersResp = await handler.query('saga.members', { sagaId: task.id });
    expect(membersResp.success).toBe(true);
    const data = membersResp.data as SagaMembersData;
    expect(data.total).toBe(0);
    expect(data.members).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // saga.rollup returns 0-count data for empty saga
  // -------------------------------------------------------------------------

  it('saga.rollup returns {total:0, completionPct:0} for empty saga', async () => {
    const handler = new TasksHandler();

    const sagaResp = await handler.mutate('saga.create', { title: 'Rollup Empty Saga' });
    expect(sagaResp.success).toBe(true);
    const { task } = sagaResp.data as SagaCreateData;

    const rollupResp = await handler.query('saga.rollup', { sagaId: task.id });
    expect(rollupResp.success).toBe(true);
    const data = rollupResp.data as SagaRollupData;
    expect(data.total).toBe(0);
    expect(data.done).toBe(0);
    expect(data.completionPct).toBe(0);
  });
});
