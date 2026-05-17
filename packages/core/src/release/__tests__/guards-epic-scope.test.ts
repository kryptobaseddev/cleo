/**
 * Unit tests for checkEpicCompleteness epic-scope isolation (T9502).
 *
 * Verifies that when `scopedEpicId` is supplied, only tasks whose ancestor
 * chain terminates at that epic are audited — sibling epics are ignored
 * entirely, preventing production failures like the T9220/T9261 incident.
 *
 * @task T9502
 * @epic T9502
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createTestDb, seedTasks } from '../../store/__tests__/test-db-helper.js';
import { checkEpicCompleteness } from '../guards.js';

let env: TestDbEnv;

beforeEach(async () => {
  env = await createTestDb();
});

afterEach(async () => {
  await env.cleanup();
});

/**
 * Shared fixture: two sibling epics (TEPIC_A and TEPIC_B), each with two child tasks.
 * TEPIC_A's children are done; TEPIC_B's children are pending.
 */
async function seedSiblingEpics(): Promise<void> {
  await seedTasks(env.accessor, [
    // Epic A — the declared scope epic
    {
      id: 'TEPIC_A',
      title: 'Epic A',
      type: 'epic',
      status: 'active',
      priority: 'high',
      createdAt: '2026-01-01T00:00:00Z',
    },
    // Epic A children — both done, both should be in the release
    {
      id: 'TA1',
      title: 'Task A1',
      type: 'task',
      status: 'done',
      parentId: 'TEPIC_A',
      priority: 'high',
      completedAt: '2026-01-10T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'TA2',
      title: 'Task A2',
      type: 'task',
      status: 'done',
      parentId: 'TEPIC_A',
      priority: 'medium',
      completedAt: '2026-01-12T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
    },
    // Epic B — unrelated sibling; should be completely ignored when scopedEpicId='TEPIC_A'
    {
      id: 'TEPIC_B',
      title: 'Epic B',
      type: 'epic',
      status: 'active',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00Z',
    },
    // Epic B children — pending (would fail completeness if incorrectly audited)
    {
      id: 'TB1',
      title: 'Task B1',
      type: 'task',
      status: 'pending',
      parentId: 'TEPIC_B',
      priority: 'medium',
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'TB2',
      title: 'Task B2',
      type: 'task',
      status: 'pending',
      parentId: 'TEPIC_B',
      priority: 'low',
      createdAt: '2026-01-01T00:00:00Z',
    },
  ]);
}

describe('checkEpicCompleteness — epic scope isolation (T9502)', () => {
  describe('with scopedEpicId set', () => {
    it('returns hasIncomplete=false when all TEPIC_A children are in the release', async () => {
      await seedSiblingEpics();

      const result = await checkEpicCompleteness(
        ['TA1', 'TA2'],
        env.tempDir,
        env.accessor,
        [],
        'TEPIC_A',
      );

      expect(result.hasIncomplete).toBe(false);
      expect(result.orphanTasks).toHaveLength(0);
      // Only TEPIC_A should appear in the audit output — TEPIC_B is scoped out
      const auditedEpicIds = result.epics.map((e) => e.epicId);
      expect(auditedEpicIds).not.toContain('TEPIC_B');
    });

    it('does NOT flag TEPIC_B children as missing when scope is TEPIC_A', async () => {
      await seedSiblingEpics();

      // Simulate a release that only ships TEPIC_A work.
      // TEPIC_B's pending tasks (TB1, TB2) should be invisible to this check.
      const result = await checkEpicCompleteness(
        ['TA1', 'TA2'],
        env.tempDir,
        env.accessor,
        [],
        'TEPIC_A',
      );

      expect(result.hasIncomplete).toBe(false);
      // No missing children should reference TEPIC_B tasks
      const allMissing = result.epics.flatMap((e) => e.missingChildren.map((c) => c.id));
      expect(allMissing).not.toContain('TB1');
      expect(allMissing).not.toContain('TB2');
    });

    it('correctly excludes TEPIC_B tasks even when they appear in releaseTaskIds', async () => {
      await seedSiblingEpics();

      // Even if the release list accidentally includes TEPIC_B task IDs, the scope
      // filter must exclude them from the epicId mapping so TEPIC_B is never audited.
      const result = await checkEpicCompleteness(
        ['TA1', 'TA2', 'TB1'],
        env.tempDir,
        env.accessor,
        [],
        'TEPIC_A',
      );

      expect(result.hasIncomplete).toBe(false);
      const auditedEpicIds = result.epics.map((e) => e.epicId);
      expect(auditedEpicIds).not.toContain('TEPIC_B');
    });
  });

  describe('without scopedEpicId (legacy behavior regression)', () => {
    it('audits ALL epics referenced by releaseTaskIds when no scope is provided', async () => {
      await seedSiblingEpics();

      // Without a scope, TEPIC_A tasks in the release → TEPIC_A is audited.
      // TEPIC_B tasks are NOT in the release, so TEPIC_B does not appear in byEpic
      // (no release task maps to it). hasIncomplete is still false because TEPIC_B
      // children are pending (not done), so they are not flagged as missing.
      const result = await checkEpicCompleteness(
        ['TA1', 'TA2'],
        env.tempDir,
        env.accessor,
        [],
        // scopedEpicId intentionally omitted
      );

      // TEPIC_A is fully covered — hasIncomplete must be false
      expect(result.hasIncomplete).toBe(false);
    });

    it('detects missing done children when no scope is set and a done child is omitted', async () => {
      await seedTasks(env.accessor, [
        {
          id: 'EPIC_X',
          title: 'Epic X',
          type: 'epic',
          status: 'active',
          priority: 'high',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'TX1',
          title: 'Task X1',
          type: 'task',
          status: 'done',
          parentId: 'EPIC_X',
          priority: 'high',
          completedAt: '2026-01-10T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        },
        {
          id: 'TX2',
          title: 'Task X2 — done but not in release',
          type: 'task',
          status: 'done',
          parentId: 'EPIC_X',
          priority: 'medium',
          completedAt: '2026-01-11T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
        },
      ]);

      // TX2 is done but deliberately omitted from the release list
      const result = await checkEpicCompleteness(
        ['TX1'],
        env.tempDir,
        env.accessor,
        [],
        // no scopedEpicId
      );

      expect(result.hasIncomplete).toBe(true);
      const missingIds = result.epics.flatMap((e) => e.missingChildren.map((c) => c.id));
      expect(missingIds).toContain('TX2');
    });
  });
});
