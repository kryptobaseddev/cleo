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

  it('treats a cancelled child as satisfied only when explicitly waived', async () => {
    const acRows = await seedParentWithChildren();
    await bind(acRows[0]!.id);
    await bind(acRows[1]!.id);

    const withoutWaiver = await evaluateCompletion('T-PARENT', accessor);
    expect(withoutWaiver.unsatisfied.map((item) => item.reason)).toContain(
      'child_cancelled_requires_waiver',
    );

    const withWaiver = await evaluateCompletion('T-PARENT', accessor, {
      waivedChildTaskIds: ['T-CANCELLED'],
    });
    expect(withWaiver.waived.map((item) => item.targetTaskId)).toEqual(['T-CANCELLED']);
    expect(withWaiver.unsatisfied.map((item) => item.targetTaskId)).not.toContain('T-CANCELLED');
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
});
