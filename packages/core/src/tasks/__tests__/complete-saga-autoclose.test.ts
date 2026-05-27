/**
 * Regression tests for the T10116 saga auto-close branch inside
 * {@link completeTask}.
 *
 * Validates that when a saga member transitions to `done`, the completion
 * path:
 *
 *   - Auto-closes any saga whose remaining members are all terminal
 *     (`done` or `cancelled`).
 *   - Resolves saga members via `task_relations.type='groups'` rather
 *     than the `parentId` column (ADR-073 §1.2 invariants I3/I5).
 *   - Synthesizes a verification envelope citing the closing event,
 *     the member rollup digest, and ADR-073.
 *   - Stays idempotent — a saga that is already `done` MUST NOT be
 *     re-touched on subsequent completeTask calls.
 *
 * Historical regression fixtures (T9787, T9800, T9831) all manifested
 * the T10090 drift bug — their sagas had every member done but the
 * saga row itself stayed `pending`. T10116 is the root-cause fix.
 *
 * @task T10116 — saga auto-close in completeTask
 * @task T10090 — saga drift bug (root-cause fixed here)
 * @epic T10210 — E-SAGA-AUTO-CLOSE
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @see ADR-073-above-epic-naming.md §1.2
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SAGA_GROUPS_RELATION } from '../../sagas/constants.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';

describe('completeTask — saga auto-close (T10116)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeConfig({
      enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
      },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    });
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it('auto-closes a saga when its last member completes (T9800 fixture)', async () => {
    // Saga TS-T9800 groups three member Epics. Two are already done; the
    // third (TM-E3) is the last pending member. Completing TM-E3 should
    // flip the saga to `done` with synthesized evidence atoms.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-T9800',
        title: 'SG-WORKTREE-CANON',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-E1',
        title: 'Member Epic 1',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-E2',
        title: 'Member Epic 2',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-E3',
        title: 'Last pending member',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-T9800', 'TM-E1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-T9800', 'TM-E2', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-T9800', 'TM-E3', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-E3' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('TS-T9800');

    // Re-load the saga from the DB and assert the on-disk state.
    const saga = await accessor.loadSingleTask('TS-T9800');
    expect(saga?.status).toBe('done');
    expect(saga?.completedAt).toBeDefined();
    expect(saga?.pipelineStage).toBe('contribution');

    // AC4 — synthesized evidence carries the three required atoms.
    const evidence = saga?.verification?.evidence?.implemented;
    expect(evidence?.atoms).toBeDefined();
    const atomNotes = (evidence?.atoms ?? []).map((a) => a.note);
    expect(atomNotes.some((n) => n?.startsWith('saga-auto-close-via-completeTask:'))).toBe(true);
    expect(atomNotes.some((n) => n?.startsWith('members:'))).toBe(true);
    expect(atomNotes.some((n) => n === 'adr:ADR-073 §1.2 invariants I3+I5')).toBe(true);
    expect(evidence?.capturedBy).toBe('system:saga-auto-close');
  });

  it('auto-closes a saga with cancelled members in the rollup (T9831 fixture)', async () => {
    // Saga TS-T9831 has two done members + one cancelled member + one
    // last pending member. The auto-close path treats `cancelled` as
    // terminal so completing the last pending member fires the rollup.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-T9831',
        title: 'SG-ARCH-SOLID',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-A1',
        title: 'Member A1',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-A2',
        title: 'Member A2 (cancelled)',
        type: 'epic',
        status: 'cancelled',
        priority: 'high',
        createdAt: now,
        cancelledAt: now,
      },
      {
        id: 'TM-A3',
        title: 'Member A3',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-A4',
        title: 'Last pending member',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-T9831', 'TM-A1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-T9831', 'TM-A2', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-T9831', 'TM-A3', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-T9831', 'TM-A4', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-A4' }, env.tempDir, accessor);
    expect(result.autoCompleted).toContain('TS-T9831');

    const saga = await accessor.loadSingleTask('TS-T9831');
    expect(saga?.status).toBe('done');
  });

  it('does NOT auto-close when a non-current member is still pending (mixed-state guard)', async () => {
    // Two members are pending. Completing one of them MUST NOT flip the
    // saga — the other member still blocks rollup. The completing
    // task's own status flips as usual.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-MIX',
        title: 'SG-MIXED-STATE',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-X1',
        title: 'Done member',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-X2',
        title: 'Still pending — blocks rollup',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'TM-X3',
        title: 'Completing now',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-MIX', 'TM-X1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MIX', 'TM-X2', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MIX', 'TM-X3', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-X3' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.autoCompleted ?? []).not.toContain('TS-MIX');

    const saga = await accessor.loadSingleTask('TS-MIX');
    expect(saga?.status).toBe('pending');
  });

  it('is idempotent — re-running completeTask on a sibling does not re-touch an already-done saga', async () => {
    // Saga has every member done EXCEPT the current target. Completing
    // it flips the saga once. A subsequent re-attempt on a separate
    // member (which is already done) MUST be rejected by the
    // already-completed guard without re-touching the saga.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-IDEM',
        title: 'SG-IDEMPOTENCY',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-I1',
        title: 'Already done',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-I2',
        title: 'Last member',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-IDEM', 'TM-I1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-IDEM', 'TM-I2', SAGA_GROUPS_RELATION);

    // First completion fires the saga auto-close.
    const first = await completeTask({ taskId: 'TM-I2' }, env.tempDir, accessor);
    expect(first.autoCompleted).toContain('TS-IDEM');
    const sagaAfterFirst = await accessor.loadSingleTask('TS-IDEM');
    expect(sagaAfterFirst?.status).toBe('done');
    const completedAtAfterFirst = sagaAfterFirst?.completedAt;

    // Second attempt on the same task MUST raise 'already completed' —
    // proving the saga auto-close path is not re-entered for a no-op
    // call. The saga's completedAt stamp MUST be unchanged.
    await expect(completeTask({ taskId: 'TM-I2' }, env.tempDir, accessor)).rejects.toThrow(
      'already completed',
    );
    const sagaAfterSecond = await accessor.loadSingleTask('TS-IDEM');
    expect(sagaAfterSecond?.status).toBe('done');
    expect(sagaAfterSecond?.completedAt).toBe(completedAtAfterFirst);
  });

  it('auto-closes multiple sagas in a single completion when the same task is a member of several', async () => {
    // The completing task is a member of TWO sagas. Both have every
    // other member done. Completing this task MUST flip BOTH sagas in
    // the same transaction.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-MULT-A',
        title: 'SG-A',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TS-MULT-B',
        title: 'SG-B',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-SHARED',
        title: 'Member of both sagas',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'TM-A-OTHER',
        title: 'Other member of SG-A',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-B-OTHER',
        title: 'Other member of SG-B',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
    ]);
    await accessor.addRelation('TS-MULT-A', 'TM-SHARED', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MULT-A', 'TM-A-OTHER', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MULT-B', 'TM-SHARED', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MULT-B', 'TM-B-OTHER', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-SHARED' }, env.tempDir, accessor);
    expect(result.autoCompleted).toEqual(expect.arrayContaining(['TS-MULT-A', 'TS-MULT-B']));

    const sagaA = await accessor.loadSingleTask('TS-MULT-A');
    const sagaB = await accessor.loadSingleTask('TS-MULT-B');
    expect(sagaA?.status).toBe('done');
    expect(sagaB?.status).toBe('done');
  });

  it('skips a saga whose status is already terminal (done)', async () => {
    // Saga is already `done`. Completing a still-pending sibling MUST
    // NOT re-touch the saga (no double-write, no audit churn).
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-DONE',
        title: 'Already-done saga',
        type: 'epic',
        status: 'done',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
        completedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'TM-D1',
        title: 'Member D1',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-D2',
        title: 'Member D2 — still pending',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-DONE', 'TM-D1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-DONE', 'TM-D2', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-D2' }, env.tempDir, accessor);
    expect(result.autoCompleted ?? []).not.toContain('TS-DONE');

    const saga = await accessor.loadSingleTask('TS-DONE');
    expect(saga?.status).toBe('done');
    // completedAt MUST be the original timestamp — proving the saga was
    // not re-written on this call.
    expect(saga?.completedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('is a no-op when the completing task is not a saga member', async () => {
    // A regular epic + child task with no saga relation MUST behave
    // exactly as before — no extra DB reads / writes on the saga path.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'T-PLAIN',
        title: 'Plain task — no saga membership',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: now,
      },
    ]);

    const result = await completeTask({ taskId: 'T-PLAIN' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toBeUndefined();
  });

  // ──────────────────────────────────────────────────────────────────────────
  // T10425 (Saga T10326 L1) — additional coverage filed AFTER T10116 shipped:
  //   1. New-shape `type='saga'` rows (T10277 ScopeB cutover) must drive the
  //      same auto-close branch — previously only legacy `type='epic' +
  //      label='saga'` fixtures exercised this code path.
  //   2. Epic→Task→Subtask cascade (the canonical AC3 "must not regress"
  //      contract) is asserted INSIDE the saga test file so a future edit to
  //      the saga branch cannot silently break the parent rollup it sits
  //      next to.
  // See ADR-083 §2.6 + ADR-073 §1.2 invariants I3+I5.
  // ──────────────────────────────────────────────────────────────────────────

  it("auto-closes a new-shape `type='saga'` row when its last member completes (T10425 / T10277)", async () => {
    // New-shape saga (post-T10277 ScopeB cutover): `type='saga'` with NO
    // `'saga'` label. The auto-close branch resolves the saga via
    // `findSagasGroupingTask`, which sweeps both shapes via `isSagaShape`.
    // This pins the new-shape contract against silent drift.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-NEW',
        title: 'SG-NEW-SHAPE',
        type: 'saga',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'TM-N1',
        title: 'Member Epic 1 (new-shape saga)',
        type: 'epic',
        status: 'done',
        priority: 'high',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'TM-N2',
        title: 'Member Epic 2 (last pending)',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-NEW', 'TM-N1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-NEW', 'TM-N2', SAGA_GROUPS_RELATION);

    const result = await completeTask({ taskId: 'TM-N2' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    expect(result.autoCompleted).toContain('TS-NEW');

    // Re-load and confirm the new-shape saga flipped terminal.
    const saga = await accessor.loadSingleTask('TS-NEW');
    expect(saga?.status).toBe('done');
    expect(saga?.type).toBe('saga');
    expect(saga?.completedAt).toBeDefined();
    expect(saga?.pipelineStage).toBe('contribution');

    // Synthesized evidence MUST still cite the canonical ADR atoms — the
    // new-shape contract reuses `buildSagaAutoCloseEvidence`, so the
    // three-atom envelope is identical to the legacy-shape case.
    const evidence = saga?.verification?.evidence?.implemented;
    const atomNotes = (evidence?.atoms ?? []).map((a) => a.note);
    expect(atomNotes.some((n) => n?.startsWith('saga-auto-close-via-completeTask:'))).toBe(true);
    expect(atomNotes.some((n) => n === 'adr:ADR-073 §1.2 invariants I3+I5')).toBe(true);
  });

  it('does NOT regress the Epic→Task→Subtask cascade auto-close (T10425 AC3)', async () => {
    // Canonical parent-edge rollup: when every subtask of a task is done,
    // the task auto-closes; when every task of an epic is done, the epic
    // auto-closes. This branch lives ABOVE the saga branch in completeTask;
    // pinning it here proves a future saga-branch edit cannot silently
    // break the cascade it sits next to.
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'E-CASCADE',
        title: 'Cascade Epic',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'T-CASCADE',
        title: 'Cascade Task',
        type: 'task',
        status: 'pending',
        priority: 'high',
        parentId: 'E-CASCADE',
        createdAt: now,
      },
      {
        id: 'ST-CASCADE-1',
        title: 'Subtask 1',
        type: 'subtask',
        status: 'done',
        priority: 'medium',
        parentId: 'T-CASCADE',
        createdAt: now,
        completedAt: now,
      },
      {
        id: 'ST-CASCADE-2',
        title: 'Subtask 2 — last pending',
        type: 'subtask',
        status: 'pending',
        priority: 'medium',
        parentId: 'T-CASCADE',
        createdAt: now,
      },
    ]);

    const result = await completeTask({ taskId: 'ST-CASCADE-2' }, env.tempDir, accessor);

    expect(result.task.status).toBe('done');
    // Both the parent task AND the grandparent epic should auto-roll.
    // Per the implementation, the immediate parent (task) closes via the
    // coordination-parent branch; the epic then closes via the epic
    // auto-complete branch on its own walk path (next call). Here we
    // assert at minimum the immediate-parent rollup landed — proving
    // the parent-edge cascade is untouched by the saga branch above.
    expect(result.autoCompleted).toContain('T-CASCADE');

    const task = await accessor.loadSingleTask('T-CASCADE');
    expect(task?.status).toBe('done');
    expect(task?.pipelineStage).toBe('contribution');
  });
});
