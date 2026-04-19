/**
 * Tests for `computeTaskRollup` / `computeTaskRollups`.
 *
 * Exercises the canonical rollup contract end-to-end against a real
 * SQLite-backed DataAccessor. Each test seeds exactly the rows it needs and
 * relies on the `passGate()` helper to populate `lifecycle_gate_results`
 * (which also creates the matching `lifecycle_pipelines` and
 * `lifecycle_stages` rows transitively).
 *
 * @task T943
 */

import type { Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { passGate } from '../index.js';
import { computeTaskRollup, computeTaskRollups, type TaskRollup } from '../rollup.js';

const BASE_TIME = '2026-04-17T00:00:00.000Z';

function baseTask(overrides: Partial<Task> & { id: string }): Partial<Task> & { id: string } {
  return {
    title: overrides.title ?? `Task ${overrides.id}`,
    description: overrides.description ?? `Description for ${overrides.id}`,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    createdAt: overrides.createdAt ?? BASE_TIME,
    ...overrides,
  };
}

describe('computeTaskRollup', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns null for an unknown task id', async () => {
    const rollup = await computeTaskRollup('T999', accessor);
    expect(rollup).toBeNull();
  });

  it('rolls up a single leaf task with no children, no gates, no activity', async () => {
    await seedTasks(accessor, [baseTask({ id: 'T001', status: 'pending' })]);

    const rollup = await computeTaskRollup('T001', accessor);

    expect(rollup).not.toBeNull();
    const r = rollup as TaskRollup;
    expect(r.id).toBe('T001');
    expect(r.execStatus).toBe('pending');
    expect(r.pipelineStage).toBeNull();
    expect(r.gatesVerified).toEqual([]);
    expect(r.childrenTotal).toBe(0);
    expect(r.childrenDone).toBe(0);
    expect(r.blockedBy).toEqual([]);
    expect(r.lastActivityAt).toBeNull();
  });

  it('rolls up an epic with mixed child statuses and excludes archived children', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T100', type: 'epic', status: 'active' }),
      baseTask({ id: 'T101', parentId: 'T100', status: 'done' }),
      baseTask({ id: 'T102', parentId: 'T100', status: 'done' }),
      baseTask({ id: 'T103', parentId: 'T100', status: 'pending' }),
      baseTask({ id: 'T104', parentId: 'T100', status: 'blocked' }),
      baseTask({ id: 'T105', parentId: 'T100', status: 'archived' }),
    ]);

    const rollup = await computeTaskRollup('T100', accessor);
    expect(rollup).not.toBeNull();
    const r = rollup as TaskRollup;

    // Archived children (T105) excluded from both counts.
    expect(r.childrenTotal).toBe(4);
    expect(r.childrenDone).toBe(2);
    expect(r.execStatus).toBe('active');
  });

  it('counts only DIRECT children (nested grandchildren do not leak)', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T200', type: 'epic' }),
      baseTask({ id: 'T201', parentId: 'T200', type: 'task' }),
      baseTask({ id: 'T202', parentId: 'T201', status: 'done' }),
      baseTask({ id: 'T203', parentId: 'T201', status: 'done' }),
    ]);

    const rollup = await computeTaskRollup('T200', accessor);
    const r = rollup as TaskRollup;
    expect(r.childrenTotal).toBe(1);
    expect(r.childrenDone).toBe(0);
  });

  it('exposes tasks.pipelineStage verbatim on the rollup', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T300', status: 'active', pipelineStage: 'implementation' }),
    ]);

    const rollup = await computeTaskRollup('T300', accessor);
    expect((rollup as TaskRollup).pipelineStage).toBe('implementation');
  });

  it('parses blockedBy as a JSON array when stored that way', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T400', status: 'blocked', blockedBy: '["T001","T002"]' }),
    ]);

    const rollup = await computeTaskRollup('T400', accessor);
    expect((rollup as TaskRollup).blockedBy).toEqual(['T001', 'T002']);
  });

  it('parses blockedBy as comma-separated tokens when not JSON', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T401', status: 'blocked', blockedBy: 'T010, T011 ,T012' }),
    ]);

    const rollup = await computeTaskRollup('T401', accessor);
    expect((rollup as TaskRollup).blockedBy).toEqual(['T010', 'T011', 'T012']);
  });

  it('returns an empty blockedBy array when column is null', async () => {
    await seedTasks(accessor, [baseTask({ id: 'T402' })]);

    const rollup = await computeTaskRollup('T402', accessor);
    expect((rollup as TaskRollup).blockedBy).toEqual([]);
  });

  it('returns an empty gatesVerified when no gate results exist', async () => {
    await seedTasks(accessor, [baseTask({ id: 'T500' })]);

    const rollup = await computeTaskRollup('T500', accessor);
    expect((rollup as TaskRollup).gatesVerified).toEqual([]);
  });

  it('surfaces passed gate names from lifecycle_gate_results', async () => {
    await seedTasks(accessor, [baseTask({ id: 'T600', status: 'active' })]);

    await passGate('T600', 'research-spec-complete', 'test-agent', 'seeded', env.tempDir);
    await passGate('T600', 'implementation-smoke', 'test-agent', 'seeded', env.tempDir);

    const rollup = await computeTaskRollup('T600', accessor);
    const r = rollup as TaskRollup;
    expect(r.gatesVerified).toContain('research-spec-complete');
    expect(r.gatesVerified).toContain('implementation-smoke');
    expect(r.gatesVerified).toHaveLength(2);
  });

  it('computes lastActivityAt as max(updatedAt, completedAt)', async () => {
    const updated = '2026-04-17T10:00:00.000Z';
    const completed = '2026-04-17T12:00:00.000Z';
    await seedTasks(accessor, [
      baseTask({
        id: 'T700',
        status: 'done',
        updatedAt: updated,
        completedAt: completed,
        pipelineStage: 'contribution',
      }),
    ]);

    const rollup = await computeTaskRollup('T700', accessor);
    expect((rollup as TaskRollup).lastActivityAt).toBe(completed);
  });

  it('falls back to updatedAt when completedAt is unset', async () => {
    const updated = '2026-04-17T09:30:00.000Z';
    await seedTasks(accessor, [baseTask({ id: 'T701', status: 'active', updatedAt: updated })]);

    const rollup = await computeTaskRollup('T701', accessor);
    expect((rollup as TaskRollup).lastActivityAt).toBe(updated);
  });
});

