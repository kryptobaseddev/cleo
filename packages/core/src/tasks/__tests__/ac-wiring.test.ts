/**
 * End-to-end coverage for the AC dual-write integration.
 *
 * Verifies that the addTask + updateTask handlers correctly:
 *   1. Insert AC rows into `task_acceptance_criteria` on creation.
 *   2. Generate UUIDv4 per AC and 1-based ordinals matching input order.
 *   3. Dual-write the legacy `tasks.acceptance` string in lock-step.
 *   4. Append history rows BEFORE deleting on shrink/replace-all updates.
 *   5. Keep extend updates ordinal-monotonic (never reuse ordinals).
 *
 * Covers the four canonical update paths called out in T10508 ACs:
 *   create-new, update-extend, update-shrink, update-replace-all.
 *
 * @adr ADR-079-r1 §2.2 — ordinal monotonicity, never reused
 * @epic T10381
 * @saga T10377
 * @task T10508
 * @decision D013
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { resetDbState } from '../../store/sqlite.js';
import { addTask } from '../add.js';
import { updateTask } from '../update.js';

describe('addTask — AC dual-write (T10508)', () => {
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

  it('writes AC rows with UUIDs + 1-based ordinals on create', async () => {
    const result = await addTask(
      {
        title: 'AC create test',
        description: 'Creates with three ACs',
        acceptance: ['First AC', 'Second AC', 'Third AC'],
      },
      env.tempDir,
      accessor,
    );

    const rows = await accessor.getAcRows(result.task.id);
    expect(rows).toHaveLength(3);
    expect(rows[0].ordinal).toBe(1);
    expect(rows[1].ordinal).toBe(2);
    expect(rows[2].ordinal).toBe(3);
    expect(rows[0].text).toBe('First AC');
    expect(rows[1].text).toBe('Second AC');
    expect(rows[2].text).toBe('Third AC');

    // Every AC row id is a UUIDv4.
    for (const r of rows) {
      expect(r.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    // All ids are unique.
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it('keeps the legacy acceptance string in sync (dual-write)', async () => {
    const result = await addTask(
      {
        title: 'AC dual-write check',
        description: 'Dual-write the legacy string column too',
        acceptance: ['Alpha', 'Beta'],
      },
      env.tempDir,
      accessor,
    );
    // Legacy string field is mirrored on the in-memory task.
    expect(result.task.acceptance).toEqual(['Alpha', 'Beta']);

    // Reloading the task from the DB yields the same legacy field.
    const reloaded = await accessor.loadSingleTask(result.task.id);
    expect(reloaded?.acceptance).toEqual(['Alpha', 'Beta']);

    // AND the new table has matching rows.
    const rows = await accessor.getAcRows(result.task.id);
    expect(rows.map((r) => r.text)).toEqual(['Alpha', 'Beta']);
  });

  it('no AC rows written when --acceptance omitted', async () => {
    const result = await addTask(
      { title: 'No AC task', description: 'No acceptance criteria here' },
      env.tempDir,
      accessor,
    );
    const rows = await accessor.getAcRows(result.task.id);
    expect(rows).toEqual([]);
  });
});

describe('updateTask — AC dual-write update paths (T10508)', () => {
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

  it('update-extend: appends new AC at maxOrdinal+1 (no shift, no history)', async () => {
    const created = await addTask(
      {
        title: 'Extend me',
        description: 'Starts with two ACs, gains a third',
        acceptance: ['AC1', 'AC2'],
      },
      env.tempDir,
      accessor,
    );
    const beforeRows = await accessor.getAcRows(created.task.id);
    const originalIds = new Set(beforeRows.map((r) => r.id));

    await updateTask(
      {
        taskId: created.task.id,
        acceptance: ['AC1', 'AC2', 'AC3'],
        reason: 'T10508 unit test — extend path',
      },
      env.tempDir,
      accessor,
    );

    const afterRows = await accessor.getAcRows(created.task.id);
    expect(afterRows).toHaveLength(3);
    expect(afterRows.map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(afterRows.map((r) => r.text)).toEqual(['AC1', 'AC2', 'AC3']);

    // Original rows preserved by id (no shift) — the new tail has a fresh id.
    expect(originalIds.has(afterRows[0].id)).toBe(true);
    expect(originalIds.has(afterRows[1].id)).toBe(true);
    expect(originalIds.has(afterRows[2].id)).toBe(false);

    // Legacy field stays in sync.
    const reloaded = await accessor.loadSingleTask(created.task.id);
    expect(reloaded?.acceptance).toEqual(['AC1', 'AC2', 'AC3']);
  });

  it('update-shrink: trailing ACs move to history with reason="edit" BEFORE delete', async () => {
    const created = await addTask(
      {
        title: 'Shrink me',
        description: 'Starts with three ACs, drops to one',
        acceptance: ['AC1-keep', 'AC2-drop', 'AC3-drop'],
      },
      env.tempDir,
      accessor,
    );
    const beforeRows = await accessor.getAcRows(created.task.id);
    const ac2Id = beforeRows.find((r) => r.ordinal === 2)!.id;
    const ac3Id = beforeRows.find((r) => r.ordinal === 3)!.id;

    await updateTask(
      {
        taskId: created.task.id,
        acceptance: ['AC1-keep'],
        reason: 'T10508 unit test — shrink path',
      },
      env.tempDir,
      accessor,
    );

    const afterRows = await accessor.getAcRows(created.task.id);
    expect(afterRows).toHaveLength(1);
    expect(afterRows[0].ordinal).toBe(1);
    expect(afterRows[0].text).toBe('AC1-keep');
    // Kept row preserved its UUID — satisfies-binding stability.
    expect(afterRows[0].id).toBe(beforeRows[0].id);

    // History captured the two dropped rows with previousText + reason='edit'.
    // Read history via raw SQL using the same native handle.
    const { getNativeTasksDb } = await import('../../store/sqlite.js');
    const native = getNativeTasksDb();
    expect(native).toBeTruthy();
    const historyRows = native!
      .prepare(
        'SELECT ac_id, previous_text, reason FROM task_acceptance_criteria_history ORDER BY id ASC',
      )
      .all() as Array<{ ac_id: string; previous_text: string; reason: string }>;
    expect(historyRows).toHaveLength(2);
    expect(historyRows.map((h) => h.ac_id)).toEqual([ac2Id, ac3Id]);
    expect(historyRows.map((h) => h.previous_text)).toEqual(['AC2-drop', 'AC3-drop']);
    expect(historyRows.every((h) => h.reason === 'edit')).toBe(true);

    // Legacy field shrunk in lock-step.
    const reloaded = await accessor.loadSingleTask(created.task.id);
    expect(reloaded?.acceptance).toEqual(['AC1-keep']);
  });

  it('update-replace-all: every existing row → history, every new row inserted from ordinal=1', async () => {
    const created = await addTask(
      {
        title: 'Replace me',
        description: 'Wholesale rewrite with new text',
        acceptance: ['Old A', 'Old B'],
      },
      env.tempDir,
      accessor,
    );
    const beforeRows = await accessor.getAcRows(created.task.id);
    const oldIds = beforeRows.map((r) => r.id);

    await updateTask(
      {
        taskId: created.task.id,
        acceptance: ['New A', 'New B'],
        reason: 'T10508 unit test — replace-all path',
      },
      env.tempDir,
      accessor,
    );

    const afterRows = await accessor.getAcRows(created.task.id);
    expect(afterRows).toHaveLength(2);
    expect(afterRows.map((r) => r.text)).toEqual(['New A', 'New B']);
    expect(afterRows.map((r) => r.ordinal)).toEqual([1, 2]);
    // Brand-new UUIDs (no id stability across replace-all).
    expect(afterRows.every((r) => !oldIds.includes(r.id))).toBe(true);

    // History captured both old rows.
    const { getNativeTasksDb } = await import('../../store/sqlite.js');
    const native = getNativeTasksDb();
    const historyRows = native!
      .prepare(
        'SELECT ac_id, previous_text, reason FROM task_acceptance_criteria_history ORDER BY id ASC',
      )
      .all() as Array<{ ac_id: string; previous_text: string; reason: string }>;
    expect(historyRows).toHaveLength(2);
    expect(historyRows.map((h) => h.previous_text)).toEqual(['Old A', 'Old B']);
    expect(historyRows.every((h) => h.reason === 'edit')).toBe(true);
    expect(historyRows.map((h) => h.ac_id).sort()).toEqual([...oldIds].sort());

    // Legacy field replaced.
    const reloaded = await accessor.loadSingleTask(created.task.id);
    expect(reloaded?.acceptance).toEqual(['New A', 'New B']);
  });

  it('update is transactional — history append precedes delete for shrink', async () => {
    // This invariant is enforced by the planner ordering (appendAcHistory
    // is called BEFORE deleteAcRowsForTask inside applyAcPlan) and by the
    // surrounding `acc.transaction` wrap. If either statement failed
    // mid-flow, the whole transaction would roll back; this test simply
    // confirms the final state matches the expected order under success.
    const created = await addTask(
      {
        title: 'Order check',
        description: 'Validates history rows exist + tail rows gone',
        acceptance: ['Keep1', 'Drop1', 'Drop2'],
      },
      env.tempDir,
      accessor,
    );
    const beforeRows = await accessor.getAcRows(created.task.id);
    const droppedIds = beforeRows.slice(1).map((r) => r.id);

    await updateTask(
      {
        taskId: created.task.id,
        acceptance: ['Keep1'],
        reason: 'T10508 unit test — transactional order',
      },
      env.tempDir,
      accessor,
    );

    // Surviving rows: only AC1 with its original UUID.
    const surviving = await accessor.getAcRows(created.task.id);
    expect(surviving).toHaveLength(1);
    expect(surviving[0].id).toBe(beforeRows[0].id);

    // History contains both dropped rows + references the now-deleted UUIDs.
    const { getNativeTasksDb } = await import('../../store/sqlite.js');
    const native = getNativeTasksDb();
    const historyAcIds = (
      native!
        .prepare('SELECT ac_id FROM task_acceptance_criteria_history ORDER BY id ASC')
        .all() as Array<{ ac_id: string }>
    ).map((h) => h.ac_id);
    expect(historyAcIds.sort()).toEqual([...droppedIds].sort());
  });
});
