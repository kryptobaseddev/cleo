/**
 * Regression tests for computeTaskView — canonical task view derivation (T943).
 *
 * Verifies that the unified `computeTaskView` / `computeTaskViews` functions
 * return identical `status` + `pipelineStage` for the same task regardless of
 * which surface is calling them, and that all derived fields (`gatesStatus`,
 * `childRollup`, `lifecycleProgress`, `readyToComplete`, `nextAction`) are
 * computed correctly.
 *
 * @task T943
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { computeTaskView, computeTaskViews, type TaskView } from '../compute-task-view.js';

describe('computeTaskView', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ─── basic projection ────────────────────────────────────────────────────────

  it('returns null for a missing task', async () => {
    await seedTasks(accessor, []);
    const view = await computeTaskView('T999', accessor);
    expect(view).toBeNull();
  });

  it('returns a view with correct id, title, status, pipelineStage', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Impl task',
        status: 'active',
        priority: 'high',
        pipelineStage: 'implementation',
      },
    ]);
    const view = await computeTaskView('T001', accessor);
    expect(view).not.toBeNull();
    const v = view!;
    expect(v.id).toBe('T001');
    expect(v.title).toBe('Impl task');
    expect(v.status).toBe('active');
    expect(v.pipelineStage).toBe('implementation');
  });

  it('returns null pipelineStage when column is not set', async () => {
    await seedTasks(accessor, [
      {
        id: 'T010',
        title: 'No stage',
        status: 'pending',
        priority: 'low',
      },
    ]);
    const view = await computeTaskView('T010', accessor);
    expect(view?.pipelineStage).toBeNull();
  });

  // ─── childRollup ─────────────────────────────────────────────────────────────

  it('childRollup counts non-archived direct children only', async () => {
    await seedTasks(accessor, [
      { id: 'T100', title: 'Epic', status: 'active', priority: 'high', type: 'epic' },
      {
        id: 'T101',
        title: 'Child pending',
        status: 'pending',
        priority: 'medium',
        parentId: 'T100',
      },
      {
        id: 'T102',
        title: 'Child done',
        status: 'done',
        priority: 'medium',
        parentId: 'T100',
        pipelineStage: 'contribution',
      },
      {
        id: 'T103',
        title: 'Child blocked',
        status: 'blocked',
        priority: 'medium',
        parentId: 'T100',
      },
      { id: 'T104', title: 'Child active', status: 'active', priority: 'medium', parentId: 'T100' },
    ]);

    const view = await computeTaskView('T100', accessor);
    expect(view?.childRollup.total).toBe(4);
    expect(view?.childRollup.done).toBe(1);
    expect(view?.childRollup.blocked).toBe(1);
    expect(view?.childRollup.active).toBe(1);
  });

  it('childRollup is all-zero for a leaf task', async () => {
    await seedTasks(accessor, [
      { id: 'T200', title: 'Leaf', status: 'pending', priority: 'medium' },
    ]);
    const view = await computeTaskView('T200', accessor);
    expect(view?.childRollup).toEqual({ total: 0, done: 0, blocked: 0, active: 0 });
  });

  // ─── gatesStatus ─────────────────────────────────────────────────────────────

  it('gatesStatus defaults to all false when no verification record exists', async () => {
    await seedTasks(accessor, [
      { id: 'T300', title: 'No verify', status: 'pending', priority: 'medium' },
    ]);
    const view = await computeTaskView('T300', accessor);
    expect(view?.gatesStatus).toEqual({
      implemented: false,
      testsPassed: false,
      qaPassed: false,
    });
  });

  it('gatesStatus reflects verification gate values', async () => {
    await seedTasks(accessor, [
      {
        id: 'T301',
        title: 'Verified',
        status: 'active',
        priority: 'high',
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: false },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T301', accessor);
    expect(view?.gatesStatus.implemented).toBe(true);
    expect(view?.gatesStatus.testsPassed).toBe(true);
    expect(view?.gatesStatus.qaPassed).toBe(false);
  });

  it('gatesStatus includes documented when it is present in verification', async () => {
    await seedTasks(accessor, [
      {
        id: 'T302',
        title: 'Documented',
        status: 'active',
        priority: 'medium',
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true, documented: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T302', accessor);
    expect(view?.gatesStatus.documented).toBe(true);
  });

  // ─── lifecycleProgress ───────────────────────────────────────────────────────

  it('lifecycleProgress defaults to empty when no pipeline exists', async () => {
    await seedTasks(accessor, [
      { id: 'T400', title: 'No pipeline', status: 'pending', priority: 'medium' },
    ]);
    const view = await computeTaskView('T400', accessor);
    expect(view?.lifecycleProgress).toEqual({
      stagesCompleted: [],
      stagesSkipped: [],
      currentStage: null,
    });
  });

  // ─── readyToComplete ─────────────────────────────────────────────────────────

  it('readyToComplete is false when status is already done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T500',
        title: 'Done',
        status: 'done',
        priority: 'medium',
        pipelineStage: 'contribution',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T500', accessor);
    expect(view?.readyToComplete).toBe(false);
  });

  it('readyToComplete is false when required gates are not all green', async () => {
    await seedTasks(accessor, [
      {
        id: 'T501',
        title: 'Partial gates',
        status: 'active',
        priority: 'high',
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true, testsPassed: false, qaPassed: false },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T501', accessor);
    expect(view?.readyToComplete).toBe(false);
  });

  it('readyToComplete is true when gates all green, no blocking deps, non-terminal status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T502',
        title: 'Ready',
        status: 'active',
        priority: 'high',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T502', accessor);
    expect(view?.readyToComplete).toBe(true);
  });

  it('readyToComplete is false when unresolved deps exist', async () => {
    await seedTasks(accessor, [
      {
        id: 'T503',
        title: 'Dep task',
        status: 'pending',
        priority: 'medium',
      },
      {
        id: 'T504',
        title: 'Blocked task',
        status: 'active',
        priority: 'high',
        depends: ['T503'],
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T504', accessor);
    expect(view?.readyToComplete).toBe(false);
  });

  it('readyToComplete is true when all deps are done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T505',
        title: 'Done dep',
        status: 'done',
        priority: 'medium',
        pipelineStage: 'contribution',
      },
      {
        id: 'T506',
        title: 'Task with done dep',
        status: 'active',
        priority: 'high',
        depends: ['T505'],
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T506', accessor);
    expect(view?.readyToComplete).toBe(true);
  });

  // ─── nextAction ──────────────────────────────────────────────────────────────

  it('nextAction is already-complete for a done task', async () => {
    await seedTasks(accessor, [
      {
        id: 'T600',
        title: 'Done',
        status: 'done',
        priority: 'medium',
        pipelineStage: 'contribution',
      },
    ]);
    const view = await computeTaskView('T600', accessor);
    expect(view?.nextAction).toBe('already-complete');
  });

  it('nextAction is blocked-on-deps when unresolved deps exist', async () => {
    await seedTasks(accessor, [
      { id: 'T601', title: 'Pending dep', status: 'pending', priority: 'medium' },
      { id: 'T602', title: 'Blocked', status: 'active', priority: 'high', depends: ['T601'] },
    ]);
    const view = await computeTaskView('T602', accessor);
    expect(view?.nextAction).toBe('blocked-on-deps');
  });

  it('nextAction is awaiting-children when epic has non-done children', async () => {
    await seedTasks(accessor, [
      { id: 'T603', title: 'Epic', status: 'active', priority: 'high', type: 'epic' },
      { id: 'T604', title: 'Child', status: 'pending', priority: 'medium', parentId: 'T603' },
    ]);
    const view = await computeTaskView('T603', accessor);
    expect(view?.nextAction).toBe('awaiting-children');
  });

  it('nextAction is verify when required gates are not all green', async () => {
    await seedTasks(accessor, [
      {
        id: 'T605',
        title: 'Needs verify',
        status: 'active',
        priority: 'high',
        verification: {
          passed: false,
          round: 1,
          gates: { implemented: true, testsPassed: false, qaPassed: false },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T605', accessor);
    expect(view?.nextAction).toBe('verify');
  });

  it('nextAction is spawn-worker when gates are all green and no blocking conditions', async () => {
    await seedTasks(accessor, [
      {
        id: 'T606',
        title: 'Ready to spawn',
        status: 'active',
        priority: 'high',
        verification: {
          passed: true,
          round: 1,
          gates: { implemented: true, testsPassed: true, qaPassed: true },
          lastAgent: null,
          lastUpdated: null,
          failureLog: [],
        },
      },
    ]);
    const view = await computeTaskView('T606', accessor);
    expect(view?.nextAction).toBe('spawn-worker');
  });

  // ─── computeTaskViews batch ──────────────────────────────────────────────────

  it('computeTaskViews returns views in input order, excluding missing IDs', async () => {
    await seedTasks(accessor, [
      { id: 'T700', title: 'First', status: 'pending', priority: 'medium' },
      { id: 'T702', title: 'Third', status: 'active', priority: 'high' },
    ]);

    const views = await computeTaskViews(['T700', 'T701', 'T702'], accessor);
    // T701 is missing, so only T700 and T702 appear.
    expect(views).toHaveLength(2);
    expect(views[0]!.id).toBe('T700');
    expect(views[1]!.id).toBe('T702');
  });

  it('computeTaskViews returns empty array for empty input', async () => {
    await seedTasks(accessor, []);
    const views = await computeTaskViews([], accessor);
    expect(views).toHaveLength(0);
  });

  // ─── parity assertion (T943 regression core) ─────────────────────────────────

  it('computeTaskView and computeTaskViews return identical status+pipelineStage', async () => {
    await seedTasks(accessor, [
      {
        id: 'T800',
        title: 'Parity task',
        status: 'active',
        priority: 'critical',
        pipelineStage: 'testing',
      },
    ]);

    const singleView: TaskView | null = await computeTaskView('T800', accessor);
    const batchViews: TaskView[] = await computeTaskViews(['T800'], accessor);

    expect(singleView).not.toBeNull();
    expect(batchViews).toHaveLength(1);

    // Status parity — the core T943 regression.
    expect(batchViews[0]!.status).toBe(singleView!.status);
    expect(batchViews[0]!.pipelineStage).toBe(singleView!.pipelineStage);

    // Full structural parity.
    expect(batchViews[0]).toEqual(singleView);
  });

  it('multiple tasks returned by computeTaskViews have consistent status+pipelineStage with single calls', async () => {
    await seedTasks(accessor, [
      {
        id: 'T810',
        title: 'Alpha',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
      },
      {
        id: 'T811',
        title: 'Beta',
        status: 'active',
        priority: 'high',
        pipelineStage: 'implementation',
      },
    ]);

    const [view810, view811] = await Promise.all([
      computeTaskView('T810', accessor),
      computeTaskView('T811', accessor),
    ]);
    const batchViews = await computeTaskViews(['T810', 'T811'], accessor);

    expect(batchViews[0]).toEqual(view810);
    expect(batchViews[1]).toEqual(view811);
  });
});
