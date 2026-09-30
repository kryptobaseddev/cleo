/**
 * Dependency-cycle guard (T12886).
 *
 * `tasks_task_dependencies` had foreign keys only: nothing refused an edge
 * that closed a cycle, and a cycle stalls every task on it (`cleo next`, ready
 * waves, orchestration). The guard is a pair of BEFORE triggers, so every
 * writer is covered, raw SQL included; the write chokepoint names the cycle.
 * `cleo doctor dep-cycles` reports cycles stored before the guard existed.
 *
 * @task T12886
 */

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanDependencyCycles } from '../../doctor/dependency-cycles.js';
import { CleoError } from '../../errors.js';
import { addTask } from '../../tasks/add.js';
import { updateTask } from '../../tasks/update.js';
import type { DataAccessor } from '../data-accessor.js';
import {
  DEPENDENCY_CYCLE_CODE,
  detectDependencyCycles,
  findClosedCycle,
} from '../dependency-cycles.js';
import { getNativeDb, resetDbState } from '../sqlite.js';
import { createTestDb, seedTasks, type TestDbEnv } from './test-db-helper.js';

const TRIGGERS = [
  'tasks_task_dependencies_cycle_guard_insert',
  'tasks_task_dependencies_cycle_guard_update',
] as const;

describe('dependency-cycle guard (T12886)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
    const createdAt = new Date().toISOString();
    await seedTasks(
      accessor,
      ['T001', 'T002', 'T003', 'T004', 'T005'].map((id) => ({
        id,
        title: `Task ${id}`,
        status: 'pending' as const,
        priority: 'medium' as const,
        createdAt,
      })),
    );
  });

  afterEach(async () => {
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  function native() {
    const db = getNativeDb(env.tempDir);
    if (!db) throw new Error('native db not open');
    return db;
  }

  function rawInsert(taskId: string, dependsOn: string): void {
    native()
      .prepare('INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES (?, ?)')
      .run(taskId, dependsOn);
  }

  function edges(): string[] {
    return (
      native()
        .prepare(
          "SELECT task_id || '->' || depends_on AS e FROM tasks_task_dependencies ORDER BY 1",
        )
        .all() as Array<{ e: string }>
    ).map((r) => r.e);
  }

  /** Run `fn`, expecting the named-cycle CleoError. */
  async function refused(fn: () => Promise<unknown>): Promise<CleoError> {
    try {
      await fn();
    } catch (err) {
      expect(err).toBeInstanceOf(CleoError);
      return err as CleoError;
    }
    throw new Error('expected the dependency to be refused');
  }

  it('the migration installs both triggers on the live store', () => {
    const names = (
      native()
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='tasks_task_dependencies'",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    for (const t of TRIGGERS) expect(names).toContain(t);
  });

  describe('cleo update --add-depends', () => {
    it('refuses a 2-node cycle and names it', async () => {
      await updateTask({ taskId: 'T001', addDepends: ['T002'] }, env.tempDir, accessor);
      const err = await refused(() =>
        updateTask({ taskId: 'T002', addDepends: ['T001'] }, env.tempDir, accessor),
      );
      expect(err.code).toBe(ExitCode.CIRCULAR_REFERENCE);
      expect(err.message).toContain(DEPENDENCY_CYCLE_CODE);
      expect(err.message).toContain('T002 → T001 → T002');
      expect(err.fix).toContain('cleo update T001 --remove-depends T002');
      expect(err.details?.['cycle']).toEqual(['T002', 'T001', 'T002']);
      expect(edges()).toEqual(['T001->T002']);
      expect((await accessor.loadSingleTask('T002'))?.depends ?? []).toEqual([]);
    });

    it('refuses a 3-node cycle and names it', async () => {
      await updateTask({ taskId: 'T001', addDepends: ['T002'] }, env.tempDir, accessor);
      await updateTask({ taskId: 'T002', addDepends: ['T003'] }, env.tempDir, accessor);
      const err = await refused(() =>
        updateTask({ taskId: 'T003', addDepends: ['T001'] }, env.tempDir, accessor),
      );
      expect(err.message).toContain('T003 → T001 → T002 → T003');
      expect(err.fix).toContain('cleo update T002 --remove-depends T003');
      expect(edges()).toEqual(['T001->T002', 'T002->T003']);
    });

    it('refuses a self-dependency', async () => {
      const err = await refused(() =>
        updateTask({ taskId: 'T001', addDepends: ['T001'] }, env.tempDir, accessor),
      );
      expect(err.message).toContain('T001 cannot depend on itself');
      expect(edges()).toEqual([]);
    });

    it('refuses the cycle-closing edge in a multi-edge update and writes none of it', async () => {
      await updateTask({ taskId: 'T002', addDepends: ['T003'] }, env.tempDir, accessor);
      const err = await refused(() =>
        updateTask({ taskId: 'T003', addDepends: ['T004', 'T002'] }, env.tempDir, accessor),
      );
      expect(err.message).toContain('T003 → T002 → T003');
      expect(edges()).toEqual(['T002->T003']);
    });

    it('allows a diamond (A→B, A→C, B→D, C→D)', async () => {
      await updateTask({ taskId: 'T001', addDepends: ['T002', 'T003'] }, env.tempDir, accessor);
      await updateTask({ taskId: 'T002', addDepends: ['T004'] }, env.tempDir, accessor);
      await updateTask({ taskId: 'T003', addDepends: ['T004'] }, env.tempDir, accessor);
      expect(edges()).toEqual(['T001->T002', 'T001->T003', 'T002->T004', 'T003->T004']);
      // Re-adding an edge already stored is a no-op, not a refusal.
      await updateTask({ taskId: 'T001', addDepends: ['T002', 'T005'] }, env.tempDir, accessor);
      expect(edges()).toContain('T001->T005');
    });
  });

  describe('cleo add --depends', () => {
    it('writes a diamond through --depends', async () => {
      await updateTask({ taskId: 'T002', addDepends: ['T004'] }, env.tempDir, accessor);
      await updateTask({ taskId: 'T003', addDepends: ['T004'] }, env.tempDir, accessor);
      const { task } = await addTask(
        {
          title: 'Diamond top',
          description: 'depends on both arms of the diamond',
          depends: ['T002', 'T003'],
          skipContainmentInvariant: true,
        },
        env.tempDir,
        accessor,
      );
      expect(edges()).toEqual(
        [`${task.id}->T002`, `${task.id}->T003`, 'T002->T004', 'T003->T004'].sort(),
      );
    });
  });

  describe('raw SQL (every writer)', () => {
    it('the trigger refuses a self-edge, a 2-cycle and a 3-cycle', () => {
      expect(() => rawInsert('T001', 'T001')).toThrow(DEPENDENCY_CYCLE_CODE);
      rawInsert('T001', 'T002');
      expect(() => rawInsert('T002', 'T001')).toThrow(DEPENDENCY_CYCLE_CODE);
      rawInsert('T002', 'T003');
      expect(() => rawInsert('T003', 'T001')).toThrow(DEPENDENCY_CYCLE_CODE);
      expect(edges()).toEqual(['T001->T002', 'T002->T003']);
    });

    it('the trigger allows a diamond', () => {
      rawInsert('T001', 'T002');
      rawInsert('T001', 'T003');
      rawInsert('T002', 'T004');
      rawInsert('T003', 'T004');
      expect(edges()).toHaveLength(4);
    });

    it('a multi-row INSERT that closes a cycle between its own rows is refused whole', () => {
      expect(() =>
        native().exec(
          "INSERT INTO tasks_task_dependencies (task_id, depends_on) VALUES ('T001','T002'), ('T002','T001')",
        ),
      ).toThrow(DEPENDENCY_CYCLE_CODE);
      expect(edges()).toEqual([]);
    });

    it('the UPDATE trigger refuses a re-point that closes a cycle and allows a harmless one', () => {
      rawInsert('T001', 'T002');
      rawInsert('T002', 'T003');
      const repoint = native().prepare(
        'UPDATE tasks_task_dependencies SET depends_on = ? WHERE task_id = ? AND depends_on = ?',
      );
      expect(() => repoint.run('T001', 'T002', 'T003')).toThrow(DEPENDENCY_CYCLE_CODE);
      // T002 → T003 becomes T002 → T004: its own OLD edge is not counted.
      repoint.run('T004', 'T002', 'T003');
      expect(edges()).toEqual(['T001->T002', 'T002->T004']);
    });
  });

  describe('cleo doctor dep-cycles', () => {
    it('reports no cycle on a clean store', async () => {
      await updateTask({ taskId: 'T001', addDepends: ['T002'] }, env.tempDir, accessor);
      const report = await scanDependencyCycles(env.tempDir);
      expect(report.cycleCount).toBe(0);
      expect(report.repairPlan).toEqual([]);
      expect(report.edgeCount).toBe(1);
    });

    it('reports stored cycles with a repair plan and changes nothing', async () => {
      // Plant cycles the way a pre-guard store holds them.
      const db = native();
      const saved = TRIGGERS.map(
        (name) =>
          (
            db
              .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?")
              .get(name) as {
              sql: string;
            }
          ).sql,
      );
      for (const name of TRIGGERS) db.exec(`DROP TRIGGER ${name}`);
      rawInsert('T001', 'T002');
      rawInsert('T002', 'T003');
      rawInsert('T003', 'T001');
      rawInsert('T004', 'T004');
      rawInsert('T005', 'T001');
      for (const sql of saved) db.exec(sql);
      const before = edges();

      const report = await scanDependencyCycles(env.tempDir);
      expect(report.readOnly).toBe(true);
      expect(report.cycleCount).toBe(2);
      expect(report.components.map((c) => c.tasks)).toEqual([['T001', 'T002', 'T003'], ['T004']]);
      expect(report.components[0]?.cycle).toEqual(['T001', 'T002', 'T003', 'T001']);
      expect(report.components[1]?.cycle).toEqual(['T004', 'T004']);
      expect(report.repairPlan.map((r) => r.command)).toEqual([
        'cleo update T003 --remove-depends T001',
        'cleo update T004 --remove-depends T004',
      ]);
      expect(edges()).toEqual(before);

      // Applying the plan leaves the graph acyclic.
      const remaining = before
        .map((e) => e.split('->') as [string, string])
        .filter(
          ([a, b]) => !report.repairPlan.some((r) => r.edge.taskId === a && r.edge.dependsOn === b),
        )
        .map(([taskId, dependsOn]) => ({ taskId, dependsOn }));
      expect(detectDependencyCycles(remaining).components).toEqual([]);
    });
  });
});

describe('findClosedCycle / detectDependencyCycles (pure)', () => {
  it('finds the shortest closing path', () => {
    const edges = [
      { taskId: 'B', dependsOn: 'C' },
      { taskId: 'C', dependsOn: 'A' },
      { taskId: 'B', dependsOn: 'A' },
    ];
    expect(findClosedCycle(edges, { taskId: 'A', dependsOn: 'B' })).toEqual(['A', 'B', 'A']);
    expect(findClosedCycle(edges, { taskId: 'A', dependsOn: 'D' })).toBeNull();
  });

  it('handles a 20 000-edge chain without recursion', () => {
    const edges = Array.from({ length: 20_000 }, (_, i) => ({
      taskId: `T${i}`,
      dependsOn: `T${i + 1}`,
    }));
    expect(detectDependencyCycles(edges).components).toEqual([]);
    edges.push({ taskId: 'T20000', dependsOn: 'T0' });
    const report = detectDependencyCycles(edges);
    expect(report.components).toHaveLength(1);
    expect(report.repairPlan).toHaveLength(1);
  });
});