describe('computeTaskRollups (batch)', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('returns an empty array when given no ids', async () => {
    const rollups = await computeTaskRollups([], accessor);
    expect(rollups).toEqual([]);
  });

  it('preserves input order when every id exists', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T001' }),
      baseTask({ id: 'T002' }),
      baseTask({ id: 'T003' }),
    ]);

    const rollups = await computeTaskRollups(['T003', 'T001', 'T002'], accessor);
    expect(rollups.map((r) => r.id)).toEqual(['T003', 'T001', 'T002']);
  });

  it('silently drops missing ids from the result', async () => {
    await seedTasks(accessor, [baseTask({ id: 'T001' })]);

    const rollups = await computeTaskRollups(['T001', 'T999'], accessor);
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.id).toBe('T001');
  });

  it('aggregates child counts for multiple epics in a single batch', async () => {
    await seedTasks(accessor, [
      baseTask({ id: 'T800', type: 'epic' }),
      baseTask({ id: 'T801', parentId: 'T800', status: 'done' }),
      baseTask({ id: 'T802', parentId: 'T800', status: 'pending' }),
      baseTask({ id: 'T803', parentId: 'T800', status: 'archived' }),
      baseTask({ id: 'T810', type: 'epic' }),
      baseTask({ id: 'T811', parentId: 'T810', status: 'done' }),
      baseTask({ id: 'T812', parentId: 'T810', status: 'done' }),
    ]);

    const rollups = await computeTaskRollups(['T800', 'T810'], accessor);
    const byId = new Map(rollups.map((r) => [r.id, r]));

    const r800 = byId.get('T800')!;
    expect(r800.childrenTotal).toBe(2);
    expect(r800.childrenDone).toBe(1);

    const r810 = byId.get('T810')!;
    expect(r810.childrenTotal).toBe(2);
    expect(r810.childrenDone).toBe(2);
  });
});
