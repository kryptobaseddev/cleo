/**
 * Unit tests for the T10116 saga storage helpers (post-T10638).
 *
 * After T10638, Saga membership uses `parent_id` containment instead of
 * `task_relations.type='groups'`. `findSagasGroupingTask` checks if a
 * task's `parentId` points to a saga.
 *
 * @task T10638 — E10.W5 switch to parent_id containment
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { buildSagaAutoCloseEvidence, findSagasGroupingTask } from '../storage.js';

describe('findSagasGroupingTask (T10638)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns the saga whose parent_id matches the target task', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'TS-FIND-1', title: 'Saga containing M1', type: 'saga', status: 'pending', priority: 'high', createdAt: now },
      { id: 'TS-FIND-2', title: 'Saga containing M2', type: 'saga', status: 'pending', priority: 'high', createdAt: now },
      { id: 'TM-M1', title: 'Member 1', type: 'epic', status: 'pending', priority: 'high', parentId: 'TS-FIND-1', createdAt: now },
      { id: 'TM-M2', title: 'Member 2 — unrelated', type: 'epic', status: 'pending', priority: 'high', parentId: 'TS-FIND-2', createdAt: now },
    ]);

    const sagas = await findSagasGroupingTask(accessor, 'TM-M1');
    expect(sagas.map((s) => s.id)).toEqual(['TS-FIND-1']);
  });

  it('returns an empty array when no saga parents the target task', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'T-LONELY', title: 'Task with no saga parent', type: 'task', status: 'pending', priority: 'medium', parentId: null, createdAt: now },
    ]);
    const sagas = await findSagasGroupingTask(accessor, 'T-LONELY');
    expect(sagas).toEqual([]);
  });

  it('returns empty when parent is not a saga', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'T-EPIC', title: 'Regular epic (parent)', type: 'epic', status: 'pending', priority: 'medium', createdAt: now },
      { id: 'T-CHILD', title: 'Child task', type: 'task', status: 'pending', priority: 'medium', parentId: 'T-EPIC', createdAt: now },
    ]);
    const sagas = await findSagasGroupingTask(accessor, 'T-CHILD');
    expect(sagas).toEqual([]);
  });

  it('returns the saga via non-groups relation (parent_id only)', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'TS-REL-1', title: 'Saga with member via parent_id', type: 'saga', status: 'pending', priority: 'high', createdAt: now },
      { id: 'TM-R1', title: 'Member R1', type: 'epic', status: 'pending', priority: 'high', parentId: 'TS-REL-1', createdAt: now },
      { id: 'TM-R2', title: 'Member R2 — no parent', type: 'epic', status: 'pending', priority: 'high', parentId: null, createdAt: now },
    ]);

    const groupedSagas = await findSagasGroupingTask(accessor, 'TM-R1');
    expect(groupedSagas.map((s) => s.id)).toEqual(['TS-REL-1']);

    const unrelatedSagas = await findSagasGroupingTask(accessor, 'TM-R2');
    expect(unrelatedSagas).toEqual([]);
  });

  it('returns a single saga when task has parent_id pointing to saga', async () => {
    const now = new Date().toISOString();
    await seedTasks(accessor, [
      { id: 'TS-MULTI-1', title: 'Saga 1', type: 'saga', status: 'pending', priority: 'high', createdAt: now },
      { id: 'TS-MULTI-2', title: 'Saga 2', type: 'saga', status: 'pending', priority: 'high', createdAt: now },
      { id: 'TM-SHARED', title: 'Shared member', type: 'epic', status: 'pending', priority: 'high', parentId: 'TS-MULTI-1', createdAt: now },
    ]);

    // A task can only have one parentId, so it can only belong to one saga.
    const sagas = await findSagasGroupingTask(accessor, 'TM-SHARED');
    expect(sagas.map((s) => s.id).sort()).toEqual(['TS-MULTI-1']);
  });
});

describe('buildSagaAutoCloseEvidence (T10116)', () => {
  it('produces implemented+testsPassed+qaPassed+cleanupDone+securityPassed+documented gates', () => {
    const evidence = buildSagaAutoCloseEvidence('T1000', ['T1001', 'T1002'], '2026-01-01T00:00:00.000Z');
    expect(evidence.passed).toBe(true);
    expect(evidence.gates.implemented).toBe(true);
    expect(evidence.gates.testsPassed).toBe(true);
    expect(evidence.gates.qaPassed).toBe(true);
    expect(evidence.gates.cleanupDone).toBe(true);
    expect(evidence.gates.securityPassed).toBe(true);
    expect(evidence.gates.documented).toBe(true);
  });

  it('round = 1', () => {
    const evidence = buildSagaAutoCloseEvidence('T1000', [], '2026-01-01T00:00:00.000Z');
    expect(evidence.round).toBe(1);
  });

  it('capturedBy = system:saga-auto-close', () => {
    const evidence = buildSagaAutoCloseEvidence('T1000', ['T1'], '2026-01-01T00:00:00.000Z');
    expect(evidence.evidence.implemented?.capturedBy).toBe('system:saga-auto-close');
    expect(evidence.evidence.testsPassed?.capturedBy).toBe('system:saga-auto-close');
  });

  it('members CSV note appears in every gate', () => {
    const evidence = buildSagaAutoCloseEvidence('T1000', ['T1001', 'T1002'], '2026-01-01T00:00:00.000Z');
    const note = evidence.evidence.implemented!.atoms.find((a) => a.kind === 'note' && a.note.startsWith('members:'));
    expect(note).toBeDefined();
    expect(note!.note).toBe('members:T1001,T1002');
  });

  it('ADR citation note appears in every gate', () => {
    const evidence = buildSagaAutoCloseEvidence('T1000', [], '2026-01-01T00:00:00.000Z');
    const note = evidence.evidence.implemented!.atoms.find((a) => a.kind === 'note' && a.note.startsWith('adr:'));
    expect(note).toBeDefined();
  });
});
