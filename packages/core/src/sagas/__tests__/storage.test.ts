/**
 * Unit tests for the T10116 saga storage helpers:
 *
 *   - `findSagasGroupingTask` — backward member-lookup walking the saga
 *     catalog for `task_relations.type='groups'` edges.
 *   - `buildSagaAutoCloseEvidence` — synthesized verification envelope
 *     attached to an auto-closing saga (ADR-073 §1.2 invariants I3+I5).
 *
 * Sibling integration tests in
 * `packages/core/src/tasks/__tests__/complete-saga-autoclose.test.ts`
 * cover the end-to-end completeTask path; this file pins the pure
 * helper contracts so a future refactor cannot drift their shape
 * silently.
 *
 * @task T10116
 * @epic T10210 — E-SAGA-AUTO-CLOSE
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @see ADR-073-above-epic-naming.md §1.2
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { SAGA_GROUPS_RELATION } from '../constants.js';
import { buildSagaAutoCloseEvidence, findSagasGroupingTask } from '../storage.js';

describe('findSagasGroupingTask (T10116)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns the saga(s) whose groups edges include the target task', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-FIND-1',
        title: 'Saga grouping M1',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TS-FIND-2',
        title: 'Saga NOT grouping M1',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-M1',
        title: 'Member 1',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'TM-M2',
        title: 'Member 2 — unrelated',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-FIND-1', 'TM-M1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-FIND-2', 'TM-M2', SAGA_GROUPS_RELATION);

    const sagas = await findSagasGroupingTask(accessor, 'TM-M1');
    expect(sagas.map((s) => s.id)).toEqual(['TS-FIND-1']);
  });

  it('returns an empty array when no saga groups the target task', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'T-LONELY',
        title: 'Task with no saga membership',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: now,
      },
    ]);

    const sagas = await findSagasGroupingTask(accessor, 'T-LONELY');
    expect(sagas).toEqual([]);
  });

  it('ignores non-saga relations of the same type id (only `groups` matches)', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-REL-1',
        title: 'Saga linking via groups',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-R1',
        title: 'Member via groups',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
      {
        id: 'TM-R2',
        title: 'Related-but-not-grouped',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-REL-1', 'TM-R1', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-REL-1', 'TM-R2', 'related');

    const groupedSagas = await findSagasGroupingTask(accessor, 'TM-R1');
    expect(groupedSagas.map((s) => s.id)).toEqual(['TS-REL-1']);

    const relatedSagas = await findSagasGroupingTask(accessor, 'TM-R2');
    expect(relatedSagas).toEqual([]);
  });

  it('returns multiple sagas when the same task is grouped by several', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      {
        id: 'TS-MULTI-1',
        title: 'Saga A',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TS-MULTI-2',
        title: 'Saga B',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        labels: ['saga'],
        createdAt: now,
      },
      {
        id: 'TM-SHARED',
        title: 'Member of both',
        type: 'epic',
        status: 'pending',
        priority: 'high',
        createdAt: now,
      },
    ]);
    await accessor.addRelation('TS-MULTI-1', 'TM-SHARED', SAGA_GROUPS_RELATION);
    await accessor.addRelation('TS-MULTI-2', 'TM-SHARED', SAGA_GROUPS_RELATION);

    const sagas = await findSagasGroupingTask(accessor, 'TM-SHARED');
    expect(sagas.map((s) => s.id).sort()).toEqual(['TS-MULTI-1', 'TS-MULTI-2']);
  });
});

describe('buildSagaAutoCloseEvidence (T10116)', () => {
  it('synthesizes a fully-populated TaskVerification with the three required atom kinds', () => {
    const verification = buildSagaAutoCloseEvidence(
      'TS-EVIDENCE',
      ['TM-X1', 'TM-X2', 'TM-X3'],
      '2026-05-22T10:00:00.000Z',
    );

    expect(verification.passed).toBe(true);
    expect(verification.round).toBe(1);
    expect(verification.gates.implemented).toBe(true);
    expect(verification.gates.testsPassed).toBe(true);
    expect(verification.gates.qaPassed).toBe(true);
    expect(verification.gates.cleanupDone).toBe(true);
    expect(verification.gates.securityPassed).toBe(true);
    expect(verification.gates.documented).toBe(true);

    // Every standard gate carries the three-atom envelope.
    for (const gate of [
      'implemented',
      'testsPassed',
      'qaPassed',
      'cleanupDone',
      'securityPassed',
      'documented',
    ] as const) {
      const ev = verification.evidence?.[gate];
      expect(ev).toBeDefined();
      expect(ev?.capturedBy).toBe('system:saga-auto-close');
      const notes = (ev?.atoms ?? []).map((a) => a.note);
      expect(notes).toContainEqual(`saga-auto-close-via-completeTask:TS-EVIDENCE:${gate}`);
      expect(notes).toContainEqual('members:TM-X1,TM-X2,TM-X3');
      expect(notes).toContainEqual('adr:ADR-073 §1.2 invariants I3+I5');
    }
  });

  it('preserves the timestamp passed in by the caller verbatim', () => {
    const ts = '2026-05-22T12:34:56.789Z';
    const verification = buildSagaAutoCloseEvidence('TS-TS', ['TM-1'], ts);
    expect(verification.lastUpdated).toBe(ts);
    expect(verification.initializedAt).toBe(ts);
    expect(verification.evidence?.implemented?.capturedAt).toBe(ts);
  });

  it('handles an empty members list (defensive — never happens at the caller)', () => {
    const verification = buildSagaAutoCloseEvidence('TS-EMPTY', [], '2026-01-01T00:00:00.000Z');
    const notes = (verification.evidence?.implemented?.atoms ?? []).map((a) => a.note);
    expect(notes).toContainEqual('members:');
  });
});
