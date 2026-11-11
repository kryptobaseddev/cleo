/** T14458: durable report ingress against real stores and an injected Orca process boundary. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import { orcaReportSourceSchema } from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureLaunch,
  fixtureReportDispatch,
  fixtureReportInbox,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runOrcaFixture,
} from '../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { hooks } from '../../hooks/registry.js';
import { pipelineManifestAppend } from '../../memory/pipeline-manifest-sqlite.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { setClaimClock } from '../../store/task-claim.js';
import {
  ingestOrcaWorkerReport,
  launchOrcaWorker,
  observeOrcaWorker,
  orchestrateOrcaWorker,
} from '../orca-execution.js';
import {
  listWorkerRecords,
  markWorkerExited,
  reconcileWorkerExits,
  type WorkerRecord,
} from '../worker-records.js';

const REPORT =
  'Implementation complete. manifest:report-fixture\nconclusion: Implemented the assigned change.\nblocker: none\nproof: vitest worker.test.ts => exit 0\nproof: src/worker.ts';

describe('Orca canonical worker report ingress', () => {
  let env: TestDbEnv;
  let launch: OrcaLaunch;
  let record: WorkerRecord;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_AGENT_ID', 'fixture-coordinator');
    env = await createTestDb();
    vi.stubEnv('CLEO_HOME', realpathSync(join(env.tempDir, '.cleo-home')));
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Ingest worker report', status: 'pending', priority: 'medium' },
      { id: 'T002', title: 'Another task', status: 'pending', priority: 'medium' },
    ]);
    const session = await requireSpawnSession(env.tempDir, 'T001');
    if (!session.ok) throw new Error(session.message);
    const projectHash = computeProjectHash(env.tempDir);
    const worktreePath = resolveTaskWorktreePath(projectHash, 'T001');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'worker-report.txt'), REPORT);
    writeFileSync(join(worktreePath, 'dirty.txt'), 'owner work');
    const lock = acquireWorktreeTaskLock({
      projectHash,
      taskId: 'T001',
      holder: { sessionId: session.identity.sessionId, agentId: session.identity.agentId },
    });
    launch = {
      ...fixtureLaunch,
      projectId: readDeclaredProjectIdentity(env.tempDir)?.projectId ?? 'missing',
      projectRoot: env.tempDir,
      projectHash,
      worktreePath,
      workerSessionId: session.identity.sessionId,
      agentId: session.identity.agentId,
      lockToken: lock.record.token,
    };
    orcaFixture.launch = launch;
    orcaFixture.start = fixtureStart();
    orcaFixture.show = fixtureShow();
    orcaFixture.inbox = fixtureReportInbox();
    orcaFixture.currentDispatch = fixtureReportDispatch();
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
    record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    const manifest = await pipelineManifestAppend(
      {
        id: 'report-fixture',
        file: 'report-fixture.md',
        title: 'Worker result',
        date: '2026-11-11',
        status: 'completed',
        agent_type: 'implementation',
        topics: ['orca'],
        actionable: false,
        linked_tasks: ['T001'],
      },
      env.tempDir,
    );
    expect(manifest.success).toBe(true);
    fixtureRunner.mockClear();
  });

  afterEach(async () => {
    setClaimClock(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await env.cleanup();
  });

  async function ingest(): Promise<WorkerRecord> {
    return ingestOrcaWorkerReport(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
      'msg_report',
    );
  }

  async function expectCustody(): Promise<void> {
    const task = await env.accessor.loadSingleTask('T001');
    expect(task?.status).toBe('active');
    expect(task?.verification?.gates?.implemented).not.toBe(true);
    expect(task?.claim).toMatchObject({
      sessionId: launch.workerSessionId,
      agentId: launch.agentId,
    });
    expect(readWorktreeTaskLock(launch.projectHash, 'T001')?.token).toBe(launch.lockToken);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe('owner work');
    const [stored] = await listWorkerRecords(env.tempDir);
    expect(stored).toMatchObject({
      pid: null,
      pgid: null,
      stoppedAt: null,
      execution: record.execution,
    });
    expect(fixtureRunner.mock.calls.map(([, args]) => args[1])).not.toContain('check');
    expect(
      fixtureRunner.mock.calls.every(([, args]) =>
        ['inbox', 'dispatch-show', 'worker-show'].includes(args[1] ?? ''),
      ),
    ).toBe(true);
  }

  it('preserves the checked report, manifest and transport separately without accepting or releasing work', async () => {
    const stop = vi.spyOn(hooks, 'dispatch');
    const settled = await ingest();
    expect(settled.report).toMatchObject({
      manifestId: 'report-fixture',
      reportText: REPORT,
      reportDigest: createHash('sha256').update(REPORT).digest('hex'),
      event: {
        messageId: 'msg_report',
        runtimeId: fixtureContext.runtimeId,
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId: 'ctx_fixture',
        body: 'Implemented the change. Checks passed. Review remains.',
      },
    });
    expect(settled.report?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await listWorkerRecords(env.tempDir))[0]).toEqual(settled);
    expect(
      await markWorkerExited({ instanceId: record.instanceId }, undefined, env.tempDir),
    ).toMatchObject({ emitted: false });
    expect(await reconcileWorkerExits(env.tempDir, () => false)).toEqual([]);
    expect(stop).not.toHaveBeenCalledWith('SubagentStop', expect.anything());
    await expectCustody();
  });

  it('deduplicates concurrent delivery, CLI restart and a second event for the same logical report', async () => {
    const [first, concurrent] = await Promise.all([ingest(), ingest()]);
    expect(concurrent.report).toEqual(first.report);
    rmSync(join(launch.worktreePath, 'worker-report.txt'));
    expect((await ingest()).report).toEqual(first.report);
    writeFileSync(join(launch.worktreePath, 'worker-report.txt'), REPORT);
    orcaFixture.inbox = fixtureReportInbox({ messageId: 'msg_duplicate' });
    const duplicate = await ingestOrcaWorkerReport(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
      'msg_duplicate',
    );
    expect(duplicate.report).toEqual(first.report);
    const observed = await observeOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(observed.report).toEqual(first.report);
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(1);
  });

  it.each([
    ['missing proof', REPORT.replace(/\nproof: .*/g, ''), 'E_WORKER_REPORT_PROOF'],
    ['invalid proof', REPORT.replace('=> exit 0', '=> exit 1'), 'E_WORKER_REPORT_PROOF'],
    [
      'placeholder proof',
      REPORT.replace('vitest worker.test.ts => exit 0', '<cmd> => exit 0'),
      'E_WORKER_REPORT_PROOF',
    ],
    ['oversized report', REPORT.replace('assigned change.', 'word '.repeat(120)), 'E_VALIDATION'],
    ['wrong protocol', REPORT.replace('Implementation', 'Research'), 'E_ORCA_REPORT_OUTCOME'],
    [
      'blocked work',
      REPORT.replace('complete.', 'blocked.').replace('blocker: none', 'blocker: tests failed'),
      'E_ORCA_REPORT_OUTCOME',
    ],
    [
      'missing manifest',
      REPORT.replace('manifest:report-fixture', 'manifest:absent'),
      'E_ORCA_REPORT_MANIFEST',
    ],
  ])('refuses %s without changing task or resource state', async (_reason, report, code) => {
    writeFileSync(join(launch.worktreePath, 'worker-report.txt'), report);
    await expect(ingest()).rejects.toMatchObject({ code });
    expect((await listWorkerRecords(env.tempDir))[0]?.report).toBeUndefined();
    await expectCustody();
  });

  it.each([
    ['wrong runtime', { runtimeId: 'runtime_other' }],
    ['wrong Run', { runId: 'run_other' }],
    ['wrong Task', { orcaTaskId: 'task_other' }],
    ['stale Dispatch', { dispatchId: 'ctx_old' }],
    ['failed outcome', { outcome: 'failed' as const }],
  ])('refuses %s even when the canonical report claims success', async (_reason, change) => {
    orcaFixture.inbox = fixtureReportInbox(change);
    await expect(ingest()).rejects.toThrow();
    expect((await listWorkerRecords(env.tempDir))[0]?.report).toBeUndefined();
    await expectCustody();
  });

  it.each([
    'ctx_replacement',
    'cancelled',
    'wrong-sender',
    'old-contract',
    'unparseable',
    'missing-path',
  ])('refuses unproven current delivery: %s', async (reason) => {
    if (reason === 'ctx_replacement') orcaFixture.currentDispatch = fixtureReportDispatch(reason);
    else if (reason === 'cancelled')
      orcaFixture.currentDispatch = fixtureReportDispatch('ctx_fixture', reason);
    else if (reason === 'unparseable')
      orcaFixture.inbox = { stdout: '{broken', stderr: '', exitCode: 0 };
    else {
      const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
      const message = source.result.messages?.[0];
      if (!message) throw new Error('Missing fixture message');
      if (reason === 'wrong-sender') {
        message.from_handle = 'term_other';
        message.sender_pane_key = 'pane_other';
      }
      if (reason === 'old-contract') message.delivery_contract = 'legacy';
      if (reason === 'missing-path')
        message.payload = JSON.stringify({
          taskId: 'task_fixture',
          dispatchId: 'ctx_fixture',
          outcome: 'succeeded',
        });
      orcaFixture.inbox = { stdout: JSON.stringify(source), stderr: '', exitCode: 0 };
    }
    await expect(ingest()).rejects.toThrow();
    await expectCustody();
  });

  it('refuses a missing report or an escaping symlink instead of parsing transport prose', async () => {
    rmSync(join(launch.worktreePath, 'worker-report.txt'));
    await expect(ingest()).rejects.toMatchObject({ code: 'E_ORCA_REPORT_FILE' });
    writeFileSync(join(env.tempDir, 'outside-report'), REPORT);
    symlinkSync(
      join(env.tempDir, 'outside-report'),
      join(launch.worktreePath, 'worker-report.txt'),
    );
    await expect(ingest()).rejects.toMatchObject({ code: 'E_ORCA_REPORT_FILE' });
    await expectCustody();
  });

  it('refuses replacing a settled logical report with a different event or proof', async () => {
    const first = await ingest();
    orcaFixture.inbox = fixtureReportInbox({ messageId: 'msg_changed' });
    writeFileSync(
      join(launch.worktreePath, 'worker-report.txt'),
      REPORT.replace('src/worker.ts', 'src/changed.ts'),
    );
    await expect(
      ingestOrcaWorkerReport(
        record.recordId,
        env.tempDir,
        new OrcaExecutionBackend(fixtureRunner),
        'msg_changed',
      ),
    ).rejects.toThrow('different worker report');
    expect((await listWorkerRecords(env.tempDir))[0]?.report).toEqual(first.report);
    await expectCustody();
  });

  it.each([
    'wrong task',
    'unfinished',
    'wrong protocol',
  ])('refuses a manifest with %s', async (reason) => {
    const manifest = await pipelineManifestAppend(
      {
        id: 'wrong-report',
        file: 'wrong-report.md',
        title: 'Another result',
        date: '2026-11-11',
        status: reason === 'unfinished' ? 'partial' : 'completed',
        agent_type: reason === 'wrong protocol' ? 'research' : 'implementation',
        topics: [],
        actionable: false,
        linked_tasks: [reason === 'wrong task' ? 'T002' : 'T001'],
      },
      env.tempDir,
    );
    expect(manifest.success).toBe(true);
    writeFileSync(
      join(launch.worktreePath, 'worker-report.txt'),
      REPORT.replace('report-fixture', 'wrong-report'),
    );
    await expect(ingest()).rejects.toMatchObject({ code: 'E_ORCA_REPORT_MANIFEST' });
    await expectCustody();
  });

  it.each([
    'before validation',
    'before commit',
  ])('refuses a claim that expires %s', async (when) => {
    const expire = () => setClaimClock(() => Date.now() + 86_400_000);
    if (when === 'before validation') expire();
    else {
      const manifests = await import('../../memory/pipeline-manifest-sqlite.js');
      const read = manifests.readManifestEntries;
      vi.spyOn(manifests, 'readManifestEntries').mockImplementationOnce(async (...args) => {
        const entries = await read(...args);
        expire();
        return entries;
      });
    }
    await expect(ingest()).rejects.toThrow(/claim/);
    expect((await listWorkerRecords(env.tempDir))[0]?.report).toBeUndefined();
    setClaimClock(null);
    await expectCustody();
  });

  it('retains report settlement when an earlier resource observation returns after ingestion', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const records = await import('../worker-records.js');
    const update = records.updateWorkerExecution;
    let settled: WorkerRecord | undefined;
    vi.spyOn(records, 'updateWorkerExecution').mockImplementationOnce(async (...args) => {
      settled = await ingest();
      return update(...args);
    });
    const observed = await observeOrcaWorker(record.recordId, env.tempDir, backend);
    expect(observed.report).toEqual(settled?.report);
    expect(observed.report?.reportText).toBe(REPORT);
    expect(observed.stoppedAt).toBeNull();
  });

  it('requires message ids only for ingest-report requests', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(
      await orchestrateOrcaWorker(
        { action: 'ingest-report', recordId: record.recordId },
        env.tempDir,
        backend,
      ),
    ).toMatchObject({ success: false, error: { code: 'E_INVALID_INPUT' } });
    expect(
      await orchestrateOrcaWorker(
        { action: 'show', recordId: record.recordId, messageId: 'msg_report' },
        env.tempDir,
        backend,
      ),
    ).toMatchObject({ success: false, error: { code: 'E_INVALID_INPUT' } });
    expect(fixtureRunner).not.toHaveBeenCalled();
  });
});
