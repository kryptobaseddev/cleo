/**
 * T10634 acceptance coverage for WorkGraph planning doc generator.
 *
 * Locks:
 * - AC1 — plan doc draft generated from saga structure (saga + epics + tasks
 *         produce structured markdown with overview, epic breakdown, ready/blocked lists)
 * - AC2 — docs SSoT attachment supported (result includes structured entries
 *         suitable for `cleo docs add` attachment)
 * - AC3 — agent/maintainer audience modes (agent mode produces compact output,
 *         maintainer mode produces descriptive prose with recommendations)
 *
 * @task T10634
 * @saga T10538
 * @epic T10547
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tempDir: string;

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    title: `Task ${overrides.id}`,
    description: overrides.description ?? `Description for task ${overrides.id}`,
    status: 'pending',
    priority: 'medium',
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Task;
}

// ---------------------------------------------------------------------------
// Isolated DB setup
// ---------------------------------------------------------------------------

describe('WorkGraph planning doc generator', () => {
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'cleo-planning-doc-'));
    const cleoDir = join(tempDir, '.cleo');
    process.env['CLEO_DIR'] = cleoDir;

    await mkdir(cleoDir, { recursive: true });
    await writeFile(
      join(cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );

    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
  });

  afterEach(async () => {
    const { closeDb } = await import('../../store/sqlite.js');
    closeDb();
    await new Promise((r) => setTimeout(r, 50));
    try {
      const { closeBrainDb } = await import('../../store/memory-sqlite.js');
      closeBrainDb();
    } catch {
      /* ignore */
    }
    delete process.env['CLEO_DIR'];
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  });

  // -----------------------------------------------------------------------
  // AC1 — plan doc draft generated from saga structure
  // -----------------------------------------------------------------------

  describe('AC1 — plan doc draft generated from saga structure', () => {
    it('generates a markdown document for a saga with epics and tasks', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      // Seed saga + 2 epics + tasks
      await createTask(
        makeTask({
          id: 'SG-TEST',
          title: 'Test Saga',
          type: 'saga',
          description: 'A test saga for planning doc generation',
          status: 'active',
        }),
      );

      // Epic 1 — done
      await createTask(
        makeTask({
          id: 'EP-1',
          title: 'First Epic',
          type: 'epic',
          parentId: 'SG-TEST',
          status: 'done',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-1A',
          title: 'Task 1A — done',
          type: 'task',
          parentId: 'EP-1',
          status: 'done',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-1B',
          title: 'Task 1B — done',
          type: 'task',
          parentId: 'EP-1',
          status: 'done',
        }),
      );

      // Epic 2 — active with mixed children
      await createTask(
        makeTask({
          id: 'EP-2',
          title: 'Second Epic',
          type: 'epic',
          parentId: 'SG-TEST',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-2A',
          title: 'Task 2A — active',
          type: 'task',
          parentId: 'EP-2',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-2B',
          title: 'Task 2B — pending',
          type: 'task',
          parentId: 'EP-2',
          status: 'pending',
          depends: ['T-2A'],
        }),
      );
      await createTask(
        makeTask({
          id: 'T-2C',
          title: 'Task 2C — pending, ready',
          type: 'task',
          parentId: 'EP-2',
          status: 'pending',
          depends: [],
        }),
      );

      const result = await generatePlanningDoc(tempDir, { sagaId: 'SG-TEST' });

      // Basic structure assertions
      expect(result.sagaId).toBe('SG-TEST');
      expect(result.sagaTitle).toBe('Test Saga');
      expect(result.audience).toBe('maintainer');
      expect(result.estimatedTokens).toBeGreaterThan(0);
      expect(result.generatedAt).toBeTruthy();
      expect(result.markdown).toContain('Test Saga');
      expect(result.markdown).toContain('SG-TEST');

      // Epic entries
      expect(result.epics).toHaveLength(2);

      const ep1 = result.epics.find((e) => e.epicId === 'EP-1');
      expect(ep1).toBeDefined();
      expect(ep1!.completionPct).toBe(100);
      expect(ep1!.doneChildren).toBe(2);
      expect(ep1!.totalChildren).toBe(2);

      const ep2 = result.epics.find((e) => e.epicId === 'EP-2');
      expect(ep2).toBeDefined();
      expect(ep2!.completionPct).toBe(0);
      expect(ep2!.doneChildren).toBe(0);
      expect(ep2!.activeChildren).toBe(1);
      expect(ep2!.pendingChildren).toBe(2);

      // Ready task
      const ready = result.readyTasks.find((t) => t.id === 'T-2C');
      expect(ready).toBeDefined();
      expect(ready!.epicId).toBe('EP-2');
      expect(ready!.depends).toEqual([]);

      // Blocked task
      const blocked = result.blockedTasks.find((t) => t.id === 'T-2B');
      expect(blocked).toBeDefined();
      expect(blocked!.blockedBy).toEqual(['T-2A']);
    });

    it('handles empty saga (no member epics)', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({
          id: 'SG-EMPTY',
          title: 'Empty Saga',
          type: 'saga',
          description: 'Saga with no members',
          status: 'active',
        }),
      );

      const result = await generatePlanningDoc(tempDir, { sagaId: 'SG-EMPTY' });

      expect(result.epics).toHaveLength(0);
      expect(result.readyTasks).toHaveLength(0);
      expect(result.blockedTasks).toHaveLength(0);
      expect(result.markdown).toContain('Empty Saga');
    });

    it('throws when saga is not found', async () => {
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await expect(
        generatePlanningDoc(tempDir, { sagaId: 'NONEXISTENT' }),
      ).rejects.toThrow(/not found/);
    });
  });

  // -----------------------------------------------------------------------
  // AC2 — docs SSoT attachment supported
  // -----------------------------------------------------------------------

  describe('AC2 — docs SSoT attachment supported', () => {
    it('result includes structured entries suitable for attachment', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({ id: 'SG-SSOT', title: 'SSoT Saga', type: 'saga', status: 'active' }),
      );
      await createTask(
        makeTask({
          id: 'EP-SSOT',
          title: 'SSoT Epic',
          type: 'epic',
          parentId: 'SG-SSOT',
          status: 'done',
        }),
      );

      const result = await generatePlanningDoc(tempDir, { sagaId: 'SG-SSOT' });

      // AC2: result carries structured data for attachment
      expect(result.markdown).toBeTruthy();
      expect(result.epics).toBeDefined();
      expect(result.readyTasks).toBeDefined();
      expect(result.blockedTasks).toBeDefined();
      expect(result.sagaId).toBe('SG-SSOT');
      expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // Epics have the right shape for attachment metadata
      for (const epic of result.epics) {
        expect(epic.epicId).toBeTruthy();
        expect(epic.title).toBeTruthy();
        expect(epic.status).toBeTruthy();
        expect(typeof epic.completionPct).toBe('number');
        expect(typeof epic.totalChildren).toBe('number');
      }

      // Ready tasks have attachment-ready shape
      for (const task of result.readyTasks) {
        expect(task.id).toBeTruthy();
        expect(task.title).toBeTruthy();
        expect(task.priority).toBeTruthy();
        expect(task.epicId).toBeTruthy();
        expect(Array.isArray(task.depends)).toBe(true);
      }
    });

    it('generated markdown has consistent header/footer for SSoT indexing', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({ id: 'SG-IDX', title: 'Index Saga', type: 'saga', status: 'active' }),
      );

      const result = await generatePlanningDoc(tempDir, { sagaId: 'SG-IDX' });

      // Has planning document header
      expect(result.markdown).toContain('Planning Document');
      // Has overview section
      expect(result.markdown).toContain('## Overview');
      // Has epic breakdown section
      expect(result.markdown).toContain('## Epic Breakdown');
      // Has generated-by footer
      expect(result.markdown).toContain('Generated by CLEO');
      expect(result.markdown).toContain('T10634');
    });
  });

  // -----------------------------------------------------------------------
  // AC3 — agent/maintainer audience modes
  // -----------------------------------------------------------------------

  describe('AC3 — agent/maintainer audience modes', () => {
    it('agent mode produces compact output with structured lists', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({
          id: 'SG-MODE',
          title: 'Mode Test Saga',
          type: 'saga',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'EP-M1',
          title: 'Mode Epic 1',
          type: 'epic',
          parentId: 'SG-MODE',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-M1A',
          title: 'Ready task for mode test',
          type: 'task',
          parentId: 'EP-M1',
          status: 'pending',
          depends: [],
          priority: 'high',
        }),
      );

      const agentResult = await generatePlanningDoc(tempDir, {
        sagaId: 'SG-MODE',
        audience: 'agent',
      });
      const maintainerResult = await generatePlanningDoc(tempDir, {
        sagaId: 'SG-MODE',
        audience: 'maintainer',
      });

      // Both produce output
      expect(agentResult.markdown).toBeTruthy();
      expect(maintainerResult.markdown).toBeTruthy();
      expect(agentResult.audience).toBe('agent');
      expect(maintainerResult.audience).toBe('maintainer');

      // Agent mode is more compact
      expect(agentResult.estimatedTokens).toBeLessThanOrEqual(
        maintainerResult.estimatedTokens,
      );

      // Agent mode uses compact formatting
      expect(agentResult.markdown).toContain('## ');
      expect(agentResult.markdown).not.toContain('**Status:**');

      // Maintainer mode uses descriptive prose
      expect(maintainerResult.markdown).toContain('# Planning Document');
      expect(maintainerResult.markdown).toContain('**Status:**');
      expect(maintainerResult.markdown).toContain('## Recommendations');
    });

    it('agent mode includes ready and blocked tasks in compact format', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({ id: 'SG-AG', title: 'Agent Saga', type: 'saga', status: 'active' }),
      );
      await createTask(
        makeTask({
          id: 'EP-AG',
          title: 'Agent Epic',
          type: 'epic',
          parentId: 'SG-AG',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-AG-READY',
          title: 'Agent mode ready task',
          type: 'task',
          parentId: 'EP-AG',
          status: 'pending',
          depends: [],
          priority: 'high',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-AG-BLOCKED',
          title: 'Agent mode blocked task',
          type: 'task',
          parentId: 'EP-AG',
          status: 'blocked',
          depends: ['T-AG-READY'],
          priority: 'medium',
        }),
      );

      const result = await generatePlanningDoc(tempDir, {
        sagaId: 'SG-AG',
        audience: 'agent',
      });

      // Has ready section
      expect(result.markdown).toContain('### Ready');
      expect(result.markdown).toContain('T-AG-READY');
      expect(result.markdown).toContain('(high)');

      // Has blocked section
      expect(result.markdown).toContain('### Blocked');
      expect(result.markdown).toContain('T-AG-BLOCKED');

      // Has overall metrics
      expect(result.markdown).toContain('Overall:');
      expect(result.markdown).toContain('Ready:');
      expect(result.markdown).toContain('Blocked:');
    });

    it('maintainer mode includes recommendations section', async () => {
      const { createTask } = await import('../../store/tasks-sqlite.js');
      const { generatePlanningDoc } = await import('../scaffold-plan.js');

      await createTask(
        makeTask({
          id: 'SG-REC',
          title: 'Recommendation Saga',
          type: 'saga',
          status: 'active',
        }),
      );
      await createTask(
        makeTask({
          id: 'EP-REC',
          title: 'Rec Epic',
          type: 'epic',
          parentId: 'SG-REC',
          status: 'active',
        }),
      );
      // Multiple ready tasks to trigger parallelization recommendation
      await createTask(
        makeTask({
          id: 'T-REC-R1',
          title: 'Ready task 1',
          type: 'task',
          parentId: 'EP-REC',
          status: 'pending',
          depends: [],
          priority: 'high',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-REC-R2',
          title: 'Ready task 2',
          type: 'task',
          parentId: 'EP-REC',
          status: 'pending',
          depends: [],
          priority: 'medium',
        }),
      );
      await createTask(
        makeTask({
          id: 'T-REC-R3',
          title: 'Ready task 3',
          type: 'task',
          parentId: 'EP-REC',
          status: 'pending',
          depends: [],
          priority: 'low',
        }),
      );
      // Blocked task
      await createTask(
        makeTask({
          id: 'T-REC-BLOCKED',
          title: 'Blocked task',
          type: 'task',
          parentId: 'EP-REC',
          status: 'blocked',
          depends: ['T-REC-R1'],
          priority: 'medium',
        }),
      );

      const result = await generatePlanningDoc(tempDir, {
        sagaId: 'SG-REC',
        audience: 'maintainer',
      });

      // Has recommendations
      expect(result.markdown).toContain('## Recommendations');
      // Mentions ready tasks
      expect(result.markdown).toContain('T-REC-R1');
      // Mentions blocked task
      expect(result.markdown).toContain('blocked');
      // Has parallelization recommendation
      expect(result.markdown).toContain('Parallelize');
      // Has unblock recommendation
      expect(result.markdown).toContain('Unblock');
    });
  });
});
