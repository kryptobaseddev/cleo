/** Task control policies and atomic decision evidence across public entry points. */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SeverityAttestation, TasksAddParams } from '@cleocode/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCleoIdentity, verifyAuditLine } from '../../identity/cleo-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { addTask, toTaskAddOptions } from '../add.js';
import * as duplicateDetector from '../duplicate-detector.js';
import { tasksAddOp, tasksUpdateOp } from '../ops.js';
import { addTaskWithSessionScope } from '../session-scope.js';
import { canonicalAttestationJson } from '../severity-attestation.js';
import { taskUpdate, updateTask } from '../update.js';

let env: TestDbEnv;
const input: TasksAddParams = {
  title: 'Control policy fixture',
  description: 'An independently authorized severity assertion',
  type: 'saga',
  severity: 'P1',
};

async function configureOwners(owners: string[]): Promise<void> {
  const path = join(env.cleoDir, 'config.json');
  const config = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...config, ownerPubkeys: owners }));
}

function freshRead() {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const tasks = db.prepare('SELECT id, title, priority, severity FROM main.tasks_tasks ORDER BY id').all();
    const audit = db.prepare("SELECT task_id, action, details_json FROM main.audit_log WHERE action IN ('task_created','task_updated') ORDER BY rowid").all();
    db.close(); process.stdout.write(JSON.stringify({ tasks, audit }));
  `,
        join(env.cleoDir, 'cleo.db'),
      ],
      { timeout: 10_000, encoding: 'utf8', maxBuffer: 1024 * 1024 },
    ),
  );
}

beforeEach(async () => {
  env = await createTestDb();
  vi.stubEnv('CLEO_DIR', env.cleoDir);
  vi.stubEnv('CLEO_IDENTITY_SEED', 'ab'.repeat(32));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await env.cleanup();
});

describe('canonical task mutation controls', () => {
  it.each([
    'sdk',
    'engine',
    'operation',
  ] as const)('rejects unauthorized severity creation through %s', async (entry) => {
    await configureOwners(['00'.repeat(32)]);
    if (entry === 'engine') {
      const result = await addTaskWithSessionScope(env.tempDir, input);
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('E_OWNER_ONLY');
    } else if (entry === 'operation') {
      await expect(tasksAddOp(env.tempDir, input)).rejects.toThrow('E_OWNER_ONLY');
    } else {
      await expect(
        addTask({ ...toTaskAddOptions(input), severity: 'P1' }, env.tempDir, env.accessor),
      ).rejects.toThrow('E_OWNER_ONLY');
    }
    expect(freshRead()).toEqual({ tasks: [], audit: [] });
    expect(existsSync(join(env.cleoDir, 'audit/severity-attestation.jsonl'))).toBe(false);
  });

  it.each([
    'sdk',
    'engine',
    'operation',
  ] as const)('rejects unauthorized severity updates through %s', async (entry) => {
    await seedTasks(env.accessor, [{ id: 'T001', severity: 'P0' }]);
    await configureOwners(['00'.repeat(32)]);
    if (entry === 'engine') {
      const result = await taskUpdate(env.tempDir, 'T001', { severity: 'P3' });
      expect(result.success).toBe(false);
      expect(result.error?.message).toContain('E_OWNER_ONLY');
    } else if (entry === 'operation') {
      await expect(tasksUpdateOp(env.tempDir, { taskId: 'T001', severity: 'P3' })).rejects.toThrow(
        'E_OWNER_ONLY',
      );
    } else {
      await expect(
        updateTask({ taskId: 'T001', severity: 'P3' }, env.tempDir, env.accessor),
      ).rejects.toThrow('E_OWNER_ONLY');
    }
    expect(freshRead().tasks[0].severity).toBe('P0');
    expect(freshRead().audit).toEqual([]);
  });

  it('checks effective dependencies on explicit-critical update without tightening ordinary edits', async () => {
    await seedTasks(env.accessor, [
      { id: 'T001', priority: 'critical' },
      { id: 'T002' },
      { id: 'T003', depends: ['T002'] },
    ]);
    await updateTask(
      { taskId: 'T001', title: 'Historical critical task renamed' },
      env.tempDir,
      env.accessor,
    );
    for (const changes of [{ depends: [] }, { removeDepends: ['T002'] }]) {
      await expect(
        updateTask({ taskId: 'T003', priority: 'critical', ...changes }, env.tempDir, env.accessor),
      ).rejects.toThrow('declare at least one dependency');
    }
    expect((await env.accessor.loadSingleTask('T003'))?.depends).toEqual(['T002']);
    await tasksUpdateOp(env.tempDir, { taskId: 'T003', priority: 'critical' });
    expect(freshRead().tasks).toContainEqual(
      expect.objectContaining({ id: 'T003', priority: 'critical' }),
    );
  });

  it.each([
    false,
    true,
  ])('persists a verifiable committed severity assertion with opt-in owner policy=%s', async (restricted) => {
    const identity = await getCleoIdentity(env.tempDir);
    await configureOwners(restricted ? [identity.pubkeyHex] : []);
    const result = await addTask(
      {
        ...toTaskAddOptions(input),
        severity: 'P1',
        priority: 'critical',
        dependsWaiver: 'Independent restoration',
      },
      env.tempDir,
      env.accessor,
    );
    await tasksUpdateOp(env.tempDir, { taskId: result.task.id, severity: 'P2' });
    const stored = freshRead();
    expect(stored.tasks[0].severity).toBe('P2');
    expect(stored.audit).toHaveLength(2);
    for (const row of stored.audit) {
      const details = JSON.parse(row.details_json);
      const { status, _sig, ...assertion } = details.severityAttestation;
      expect(status).toBe('committed');
      expect(assertion.taskId).toBe(result.task.id);
      expect(assertion.title).toBe(input.title);
      expect(assertion.signerPub).toBe(identity.pubkeyHex);
      expect(
        await verifyAuditLine(
          canonicalAttestationJson(assertion as SeverityAttestation),
          _sig.sig,
          _sig.pub,
        ),
      ).toBe(true);
    }
    expect(JSON.parse(stored.audit[0].details_json).dependsWaiver).toBe('Independent restoration');
  });

  it('keeps dry-run severity assertions out of task state and committed evidence', async () => {
    await configureOwners(['00'.repeat(32)]);
    await addTask(
      { ...toTaskAddOptions(input), severity: 'P1', dryRun: true },
      env.tempDir,
      env.accessor,
    );
    expect(freshRead()).toEqual({ tasks: [], audit: [] });
    expect(existsSync(join(env.cleoDir, 'audit/severity-attestation.jsonl'))).toBe(false);
  });

  it('rolls back task, criteria, dependency waiver, and signed decision when receipt persistence fails', async () => {
    const db = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      db.exec(
        "CREATE TRIGGER refuse_fixture_receipt BEFORE INSERT ON main.audit_log WHEN NEW.action='task_created' BEGIN SELECT RAISE(ABORT, 'fixture receipt fault'); END",
      );
      await expect(
        addTask(
          {
            ...toTaskAddOptions(input),
            severity: 'P1',
            priority: 'critical',
            dependsWaiver: 'Independent restoration',
            acceptance: ['Verified restoration'],
          },
          env.tempDir,
          env.accessor,
        ),
      ).rejects.toMatchObject({ cause: { message: 'fixture receipt fault' } });
      expect(freshRead()).toEqual({ tasks: [], audit: [] });
      expect(
        db.prepare('SELECT COUNT(*) AS n FROM main.tasks_task_acceptance_criteria').get()?.n,
      ).toBe(0);
      expect(existsSync(join(env.cleoDir, 'audit/severity-attestation.jsonl'))).toBe(false);
    } finally {
      db.close();
    }
  });
  it('retains duplicate bypass provenance only when the task transaction commits', async () => {
    vi.spyOn(duplicateDetector, 'checkDuplicatesBounded').mockResolvedValue({
      maxScore: 0.99,
      shouldReject: true,
      shouldWarn: false,
      candidates: [{ id: 'T999', title: 'Historical candidate', score: 0.99 }],
    });
    const db = new DatabaseSync(join(env.cleoDir, 'cleo.db'));
    try {
      db.exec(
        "CREATE TRIGGER refuse_duplicate_receipt BEFORE INSERT ON main.audit_log WHEN NEW.action='task_created' BEGIN SELECT RAISE(ABORT, 'fixture duplicate receipt fault'); END",
      );
      await expect(
        addTask({ ...toTaskAddOptions(input), forceDuplicate: true }, env.tempDir, env.accessor),
      ).rejects.toMatchObject({ cause: { message: 'fixture duplicate receipt fault' } });
      expect(freshRead()).toEqual({ tasks: [], audit: [] });
      expect(existsSync(join(env.cleoDir, 'audit/duplicate-bypass.jsonl'))).toBe(false);
      db.exec('DROP TRIGGER refuse_duplicate_receipt');
      const result = await tasksAddOp(env.tempDir, { ...input, forceDuplicate: true });
      const persisted = freshRead();
      expect(persisted.tasks).toHaveLength(1);
      expect(JSON.parse(persisted.audit[0].details_json).forceDuplicate).toMatchObject({
        requested: true,
        bypassed: true,
        status: 'committed',
        maxScore: 0.99,
        matchedCandidates: [{ id: 'T999', title: 'Historical candidate', score: 0.99 }],
      });
      expect(persisted.audit[0].task_id).toBe(result.task.id);
      const mirror = await readFile(join(env.cleoDir, 'audit/duplicate-bypass.jsonl'), 'utf8');
      expect(JSON.parse(mirror)).toMatchObject({ taskId: result.task.id, status: 'committed' });
      const repeated = await tasksAddOp(env.tempDir, { ...input, forceDuplicate: true });
      expect(repeated.duplicate).toBe(true);
      expect(freshRead().audit).toHaveLength(1);
      expect(await readFile(join(env.cleoDir, 'audit/duplicate-bypass.jsonl'), 'utf8')).toBe(
        mirror,
      );
    } finally {
      db.close();
    }
  });
});
