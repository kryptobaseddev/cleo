/** Independent durability and validation oracles for typed requirement gates. */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AcceptanceGate, AcRow, Task } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { awaitBackgroundOps } from '../../store/background-ops.js';
import type { DataAccessor } from '../../store/data-accessor.js';
import { closeDb, getNativeTasksDb } from '../../store/sqlite.js';
import { createSqliteDataAccessor } from '../../store/sqlite-data-accessor.js';
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
});
