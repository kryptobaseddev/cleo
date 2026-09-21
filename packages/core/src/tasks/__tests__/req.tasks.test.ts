/** Independent durability and validation oracles for typed requirement gates. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, AcRow, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureProjectScope, worktreeScope } from '../../project-scope.js';
import { _forceSystemdRunAvailable } from '../../resources/spawn-wrapper.js';
import { awaitBackgroundOps, createOperationExecutionContext } from '../../store/background-ops.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { closeDb, getNativeTasksDb } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
import { validateGateVerify } from '../../validation/engine-ops.js';
import { buildFreshAcRows } from '../ac-table.js';
import { parseGateJson, reqAdd, reqList, reqMigrate } from '../req.js';

function gate(req = 'PARTNER-121'): AcceptanceGate {
  return {
    kind: 'test',
    command: 'node',
    args: ['axiom-app/scripts/verify-partner-completion.mjs', '--task', 'T121'],
    expect: 'exit0',
    timeoutMs: 1_800_000,
    req,
    description: 'Task-specific harness must pass',
    advisory: false,
    cwd: '.',
    env: { REQUIREMENT_FIXTURE: 'literal | Unicode λ' },
    minCount: 1,
  };
}

function persisted(root: string, sql: string): string {
  const child = spawnSync(
    process.execPath,
    [
      '--max-old-space-size=128',
      '--input-type=module',
      '-e',
      `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      try { process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all())); }
      finally { db.close(); }
    `,
      join(root, '.cleo/cleo.db'),
      sql,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: root, TMPDIR: root, TMP: root, TEMP: root },
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return child.stdout;
}

describe('typed requirement persistence', () => {
  let root: string;
  let accessor: DataAccessor;
  const original = ['Literal a|b', 'tests pass'];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-requirement-'));
    await mkdir(join(root, '.cleo'));
    vi.stubEnv('CLEO_ROOT', root);
    vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    accessor = await createSqliteDataAccessor(root);
    const task: Task = {
      id: 'T121',
      title: 'Requirement fixture',
      description: 'Synthetic typed requirement persistence fixture',
      status: 'pending',
      type: 'task',
      priority: 'medium',
      createdAt: '2026-09-20T00:00:00Z',
      acceptance: original,
    };
    await accessor.transaction(async (tx) => {
      await tx.upsertSingleTask(task);
      await tx.insertAcRows(buildFreshAcRows(task.id, original));
    });
  });

  afterEach(async () => {
    await awaitBackgroundOps();
    closeDb();
    vi.unstubAllEnvs();
    _forceSystemdRunAvailable(undefined);
    await rm(root, { recursive: true, force: true });
  });

  it('preserves every gate field, literal text and canonical AC projection in a fresh process', async () => {
    const typed = gate();
    await reqAdd(root, 'T121', typed, accessor);
    const stored = JSON.parse(
      persisted(root, "SELECT acceptance_json FROM tasks_tasks WHERE id='T121'"),
    );
    expect(JSON.parse(stored[0].acceptance_json)).toEqual([...original, typed]);
    const rows: Pick<AcRow, 'kind' | 'sourceKey' | 'text'>[] = JSON.parse(
      persisted(
        root,
        "SELECT kind,source_key AS sourceKey,text FROM tasks_task_acceptance_criteria WHERE task_id='T121' ORDER BY ordinal",
      ),
    );
    expect(rows.slice(0, 2).map((row) => row.text)).toEqual(original);
    expect(rows[2]!.kind).toBe('evidence_bound');
    expect(rows[2]!.sourceKey).toBe('evidence:PARTNER-121');
    expect(JSON.parse(rows[2]!.text)).toEqual(typed);
    expect(await reqList(root, 'T121', accessor)).toEqual({
      taskId: 'T121',
      gates: [
        { index: 2, req: typed.req, kind: 'test', description: typed.description, advisory: false },
      ],
    });
  });

  it.each([
    { ...gate(), kind: 'unrecognized' },
    { ...gate(), timeoutMs: -1 },
    { ...gate(), args: [23] },
    { ...gate(), unsupported: 'must not be silently dropped' },
    {
      kind: 'file',
      description: 'Nested key must not vanish',
      path: 'a',
      assertions: [{ type: 'exists', unsupported: true }],
    },
  ])('rejects invalid runtime gate input before any durable mutation: %j', async (input) => {
    const before = persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks');
    const beforeRows = persisted(root, 'SELECT * FROM tasks_task_acceptance_criteria');
    const runtimeInput: AcceptanceGate = JSON.parse(JSON.stringify(input));
    await expect(reqAdd(root, 'T121', runtimeInput, accessor)).rejects.toThrow();
    expect(() => parseGateJson(JSON.stringify(input))).toThrow();
    expect(persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks')).toBe(before);
    expect(persisted(root, 'SELECT * FROM tasks_task_acceptance_criteria')).toBe(beforeRows);
  });

  it('retains concurrent distinct appends and rejects a concurrent duplicate identity', async () => {
    await Promise.all([
      reqAdd(root, 'T121', gate('FIRST'), accessor),
      reqAdd(root, 'T121', gate('SECOND'), accessor),
    ]);
    expect((await reqList(root, 'T121', accessor)).gates.map((item) => item.req)).toEqual([
      'FIRST',
      'SECOND',
    ]);
    const attempts = await Promise.allSettled([
      reqAdd(root, 'T121', gate('SHARED'), accessor),
      reqAdd(root, 'T121', gate('SHARED'), accessor),
    ]);
    expect(attempts.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(
      persisted(
        root,
        "SELECT source_key FROM tasks_task_acceptance_criteria WHERE kind='evidence_bound' ORDER BY ordinal",
      ),
    ).toBe(
      JSON.stringify(
        ['FIRST', 'SECOND', 'SHARED'].map((req) => ({ source_key: `evidence:${req}` })),
      ),
    );
  });

  it('rolls task JSON and all AC rows back when the evidence row insertion fails', async () => {
    const before = persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks');
    const beforeRows = persisted(root, 'SELECT * FROM tasks_task_acceptance_criteria');
    const native = getNativeTasksDb(root);
    expect(native).not.toBeNull();
    native?.exec(
      "CREATE TRIGGER reject_gate BEFORE INSERT ON tasks_task_acceptance_criteria WHEN NEW.kind='evidence_bound' BEGIN SELECT RAISE(ABORT,'requirement fault'); END",
    );
    await expect(reqAdd(root, 'T121', gate(), accessor)).rejects.toThrow();
    expect(persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks')).toBe(before);
    expect(persisted(root, 'SELECT * FROM tasks_task_acceptance_criteria')).toBe(beforeRows);
  });

  it('does not let an inner requirement savepoint escape an outer rollback', async () => {
    const before = persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks');
    await expect(
      accessor.transaction(async () => {
        await reqAdd(root, 'T121', gate(), accessor);
        expect((await reqList(root, 'T121', accessor)).gates).toHaveLength(1);
        throw new Error('outer caller rejects operation');
      }),
    ).rejects.toThrow('outer caller rejects operation');
    expect(persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks')).toBe(before);
    expect((await reqList(root, 'T121', accessor)).gates).toEqual([]);
  });

  it('propagates a diagnostic read failure without starting a partial write', async () => {
    const before = persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks');
    const read = vi
      .spyOn(accessor, 'loadSingleTask')
      .mockRejectedValueOnce(new Error('injected read failure'));
    try {
      await expect(reqAdd(root, 'T121', gate(), accessor)).rejects.toThrow('injected read failure');
    } finally {
      read.mockRestore();
    }
    expect(persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks')).toBe(before);
  });

  it('rejects a missing task and malformed JSON without creating a record', async () => {
    await expect(reqAdd(root, 'T404', gate(), accessor)).rejects.toThrow('Task not found: T404');
    expect(() => parseGateJson('{bad JSON')).toThrow('not valid JSON');
    expect(persisted(root, "SELECT id FROM tasks_tasks WHERE id='T404'")).toBe('[]');
  });

  it('keeps migration preview read-only and preserves existing requirement identities on apply', async () => {
    await reqAdd(root, 'T121', gate('MIGRATED-001'), accessor);
    const before = persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks');
    const preview = await reqMigrate(root, 'T121', false, accessor);
    expect(preview.proposals.map((proposal) => proposal.reqId)).toEqual([
      'MIGRATED-002',
      'MIGRATED-003',
    ]);
    expect(persisted(root, 'SELECT acceptance_json,updated_at FROM tasks_tasks')).toBe(before);
    await reqMigrate(root, 'T121', true, accessor);
    expect((await reqList(root, 'T121', accessor)).gates.map((item) => item.req)).toEqual([
      'MIGRATED-002',
      'MIGRATED-003',
      'MIGRATED-001',
    ]);
  });
  async function verificationFixture(script: string, content?: string) {
    _forceSystemdRunAvailable(false);
    await writeFile(
      join(root, '.cleo/project-info.json'),
      JSON.stringify({ projectId: 'requirement-verifier', projectHash: 'fixture-path' }),
    );
    await writeFile(
      join(root, '.cleo/config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        verification: { enabled: true, requiredGates: ['cleanupDone'] },
        lifecycle: { mode: 'off' },
      }),
    );
    if (content !== undefined) await writeFile(join(root, script), content);
    await reqAdd(
      root,
      'T121',
      {
        kind: 'test',
        command: process.execPath,
        args: [script],
        expect: 'exit0',
        req: 'VERIFY-121',
        description: 'Actual harness result',
        timeoutMs: 1800000,
      },
      accessor,
    );
  }

  it('canonical verify runs the real harness and commits exact bound result plus receipt in a fresh process', async () => {
    await verificationFixture('verified.mjs', 'process.exit(0);');
    const result = await validateGateVerify(root, {
      taskId: 'T121',
      gate: 'cleanupDone',
      value: true,
      agent: 'implementer',
      evidence: 'note:explicit synthetic verification',
    });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    const loaded = await accessor.loadSingleTask('T121');
    expect(loaded?.verification?.gateResults?.[0]).toMatchObject({
      index: 2,
      req: 'VERIFY-121',
      result: 'pass',
      binding: { taskId: 'T121' },
    });
    const stored = JSON.parse(
      persisted(root, "SELECT verification_json FROM tasks_tasks WHERE id='T121'"),
    );
    expect(JSON.parse(stored[0].verification_json).gateResults).toEqual(
      loaded?.verification?.gateResults,
    );
    const logs = JSON.parse(
      persisted(
        root,
        "SELECT details_json FROM tasks_audit_log WHERE task_id='T121' AND action='gate.verify.typed'",
      ),
    );
    expect(
      logs,
      persisted(
        root,
        "SELECT action, task_id, details_json FROM audit_log WHERE action='gate.verify.typed'",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(logs[0].details_json).verificationId).toBe(
      loaded?.verification?.gateResults?.[0]?.binding?.verificationId,
    );
    const rows = await accessor.getAcRows('T121');
    expect(
      (await accessor.getAcBindings([rows[2]!.id])).some(
        (entry) => entry.bindingType === 'satisfies',
      ),
    ).toBe(true);
  });

  it('canonical verify records missing harness as unmet instead of green generic evidence', async () => {
    await verificationFixture('not-present.mjs');
    const result = await validateGateVerify(root, {
      taskId: 'T121',
      gate: 'cleanupDone',
      value: true,
      agent: 'implementer',
      evidence: 'note:explicit synthetic verification',
    });
    expect(result.success, result.success ? undefined : result.error.message).toBe(true);
    if (!result.success) throw new Error(result.error.message);
    expect(result.data.passed).toBe(false);
    const loaded = await accessor.loadSingleTask('T121');
    expect(loaded?.verification?.gateResults?.[0]).toMatchObject({
      req: 'VERIFY-121',
      result: 'fail',
    });
    const rows = await accessor.getAcRows('T121');
    expect(await accessor.getAcBindings([rows[2]!.id])).toEqual([]);
  });
  it('canonical verify rolls results and bindings back if mandatory receipt insertion fails', async () => {
    await verificationFixture('verified.mjs', 'process.exit(0);');
    const before = persisted(root, 'SELECT verification_json,updated_at FROM tasks_tasks');
    const beforeBindings = persisted(root, 'SELECT * FROM tasks_evidence_ac_bindings');
    const native = getNativeTasksDb(root);
    expect(native).not.toBeNull();
    native!.exec(
      "CREATE TRIGGER reject_typed_receipt BEFORE INSERT ON tasks_audit_log WHEN NEW.action='gate.verify.typed' BEGIN SELECT RAISE(ABORT,'typed receipt fault'); END",
    );
    const result = await validateGateVerify(root, {
      taskId: 'T121',
      gate: 'cleanupDone',
      agent: 'implementer',
      evidence: 'note:explicit synthetic verification',
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Receipt fault unexpectedly committed');
    expect(result.error.message).toContain('typed receipt fault');
    expect(persisted(root, 'SELECT verification_json,updated_at FROM tasks_tasks')).toBe(before);
    expect(persisted(root, 'SELECT * FROM tasks_evidence_ac_bindings')).toBe(beforeBindings);
    expect(persisted(root, "SELECT id FROM tasks_audit_log WHERE action='gate.verify.typed'")).toBe(
      '[]',
    );
  });

  it('canonical verify admits one concurrent result and records a fresh run on a later repeat', async () => {
    await verificationFixture(
      'rendezvous.mjs',
      `
      import { writeFileSync, readdirSync } from 'node:fs';
      writeFileSync('gate-started-' + process.pid, 'ready');
      const began = Date.now();
      while (readdirSync('.').filter(name => name.startsWith('gate-started-')).length < 2) {
        if (Date.now() - began > 1200) process.exit(2);
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    `,
    );
    const verify = () =>
      validateGateVerify(root, {
        taskId: 'T121',
        gate: 'cleanupDone',
        agent: 'implementer',
        evidence: 'note:explicit synthetic verification',
      });
    const results = await Promise.all([verify(), verify()]);
    expect(results.map((result) => result.success).sort()).toEqual([false, true]);
    expect(results.find((result) => !result.success)?.error?.message).toContain(
      'changed during execution',
    );
    const first = await accessor.loadSingleTask('T121');
    const firstId = first?.verification?.gateResults?.[0]?.binding?.verificationId;
    expect(firstId).toBeTruthy();
    expect(
      JSON.parse(
        persisted(root, "SELECT id FROM tasks_audit_log WHERE action='gate.verify.typed'"),
      ),
    ).toHaveLength(1);
    const repeat = await verify();
    expect(repeat.success, repeat.success ? undefined : repeat.error.message).toBe(true);
    const second = await accessor.loadSingleTask('T121');
    expect(second?.verification?.gateResults?.[0]?.binding?.verificationId).not.toBe(firstId);
    expect(
      JSON.parse(
        persisted(root, "SELECT id FROM tasks_audit_log WHERE action='gate.verify.typed'"),
      ),
    ).toHaveLength(2);
  });
  it('canonical verify retains the admitted deadline instead of renewing the long gate timeout', async () => {
    await verificationFixture(
      'slow.mjs',
      'await new Promise(resolve => setTimeout(resolve, 10000));',
    );
    const before = persisted(root, 'SELECT verification_json,updated_at FROM tasks_tasks');
    const beforeBindings = persisted(root, 'SELECT * FROM tasks_evidence_ac_bindings');
    const context = createOperationExecutionContext(
      {
        projectId: 'requirement-verifier',
        projectRoot: root,
        actor: 'deadline-test',
        operation: 'check.gate.verify',
        idempotencyKey: 'original-deadline',
      },
      { deadlineAt: Date.now() + 100 },
    );
    try {
      const result = await worktreeScope.run(
        captureProjectScope(root, { ...captureProjectScope(root, undefined), execution: context }),
        () =>
          validateGateVerify(root, {
            taskId: 'T121',
            gate: 'cleanupDone',
            agent: 'deadline-test',
            evidence: 'note:explicit synthetic verification',
          }),
      );
      expect(result.success).toBe(false);
      expect(persisted(root, 'SELECT verification_json,updated_at FROM tasks_tasks')).toBe(before);
      expect(persisted(root, 'SELECT * FROM tasks_evidence_ac_bindings')).toBe(beforeBindings);
      expect(
        persisted(root, "SELECT id FROM tasks_audit_log WHERE action='gate.verify.typed'"),
      ).toBe('[]');
      expect(() => context.assertActive()).toThrow();
    } finally {
      context.close();
    }
  });
});
