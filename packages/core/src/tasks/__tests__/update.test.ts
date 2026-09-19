/**
 * Tests for task update.
 * @task T4461
 * @epic T4454
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Task, TasksUpdateQueryParams } from '@cleocode/contracts';
import { ExitCode } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import * as taskAccessors from '../../store/data-accessor.js';
import * as taskSqlite from '../../store/sqlite.js';
import { resetDbState } from '../../store/sqlite.js';
import { tasks } from '../../store/tasks-schema.js';
import { auditData, queryAuditLog } from '../../system/audit.js';
import { tasksUpdateOp } from '../ops.js';
import { taskUpdate, updateTask } from '../update.js';

describe('updateTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    // Pin CLEO_DIR so concurrent workers cannot contaminate path resolution
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeFile(
      join(env.cleoDir, 'config.json'),
      JSON.stringify({
        enforcement: {
          session: { requiredForMutate: false },
          acceptance: { mode: 'off' },
        },
        lifecycle: { mode: 'off' },
        verification: { enabled: false },
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  it.each([
    'engine',
    'operation',
  ] as const)('%s wrapper durably forwards noAutoComplete', async (wrapper) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Auto-complete fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    for (const noAutoComplete of [true, false]) {
      if (wrapper === 'engine') {
        const result = await taskUpdate(env.tempDir, 'T001', { noAutoComplete });
        expect(result.success).toBe(true);
      } else {
        const result = await tasksUpdateOp(env.tempDir, { taskId: 'T001', noAutoComplete });
        expect(result.changes).toContain('noAutoComplete');
      }
      expect((await accessor.loadSingleTask('T001'))?.noAutoComplete).toBe(noAutoComplete);
    }
  });

  it.each([
    'engine',
    'operation',
  ] as const)('%s wrapper preserves supported field updates', async (wrapper) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Field forwarding fixture',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);
    const updates = [
      { input: { phase: 'verification' }, expected: { phase: 'verification' } },
      { input: { title: 'Revised title' }, expected: { title: 'Revised title' } },
      { input: { description: 'Detailed outcome' }, expected: { description: 'Detailed outcome' } },
      { input: { priority: 'high' }, expected: { priority: 'high' } },
      {
        input: { notes: 'An evidence note' },
        expected: { notes: [expect.stringMatching(/: An evidence note$/)] },
      },
      { input: { size: 'small' }, expected: { size: 'small' } },
      { input: { labels: ['first'] }, expected: { labels: ['first'] } },
      { input: { addLabels: ['second'] }, expected: { labels: ['first', 'second'] } },
      { input: { removeLabels: ['first'] }, expected: { labels: ['second'] } },
      { input: { files: ['one.ts'] }, expected: { files: ['one.ts'] } },
      { input: { addFiles: ['two.ts'] }, expected: { files: ['one.ts', 'two.ts'] } },
      { input: { removeFiles: ['one.ts'] }, expected: { files: ['two.ts'] } },
      {
        input: { blockedBy: 'Awaiting external input' },
        expected: { blockedBy: 'Awaiting external input' },
      },
      { input: { clearBlockedBy: true }, expected: { blockedBy: undefined } },
      { input: { kind: 'research' }, expected: { kind: 'research' } },
      { input: { scope: 'unit' }, expected: { scope: 'unit' } },
      { input: { severity: 'P2' }, expected: { severity: 'P2' } },
      {
        input: { acceptance: ['literal a|b', 'verified output', 'fresh read'] },
        expected: { acceptance: ['literal a|b', 'verified output', 'fresh read'] },
      },
    ];
    for (const { input, expected } of updates) {
      if (wrapper === 'engine') {
        const result = await taskUpdate(env.tempDir, 'T001', input);
        expect(result.success).toBe(true);
      } else {
        await tasksUpdateOp(env.tempDir, { taskId: 'T001', ...input });
      }
      expect(await accessor.loadSingleTask('T001')).toMatchObject(expected);
    }
  });

  it.each([
    false,
    true,
  ])('records committed acceptance overrides only after a successful transaction (fault=%s)', async (failAudit) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Locked acceptance fixture',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        acceptance: ['original criterion'],
        createdAt: new Date().toISOString(),
      },
    ]);
    const faultAccessor: DataAccessor = {
      ...accessor,
      async transaction(callback) {
        return accessor.transaction((tx) =>
          callback({
            ...tx,
            async appendLog(entry) {
              if (failAudit) throw new Error('Injected override audit failure');
              return tx.appendLog(entry);
            },
          }),
        );
      },
    };
    const mutation = updateTask(
      {
        taskId: 'T001',
        acceptance: ['approved criterion'],
        reason: 'Owner approved scope correction',
      },
      env.tempDir,
      faultAccessor,
    );
    if (failAudit) await expect(mutation).rejects.toThrow('Injected override audit failure');
    else await mutation;
    const entries = await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] });
    if (failAudit) {
      expect(entries).toEqual([]);
      expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(['original criterion']);
    } else {
      expect(entries).toHaveLength(1);
      expect(JSON.parse(entries[0]!.detailsJson!)).toMatchObject({
        reason: 'Owner approved scope correction',
        acceptanceOverride: {
          status: 'committed',
          oldAcceptance: ['original criterion'],
          newAcceptance: ['approved criterion'],
          reason: 'Owner approved scope correction',
          stage: 'implementation',
        },
      });
    }
    const attempt = JSON.parse(
      (await readFile(join(env.tempDir, '.cleo/audit/ac-changes.jsonl'), 'utf8')).trim(),
    );
    expect(attempt.status).toBe('authorization-attempt');
  });

  it('compares canonical criteria before immutability and stores literal arrays', async () => {
    const expected = ['literal a|b', "mode: 'a'|'b'"];
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Canonical criteria',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        acceptance: expected,
        createdAt: new Date().toISOString(),
      },
    ]);
    await updateTask(
      { taskId: 'T001', acceptance: [' literal a|b ', '', " mode: 'a'|'b' ", '  '] },
      env.tempDir,
      accessor,
    );
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(expected);
    expect((await accessor.getAcRows('T001')).map((row) => row.text)).toEqual(expected);
  });

  it.each([
    'not-json',
    '{}',
    '1',
    'null',
    '"text"',
    '["valid", 3]',
    '["valid", false]',
    '["valid", {}]',
  ])('reports invalid historical acceptance explicitly without rewriting it: %s', async (raw) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Historical acceptance fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const db = await taskSqlite.getDb(env.tempDir);
    await db.update(tasks).set({ acceptanceJson: raw });
    await expect(accessor.loadSingleTask('T001')).rejects.toThrow(
      'Invalid stored acceptance for task T001',
    );
    expect((await db.select({ raw: tasks.acceptanceJson }).from(tasks))[0]?.raw).toBe(raw);
  });

  it('preserves valid historical strings and structured gates without read-time normalization', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Historical gate fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const raw =
      '[ "  literal a|b  ", {"kind":"manual","description":"Historical review", "prompt":"Review the original evidence", "reference":"original"} ]';
    const db = await taskSqlite.getDb(env.tempDir);
    await db.update(tasks).set({ acceptanceJson: raw });
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(JSON.parse(raw));
    expect((await db.select({ raw: tasks.acceptanceJson }).from(tasks))[0]?.raw).toBe(raw);
  });

  it('requires authorization to clear locked criteria and leaves absent criteria unchanged', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Locked clear fixture',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        acceptance: ['original'],
        createdAt: new Date().toISOString(),
      },
    ]);
    await expect(
      updateTask({ taskId: 'T001', acceptance: [] }, env.tempDir, accessor),
    ).rejects.toMatchObject({ code: ExitCode.AC_LOCKED });
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(['original']);
    await updateTask(
      { taskId: 'T001', title: 'Unrelated title change', acceptance: undefined },
      env.tempDir,
      accessor,
    );
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(['original']);
  });

  it.each(['[]', '["  ", ""]'])('keeps explicit empty input as an AC clear: %s', async (raw) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Clear criteria fixture',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        acceptance: ['original'],
        createdAt: new Date().toISOString(),
      },
    ]);
    await updateTask({ taskId: 'T001', acceptance: JSON.parse(raw) }, env.tempDir, accessor);
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual([]);
    expect(await accessor.getAcRows('T001')).toEqual([]);
  });

  it.each([
    '["valid", 3]',
    '["valid", null]',
    '["valid", false]',
    '["valid", {}]',
    '["valid", []]',
  ])('rejects invalid update criteria without saving other fields or partial rows: %s', async (raw) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Preserved title',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        acceptance: ['original'],
        createdAt: new Date().toISOString(),
      },
    ]);
    const before = await accessor.loadSingleTask('T001');
    const rows = await accessor.getAcRows('T001');
    await expect(
      updateTask(
        { taskId: 'T001', title: 'Must not persist', acceptance: JSON.parse(raw) },
        env.tempDir,
        accessor,
      ),
    ).rejects.toMatchObject({ code: ExitCode.VALIDATION_ERROR });
    expect(await accessor.loadSingleTask('T001')).toEqual(before);
    expect(await accessor.getAcRows('T001')).toEqual(rows);
    expect(await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] })).toEqual(
      [],
    );
  });

  it('retains committed override provenance when the advisory filesystem audit cannot be written', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Audit filesystem failure fixture',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        acceptance: ['original'],
        createdAt: new Date().toISOString(),
      },
    ]);
    await writeFile(join(env.tempDir, '.cleo/audit'), 'Block advisory audit directory');
    await updateTask(
      {
        taskId: 'T001',
        acceptance: ['approved'],
        reason: 'Approved despite unavailable advisory stream',
      },
      env.tempDir,
      accessor,
    );
    const entries = await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.detailsJson!)).toMatchObject({
      acceptanceOverride: {
        status: 'committed',
        reason: 'Approved despite unavailable advisory stream',
        oldAcceptance: ['original'],
        newAcceptance: ['approved'],
      },
    });
    expect((await accessor.loadSingleTask('T001'))?.acceptance).toEqual(['approved']);
  });

  it.each([
    'engine',
    'operation',
  ] as const)('%s wrapper persists dependency, parent and relationship changes', async (wrapper) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Initial epic',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Mutation target',
        type: 'task',
        parentId: 'T001',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T003',
        title: 'Related task',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T004',
        title: 'Destination epic',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const cases: Array<{ input: Omit<TasksUpdateQueryParams, 'taskId'>; expected: Partial<Task> }> =
      [
        { input: { depends: ['T003'] }, expected: { depends: ['T003'] } },
        { input: { addDepends: ['T004'] }, expected: { depends: ['T003', 'T004'] } },
        { input: { removeDepends: ['T003'] }, expected: { depends: ['T004'] } },
        { input: { depends: [] }, expected: { depends: undefined } },
        {
          input: { relates: [{ taskId: 'T003', type: 'related', reason: 'Shared evidence' }] },
          expected: { relates: [{ taskId: 'T003', type: 'related', reason: 'Shared evidence' }] },
        },
        {
          input: { addRelates: [{ taskId: 'T004', type: 'blocks', reason: 'Prerequisite' }] },
          expected: {
            relates: [
              { taskId: 'T003', type: 'related', reason: 'Shared evidence' },
              { taskId: 'T004', type: 'blocks', reason: 'Prerequisite' },
            ],
          },
        },
        {
          input: { removeRelates: ['T003'] },
          expected: { relates: [{ taskId: 'T004', type: 'blocks', reason: 'Prerequisite' }] },
        },
        { input: { relates: [] }, expected: { relates: undefined } },
        { input: { parent: 'T004' }, expected: { parentId: 'T004', type: 'task' } },
        { input: { parent: null }, expected: { parentId: undefined } },
        { input: { type: 'epic' }, expected: { type: 'epic' } },
        { input: { status: 'blocked' }, expected: { status: 'blocked' } },
        { input: { pipelineStage: 'consensus' }, expected: { pipelineStage: 'consensus' } },
      ];
    for (const { input, expected } of cases) {
      if (wrapper === 'engine') {
        const result = await taskUpdate(env.tempDir, 'T002', input);
        expect(result.success, JSON.stringify(result)).toBe(true);
      } else {
        await tasksUpdateOp(env.tempDir, { taskId: 'T002', ...input });
      }
      const persisted = await accessor.loadSingleTask('T002');
      const { relates, ...expectedFields } = expected;
      expect(persisted, JSON.stringify(input)).toMatchObject(expectedFields);
      if ('relates' in expected) {
        expect(persisted?.relates ?? []).toHaveLength(relates?.length ?? 0);
        expect(persisted?.relates ?? []).toEqual(expect.arrayContaining(relates ?? []));
      }
    }
  });

  it('audits task and session data from the modern store without legacy files', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: '',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await accessor.upsertSingleSession({
      id: 'ses_global',
      name: 'Global fixture',
      status: 'ended',
      scope: { type: 'global' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    });
    await accessor.upsertSingleSession({
      id: 'ses_invalid_epic',
      name: 'Missing epic fixture',
      status: 'ended',
      scope: { type: 'epic' },
      taskWork: { taskId: null, setAt: null },
      startedAt: new Date().toISOString(),
    });
    expect(existsSync(join(env.cleoDir, 'tasks.db'))).toBe(false);
    expect(existsSync(join(env.cleoDir, 'sessions.json'))).toBe(false);
    const tasks = await auditData(env.tempDir, { scope: 'tasks' });
    expect(tasks.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          category: 'tasks',
          severity: 'error',
          message: 'Task T001 missing title',
        }),
      ]),
    );
    const sessions = await auditData(env.tempDir, { scope: 'sessions' });
    expect(sessions.issues).toEqual([
      expect.objectContaining({
        category: 'sessions',
        severity: 'warning',
        message: 'Session ses_invalid_epic missing scope epicId',
      }),
    ]);
  });

  it.each([
    'tasks',
    'sessions',
  ])('reports %s diagnostic read failures explicitly', async (scope) => {
    vi.spyOn(taskAccessors, 'getTaskAccessor').mockResolvedValueOnce({
      ...accessor,
      async queryTasks() {
        throw new Error('Injected task read failure');
      },
      async loadSessions() {
        throw new Error('Injected session read failure');
      },
    });
    const audit = await auditData(env.tempDir, { scope });
    expect(audit.summary.errors).toBe(1);
    expect(audit.issues[0]).toMatchObject({
      category: scope,
      severity: 'error',
      message: expect.stringContaining('Injected'),
    });
  });

  it('reads committed audit receipts from the modern store without a legacy tasks.db', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Audit read fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await updateTask(
      { taskId: 'T001', title: 'Verified audit read', reason: 'Explicit correction' },
      env.tempDir,
      accessor,
    );
    expect(existsSync(join(env.cleoDir, 'tasks.db'))).toBe(false);
    const audit = await queryAuditLog(env.tempDir, { taskId: 'T001', operation: 'task_updated' });
    expect(audit.pagination.total).toBe(1);
    expect(audit.entries).toEqual([
      expect.objectContaining({
        taskId: 'T001',
        details: expect.objectContaining({ reason: 'Explicit correction' }),
      }),
    ]);
    expect(
      (await queryAuditLog(env.tempDir, { taskId: 'T001', operation: 'task_updated', offset: 1 }))
        .entries,
    ).toEqual([]);
  });

  it('surfaces audit diagnostic read failure instead of empty successful history', async () => {
    vi.spyOn(taskSqlite, 'getDb').mockRejectedValueOnce(new Error('Injected audit read failure'));
    await expect(queryAuditLog(env.tempDir)).rejects.toThrow('Injected audit read failure');
  });

  it('persists dependency-waiver provenance with the critical-priority mutation', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Waiver fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const dependsWaiver = 'Independent incident repair with no prerequisite work';
    const result = await taskUpdate(env.tempDir, 'T001', { priority: 'critical', dependsWaiver });
    expect(result.success).toBe(true);
    expect((await accessor.loadSingleTask('T001'))?.priority).toBe('critical');
    const entries = await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] });
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0]!.detailsJson!)).toMatchObject({ dependsWaiver });
  });

  it.each([
    { priority: 'critical', dependsWaiver: '   ' },
    { priority: 'high', dependsWaiver: 'Not a critical-priority waiver' },
  ])('rejects unsupported dependency waivers without changing the task: %j', async (input) => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Waiver rejection fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const result = await taskUpdate(env.tempDir, 'T001', input);
    expect(result.success).toBe(false);
    expect((await accessor.loadSingleTask('T001'))?.priority).toBe('medium');
    expect(await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] })).toEqual(
      [],
    );
  });

  it('rolls back the priority change when dependency-waiver audit persistence fails', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Audit rollback fixture',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    const faultAccessor: DataAccessor = {
      ...accessor,
      async transaction(callback) {
        return accessor.transaction((tx) =>
          callback({
            ...tx,
            async appendLog() {
              throw new Error('Injected audit persistence failure');
            },
          }),
        );
      },
    };
    await expect(
      updateTask(
        {
          taskId: 'T001',
          priority: 'critical',
          dependsWaiver: 'Urgent independent repair',
        },
        env.tempDir,
        faultAccessor,
      ),
    ).rejects.toThrow('Injected audit persistence failure');
    expect((await accessor.loadSingleTask('T001'))?.priority).toBe('medium');
    expect(await accessor.queryAuditLog({ taskIds: ['T001'], actions: ['task_updated'] })).toEqual(
      [],
    );
  });

  it('updates task title', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Old title',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', title: 'New title' }, env.tempDir, accessor);
    expect(result.task.title).toBe('New title');
    expect(result.changes).toContain('title');
  });

  it('updates task status', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'active' }, env.tempDir, accessor);
    expect(result.task.status).toBe('active');
  });

  it('adds labels', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        labels: ['bug'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T001', addLabels: ['security'] },
      env.tempDir,
      accessor,
    );
    expect(result.task.labels).toContain('bug');
    expect(result.task.labels).toContain('security');
  });

  it('removes labels', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        labels: ['bug', 'security'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T001', removeLabels: ['bug'] },
      env.tempDir,
      accessor,
    );
    expect(result.task.labels).toEqual(['security']);
  });

  it('adds notes', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask(
      { taskId: 'T001', notes: 'Progress update' },
      env.tempDir,
      accessor,
    );
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Progress update');
  });

  it('throws if no changes specified', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(updateTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'No changes',
    );
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(
      updateTask({ taskId: 'T999', title: 'New' }, env.tempDir, accessor),
    ).rejects.toThrow('Task not found');
  });

  it('sets completedAt when marking done', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await updateTask({ taskId: 'T001', status: 'done' }, env.tempDir, accessor);
    expect(result.task.completedAt).toBeDefined();
  });

  it('status=done path enforces dependency checks via complete flow', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dependency',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'active',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T002', status: 'done' }, env.tempDir, accessor),
    ).rejects.toThrow('unresolved dependencies');
  });

  it('rejects mixed status=done updates with other fields', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(
      updateTask({ taskId: 'T001', status: 'done', priority: 'high' }, env.tempDir, accessor),
    ).rejects.toThrow('status=done must use complete flow');
  });

  describe('parentId (reparent via update)', () => {
    it('sets parent on a root task', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Orphan',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor);
      expect(result.task.parentId).toBe('T001');
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=null', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: null }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('promotes child to root with parentId=""', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask({ taskId: 'T002', parentId: '' }, env.tempDir, accessor);
      expect(result.task.parentId).toBeNull();
      expect(result.changes).toContain('parentId');
    });

    it('does not change when parentId is same as current', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Child',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          parentId: 'T001',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      await expect(
        updateTask({ taskId: 'T002', parentId: 'T001' }, env.tempDir, accessor),
      ).rejects.toThrow('No changes');
    });

    it('can set parent and other fields simultaneously', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Epic',
          status: 'pending',
          priority: 'medium',
          type: 'epic',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'T002',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          type: 'task',
          createdAt: new Date().toISOString(),
        },
      ]);
      await writeFile(
        join(env.cleoDir, 'config.json'),
        JSON.stringify({
          enforcement: { session: { requiredForMutate: false } },
          lifecycle: { mode: 'off' },
          verification: { enabled: false },
          hierarchy: { maxDepth: 3, maxSiblings: 20 },
        }),
      );

      const result = await updateTask(
        {
          taskId: 'T002',
          parentId: 'T001',
          priority: 'high',
        },
        env.tempDir,
        accessor,
      );
      expect(result.task.parentId).toBe('T001');
      expect(result.task.priority).toBe('high');
      expect(result.changes).toContain('parentId');
      expect(result.changes).toContain('priority');
    });
  });

  describe('blockedBy set/clear (T9241)', () => {
    it('sets blockedBy reason text', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', blockedBy: 'waiting on infra' },
        env.tempDir,
        accessor,
      );
      expect(result.task.blockedBy).toBe('waiting on infra');
      expect(result.changes).toContain('blockedBy');
    });

    it('clears blockedBy via --clear-blocked-by flag', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'waiting on infra',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', clearBlockedBy: true },
        env.tempDir,
        accessor,
      );
      expect(result.task.blockedBy).toBeUndefined();
      expect(result.changes).toContain('blockedBy');
    });

    it('auto-clears blockedBy when set to empty string', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'waiting on infra',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask({ taskId: 'T001', blockedBy: '' }, env.tempDir, accessor);
      expect(result.task.blockedBy).toBeUndefined();
      expect(result.changes).toContain('blockedBy');
    });

    it('stale text does not persist in cleo show after clear', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          blockedBy: 'stale reason',
          createdAt: new Date().toISOString(),
        },
      ]);

      await updateTask({ taskId: 'T001', clearBlockedBy: true }, env.tempDir, accessor);
      const reloaded = await accessor.loadSingleTask('T001');
      expect(reloaded?.blockedBy).toBeUndefined();
    });

    // gh#1106 / T12016 — the EngineResult wrapper `taskUpdate` (the layer the
    // dispatch handler calls) must forward `blockedBy`. It previously omitted it
    // from its `updates` type and forwarding object, so `cleo update --blocked-by`
    // round-tripped to E_CLEO_NO_CHANGE.
    it('wrapper taskUpdate forwards blockedBy and counts it as a change', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await taskUpdate(env.tempDir, 'T001', { blockedBy: 'waiting on infra' });
      expect(result.success).toBe(true);
      if (!result.success) return;
      // taskToRecord maps the free-text string reason into a 1-element array on
      // the wire TaskRecord (engine-converters.ts — blockedBy: string vs string[]).
      expect(result.data.task.blockedBy).toEqual(['waiting on infra']);
      expect(result.data.changes).toContain('blockedBy');
    });
  });

  describe('files add/remove (T9242)', () => {
    it('sets files via --files (replace)', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', files: ['src/a.ts', 'src/b.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).toEqual(['src/a.ts', 'src/b.ts']);
      expect(result.changes).toContain('files');
    });

    it('adds files without replacing existing via addFiles', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', addFiles: ['src/b.ts', 'src/c.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).toContain('src/a.ts');
      expect(result.task.files).toContain('src/b.ts');
      expect(result.task.files).toContain('src/c.ts');
      expect(result.changes).toContain('files');
    });

    it('addFiles deduplicates — does not add already-present files twice', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', addFiles: ['src/a.ts', 'src/b.ts'] },
        env.tempDir,
        accessor,
      );
      const files = result.task.files ?? [];
      expect(files.filter((f) => f === 'src/a.ts')).toHaveLength(1);
      expect(files).toContain('src/b.ts');
    });

    it('removes specific files via removeFiles', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', removeFiles: ['src/b.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files).not.toContain('src/b.ts');
      expect(result.task.files).toContain('src/a.ts');
      expect(result.task.files).toContain('src/c.ts');
      expect(result.changes).toContain('files');
    });

    it('removeFiles on empty files list is a no-op', async () => {
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Task',
          status: 'pending',
          priority: 'medium',
          createdAt: new Date().toISOString(),
        },
      ]);

      const result = await updateTask(
        { taskId: 'T001', removeFiles: ['src/a.ts'] },
        env.tempDir,
        accessor,
      );
      expect(result.task.files ?? []).toHaveLength(0);
    });
  });
});
