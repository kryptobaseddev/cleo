/**
 * Tests for the T1632 epic pending-children guard (E_EPIC_HAS_PENDING_CHILDREN).
 *
 * Acceptance criteria:
 * (a) auto-close happy path: completing the last child auto-closes the parent
 * (b) premature-close blocked path: direct `cleo complete <epicId>` rejected when children are pending
 * (c) --override-reason audit-log path: override bypasses guard AND writes to premature-close.jsonl
 * (d) re-open via reopen after auto-close: the epic can be re-opened
 *
 * @epic T1627
 * @task T1632
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { completeTask } from '../complete.js';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const permissiveConfig = JSON.stringify({
  enforcement: {
    session: { requiredForMutate: false },
    acceptance: { mode: 'off' },
  },
  lifecycle: { mode: 'off' },
  verification: { enabled: false },
});

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

const now = new Date().toISOString();

function makeEpic(id: string, opts: { noAutoComplete?: boolean } = {}) {
  return {
    id,
    title: `Epic ${id}`,
    type: 'epic' as const,
    status: 'active' as const,
    priority: 'medium' as const,
    acceptance: ['AC1'],
    createdAt: now,
    updatedAt: now,
    ...(opts.noAutoComplete ? { noAutoComplete: true } : {}),
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

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

describe('T1632: epic pending-children guard', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    // Write permissive config so verification/lifecycle enforcement does not fire
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(env.cleoDir, 'config.json'), permissiveConfig);
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  // -------------------------------------------------------------------------
  // (a) Auto-close happy path
  // -------------------------------------------------------------------------

  describe('(a) auto-close happy path', () => {
    it('auto-closes parent epic when the last pending child is completed', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'active'),
      ]);

      const result = await completeTask({ taskId: 'T003' }, env.tempDir, accessor);

      expect(result.task.status).toBe('done');
      expect(result.autoCompleted).toContain('E001');

      const epic = await accessor.loadSingleTask('E001');
      expect(epic?.status).toBe('done');
      expect(epic?.completedAt).toBeDefined();
    });

    it('auto-closes parent epic when all remaining siblings are cancelled', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'cancelled'),
        makeChild('T003', 'E001', 'active'),
      ]);

      const result = await completeTask({ taskId: 'T003' }, env.tempDir, accessor);

      expect(result.task.status).toBe('done');
      expect(result.autoCompleted).toContain('E001');
    });

    it('does NOT auto-close when siblings still have pending children', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'active'),
        makeChild('T003', 'E001', 'pending'),
        makeChild('T004', 'E001', 'active'),
      ]);

      const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);

      expect(result.task.status).toBe('done');
      expect(result.autoCompleted).toBeUndefined();

      const epic = await accessor.loadSingleTask('E001');
      expect(epic?.status).not.toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // (b) Premature-close blocked path
  // -------------------------------------------------------------------------

  describe('(b) premature-close blocked path', () => {
    it('REJECTS direct complete on epic with pending children (E_EPIC_HAS_PENDING_CHILDREN)', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'pending'),
        makeChild('T003', 'E001', 'active'),
      ]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.EPIC_HAS_PENDING_CHILDREN,
        message: expect.stringContaining('pending/active children'),
      });

      // Epic must still be active
      const epic = await accessor.loadSingleTask('E001');
      expect(epic?.status).toBe('active');
    });

    it('REJECTS epic with one pending child even if others are done', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'pending'),
      ]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.EPIC_HAS_PENDING_CHILDREN,
        message: expect.stringContaining('T003'),
      });
    });

    it('REJECTS epic with one active child', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeChild('T002', 'E001', 'active')]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.EPIC_HAS_PENDING_CHILDREN,
      });
    });

    it('ALLOWS direct complete on epic when all children are done or cancelled', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'done'),
        makeChild('T003', 'E001', 'cancelled'),
      ]);

      const result = await completeTask({ taskId: 'E001' }, env.tempDir, accessor);
      expect(result.task.status).toBe('done');
    });

    it('ALLOWS direct complete on epic with no children (no evidence gate in off mode)', async () => {
      await seedTasks(accessor, [makeEpic('E001')]);

      const result = await completeTask({ taskId: 'E001' }, env.tempDir, accessor);
      expect(result.task.status).toBe('done');
    });
  });

  // -------------------------------------------------------------------------
  // (c) --override-reason audit-log path
  // -------------------------------------------------------------------------

  describe('(c) --override-reason audit-log path', () => {
    it('allows completion with overrideReason when children are pending', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeChild('T002', 'E001', 'pending')]);

      const result = await completeTask(
        { taskId: 'E001', overrideReason: 'emergency close for incident-9001' },
        env.tempDir,
        accessor,
      );

      expect(result.task.status).toBe('done');
    });

    it('writes an audit entry to premature-close.jsonl when override is used', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeChild('T002', 'E001', 'pending'),
        makeChild('T003', 'E001', 'active'),
      ]);

      await completeTask(
        { taskId: 'E001', overrideReason: 'incident-9001 hotfix' },
        env.tempDir,
        accessor,
      );

      // Read the audit file
      const auditPath = join(env.tempDir, '.cleo', 'audit', 'premature-close.jsonl');
      const raw = await readFile(auditPath, 'utf8');
      const entries = raw
        .trim()
        .split('\n')
        .map(
          (l) =>
            JSON.parse(l) as {
              epicId: string;
              pendingChildIds: string[];
              overrideReason: string;
              timestamp: string;
              agent: string;
            },
        );

      expect(entries).toHaveLength(1);
      const [entry] = entries;
      expect(entry.epicId).toBe('E001');
      expect(entry.overrideReason).toBe('incident-9001 hotfix');
      expect(entry.pendingChildIds).toContain('T002');
      expect(entry.pendingChildIds).toContain('T003');
      expect(entry.timestamp).toBeTruthy();
      expect(entry.agent).toBeTruthy();
    });

    it('appends multiple override entries on successive calls', async () => {
      await seedTasks(accessor, [
        makeEpic('E001'),
        makeEpic('E002'),
        makeChild('T002', 'E001', 'pending'),
        makeChild('T003', 'E002', 'pending'),
      ]);

      await completeTask({ taskId: 'E001', overrideReason: 'reason-1' }, env.tempDir, accessor);
      await completeTask({ taskId: 'E002', overrideReason: 'reason-2' }, env.tempDir, accessor);

      const auditPath = join(env.tempDir, '.cleo', 'audit', 'premature-close.jsonl');
      const raw = await readFile(auditPath, 'utf8');
      const entries = raw.trim().split('\n');
      expect(entries).toHaveLength(2);
    });

    it('does NOT write an audit entry when override is not used (normal blocked path)', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeChild('T002', 'E001', 'pending')]);

      await expect(completeTask({ taskId: 'E001' }, env.tempDir, accessor)).rejects.toMatchObject({
        code: ExitCode.EPIC_HAS_PENDING_CHILDREN,
      });

      // No audit file should exist
      const auditPath = join(env.tempDir, '.cleo', 'audit', 'premature-close.jsonl');
      await expect(readFile(auditPath, 'utf8')).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // (d) Re-open after auto-close
  // -------------------------------------------------------------------------

  describe('(d) re-open after auto-close', () => {
    it('allows status to be set back to active after auto-close', async () => {
      await seedTasks(accessor, [makeEpic('E001'), makeChild('T002', 'E001', 'active')]);

      // Complete last child → triggers auto-close of E001
      const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
      expect(result.autoCompleted).toContain('E001');

      const epicBefore = await accessor.loadSingleTask('E001');
      expect(epicBefore?.status).toBe('done');

      // Re-open the epic
      await accessor.upsertSingleTask({
        ...epicBefore!,
        status: 'active',
        completedAt: undefined,
        updatedAt: new Date().toISOString(),
      });

      const epicAfter = await accessor.loadSingleTask('E001');
      expect(epicAfter?.status).toBe('active');
      expect(epicAfter?.completedAt).toBeUndefined();
    });
  });
});
