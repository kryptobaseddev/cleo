/**
 * Dispatch-level receipt for typed requirements (T12292): the operations
 * `cleo req add`, `cleo verify --run`, `cleo complete` and `cleo add` dispatch
 * run here against a real temporary project store, with the Axiom gate shape.
 *
 * The 2026.9.7 failure was `tasks.req.add` missing from the registry and the
 * tasks handler (E_INVALID_OPERATION); these cases prove the routed surface
 * now persists, executes and enforces the gate end to end.
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckHandler } from '../../../dispatch/domains/check.js';
import { TasksHandler } from '../../../dispatch/domains/tasks.js';

const HARNESS = 'harness/verify-partner-completion.mjs';

/** The Axiom partner gate: task-specific harness, exit 0, 30-minute timeout. */
function partnerGate(req = 'PARTNER-01'): Record<string, unknown> {
  return {
    kind: 'test',
    command: process.execPath,
    args: [HARNESS, '--task', 'T001'],
    expect: 'exit0',
    timeoutMs: 1_800_000,
    req,
    description: 'Partner completion harness passes',
  };
}

let root: string;
const tasks = new TasksHandler();
const check = new CheckHandler();

/** Read rows from the project store in a separate, read-only Node process. */
function freshRead(sql: string): Array<Record<string, string | number | null>> {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { DatabaseSync } from 'node:sqlite';
       const db = new DatabaseSync(process.argv[1], { readOnly: true });
       try { process.stdout.write(JSON.stringify(db.prepare(process.argv[2]).all())); }
       finally { db.close(); }`,
      join(root, '.cleo', 'cleo.db'),
      sql,
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

function storedAcceptance(taskId: string): unknown[] {
  const rows = freshRead(`SELECT acceptance_json FROM tasks_tasks WHERE id='${taskId}'`);
  expect(rows).toHaveLength(1);
  return JSON.parse(String(rows[0]?.['acceptance_json']));
}

const FIVE_ACS = [
  'AC one holds',
  'AC two holds',
  'AC three holds',
  'AC four holds',
  'AC five holds',
];

/** The saga → epic → task spine a fixture task lives in. */
interface Spine {
  sagaId: string;
  epicId: string;
  taskId: string;
}

/** Strict-spine containment (T11811): a task lives under an epic under a saga. */
async function addSpine(): Promise<Spine> {
  const saga = await tasks.mutate('saga.create', {
    title: 'Partner programme',
    description: 'Synthetic saga root for typed requirement routing',
    acceptance: FIVE_ACS,
  });
  expect(saga.success, JSON.stringify(saga.error)).toBe(true);
  const sagaId = (saga.data as { task: { id: string } }).task.id;
  const epic = await tasks.mutate('add', {
    title: 'Partner company system',
    description: 'Synthetic epic for typed requirement routing',
    type: 'epic',
    parent: sagaId,
    acceptance: FIVE_ACS,
  });
  expect(epic.success, JSON.stringify(epic.error)).toBe(true);
  const epicId = (epic.data as { task: { id: string } }).task.id;
  const added = await tasks.mutate('add', {
    title: 'Partner completion',
    description: 'Synthetic partner completion task for typed requirement routing',
    parent: epicId,
    acceptance: ['Partner records reconcile'],
  });
  expect(added.success, JSON.stringify(added.error)).toBe(true);
  const taskId = (added.data as { task: { id: string } }).task.id;
  expect(taskId).toMatch(/^T\d+$/);
  return { sagaId, epicId, taskId };
}

async function addTask(): Promise<string> {
  return (await addSpine()).taskId;
}

function taskCount(): unknown {
  return freshRead('SELECT COUNT(*) AS n FROM tasks_tasks')[0]?.['n'];
}

/** A refusal at the shared acceptance-input boundary, with the `cleo req add` fix. */
function expectGateTextRefused(response: { success: boolean; error?: { fix?: string } }): void {
  expect(response.success).toBe(false);
  expect(response.error?.fix).toContain('cleo req add');
}

describe('typed requirement dispatch receipt (T12292)', () => {
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cleo-req-receipt-'));
    await mkdir(join(root, '.cleo'), { recursive: true });
    await mkdir(join(root, 'harness'), { recursive: true });
    vi.stubEnv('CLEO_ROOT', root);
    vi.stubEnv('CLEO_DIR', join(root, '.cleo'));
    vi.stubEnv('CLEO_DISABLE_PROJECT_AUTOREGISTER', '1');
    await writeFile(
      join(root, '.cleo', 'project-info.json'),
      JSON.stringify({ projectId: 'req-receipt', projectHash: 'req-receipt' }),
    );
    await writeFile(
      join(root, '.cleo', 'config.json'),
      JSON.stringify({
        enforcement: { session: { requiredForMutate: false }, acceptance: { mode: 'off' } },
        lifecycle: { mode: 'off' },
      }),
    );
  });

  afterEach(async () => {
    const { closeDb, closeAllDatabases } = await import('@cleocode/core/internal');
    closeDb();
    await closeAllDatabases();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('req add keeps every Axiom gate field and its task link across a fresh-process read', async () => {
    const { epicId, taskId } = await addSpine();
    const added = await tasks.mutate('req.add', {
      taskId,
      gate: JSON.stringify(partnerGate()),
    });
    expect(added.success, JSON.stringify(added.error)).toBe(true);

    const acceptance = storedAcceptance(taskId);
    expect(acceptance[0]).toBe('Partner records reconcile');
    expect(acceptance[1]).toMatchObject(partnerGate());

    // Relationships, read in the same separate process: the REQ-ID's canonical
    // criterion row is bound to this task, and the task stays under its epic.
    const criteria = freshRead(
      `SELECT task_id, kind, source_key, text FROM tasks_task_acceptance_criteria WHERE source_key='evidence:PARTNER-01'`,
    );
    expect(criteria).toHaveLength(1);
    expect(criteria[0]).toMatchObject({ task_id: taskId, kind: 'evidence_bound' });
    expect(JSON.parse(String(criteria[0]?.['text']))).toMatchObject(partnerGate());
    expect(freshRead(`SELECT parent_id FROM tasks_tasks WHERE id='${taskId}'`)[0]).toEqual({
      parent_id: epicId,
    });
  });

  it('a missing harness fails verify --run and complete refuses the task', async () => {
    const taskId = await addTask();
    await tasks.mutate('req.add', { taskId, gate: JSON.stringify(partnerGate()) });

    const run = await check.query('gate.run', { taskId });
    expect(run.success).toBe(false);
    expect(run.error?.code).toBe('E_GATE_RUN_FAILED');

    const completed = await tasks.mutate('complete', { taskId });
    expect(completed.success).toBe(false);
    // The refusal is the typed requirement itself, not an unrelated gate.
    expect(completed.error?.message).toContain('PARTNER-01');
    expect(
      freshRead(`SELECT status FROM tasks_tasks WHERE id='${taskId}'`)[0]?.['status'],
    ).not.toBe('done');
  });

  it('a parent cannot complete while its child is held open by a missing harness', async () => {
    const { epicId, taskId } = await addSpine();
    await tasks.mutate('req.add', { taskId, gate: JSON.stringify(partnerGate()) });
    expect((await tasks.mutate('complete', { taskId })).success).toBe(false);

    const parent = await tasks.mutate('complete', { taskId: epicId });
    expect(parent.success).toBe(false);
    expect(JSON.stringify(parent.error)).toContain(taskId);
    expect(
      freshRead(`SELECT status FROM tasks_tasks WHERE id IN ('${epicId}','${taskId}')`).map(
        (row) => row['status'],
      ),
    ).not.toContain('done');
  });

  it('a present harness passes verify --run, and deleting it invalidates the pass', async () => {
    const taskId = await addTask();
    await tasks.mutate('req.add', { taskId, gate: JSON.stringify(partnerGate()) });
    await writeFile(join(root, HARNESS), 'process.exit(0);\n');

    const passed = await check.query('gate.run', { taskId });
    expect(passed.success, JSON.stringify(passed.error)).toBe(true);

    await unlink(join(root, HARNESS));
    const rerun = await check.query('gate.run', { taskId });
    expect(rerun.success).toBe(false);
    expect(rerun.error?.code).toBe('E_GATE_RUN_FAILED');
  });

  it('refuses a duplicate REQ-ID and an unsupported gate field without changing acceptance', async () => {
    const taskId = await addTask();
    await tasks.mutate('req.add', { taskId, gate: JSON.stringify(partnerGate()) });
    const before = storedAcceptance(taskId);

    const duplicate = await tasks.mutate('req.add', {
      taskId,
      gate: JSON.stringify(partnerGate()),
    });
    expect(duplicate.success).toBe(false);
    expect(duplicate.error?.message).toContain('already exists');

    const unsupported = await tasks.mutate('req.add', {
      taskId,
      gate: JSON.stringify({ ...partnerGate('PARTNER-02'), retries: 3 }),
    });
    expect(unsupported.success).toBe(false);
    expect(unsupported.error?.fix).toBeTruthy();

    expect(storedAcceptance(taskId)).toEqual(before);
  });

  // AC3: every write path shares one acceptance-input boundary, so each one
  // refuses a gate passed as text. Each call would write without the refusal.
  it('tasks.add with array params refuses a typed gate as text and writes no task row', async () => {
    const { epicId } = await addSpine();
    const before = taskCount();
    expectGateTextRefused(
      await tasks.mutate('add', {
        title: 'Gate as prose',
        description: 'A typed gate passed through text acceptance must be refused',
        parent: epicId,
        acceptance: ['Partner records reconcile', JSON.stringify(partnerGate())],
      }),
    );
    expect(taskCount()).toBe(before);
  });

  it('tasks.add-batch refuses a typed gate as text and writes no task row', async () => {
    const { epicId } = await addSpine();
    const before = taskCount();
    expectGateTextRefused(
      await tasks.mutate('add-batch', {
        defaultParent: epicId,
        tasks: [
          {
            title: 'Batch prose task',
            description: 'A valid batch entry that must roll back with its sibling',
            acceptance: ['Partner records reconcile'],
          },
          {
            title: 'Batch gate as prose',
            description: 'A typed gate passed through text acceptance must be refused',
            acceptance: [JSON.stringify(partnerGate())],
          },
        ],
      }),
    );
    expect(taskCount()).toBe(before);
  });

  it('tasks.update refuses a typed gate as text and leaves acceptance unchanged', async () => {
    const taskId = await addTask();
    const before = storedAcceptance(taskId);
    expectGateTextRefused(
      await tasks.mutate('update', {
        taskId,
        acceptance: ['Partner records reconcile', JSON.stringify(partnerGate())],
      }),
    );
    expect(storedAcceptance(taskId)).toEqual(before);
  });

  it('saga.create refuses a typed gate as text and writes no task row', async () => {
    await addSpine();
    const before = taskCount();
    expectGateTextRefused(
      await tasks.mutate('saga.create', {
        title: 'Gate saga',
        description: 'A typed gate passed through text acceptance must be refused',
        acceptance: [...FIVE_ACS.slice(0, 4), JSON.stringify(partnerGate())],
      }),
    );
    expect(taskCount()).toBe(before);
  });
});
