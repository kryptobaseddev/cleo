/**
 * Regression test for T9625 SG-CLEO-DOCS-CANON saga closure (T10374, E5.4).
 *
 * The saga T9625 was stuck `pending` even though all 7 member Epics
 * (T9626–T9632) had completed. The auto-close path (ADR-076 / T10113)
 * never fired because the original member Epics shipped before the
 * reconcile verb existed, leaving the saga row dangling. This test
 * locks in the recovery pattern: seed a saga with N done members,
 * invoke `reconcileSaga(testRoot, { sagaId })`, and assert the saga
 * flips to `done` while the sibling closure-saga (T9787) remains
 * unaffected.
 *
 * Covered acceptance criteria:
 *
 *   - **AC1** — `reconcileSaga` closes a stuck saga whose 7 member
 *     Epics are all `done` (mirrors the real T9625 → T9626..T9632 shape).
 *   - **AC2** — The sibling closure-saga (T9787) is NOT touched by the
 *     reconcile (cross-saga isolation).
 *   - **AC3** — Idempotency: a second invocation of `reconcileSaga`
 *     returns `action: 'no-op'` for the already-closed saga.
 *
 * @task T10374
 * @saga T10288
 * @epic T10293
 * @see ADR-076 — docs SSoT routing
 * @see T10113 — saga auto-close
 */

import { mkdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addRelation, createTask, getDb, taskShow } from '@cleocode/core/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reconcileSaga } from '../reconcile.js';

let TEST_ROOT: string;

/**
 * Seed a saga `sagaId` with `memberIds` member Epics, all marked `done`.
 * Mirrors the T9625 → T9626..T9632 shape from production.
 */
async function seedSagaWithDoneMembers(
  testRoot: string,
  sagaId: string,
  memberIds: string[],
): Promise<void> {
  mkdirSync(join(testRoot, '.cleo'), { recursive: true });
  mkdirSync(join(testRoot, '.git'), { recursive: true });
  await getDb(testRoot);

  const ts = '2026-05-18T00:00:00Z';
  await createTask(
    {
      id: sagaId,
      title: `Saga ${sagaId}`,
      description: 'T9625 closure fixture',
      type: 'epic',
      status: 'active',
      priority: 'high',
      labels: ['saga'],
      createdAt: ts,
      updatedAt: null,
    } as Parameters<typeof createTask>[0],
    testRoot,
  );

  for (const memberId of memberIds) {
    await createTask(
      {
        id: memberId,
        title: `Epic ${memberId}`,
        description: `Member of ${sagaId}`,
        type: 'epic',
        status: 'done',
        priority: 'medium',
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      testRoot,
    );
    await addRelation(sagaId, memberId, 'groups', testRoot);
  }
}

beforeEach(async () => {
  TEST_ROOT = await mkdtemp(join(tmpdir(), 'cleo-t9625-closure-test-'));
});

afterEach(async () => {
  try {
    const { closeAllDatabases } = await import('@cleocode/core/internal');
    await closeAllDatabases();
  } catch {
    // ignore cleanup errors
  }
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe('T9625 SG-CLEO-DOCS-CANON closure regression (T10374)', () => {
  it('AC1: closes a stuck saga whose 7 member Epics are all done', async () => {
    // Production shape: T9625 → T9626..T9632 (7 Epics, all done).
    await seedSagaWithDoneMembers(TEST_ROOT, 'T-S9625', [
      'T-E9626',
      'T-E9627',
      'T-E9628',
      'T-E9629',
      'T-E9630',
      'T-E9631',
      'T-E9632',
    ]);

    // Sanity: before reconcile the saga is pending/active even though
    // every member is terminal — this is the bug we're locking against.
    const before = await taskShow(TEST_ROOT, 'T-S9625');
    expect(before.data?.task.status).toBe('active');
    expect(before.data?.task.completedAt).toBeFalsy();

    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T-S9625' });
    expect(result.success, JSON.stringify(result)).toBe(true);
    if (!result.success) return;

    expect(result.data.total).toBe(1);
    expect(result.data.closed).toBe(1);
    expect(result.data.noOp).toBe(0);
    expect(result.data.pending).toBe(0);

    const entry = result.data.entries[0];
    expect(entry?.action).toBe('close');
    expect(entry?.sagaId).toBe('T-S9625');
    expect(entry?.statusBefore).toBe('active');
    expect(entry?.statusAfter).toBe('done');
    expect(entry?.terminalMembers).toHaveLength(7);
    expect(entry?.pendingMembers).toHaveLength(0);
    expect(entry?.reason).toContain('all members terminal');

    // Verify the row was actually flipped + completedAt populated.
    const after = await taskShow(TEST_ROOT, 'T-S9625');
    expect(after.data?.task.status).toBe('done');
    expect(after.data?.task.completedAt).toBeTruthy();
  });

  it('AC2: leaves sibling closure-saga (T9787 shape) untouched', async () => {
    // Stuck saga (T9625 shape).
    await seedSagaWithDoneMembers(TEST_ROOT, 'T-S9625', ['T-E9626', 'T-E9627']);

    // Already-done sibling closure-saga (T9787 shape). Seed by hand
    // so we can stamp `status='done'` + `completedAt` upfront.
    const ts = '2026-05-23T05:55:27.596Z';
    await createTask(
      {
        id: 'T-S9787',
        title: 'SG-DOCS-CANON-CLOSURE sibling',
        type: 'epic',
        status: 'done',
        priority: 'high',
        labels: ['saga'],
        completedAt: ts,
        createdAt: ts,
        updatedAt: null,
      } as Parameters<typeof createTask>[0],
      TEST_ROOT,
    );
    // T9787 has no `groups` members in this fixture — it stands alone.

    const beforeT9787 = await taskShow(TEST_ROOT, 'T-S9787');
    expect(beforeT9787.data?.task.status).toBe('done');
    const t9787CompletedBefore = beforeT9787.data?.task.completedAt;
    expect(t9787CompletedBefore).toBeTruthy();

    // Reconcile the stuck saga.
    const result = await reconcileSaga(TEST_ROOT, { sagaId: 'T-S9625' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.closed).toBe(1);

    // T9787 must NOT have been touched — same status, same completedAt.
    const afterT9787 = await taskShow(TEST_ROOT, 'T-S9787');
    expect(afterT9787.data?.task.status).toBe('done');
    expect(afterT9787.data?.task.completedAt).toBe(t9787CompletedBefore);
  });

  it('AC3: idempotency — second reconcile is a no-op on already-closed saga', async () => {
    await seedSagaWithDoneMembers(TEST_ROOT, 'T-S9625', ['T-E9626', 'T-E9627', 'T-E9628']);

    // First reconcile closes the saga.
    const first = await reconcileSaga(TEST_ROOT, { sagaId: 'T-S9625' });
    expect(first.success).toBe(true);
    if (!first.success) return;
    expect(first.data.closed).toBe(1);

    const closedAt = (await taskShow(TEST_ROOT, 'T-S9625')).data?.task.completedAt;
    expect(closedAt).toBeTruthy();

    // Second reconcile must emit no-op AND must NOT mutate completedAt.
    const second = await reconcileSaga(TEST_ROOT, { sagaId: 'T-S9625' });
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.data.closed).toBe(0);
    expect(second.data.noOp).toBe(1);
    expect(second.data.entries[0]?.action).toBe('no-op');

    const afterSecond = await taskShow(TEST_ROOT, 'T-S9625');
    expect(afterSecond.data?.task.completedAt).toBe(closedAt);
  });
});
