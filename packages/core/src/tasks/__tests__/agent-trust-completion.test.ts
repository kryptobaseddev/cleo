/**
 * PM-Core V2 agent-trust completion semantics (saga T10538).
 *
 * Covers two completion-trust defects flagged by the agent-trust audit:
 *
 * Design-point 4 — "Cancelled children should NOT automatically satisfy parent
 *   completion. They require waiver/replacement evidence."
 *   A parent with an un-waived `cancelled` child is REJECTED with
 *   `E_CANCELLED_CHILD_NO_WAIVER`; supplying `cancelledChildWaiverReason`
 *   records an audit and allows completion.
 *
 * Design-point 5 — "Silent stale 'done' parents destroy agent trust."
 *   Adding a child under a `done` parent reopens the done parent (and any done
 *   ancestors) so it never silently holds an unsatisfied child.
 *
 * @saga T10538
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import { completeTask } from '../complete.js';

const permissiveConfig = JSON.stringify({
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  lifecycle: { mode: 'off' },
  verification: { enabled: false },
});

const now = new Date().toISOString();

function makeEpic(id: string, status: 'active' | 'done' = 'active') {
  return {
    id,
    title: `Epic ${id}`,
    type: 'epic' as const,
    status,
    priority: 'medium' as const,
    acceptance: ['AC1'],
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: now } : {}),
  };
}

function makeChild(
  id: string,
  parentId: string,
  status: 'pending' | 'active' | 'done' | 'cancelled' = 'pending',
) {
  return {
    id,
    title: `Child ${id}`,
    type: 'task' as const,
    status,
    priority: 'medium' as const,
    parentId,
    acceptance: ['AC1'],
    createdAt: now,
    updatedAt: now,
    ...(status === 'done' ? { completedAt: now } : {}),
    ...(status === 'cancelled' ? { cancelledAt: now } : {}),
  };
}

describe('T10538: agent-trust completion semantics', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(env.cleoDir, 'config.json'), permissiveConfig);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // Design-point 4 — cancelled children require a waiver
  // -------------------------------------------------------------------------

  describe('design-point 4: cancelled children require waiver/replacement', () => {
    it('REJECTS completing a parent with an un-waived cancelled child', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'cancelled'),
      ]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.CANCELLED_CHILD_NO_WAIVER,
        message: expect.stringContaining('T003'),
      });

      const epic = await accessor.loadSingleTask('E001');
      expect(epic?.status).not.toBe('done');
    });

    it('surfaces the offending cancelled child ids in error.details', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'cancelled'),
        makeChild('T003', 'E001', 'cancelled'),
      ]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.CANCELLED_CHILD_NO_WAIVER,
        details: { cancelledChildIds: expect.arrayContaining(['T002', 'T003']) },
      });
    });

    it('ALLOWS completion when a cancelled-child waiver is supplied', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'cancelled'),
      ]);

      const result = await completeTask(
        { taskId: 'E001', cancelledChildWaiverReason: 'replaced by T999 — out of scope' },
        env.tempDir,
        accessor,
      );
      expect(result.task.status).toBe('done');
    });

    it('writes the waiver to .cleo/audit/cancelled-child-waiver.jsonl', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'cancelled'),
      ]);

      await completeTask(
        { taskId: 'E001', cancelledChildWaiverReason: 'incident-42 replacement T999' },
        env.tempDir,
        accessor,
      );

      const auditPath = join(env.tempDir, '.cleo', 'audit', 'cancelled-child-waiver.jsonl');
      const raw = await readFile(auditPath, 'utf8');
      const entries = raw
        .trim()
        .split('\n')
        .map(
          (l) =>
            JSON.parse(l) as {
              parentId: string;
              cancelledChildIds: string[];
              waiverReason: string;
              timestamp: string;
              agent: string;
            },
        );

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry.parentId).toBe('E001');
      expect(entry.cancelledChildIds).toContain('T003');
      expect(entry.waiverReason).toBe('incident-42 replacement T999');
      expect(entry.timestamp).toBeTruthy();
      expect(entry.agent).toBeTruthy();
    });

    it('does NOT write an audit entry when the gate blocks (no waiver)', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeChild('T002', 'E001', 'cancelled')]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.CANCELLED_CHILD_NO_WAIVER,
      });

      const auditPath = join(env.tempDir, '.cleo', 'audit', 'cancelled-child-waiver.jsonl');
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow();
    });

    it('completes normally when there are no cancelled children', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'done'),
      ]);

      const result = await completeTask({ taskId: 'E001' }, env.tempDir, accessor);
      expect(result.task.status).toBe('done');
    });

    it('does NOT auto-close a parent when the last live sibling completes but a sibling is cancelled', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'cancelled'),
        makeChild('T003', 'E001', 'active'),
      ]);

      // Completing the last active child must NOT auto-roll the epic to done —
      // the cancelled sibling is un-waived abandoned work.
      const result = await completeTask({ taskId: 'T003' }, env.tempDir, accessor);
      expect(result.task.status).toBe('done');
      expect(result.autoCompleted ?? []).not.toContain('E001');

      const epic = await accessor.loadSingleTask('E001');
      expect(epic?.status).not.toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // Design-point 5 — add under a done parent reopens the ancestor chain
  // -------------------------------------------------------------------------

  describe('design-point 5: add under a done parent reopens the ancestor', () => {
    // addTask validates parent ids match the T### format, so the parent epic
    // is seeded as T001 here (not the E### alias used in the completion tests).
    it('reopens a done parent when a child is added under it', async () => {
      await seedTasks(accessor, [makeEpic('T001', 'done')]);

      const result = await addTask(
        {
          title: 'Late child',
          description: 'work added after the parent was completed',
          parentId: 'T001',
        },
        env.tempDir,
        accessor,
      );

      // The new child exists.
      expect(result.task.parentId).toBe('T001');
      // The done parent was reopened and reported on the result.
      expect(result.reopenedAncestors).toEqual(['T001']);

      const parent = await accessor.loadSingleTask('T001');
      expect(parent?.status).toBe('pending');
      expect(parent?.completedAt).toBeUndefined();
    });

    it('surfaces a warning describing the reopen', async () => {
      await seedTasks(accessor, [makeEpic('T001', 'done')]);

      const result = await addTask(
        { title: 'Late child', description: 'late work under done parent', parentId: 'T001' },
        env.tempDir,
        accessor,
      );

      expect(result.warnings).toBeDefined();
      expect(result.warnings?.some((w) => w.includes('T001') && /Reopen/i.test(w))).toBe(true);
    });

    it('preserves the prior completion timestamp in the parent notes', async () => {
      await seedTasks(accessor, [makeEpic('T001', 'done')]);

      await addTask(
        { title: 'Late child', description: 'late work', parentId: 'T001' },
        env.tempDir,
        accessor,
      );

      const parent = await accessor.loadSingleTask('T001');
      const notes = parent?.notes ?? [];
      expect(notes.some((n) => n.includes('completion-history'))).toBe(true);
      expect(notes.some((n) => /Reopened by add of child/i.test(n))).toBe(true);
    });

    it('does NOT reopen a parent that is not done', async () => {
      await seedTasks(accessor, [makeEpic('T001', 'active')]);

      const result = await addTask(
        { title: 'Child', description: 'child under active parent', parentId: 'T001' },
        env.tempDir,
        accessor,
      );

      expect(result.reopenedAncestors).toBeUndefined();

      const parent = await accessor.loadSingleTask('T001');
      expect(parent?.status).toBe('active');
    });
  });
});
