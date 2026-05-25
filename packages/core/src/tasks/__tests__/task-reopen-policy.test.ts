/**
 * Tests for the T10605 reopen policy: done-parent ancestor propagation,
 * regression_of path documentation, and completion-history preservation.
 *
 * Acceptance criteria:
 * (AC1) required unsatisfied child reopens ancestors — done parents become pending
 * (AC2) regression_of path documented — regressionOf param recorded in notes
 * (AC3) completion history preserved — prior completedAt preserved in notes
 *
 * @task T10605
 * @epic T10544
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { coreTaskReopen } from '../task-reparent.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPLETED_AT = '2026-01-10T12:00:00.000Z';
const now = new Date().toISOString();

function makeEpic(id: string, status: 'pending' | 'active' | 'done' = 'done') {
  return {
    id,
    title: `Epic ${id}`,
    type: 'epic' as const,
    status,
    priority: 'medium' as const,
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: COMPLETED_AT } : {}),
  };
}

function makeTask(
  id: string,
  parentId: string | undefined,
  status: 'pending' | 'active' | 'done' = 'done',
) {
  return {
    id,
    title: `Task ${id}`,
    type: 'task' as const,
    status,
    priority: 'medium' as const,
    parentId,
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: COMPLETED_AT } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe('T10605: reopen policy', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // AC1: required unsatisfied child reopens ancestors
  // -------------------------------------------------------------------------

  describe('AC1: done parent is reopened when a done child is reopened', () => {
    it('reopens a direct done parent when a done child is reopened', async () => {
      // E001 (done) → T002 (done)
      await seedTasks(accessor, [makeEpic('E001'), makeTask('T002', 'E001')]);

      const result = await coreTaskReopen(env.tempDir, 'T002', { reopenAncestors: true });

      expect(result.reopened).toBe(true);
      expect(result.ancestorsReopened).toContain('E001');

      const parent = await accessor.loadSingleTask('E001');
      expect(parent?.status).toBe('pending');
      expect(parent?.completedAt).toBeUndefined();
    });

    it('reopens the full ancestor chain (grandparent and parent) when a done leaf is reopened', async () => {
      // SG001 (done) → E001 (done) → T002 (done)
      await seedTasks(accessor, [
        makeEpic('SG001'),
        { ...makeEpic('E001'), parentId: 'SG001' },
        makeTask('T002', 'E001'),
      ]);

      const result = await coreTaskReopen(env.tempDir, 'T002');

      expect(result.ancestorsReopened).toContain('E001');
      expect(result.ancestorsReopened).toContain('SG001');

      const grandparent = await accessor.loadSingleTask('SG001');
      expect(grandparent?.status).toBe('pending');
    });

    it('skips already-non-done ancestors (does not double-reopen active/pending)', async () => {
      // E001 (active, not done) → T002 (done)
      await seedTasks(accessor, [makeEpic('E001', 'active'), makeTask('T002', 'E001')]);

      const result = await coreTaskReopen(env.tempDir, 'T002');

      expect(result.ancestorsReopened).not.toContain('E001');

      const parent = await accessor.loadSingleTask('E001');
      expect(parent?.status).toBe('active');
    });

    it('does NOT reopen ancestors when reopenAncestors is explicitly false', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeTask('T002', 'E001')]);

      const result = await coreTaskReopen(env.tempDir, 'T002', { reopenAncestors: false });

      expect(result.ancestorsReopened).toHaveLength(0);

      const parent = await accessor.loadSingleTask('E001');
      expect(parent?.status).toBe('done');
    });

    it('returns empty ancestorsReopened when task has no parent', async () => {
      await seedTasks(accessor, [makeTask('T001', undefined)]);

      const result = await coreTaskReopen(env.tempDir, 'T001');

      expect(result.ancestorsReopened).toHaveLength(0);
    });

    it('appends a note on the ancestor identifying the triggering child', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeTask('T002', 'E001')]);

      await coreTaskReopen(env.tempDir, 'T002');

      const parent = await accessor.loadSingleTask('E001');
      const triggerNote = parent?.notes?.find(
        (n) => n.includes('T002') && n.includes('Reopened by child'),
      );
      expect(triggerNote).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC2: regression_of path documented
  // -------------------------------------------------------------------------

  describe('AC2: regression_of param is persisted in task notes', () => {
    it('appends a regression_of note when regressionOf is supplied', async () => {
      await seedTasks(accessor, [makeTask('T001', undefined)]);

      await coreTaskReopen(env.tempDir, 'T001', { regressionOf: 'T001' });

      const task = await accessor.loadSingleTask('T001');
      const regressionNote = task?.notes?.find(
        (n) => n.startsWith('[') && n.includes('regression_of: T001'),
      );
      expect(regressionNote).toBeDefined();
    });

    it('does NOT append a regression_of note when regressionOf is omitted', async () => {
      await seedTasks(accessor, [makeTask('T001', undefined)]);

      await coreTaskReopen(env.tempDir, 'T001');

      const task = await accessor.loadSingleTask('T001');
      const regressionNote = task?.notes?.find((n) => n.includes('regression_of:'));
      expect(regressionNote).toBeUndefined();
    });

    it('regressionOf references a different task ID (cross-task regression)', async () => {
      await seedTasks(accessor, [makeTask('T005', undefined), makeTask('T006', undefined)]);

      await coreTaskReopen(env.tempDir, 'T005', { regressionOf: 'T006' });

      const task = await accessor.loadSingleTask('T005');
      const regressionNote = task?.notes?.find((n) => n.includes('regression_of: T006'));
      expect(regressionNote).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // AC3: completion history preserved
  // -------------------------------------------------------------------------

  describe('AC3: prior completedAt is preserved in notes before being cleared', () => {
    it('records the previous completedAt in a completion-history note', async () => {
      await seedTasks(accessor, [makeTask('T001', undefined)]);

      await coreTaskReopen(env.tempDir, 'T001');

      const task = await accessor.loadSingleTask('T001');
      expect(task?.completedAt).toBeUndefined();

      const historyNote = task?.notes?.find(
        (n) => n.includes('completion-history:') && n.includes(COMPLETED_AT),
      );
      expect(historyNote).toBeDefined();
    });

    it('does NOT append a completion-history note when task had no completedAt', async () => {
      // Seed a done task without an explicit completedAt (edge case)
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task T001',
          type: 'task' as const,
          status: 'done' as const,
          priority: 'medium' as const,
          createdAt: now,
          updatedAt: now,
          // no completedAt intentionally
        },
      ]);

      await coreTaskReopen(env.tempDir, 'T001');

      const task = await accessor.loadSingleTask('T001');
      const historyNote = task?.notes?.find((n) => n.includes('completion-history:'));
      expect(historyNote).toBeUndefined();
    });

    it('preserves completion history of done ancestors when they are reopened', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeTask('T002', 'E001')]);

      await coreTaskReopen(env.tempDir, 'T002');

      const parent = await accessor.loadSingleTask('E001');
      const ancestorHistoryNote = parent?.notes?.find(
        (n) => n.includes('completion-history:') && n.includes(COMPLETED_AT),
      );
      expect(ancestorHistoryNote).toBeDefined();
    });

    it('preserves the Reopened note with previousStatus in task notes', async () => {
      await seedTasks(accessor, [makeTask('T001', undefined)]);

      const result = await coreTaskReopen(env.tempDir, 'T001', { reason: 'post-release rework' });

      expect(result.previousStatus).toBe('done');
      expect(result.newStatus).toBe('pending');

      const task = await accessor.loadSingleTask('T001');
      const reopenNote = task?.notes?.find(
        (n) => n.includes('Reopened from done') && n.includes('post-release rework'),
      );
      expect(reopenNote).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Combined: real-world scenario
  // -------------------------------------------------------------------------

  describe('combined: post-release regression rework', () => {
    it('reopens child + done parent, documents regression, preserves history', async () => {
      // Scenario: Epic E001 was done. Child T002 was done. A regression found in T002
      // post-release forces us to reopen.
      await seedTasks(accessor, [makeEpic('E001'), makeTask('T002', 'E001')]);

      const result = await coreTaskReopen(env.tempDir, 'T002', {
        reason: 'Regression found in v2026.5.100',
        regressionOf: 'T002',
        reopenAncestors: true,
      });

      // Core reopened
      expect(result.reopened).toBe(true);
      expect(result.newStatus).toBe('pending');

      // Ancestor reopened
      expect(result.ancestorsReopened).toContain('E001');
      const parent = await accessor.loadSingleTask('E001');
      expect(parent?.status).toBe('pending');

      // History preserved on child
      const child = await accessor.loadSingleTask('T002');
      expect(child?.notes?.some((n) => n.includes('completion-history:'))).toBe(true);
      expect(child?.notes?.some((n) => n.includes('regression_of:'))).toBe(true);
      expect(child?.notes?.some((n) => n.includes('Reopened from done'))).toBe(true);
    });
  });
});
