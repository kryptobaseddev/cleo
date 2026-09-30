/**
 * T12790 — evidence bindings leave the store with their AC, and orphans left
 * behind before that are reported (read-only) and repaired (audited).
 *
 * Every case runs against a real temp `cleo.db` (scratch CLEO_HOME via
 * {@link createTestDb}); nothing touches a live project store.
 */

import type { DataAccessor } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { scanOrphanAcBindings } from '../../doctor/orphan-ac-bindings.js';
import { applyAcPlan } from '../../tasks/ac-table.js';
import { AC_BINDINGS_PRUNED_ACTION, selectPrunedAcBindings } from '../ac-binding-prune.js';
import { getDb } from '../sqlite.js';
import { deleteTask } from '../tasks-sqlite.js';
import { createTestDb, seedTasks } from './test-db-helper.js';

interface PrunedDetails {
  reason: string;
  acIds: string[];
  bindings: Array<{ id: string }>;
}

function details(row: { detailsJson: string | null } | undefined): PrunedDetails {
  return JSON.parse(row?.detailsJson ?? 'null') as PrunedDetails;
}

async function seed(accessor: DataAccessor): Promise<void> {
  await seedTasks(accessor, [
    { id: 'T1', title: 'Owner', type: 'task', status: 'pending', priority: 'medium' },
    { id: 'T2', title: 'Other', type: 'task', status: 'pending', priority: 'medium' },
  ]);
  await accessor.transaction(async (tx) => {
    await tx.insertAcRows([
      { id: 'ac-keep', taskId: 'T1', ordinal: 1, text: 'keep me' },
      { id: 'ac-drop', taskId: 'T1', ordinal: 2, text: 'drop me' },
      { id: 'ac-other', taskId: 'T2', ordinal: 1, text: 'someone else' },
    ]);
    await tx.insertAcBindings([
      { id: 'b-keep', evidenceAtomId: 'commit:aaa', acId: 'ac-keep', bindingType: 'coverage' },
      {
        id: 'b-drop',
        evidenceAtomId: 'satisfies:T9->T1#AC2',
        acId: 'ac-drop',
        bindingType: 'satisfies',
      },
      { id: 'b-other', evidenceAtomId: 'commit:bbb', acId: 'ac-other', bindingType: 'direct' },
    ]);
  });
}

async function allBindingIds(accessor: DataAccessor): Promise<string[]> {
  const rows = await accessor.getAcBindings(['ac-keep', 'ac-drop', 'ac-other', 'ghost-ac']);
  return rows.map((r) => r.id).sort();
}

async function prunedAuditRows(accessor: DataAccessor, taskId: string) {
  return accessor.queryAuditLog({ taskIds: [taskId], actions: [AC_BINDINGS_PRUNED_ACTION] });
}

