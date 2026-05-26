/**
 * Tests for typed completion-criteria evaluation (T10591).
 *
 * These tests deliberately exercise the row-table SSoT:
 * task_acceptance_criteria + evidence_ac_bindings + child task status.
 */

import { randomUUID } from 'node:crypto';
import type { AcRow, DataAccessor, TaskStatus } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { buildCompletionContextPack } from '../completion-context-pack.js';
import { evaluateCompletion, explainCompletion } from '../completion-evaluation.js';

describe('completion evaluation (T10591)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  async function insertAcRows(
    taskId: string,
    rows: Array<{
      id?: string;
      ordinal: number;
      text: string;
      kind: AcRow['kind'];
      sourceKey: string;
      targetTaskId?: string | null;
    }>,
  ): Promise<AcRow[]> {
    await accessor.transaction(async (tx) => {
      await tx.insertAcRows(
        rows.map((row) => ({
          id: row.id ?? randomUUID(),
          taskId,
          ordinal: row.ordinal,
          text: row.text,
          kind: row.kind,
          sourceKey: row.sourceKey,
          targetTaskId: row.targetTaskId ?? null,
          projection: row.kind === 'child_task' ? 'parent-child' : 'legacy',
        })),
      );
    });
    return accessor.getAcRows(taskId);
  }

  async function bind(acId: string): Promise<void> {
    await accessor.transaction(async (tx) => {
      await tx.insertAcBindings([
        {
          id: randomUUID(),
          evidenceAtomId: `commit:${randomUUID().replace(/-/g, '').slice(0, 12)}`,
          acId,
          bindingType: 'direct',
        },
      ]);
    });
  }

  async function seedParentWithChildren(parentStatus: TaskStatus = 'active'): Promise<AcRow[]> {
    await seedTasks(accessor, [
      { id: 'T-PARENT', title: 'Parent', status: parentStatus, priority: 'high', type: 'epic' },
      {
        id: 'T-DONE',
        title: 'Done child',
        status: 'done',
        priority: 'medium',
        parentId: 'T-PARENT',
      },
      {
        id: 'T-CANCELLED',
        title: 'Cancelled child',
        status: 'cancelled',
        priority: 'medium',
        parentId: 'T-PARENT',
      },
      {
        id: 'T-REPLACEMENT',
        title: 'Replacement child',
        status: 'done',
        priority: 'medium',
        parentId: 'T-PARENT',
      },
      {
        id: 'T-REPLACEMENT-PENDING',
        title: 'Pending replacement child',
        status: 'pending',
        priority: 'medium',
        parentId: 'T-PARENT',
      },
      {
        id: 'T-PENDING',
        title: 'Pending child',
        status: 'pending',
        priority: 'medium',
        parentId: 'T-PARENT',
      },
    ]);

    return insertAcRows('T-PARENT', [
      { ordinal: 1, text: 'Manual text AC', kind: 'text', sourceKey: 'text:1:manual' },
      {
        ordinal: 2,
        text: '{"kind":"test","command":"pnpm test","expect":"pass"}',
        kind: 'evidence_bound',
        sourceKey: 'evidence:req-test',
      },
      {
        ordinal: 3,
        text: 'Complete child T-DONE: Done child',
        kind: 'child_task',
        sourceKey: 'child:T-DONE',
        targetTaskId: 'T-DONE',
      },
      {
        ordinal: 4,
        text: 'Complete child T-CANCELLED: Cancelled child',
        kind: 'child_task',
        sourceKey: 'child:T-CANCELLED',
        targetTaskId: 'T-CANCELLED',
      },
      {
        ordinal: 5,
        text: 'Complete child T-PENDING: Pending child',
        kind: 'child_task',
        sourceKey: 'child:T-PENDING',
        targetTaskId: 'T-PENDING',
      },
    ]);
  }

  it('returns unsatisfied text, evidence, and child criteria', async () => {
    await seedParentWithChildren();

    const evaluation = await evaluateCompletion('T-PARENT', accessor);

    expect(evaluation.ready).toBe(false);
    expect(evaluation.unsatisfied.map((item) => [item.alias, item.kind, item.reason])).toEqual([
      ['AC1', 'text', 'missing_evidence_binding'],
      ['AC2', 'evidence_bound', 'missing_evidence_binding'],
      ['AC4', 'child_task', 'child_cancelled_requires_waiver'],
      ['AC5', 'child_task', 'child_not_done'],
    ]);
    expect(evaluation.satisfied.map((item) => item.alias)).toEqual(['AC3']);
  });

  it('requires criterion-scoped waiver metadata before waiving a cancelled child', async () => {
    const acRows = await seedParentWithChildren();
    await bind(acRows[0]!.id);
    await bind(acRows[1]!.id);
    const cancelledChildAc = acRows[3]!;

    const withoutWaiver = await evaluateCompletion('T-PARENT', accessor);
    expect(withoutWaiver.unsatisfied.map((item) => item.reason)).toContain(
      'child_cancelled_requires_waiver',
    );

    const withWaiver = await evaluateCompletion('T-PARENT', accessor, {
      childWaivers: [
        {
          criterionAcId: cancelledChildAc.id,
          childTaskId: 'T-CANCELLED',
          reason: 'Scope intentionally cancelled after owner approval',
          actor: 'keaton',
          waivedAt: '2026-05-26T08:00:00.000Z',
        },
      ],
    });
    expect(withWaiver.waived.map((item) => item.targetTaskId)).toEqual(['T-CANCELLED']);
    expect(withWaiver.waived[0]!.waiver).toEqual({
      criterionAcId: cancelledChildAc.id,
      childTaskId: 'T-CANCELLED',
      reason: 'Scope intentionally cancelled after owner approval',
      actor: 'keaton',
      waivedAt: '2026-05-26T08:00:00.000Z',
    });
    expect(withWaiver.unsatisfied.map((item) => item.targetTaskId)).not.toContain('T-CANCELLED');
  });

  it('distinguishes replaced child criteria from satisfied and waived rollup buckets', async () => {
    const acRows = await seedParentWithChildren();
    await bind(acRows[0]!.id);
    await bind(acRows[1]!.id);
    const cancelledChildAc = acRows[3]!;
    const pendingChildAc = acRows[4]!;

    const evaluation = await evaluateCompletion('T-PARENT', accessor, {
      childReplacements: [
        {
          criterionAcId: cancelledChildAc.id,
          originalChildTaskId: 'T-CANCELLED',
          replacementChildTaskId: 'T-REPLACEMENT',
          reason: 'Replacement task carries the superseding deliverable',
          actor: 'prime',
          replacedAt: '2026-05-26T08:05:00.000Z',
        },
        {
          criterionAcId: pendingChildAc.id,
          originalChildTaskId: 'T-PENDING',
          replacementChildTaskId: 'T-REPLACEMENT-PENDING',
          reason: 'Replacement exists but is not complete yet',
          actor: 'prime',
          replacedAt: '2026-05-26T08:06:00.000Z',
        },
      ],
    });

    expect(evaluation.satisfied.map((item) => item.alias)).toEqual(['AC1', 'AC2', 'AC3']);
    expect(evaluation.replaced.map((item) => item.alias)).toEqual(['AC4']);
    expect(evaluation.replaced[0]!.replacement).toMatchObject({
      originalChildTaskId: 'T-CANCELLED',
      replacementChildTaskId: 'T-REPLACEMENT',
    });
    expect(evaluation.replaced[0]!.replacementTaskStatus).toBe('done');
    expect(evaluation.unsatisfied.map((item) => [item.alias, item.reason])).toEqual([
      ['AC5', 'child_replacement_not_done'],
    ]);
    expect(evaluation.totals).toEqual({
      criteria: 5,
      satisfied: 3,
      unsatisfied: 1,
      waived: 0,
      replaced: 1,
    });
    expect(explainCompletion(evaluation).summary).toContain('1 replaced criteria');
  });

  it('detects stale completion when an already-done parent has unsatisfied criteria', async () => {
    await seedParentWithChildren('done');

    const evaluation = await evaluateCompletion('T-PARENT', accessor);
    const explanation = explainCompletion(evaluation);

    expect(evaluation.ready).toBe(false);
    expect(evaluation.stale).toBe(true);
    expect(evaluation.staleReasons).toEqual(['done_parent_has_unsatisfied_criteria']);
    expect(explanation.summary).toContain('already done but has 4 unsatisfied completion criteria');
    expect(explanation.blockers.map((blocker) => blocker.reason)).toContain('done_parent_stale');
  });

  it('builds and attaches recent lifecycle context from audit log entries', async () => {
    await seedParentWithChildren();
    await accessor.appendLog({
      id: 'log-context-completed',
      timestamp: '2026-05-26T08:00:00.000Z',
      action: 'task_completed',
      taskId: 'T-DONE',
      actor: 'system',
      details: { title: 'Done child' },
      before: { status: 'active' },
      after: { status: 'done' },
    });
    await accessor.appendLog({
      id: 'log-context-cancelled',
      timestamp: '2026-05-26T08:01:00.000Z',
      action: 'task_cancelled',
      taskId: 'T-CANCELLED',
      actor: 'system',
      details: { title: 'Cancelled child' },
      before: { status: 'active' },
      after: { status: 'cancelled' },
    });
    await accessor.appendLog({
      id: 'log-context-reopened',
      timestamp: '2026-05-26T08:02:00.000Z',
      action: 'task_reopened',
      taskId: 'T-PARENT',
      actor: 'system',
      details: { title: 'Parent' },
      before: { status: 'done' },
      after: { status: 'pending' },
    });

    const pack = await buildCompletionContextPack('T-PARENT', accessor, { limit: 10 });
    expect(pack.events.map((event) => [event.action, event.taskId, event.relation])).toEqual([
      ['task_reopened', 'T-PARENT', 'self'],
      ['task_cancelled', 'T-CANCELLED', 'child'],
      ['task_completed', 'T-DONE', 'child'],
    ]);
    expect(pack.summary.byAction.task_cancelled).toBe(1);
    expect(pack.summary.byRelation.child).toBe(2);

    const evaluation = await evaluateCompletion('T-PARENT', accessor, { contextPack: pack });
    expect(evaluation.contextPack?.summary.totalEvents).toBe(3);
    expect(explainCompletion(evaluation).contextPack?.events).toHaveLength(3);
    expect(explainCompletion(evaluation).summary).toContain('Recent history: 3 lifecycle event(s)');
  });
});
