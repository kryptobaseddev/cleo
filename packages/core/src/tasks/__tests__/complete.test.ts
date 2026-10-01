/**
 * Tests for task completion.
 * @task T4461
 * @epic T4454
 */

import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcceptanceGate } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureProjectScope,
  readProjectInfoAtDirectorySync,
  worktreeScope,
} from '../../project-scope.js';
import { _forceSystemdRunAvailable } from '../../resources/spawn-wrapper.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { createOperationExecutionContext } from '../../store/background-ops.js';
import type { DataAccessor, TransactionAccessor } from '../../store/data-accessor.js';
import { getNativeTasksDb, resetDbState } from '../../store/sqlite.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { buildFreshAcRows } from '../ac-table.js';
import { completeTask, completeTaskStrict, withTaskWriteTransaction } from '../complete.js';
import { reqAdd } from '../req.js';

/** T12960: a switchable `ci:<pr>` resolver; null delegates to the real one. */
const ciResolver = vi.hoisted(() => ({
  impl: null as null | typeof import('../../release/ci-evidence.js')['resolveCiEvidenceAtom'],
}));

vi.mock('../../release/ci-evidence.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../release/ci-evidence.js')>();
  return {
    ...actual,
    resolveCiEvidenceAtom: (...args: Parameters<typeof actual.resolveCiEvidenceAtom>) =>
      (ciResolver.impl ?? actual.resolveCiEvidenceAtom)(...args),
  };
});