describe('T12790 AC binding pruning', () => {
  it('an AC edit deletes only the departing AC bindings and audits them', async () => {
    const env = await createTestDb();
    try {
      await seed(env.accessor);
      await env.accessor.transaction(async (tx) => {
        await applyAcPlan(tx, 'T1', {
          inserts: [{ id: 'ac-keep', taskId: 'T1', ordinal: 1, text: 'keep me' }],
          history: [{ acId: 'ac-drop', previousText: 'drop me', reason: 'edit' }],
          fullDelete: true,
        });
      });

      expect(await allBindingIds(env.accessor)).toEqual(['b-keep', 'b-other']);
      const audit = await prunedAuditRows(env.accessor, 'T1');
      expect(audit).toHaveLength(1);
      const pruned = details(audit[0]);
      expect(pruned.reason).toBe('ac-removed');
      expect(pruned.acIds).toEqual(['ac-drop']);
      expect(pruned.bindings.map((b) => b.id)).toEqual(['b-drop']);

      // History survives for alias-drift detection.
      const history = await selectPrunedAcBindings(await getDb(env.tempDir), 'T1');
      expect(history.map((b) => [b.id, b.acId, b.bindingType])).toEqual([
        ['b-drop', 'ac-drop', 'satisfies'],
      ]);
      expect(await env.accessor.findOrphanAcBindings()).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('deleteAcRowsByIds never prunes a binding of an AC another task owns', async () => {
    const env = await createTestDb();
    try {
      await seed(env.accessor);
      await env.accessor.transaction((tx) => tx.deleteAcRowsByIds('T1', ['ac-other']));
      expect(await allBindingIds(env.accessor)).toEqual(['b-drop', 'b-keep', 'b-other']);
      expect(await prunedAuditRows(env.accessor, 'T1')).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('deleteAcRowsForTask prunes every binding of the task', async () => {
    const env = await createTestDb();
    try {
      await seed(env.accessor);
      await env.accessor.transaction((tx) => tx.deleteAcRowsForTask('T1'));
      expect(await allBindingIds(env.accessor)).toEqual(['b-other']);
    } finally {
      await env.cleanup();
    }
  });

  it('hard task delete (accessor and legacy path) prunes the cascading AC bindings', async () => {
    const env = await createTestDb();
    try {
      await seed(env.accessor);
      await env.accessor.removeSingleTask('T1');
      expect(await allBindingIds(env.accessor)).toEqual(['b-other']);
      const audit = await prunedAuditRows(env.accessor, 'T1');
      expect(details(audit[0]).reason).toBe('task-removed');

      expect(await deleteTask('T2', env.tempDir)).toBe(true);
      expect(await allBindingIds(env.accessor)).toEqual([]);
      expect(await env.accessor.findOrphanAcBindings()).toEqual([]);
    } finally {
      await env.cleanup();
    }
  });

  it('doctor scan counts orphans read-only; --fix removes them with an audit line', async () => {
    const env = await createTestDb();
    try {
      await seed(env.accessor);
      // Orphans as a pre-T12790 store holds them: bindings whose AC is gone.
      await env.accessor.transaction((tx) =>
        tx.insertAcBindings([
          {
            id: 'b-ghost-1',
            evidenceAtomId: 'satisfies:T9->T1#AC7',
            acId: 'ghost-ac',
            bindingType: 'satisfies',
          },
          {
            id: 'b-ghost-2',
            evidenceAtomId: 'commit:ccc',
            acId: 'ghost-ac',
            bindingType: 'direct',
          },
        ]),
      );

      const report = await scanOrphanAcBindings(env.tempDir);
      expect(report.orphanCount).toBe(2);
      expect(report.missingAcIds).toEqual(['ghost-ac']);
      expect([...report.byType].sort((a, b) => a.bindingType.localeCompare(b.bindingType))).toEqual(
        [
          { bindingType: 'direct', count: 1 },
          { bindingType: 'satisfies', count: 1 },
        ],
      );
      expect(report.repaired).toBe(false);
      expect(report.removed).toBe(0);
      // Read-only: nothing moved.
      expect(await allBindingIds(env.accessor)).toContain('b-ghost-1');
      expect(await prunedAuditRows(env.accessor, 'T1')).toEqual([]);

      const fixed = await scanOrphanAcBindings(env.tempDir, { fix: true });
      expect(fixed.orphanCount).toBe(2);
      expect(fixed.removed).toBe(2);
      expect(await allBindingIds(env.accessor)).toEqual(['b-drop', 'b-keep', 'b-other']);

      // One audit row per inferred owner: T1 (satisfies target) and 'unknown'.
      const t1 = await prunedAuditRows(env.accessor, 'T1');
      expect(t1).toHaveLength(1);
      expect(details(t1[0]).reason).toBe('orphan-repair');
      expect(await prunedAuditRows(env.accessor, 'unknown')).toHaveLength(1);

      const again = await scanOrphanAcBindings(env.tempDir, { fix: true });
      expect(again.orphanCount).toBe(0);
      expect(again.removed).toBe(0);
    } finally {
      await env.cleanup();
    }
  });
});