describe('completeTask', () => {
  let env: TestDbEnv;
  let accessor: DataAccessor;

  beforeEach(async () => {
    env = await createTestDb();
    accessor = env.accessor;
    // Pin CLEO_DIR so concurrent workers cannot contaminate path resolution
    process.env['CLEO_DIR'] = env.cleoDir;
    await writeConfig({
      enforcement: {
        session: { requiredForMutate: false },
        acceptance: { mode: 'off' },
      },
      lifecycle: { mode: 'off' },
      verification: { enabled: false },
    });
  });

  const writeConfig = async (config: Record<string, unknown>): Promise<void> => {
    await writeFile(join(env.cleoDir, 'config.json'), JSON.stringify(config));
  };

  afterEach(async () => {
    _forceSystemdRunAvailable(undefined);
    delete process.env['CLEO_DIR'];
    resetDbState();
    await env.cleanup();
  });

  function persistedCompletion(sql: string): string {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync(process.argv[1], {readOnly:true}); try { process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all())); } finally { db.close(); }`,
        join(env.cleoDir, 'cleo.db'),
        sql,
      ],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(child.status, child.stderr).toBe(0);
    return child.stdout;
  }

  async function typedFixture(gate?: AcceptanceGate, literal?: string): Promise<void> {
    _forceSystemdRunAvailable(false);
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Typed completion',
        description: 'Controlled typed result',
        acceptance: literal === undefined ? [] : [literal],
        status: 'pending',
        type: 'task',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    if (literal !== undefined)
      await accessor.transaction((tx) => tx.insertAcRows(buildFreshAcRows('T001', [literal])));
    await writeFile(join(env.tempDir, 'harness.mjs'), 'process.exit(0);');
    await reqAdd(
      env.tempDir,
      'T001',
      gate ?? {
        kind: 'test',
        command: process.execPath,
        args: ['harness.mjs'],
        expect: 'exit0',
        req: 'COMPLETE-001',
        description: 'Actual harness',
      },
      accessor,
    );
  }

  async function verifyTypedFixture(): Promise<void> {
    const verified = await validateGateVerify(env.tempDir, {
      taskId: 'T001',
      gate: 'cleanupDone',
      evidence: 'note:explicit synthetic typed proof',
    });
    expect(verified.success, verified.success ? undefined : verified.error.message).toBe(true);
    expect((await accessor.loadSingleTask('T001'))?.verification?.gateResults?.[0]?.result).toBe(
      'pass',
    );
  }

  it('typed completion refuses generic coverage and an AC waiver without actual requirement results', async () => {
    await typedFixture();
    const rows = await accessor.getAcRows('T001');
    await accessor.transaction((tx) =>
      tx.insertAcBindings([
        {
          id: 'generic-claim',
          acId: rows[0]!.id,
          evidenceAtomId: 'note:claimed complete',
          bindingType: 'satisfies',
        },
      ]),
    );
    const before = persistedCompletion(
      "SELECT status,verification_json FROM tasks_tasks WHERE id='T001'",
    );
    await expect(
      completeTask(
        {
          taskId: 'T001',
          waiveAc: rows[0]!.id,
          waiveReason: 'generic waiver cannot prove an executable requirement',
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(/typed|Typed/);
    expect(
      persistedCompletion("SELECT status,verification_json FROM tasks_tasks WHERE id='T001'"),
    ).toBe(before);
  });

  it.each([
    'unchanged',
    'harness',
    'gate',
    'receipt',
    'receipt-actor',
    'receipt-details',
    'project',
  ] as const)('typed completion requires current authentic proof: %s', async (change) => {
    await typedFixture();
    await verifyTypedFixture();
    if (change === 'harness') await writeFile(join(env.tempDir, 'harness.mjs'), 'process.exit(1);');
    if (change === 'gate') {
      const loaded = (await accessor.loadSingleTask('T001'))!;
      const item = loaded.acceptance![0]!;
      if (typeof item === 'string') throw new Error('Missing typed fixture');
      await accessor.updateTaskFields('T001', {
        acceptanceJson: JSON.stringify([{ ...item, description: 'Edited after verification' }]),
      });
    }
    if (change === 'receipt')
      getNativeTasksDb(env.tempDir)!
        .prepare("DELETE FROM tasks_audit_log WHERE action='gate.verify.typed'")
        .run();
    if (change === 'receipt-actor')
      getNativeTasksDb(env.tempDir)!
        .prepare(
          "UPDATE tasks_audit_log SET actor='unrelated-actor' WHERE action='gate.verify.typed'",
        )
        .run();
    if (change === 'receipt-details')
      getNativeTasksDb(env.tempDir)!
        .prepare("UPDATE tasks_audit_log SET details_json='{}' WHERE action='gate.verify.typed'")
        .run();
    if (change === 'project')
      await writeFile(
        join(env.cleoDir, 'project-info.json'),
        JSON.stringify({ projectId: 'different-owner', projectHash: 'different-owner' }),
      );
    const operation = completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    if (change === 'unchanged') {
      expect((await operation).task.status).toBe('done');
      expect(persistedCompletion("SELECT status FROM tasks_tasks WHERE id='T001'")).toBe(
        '[{"status":"done"}]',
      );
    } else {
      await expect(operation).rejects.toThrow();
      expect(persistedCompletion("SELECT status FROM tasks_tasks WHERE id='T001'")).toBe(
        '[{"status":"pending"}]',
      );
    }
  });

  it.each([
    'stringified',
    'removed',
    'wrong-kind',
  ] as const)('typed completion rejects inconsistent canonical representation: %s', async (change) => {
    await typedFixture();
    await verifyTypedFixture();
    const [criterion] = await accessor.getAcRows('T001');
    if (change === 'wrong-kind') {
      getNativeTasksDb(env.tempDir)!
        .prepare("UPDATE tasks_task_acceptance_criteria SET kind='text' WHERE id=?")
        .run(criterion!.id);
    } else {
      await accessor.updateTaskFields('T001', {
        acceptanceJson: JSON.stringify(change === 'removed' ? [] : [criterion!.text]),
      });
    }
    const before = persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'");
    await expect(
      completeTask(
        {
          taskId: 'T001',
          waiveAc: 'AC1',
          waiveReason: 'Generic waiver cannot repair erased gate identity',
        },
        env.tempDir,
        accessor,
      ),
    ).rejects.toThrow(/inconsistent acceptance/);
    expect(persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'")).toBe(before);
  });

  it('does not auto-close a parent whose canonical typed row was demoted to literal JSON', async () => {
    await seedTasks(accessor, [
      {
        id: 'T100',
        title: 'Parent',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T001',
        parentId: 'T100',
        title: 'Last child',
        type: 'task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await reqAdd(
      env.tempDir,
      'T100',
      {
        kind: 'test',
        req: 'DEMOTED-PARENT',
        description: 'Retained typed row',
        command: process.execPath,
        args: ['absent.mjs'],
        expect: 'exit0',
      },
      accessor,
    );
    const [criterion] = await accessor.getAcRows('T100');
    await accessor.updateTaskFields('T100', { acceptanceJson: JSON.stringify([criterion!.text]) });
    await accessor.transaction((tx) =>
      tx.insertAcBindings([
        {
          id: 'synthetic-covered',
          acId: criterion!.id,
          evidenceAtomId: 'note:generic coverage',
          bindingType: 'satisfies',
        },
      ]),
    );
    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.autoCompleted ?? []).not.toContain('T100');
    expect((await accessor.loadSingleTask('T100'))?.status).toBe('pending');
    expect((await accessor.loadSingleTask('T100'))?.acceptance).toEqual([criterion!.text]);
  });

  it('typed completion keeps an unmet parent open even when generic AC bindings allow rollup', async () => {
    await seedTasks(accessor, [
      {
        id: 'T100',
        title: 'Parent',
        type: 'epic',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T001',
        title: 'Last child',
        type: 'task',
        parentId: 'T100',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await reqAdd(
      env.tempDir,
      'T100',
      {
        kind: 'test',
        command: process.execPath,
        args: ['missing-parent-harness.mjs'],
        expect: 'exit0',
        req: 'PARENT-100',
        description: 'Parent must prove own gate',
      },
      accessor,
    );
    const rows = await accessor.getAcRows('T100');
    await accessor.transaction((tx) =>
      tx.insertAcBindings([
        {
          id: 'parent-generic',
          acId: rows[0]!.id,
          evidenceAtomId: 'note:parent claimed',
          bindingType: 'satisfies',
        },
      ]),
    );
    const completed = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(completed.task.status).toBe('done');
    expect(completed.autoCompleted ?? []).not.toContain('T100');
    expect(persistedCompletion("SELECT status FROM tasks_tasks WHERE id='T100'")).toBe(
      '[{"status":"pending"}]',
    );
  });

  it('typed completion preserves advisory semantics without inventing a hard generic AC', async () => {
    await typedFixture({
      kind: 'manual',
      prompt: 'Optional review',
      description: 'Optional review',
      req: 'OPTIONAL',
      advisory: true,
    });
    const completed = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(completed.task.status).toBe('done');
    expect(
      await accessor.getAcBindings((await accessor.getAcRows('T001')).map((row) => row.id)),
    ).toEqual([]);
  });

  it('typed completion rejects an actual failed re-verification instead of reusing the earlier pass', async () => {
    await typedFixture();
    await verifyTypedFixture();
    await writeFile(join(env.tempDir, 'harness.mjs'), 'process.exit(2);');
    const failed = await validateGateVerify(env.tempDir, {
      taskId: 'T001',
      gate: 'cleanupDone',
      evidence: 'note:actual second execution',
    });
    expect(failed.success).toBe(true);
    expect((await accessor.loadSingleTask('T001'))?.verification?.gateResults?.[0]?.result).toBe(
      'fail',
    );
    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'lacks a passing bound result',
    );
    expect(persistedCompletion("SELECT status FROM tasks_tasks WHERE id='T001'")).toBe(
      '[{"status":"pending"}]',
    );
  });

  it('typed completion rolls status back when its final canonical completion receipt fails', async () => {
    await typedFixture();
    await verifyTypedFixture();
    const before = persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'");
    const bindings = persistedCompletion('SELECT * FROM tasks_evidence_ac_bindings');
    const receipts = persistedCompletion('SELECT * FROM tasks_audit_log');
    getNativeTasksDb(env.tempDir)!.exec(
      "CREATE TRIGGER reject_completion_receipt BEFORE INSERT ON tasks_audit_log WHEN NEW.action='task_completed' BEGIN SELECT RAISE(ABORT,'completion receipt fault'); END",
    );
    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toMatchObject({
      cause: { message: 'completion receipt fault' },
    });
    expect(persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'")).toBe(before);
    expect(persistedCompletion('SELECT * FROM tasks_evidence_ac_bindings')).toBe(bindings);
    expect(persistedCompletion('SELECT * FROM tasks_audit_log')).toBe(receipts);
  });

  it('typed completion retains captured cancellation through the final native write transaction', async () => {
    await typedFixture();
    await verifyTypedFixture();
    const before = persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'");
    const receipts = persistedCompletion('SELECT * FROM tasks_audit_log');
    const info = readProjectInfoAtDirectorySync(env.tempDir, env.cleoDir);
    const execution = createOperationExecutionContext({
      projectId: info.projectId!,
      projectRoot: env.tempDir,
      actor: 'completion-cancel',
      operation: 'tasks.complete',
      idempotencyKey: 'cancel-on-update',
    });
    const native = getNativeTasksDb(env.tempDir)!;
    native.function('cancel_typed_completion', () => {
      execution.close();
      return 0;
    });
    native.exec(
      "CREATE TRIGGER cancel_typed_completion AFTER UPDATE OF status ON tasks_tasks WHEN NEW.status='done' BEGIN SELECT cancel_typed_completion(); END",
    );
    try {
      await expect(
        worktreeScope.run(
          captureProjectScope(env.tempDir, {
            ...captureProjectScope(env.tempDir, undefined),
            execution,
          }),
          () => completeTask({ taskId: 'T001' }, env.tempDir, accessor),
        ),
      ).rejects.toThrow();
      expect(execution.signal.aborted).toBe(true);
      expect(persistedCompletion("SELECT * FROM tasks_tasks WHERE id='T001'")).toBe(before);
      expect(persistedCompletion('SELECT * FROM tasks_audit_log')).toBe(receipts);
    } finally {
      execution.close();
    }
  });

  it('typed completion never exempts a literal text criterion that resembles an advisory gate', async () => {
    const gate: AcceptanceGate = {
      kind: 'manual',
      prompt: 'Optional',
      description: 'Optional',
      advisory: true,
      req: 'OPTIONAL-EXACT',
    };
    await typedFixture(
      gate,
      '{"advisory":true,"description":"Optional","kind":"manual","prompt":"Optional","req":"OPTIONAL-EXACT"}',
    );
    const rows = await accessor.getAcRows('T001');
    expect(rows[0]!.text).toBe(rows[1]!.text);
    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow('AC1');
    expect(persistedCompletion("SELECT status FROM tasks_tasks WHERE id='T001'")).toBe(
      '[{"status":"pending"}]',
    );
  });

  it('completes a pending task', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.completedAt).toBeDefined();
  });

  it('throws if task not found', async () => {
    await seedTasks(accessor, []);

    await expect(completeTask({ taskId: 'T999' }, env.tempDir, accessor)).rejects.toThrow(
      'Task not found',
    );
  });

  it('is an idempotent no-op success when the task is already done (T12102 / gh#1196)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done task',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.alreadyCompleted).toBe(true);
    expect(result.task.status).toBe('done');
    // No side effects on a no-op: no auto-completed parents, no unblocked list.
    expect(result.autoCompleted).toBeUndefined();
    expect(result.unblockedTasks).toBeUndefined();
  });

  it('completeTaskStrict returns success with alreadyDone for a done task in strict mode (T12102 / gh#1196)', async () => {
    // Strict lifecycle mode would normally run the staleness/IVTR/verification
    // pre-checks — the done short-circuit must fire BEFORE any of them so a
    // post-timeout retry succeeds instead of failing on stale-state guards.
    await writeConfig({ lifecycle: { mode: 'strict' } });
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Done task',
        status: 'done',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTaskStrict(env.tempDir, 'T001');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data?.alreadyDone).toBe(true);
      expect(result.data?.note).toContain('already done');
    }
  });

  it('throws if dependencies are incomplete', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dep',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toThrow(
      'unresolved dependencies',
    );
  });

  it('allows completion when dependency is cancelled', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Dep',
        status: 'cancelled',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        cancelledAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  // T1954: archived deps must satisfy dependencies (equivalent to done)
  it('allows completion when dependency is archived', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Archived dep',
        status: 'archived',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked by archived',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T002' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  // T1954: still block when dep is pending (regression guard)
  it('still blocks completion when dependency is pending', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Pending dep',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
      {
        id: 'T002',
        title: 'Blocked by pending',
        status: 'pending',
        priority: 'medium',
        depends: ['T001'],
        createdAt: new Date().toISOString(),
      },
    ]);

    await expect(completeTask({ taskId: 'T002' }, env.tempDir, accessor)).rejects.toThrow(
      'unresolved dependencies',
    );
  });

  it('blocks completion when acceptance is required and missing', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'High priority task',
        status: 'active',
        priority: 'high',
        createdAt: new Date().toISOString(),
      },
    ]);
    await writeConfig({
      enforcement: {
        acceptance: {
          mode: 'block',
          requiredForPriorities: ['high'],
        },
      },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'acceptance criteria',
    );
  });

  it('blocks completion when verification metadata is missing', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Verified task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
      verification: { enabled: true },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'missing verification metadata',
    );
  });

  it('defaults verification enforcement to disabled when unset (opt-in)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Default enforcement task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    // Write a config that only disables acceptance enforcement but no verification
    // settings — verifying that verification defaults to disabled (opt-in behavior).
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
    });

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('honors project config when verification enforcement is off', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'No verification task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
      },
    ]);
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
      verification: { enabled: false },
    });

    const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
  });

  it('blocks completion when required verification gates are incomplete', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Gate incomplete task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
        type: 'task',
        verification: {
          passed: false,
          round: 1,
          gates: {
            implemented: true,
            testsPassed: false,
          },
          lastAgent: 'testing',
          lastUpdated: new Date().toISOString(),
          failureLog: [],
        },
      },
    ]);
    await writeConfig({
      enforcement: { acceptance: { mode: 'off' } },
      verification: {
        enabled: true,
        requiredGates: ['implemented', 'testsPassed'],
      },
    });

    await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
      'failed verification gates',
    );
  });

  describe('an affected-scope testsPassed counts before merge only (T12656, D11150)', () => {
    const affected = {
      kind: 'tool' as const,
      tool: 'test-affected',
      exitCode: 0,
      scope: 'affected' as const,
      affectedPackages: ['@x/a'],
    };
    const prAtom = {
      kind: 'pr' as const,
      prNumber: 42,
      mergedAt: '2026-09-28T00:00:00Z',
      mergeCommitSha: 'a'.repeat(40),
      successCount: 1,
      totalChecks: 1,
    };
    async function seedMerged(testsAtoms: object[]): Promise<void> {
      const now = new Date().toISOString();
      await seedTasks(accessor, [
        {
          id: 'T001',
          title: 'Affected-scope task',
          status: 'active',
          priority: 'medium',
          createdAt: now,
          type: 'task',
          verification: {
            passed: true,
            round: 1,
            gates: { implemented: true, testsPassed: true },
            lastAgent: 'testing',
            lastUpdated: now,
            failureLog: [],
            evidence: {
              implemented: { atoms: [prAtom], capturedAt: now, capturedBy: 'test' },
              testsPassed: { atoms: testsAtoms, capturedAt: now, capturedBy: 'test' },
            },
          },
        } as Parameters<typeof seedTasks>[1][number],
      ]);
      await writeConfig({
        enforcement: { acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
        verification: { enabled: true, requiredGates: ['implemented', 'testsPassed'] },
      });
    }

    it('refuses completion once the PR has merged and only tool:test-affected backs testsPassed', async () => {
      await seedMerged([affected]);
      await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
        /testsPassed \(testsPassed was recorded from a scoped run .*the merged change needs merged CI/,
      );
      expect((await accessor.loadSingleTask('T001'))?.status).toBe('active');
    });

    it('completes when a full tool:test also backs testsPassed', async () => {
      await seedMerged([affected, { kind: 'tool', tool: 'test', exitCode: 0 }]);
      const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
      expect(result.task.status).toBe('done');
    });

    it('refuses a test-run whose tree no longer matches (T12965)', async () => {
      await seedMerged([
        {
          kind: 'test-run',
          path: 'reports/vitest.json',
          sha256: 'c'.repeat(64),
          passCount: 1,
          failCount: 0,
          skipCount: 0,
          treeHash: '1'.repeat(40),
        },
      ]);
      await expect(completeTask({ taskId: 'T001' }, env.tempDir, accessor)).rejects.toThrow(
        /testsPassed \(testsPassed rests on test-run:reports\/vitest\.json/,
      );
      expect((await accessor.loadSingleTask('T001'))?.status).toBe('active');
    });

    describe('merged CI stands in at complete (T12960)', () => {
      const greenCi = {
        kind: 'ci' as const,
        prNumber: 42,
        mergeCommitSha: 'a'.repeat(40),
        checks: [{ name: 'CI', conclusion: 'SUCCESS', sha: 'a'.repeat(40) }],
        taskId: 'T001',
        requiredSource: 'project-context',
      };
      beforeEach(async () => {
        await writeFile(
          join(env.cleoDir, 'project-context.json'),
          JSON.stringify({ evidence: { ciSatisfies: true } }),
        );
      });
      afterEach(() => {
        ciResolver.impl = null;
      });

      it('merged and green: an affected-only testsPassed is replaced by ci:<pr> and the task completes', async () => {
        const seen: number[] = [];
        ciResolver.impl = async (prNumber) => {
          seen.push(prNumber);
          return { ok: true, atom: greenCi };
        };
        await seedMerged([affected]);
        const result = await completeTask({ taskId: 'T001' }, env.tempDir, accessor);
        expect(result.task.status).toBe('done');
        expect(seen).toContain(42);
        const atoms = result.task.verification?.evidence?.testsPassed?.atoms ?? [];
        expect(atoms.map((a) => a.kind)).toEqual(['ci', 'note']);
        expect(atoms[1]).toMatchObject({ note: expect.stringMatching(/cleo complete.*PR #42/) });
      });

      it('red or pending CI refuses with wait-for-CI, never a local run', async () => {
        ciResolver.impl = async () => ({
          ok: false,
          codeName: 'E_EVIDENCE_TESTS_FAILED',
          reason: "Required CI on PR #42's merge commit is not green: CI pending",
        });
        await seedMerged([affected]);
        const refusal = completeTask({ taskId: 'T001' }, env.tempDir, accessor);
        await expect(refusal).rejects.toThrow(/ci:42 does not hold.*CI pending/);
        await expect(refusal).rejects.toMatchObject({
          fix: expect.stringMatching(
            /Wait for the PR's required CI.*Do not run the test suite locally/,
          ),
        });
        expect((await accessor.loadSingleTask('T001'))?.status).toBe('active');
      });

      it('a final red CI refuses with fix-CI-or-run-full, never a wait', async () => {
        ciResolver.impl = async () => ({
          ok: false,
          codeName: 'E_EVIDENCE_TESTS_FAILED',
          reason: "Required CI on PR #42's merge commit is not green:\n  - CI: failure",
        });
        await seedMerged([affected]);
        const refusal = completeTask({ taskId: 'T001' }, env.tempDir, accessor);
        await expect(refusal).rejects.toThrow(/ci:42 does not hold.*CI: failure/s);
        await expect(refusal).rejects.toMatchObject({
          fix: expect.stringMatching(/fix CI .*tool:test.*tool:lint;tool:typecheck/),
        });
      });
    });
  });

  it('adds notes on completion', async () => {
    await seedTasks(accessor, [
      {
        id: 'T001',
        title: 'Test task',
        status: 'active',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask(
      { taskId: 'T001', notes: 'Done with tests' },
      env.tempDir,
      accessor,
    );
    expect(result.task.notes).toHaveLength(1);
    expect(result.task.notes![0]).toContain('Done with tests');
  });

  // --------------------------------------------------------------------------
  // T871 — status ↔ pipelineStage sync on completion
  // --------------------------------------------------------------------------

  it('T871: sets pipelineStage to contribution when completing from research', async () => {
    await seedTasks(accessor, [
      {
        id: 'T870',
        title: 'Research task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'research',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T870' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: sets pipelineStage to contribution when completing from implementation', async () => {
    await seedTasks(accessor, [
      {
        id: 'T871',
        title: 'Implementation task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'implementation',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T871' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: sets pipelineStage to contribution when completing from release', async () => {
    await seedTasks(accessor, [
      {
        id: 'T872',
        title: 'Release task',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'release',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T872' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T871: leaves pipelineStage=contribution unchanged (idempotent)', async () => {
    await seedTasks(accessor, [
      {
        id: 'T873',
        title: 'Already at contribution',
        status: 'pending',
        priority: 'medium',
        pipelineStage: 'contribution',
        createdAt: new Date().toISOString(),
      },
    ]);

    const result = await completeTask({ taskId: 'T873' }, env.tempDir, accessor);
    expect(result.task.status).toBe('done');
    expect(result.task.pipelineStage).toBe('contribution');
  });

  it('T10595: runs AC completion gate inside the same write transaction as status update', async () => {
    await seedTasks(accessor, [
      {
        id: 'T10595-A',
        title: 'Atomic gate task',
        status: 'pending',
        priority: 'medium',
        createdAt: new Date().toISOString(),
      },
    ]);
    await accessor.transaction(async (tx) => {
      await tx.insertAcRows([
        { id: 'ac-t10595-a', taskId: 'T10595-A', ordinal: 1, text: 'covered atomically' },
      ]);
    });

    const events: string[] = [];
    const instrumented: DataAccessor = {
      ...accessor,
      async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
        events.push('begin-immediate');
        return accessor.transaction(async (tx) => {
          const instrumentedTx: TransactionAccessor = {
            ...tx,
            async getAcRows(taskId) {
              events.push(`gate:${taskId}`);
              return tx.getAcRows(taskId);
            },
            async upsertSingleTask(task) {
              events.push(`status:${task.id}:${task.status}`);
              return tx.upsertSingleTask(task);
            },
          };
          return fn(instrumentedTx);
        });
      },
    };

    await expect(completeTask({ taskId: 'T10595-A' }, env.tempDir, instrumented)).rejects.toThrow(
      'acceptance criterion/criteria have no evidence bindings',
    );

    expect(events).toEqual(['begin-immediate', 'gate:T10595-A']);
    const persisted = await accessor.loadSingleTask('T10595-A');
    expect(persisted?.status).toBe('pending');
    expect(persisted?.completedAt).toBeUndefined();
  });

  it('T10595: serializes concurrent task write helpers', async () => {
    let activeWriters = 0;
    let maxActiveWriters = 0;
    const releaseFirst = Promise.withResolvers<void>();
    const firstEntered = Promise.withResolvers<void>();
    const events: string[] = [];

    const serialQueue: Array<() => void> = [];
    const fakeAccessor = {
      async transaction<T>(fn: (tx: TransactionAccessor) => Promise<T>): Promise<T> {
        if (activeWriters > 0) {
          await new Promise<void>((resolve) => serialQueue.push(resolve));
        }
        activeWriters += 1;
        maxActiveWriters = Math.max(maxActiveWriters, activeWriters);
        try {
          return await fn({} as TransactionAccessor);
        } finally {
          activeWriters -= 1;
          serialQueue.shift()?.();
        }
      },
    } as DataAccessor;

    const first = withTaskWriteTransaction(fakeAccessor, async () => {
      events.push('first-enter');
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push('first-exit');
      return 'first';
    });
    await firstEntered.promise;
    const second = withTaskWriteTransaction(fakeAccessor, async () => {
      events.push('second-enter');
      return 'second';
    });

    await Promise.resolve();
    expect(events).toEqual(['first-enter']);
    releaseFirst.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
    expect(maxActiveWriters).toBe(1);
    expect(events).toEqual(['first-enter', 'first-exit', 'second-enter']);
  });
});
