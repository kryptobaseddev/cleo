/** T14458: durable report ingress against real stores and an injected Orca process boundary. */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import {
  orcaReplySchema,
  orcaReportMessageSchema,
  orcaReportSourceSchema,
} from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureLaunch,
  fixtureMail,
  fixtureMbxRunner,
  fixtureReleasedShow,
  fixtureReply,
  fixtureReportDispatch,
  fixtureReportInbox,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runMbxFixture,
  runOrcaFixture,
} from '../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { hooks } from '../../hooks/registry.js';
import { pipelineManifestAppend } from '../../memory/pipeline-manifest-sqlite.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { tasksAgentInstances } from '../../store/schema/cleo-project/runtime.js';
import { getDb } from '../../store/sqlite.js';
import { setClaimClock } from '../../store/task-claim.js';
import { createAgentMbxClient } from '../agentmbx.js';
import {
  ingestOrcaWorkerReport,
  launchOrcaWorker,
  observeOrcaWorker,
  orchestrateOrcaWorker,
  relayOrcaWorkerReport,
  retryOrcaWorker,
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
    fixtureMail.bodies.clear();
    fixtureMail.failBefore = false;
    fixtureMail.loseAck = false;
    fixtureMbxRunner.mockReset().mockImplementation(runMbxFixture);
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
      createAgentMbxClient(fixtureMbxRunner),
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

  it.each([
    199, 200, 529,
  ])('ingests the exact report behind %i newer inbox messages', async (newerMessages) => {
    orcaFixture.inbox = fixtureReportInbox({}, newerMessages);
    expect((await ingest()).report?.event.messageId).toBe('msg_report');
    const inboxCalls = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'inbox');
    expect(inboxCalls.map(([, args]) => args[args.indexOf('--limit') + 1])).toEqual(
      newerMessages < 200 ? ['200'] : newerMessages < 400 ? ['200', '400'] : ['200', '400', '800'],
    );
    await expectCustody();
  });

  it('exhausts history before refusing a message id that is absent', async () => {
    orcaFixture.inbox = fixtureReportInbox({ messageId: 'msg_other' }, 529);
    await expect(ingest()).rejects.toMatchObject({
      code: 'E_ORCA_REPORT_SOURCE',
      message: expect.stringContaining('absent from the exhausted Run inbox'),
      fix: expect.stringContaining('run:run_fixture'),
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'inbox')).toHaveLength(3);
    await expectCustody();
  });

  it('does not claim absence when its bounded history search is incomplete', async () => {
    fixtureRunner.mockImplementation(async (...args) => {
      if (args[1][1] !== 'inbox') return runOrcaFixture(...args);
      const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
      const limit = Number(args[1][args[1].indexOf('--limit') + 1]);
      source.result.messages = Array.from({ length: limit }, (_, index) => ({
        id: `noise_${index}`,
      }));
      return { ...orcaFixture.inbox, stdout: JSON.stringify(source) };
    });
    await expect(ingest()).rejects.toMatchObject({
      code: 'E_ORCA_REPORT_SOURCE',
      message: expect.stringContaining('older history remains unsearched'),
      fix: expect.stringContaining('--limit 25600'),
    });
    expect(fixtureRunner.mock.calls).toHaveLength(7);
    await expectCustody();
  });

  it('ignores unrelated malformed inbox rows but validates the target row', async () => {
    const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
    source.result.messages?.unshift(
      null,
      42,
      'unrelated',
      {},
      { id: 'msg_unrelated', body: false },
    );
    orcaFixture.inbox = { ...orcaFixture.inbox, stdout: JSON.stringify(source) };
    expect((await ingest()).report?.event.messageId).toBe('msg_report');
    source.result.messages = [{ id: 'msg_report', body: false }];
    orcaFixture.inbox = { ...orcaFixture.inbox, stdout: JSON.stringify(source) };
    await expect(ingest()).rejects.toMatchObject({
      code: 'E_ORCA_REPORT_SOURCE',
      message: expect.stringContaining('body'),
    });
    await expectCustody();
  });

  it.each([
    'command failure',
    'invalid JSON',
    'schema issues',
    'runtime drift',
    'missing messages',
    'malformed target',
    'malformed payload',
    'transport failure',
  ])('retains subprocess diagnostics in the public refusal for %s', async (reason) => {
    orcaFixture.inbox = { ...orcaFixture.inbox, stderr: 'source diagnostic', exitCode: 17 };
    let issue = 'did not exit successfully';
    if (reason === 'invalid JSON') {
      orcaFixture.inbox.stdout = '{broken';
      issue = 'JSON';
    } else if (reason === 'schema issues') {
      orcaFixture.inbox.stdout = JSON.stringify({ ok: true, _meta: { runtimeId: 42 }, result: {} });
      issue = 'runtimeId';
    } else if (reason === 'runtime drift') {
      orcaFixture.inbox = {
        ...fixtureReportInbox({ runtimeId: 'runtime_other' }),
        stderr: 'source diagnostic',
      };
      issue = 'runtime_other';
    } else if (reason === 'missing messages') {
      const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
      delete source.result.messages;
      orcaFixture.inbox = { ...orcaFixture.inbox, stdout: JSON.stringify(source), exitCode: 0 };
      issue = 'messages array';
    } else if (reason === 'malformed target' || reason === 'malformed payload') {
      const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
      const message = orcaReportMessageSchema.parse(source.result.messages?.[0]);
      source.result.messages =
        reason === 'malformed target'
          ? [{ id: 'msg_report', body: false }]
          : [{ ...message, payload: '{broken' }];
      orcaFixture.inbox = { ...orcaFixture.inbox, stdout: JSON.stringify(source), exitCode: 0 };
      issue = reason === 'malformed target' ? 'body' : 'report-path payload';
    } else if (reason === 'transport failure') {
      orcaFixture.inbox.exitCode = null;
    }
    const refused = await orchestrateOrcaWorker(
      { action: 'ingest-report', recordId: record.recordId, messageId: 'msg_report' },
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(refused).toMatchObject({
      success: false,
      error: {
        code: 'E_ORCA_REPORT_SOURCE',
        message: expect.stringContaining(`"exitCode":${orcaFixture.inbox.exitCode}`),
      },
    });
    expect(refused).toMatchObject({
      error: { message: expect.stringContaining('source diagnostic') },
    });
    expect(refused).toMatchObject({ error: { message: expect.stringContaining(issue) } });
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
      createAgentMbxClient(fixtureMbxRunner),
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
      const message = orcaReportMessageSchema.parse(source.result.messages?.[0]);
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
      source.result.messages = [message];
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
        createAgentMbxClient(fixtureMbxRunner),
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
    await expect(ingest()).rejects.toMatchObject({
      code: 'E_ORCA_REPORT_MANIFEST',
      fix: expect.stringContaining(
        'completed implementation manifest whose linked_tasks includes T001',
      ),
    });
    await expectCustody();
  });

  it('accepts the assigned task anywhere in the manifest linked_tasks', async () => {
    const manifest = await pipelineManifestAppend(
      {
        id: 'multi-task-report',
        file: 'multi-task-report.md',
        title: 'Multiple task result',
        date: '2026-11-11',
        status: 'completed',
        agent_type: 'implementation',
        topics: ['orca'],
        actionable: false,
        linked_tasks: ['T002', 'T001'],
      },
      env.tempDir,
    );
    expect(manifest.success).toBe(true);
    writeFileSync(
      join(launch.worktreePath, 'worker-report.txt'),
      REPORT.replace('report-fixture', 'multi-task-report'),
    );
    expect((await ingest()).report?.manifestId).toBe('multi-task-report');
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

  it('refuses a worker record read under a different portable project identity', async () => {
    const paths = await import('@cleocode/paths');
    const identity = paths.readDeclaredProjectIdentity(env.tempDir);
    if (!identity) throw new Error('Missing fixture project');
    vi.spyOn(paths, 'readDeclaredProjectIdentity').mockReturnValue({
      ...identity,
      projectId: 'project_other',
    });
    await expect(ingest()).rejects.toMatchObject({ code: 'E_ORCA_REPORT_IDENTITY' });
    expect((await listWorkerRecords(env.tempDir))[0]?.report).toBeUndefined();
    await expectCustody();
  });

  it.each([
    'report-first',
    'release-first',
  ])('settles PID-less resource exit and report independently: %s', async (order) => {
    const stop = vi.spyOn(hooks, 'dispatch');
    if (order === 'report-first') await ingest();
    orcaFixture.show = fixtureReleasedShow();
    const exited = await observeOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(exited).toMatchObject({
      pid: null,
      pgid: null,
      resourceRelease: { dispatchId: 'ctx_fixture' },
      execution: { resourceState: 'stopped' },
    });
    expect(exited.stoppedAt).toBe(exited.resourceRelease?.releasedAt);
    expect(exited.resourceRelease?.receipt).toBe(orcaFixture.show.stdout);
    if (order === 'release-first') expect(exited.report).toBeUndefined();
    const settled = await ingest();
    expect(settled.report?.reportText).toBe(REPORT);
    expect(settled.reportDelivery?.state).toBe('delivered');
    await observeOrcaWorker(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner));
    const stops = stop.mock.calls.filter(([event]) => event === 'SubagentStop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[2]).toMatchObject({
      taskId: 'T001',
      status: 'partial',
      metadata: { pid: null, backend: 'orca', dispatchId: 'ctx_fixture' },
    });
    expect((await env.accessor.loadSingleTask('T001'))?.status).toBe('active');
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(
      launch.workerSessionId,
    );
    expect(readWorktreeTaskLock(launch.projectHash, 'T001')?.token).toBe(launch.lockToken);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe('owner work');
    expect(fixtureMail.bodies.size).toBe(1);
  });

  it.each([
    'owned',
    'retained',
    'unknown',
    'foreign-release',
  ])('keeps a done chat worker open without exact resource exit proof: %s', async (state) => {
    await ingest();
    const stop = vi.spyOn(hooks, 'dispatch');
    const source = orcaReplySchema.parse(JSON.parse(fixtureReleasedShow().stdout));
    if (!source.result?.worker || !source.result.projection?.resource || !source.result.observation)
      throw new Error('Incomplete release fixture');
    source.result.worker.state = 'completed';
    if (state === 'foreign-release')
      source.result.projection.resource.ownerDispatchId = 'ctx_foreign';
    else {
      source.result.projection.resource.state = state;
      source.result.observation.status = 'live';
    }
    orcaFixture.show = fixtureReply(source.result);
    const observed = await observeOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(observed.stoppedAt).toBeNull();
    expect(observed.resourceRelease).toBeUndefined();
    expect(stop.mock.calls.filter(([event]) => event === 'SubagentStop')).toHaveLength(0);
    expect(observed.reportDelivery?.state).toBe('delivered');
  });

  it('retains custody after physical exit and retires it atomically for an exact retry', async () => {
    orcaFixture.show = fixtureReleasedShow();
    const exited = await observeOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    await expect(
      launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('custody already exists');
    orcaFixture.start = fixtureStart('ready', 0, 'ctx_retry');
    const retry = await retryOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    const predecessor = (await listWorkerRecords(env.tempDir)).find(
      (worker) => worker.recordId === record.recordId,
    );
    expect(predecessor?.stoppedAt).toBe(exited.stoppedAt);
    expect(predecessor?.retiredAt).toBeDefined();
    expect(retry.execution?.retryOf).toBe('ctx_fixture');
    expect(retry.resourceRelease).toBeUndefined();
    expect(retry.reportDelivery).toBeUndefined();
  });

  it('keeps a legacy worker without leadMailbox readable after report ingestion', async () => {
    (await getDb(env.tempDir))
      .update(tasksAgentInstances)
      .set({ metadataJson: sql`json_remove(${tasksAgentInstances.metadataJson}, '$.leadMailbox')` })
      .where(eq(tasksAgentInstances.id, record.recordId))
      .run();
    expect((await listWorkerRecords(env.tempDir))[0]?.leadMailbox).toBeNull();

    const settled = await ingest();
    expect(settled.reportDelivery).toMatchObject({ mailbox: null, state: 'pending' });
    expect(settled.reportDelivery?.lastError).toContain('No valid lead mailbox');
    expect(settled.report?.reportText).toBe(REPORT);
    expect(await listWorkerRecords(env.tempDir)).toEqual([settled]);
    expect(fixtureMbxRunner).not.toHaveBeenCalled();
  });

  it.each([
    'direct',
    'CLI',
  ])('delivers one logical report through %s ingress and repeated notifications', async (ingress) => {
    if (ingress === 'CLI') {
      const result = await orchestrateOrcaWorker(
        { action: 'ingest-report', recordId: record.recordId, messageId: 'msg_report' },
        env.tempDir,
        new OrcaExecutionBackend(fixtureRunner),
        createAgentMbxClient(fixtureMbxRunner),
      );
      expect(result.success).toBe(true);
    } else await ingest();
    const [first] = await listWorkerRecords(env.tempDir);
    if (!first) throw new Error('Missing stored report fixture');
    const key = `cleo-orca-report:${createHash('sha256')
      .update(
        JSON.stringify([fixtureContext.runtimeId, 'run_fixture', 'ctx_fixture', 'msg_report']),
      )
      .digest('hex')}`;
    expect(first.reportDelivery).toMatchObject({
      key,
      mailbox: 'fixture-lead',
      state: 'delivered',
      messageId: 'mbx-1',
    });
    const orcaCalls = fixtureRunner.mock.calls.length;
    const relayed = await orchestrateOrcaWorker(
      { action: 'relay-report', recordId: record.recordId },
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
      createAgentMbxClient(fixtureMbxRunner),
    );
    expect(relayed.success).toBe(true);
    expect(fixtureRunner).toHaveBeenCalledTimes(orcaCalls);
    await ingest();
    expect(fixtureMbxRunner).toHaveBeenCalledTimes(1);
    expect([...fixtureMail.bodies.values()]).toEqual([REPORT]);
    const args = fixtureMbxRunner.mock.calls[0]?.[0];
    expect(args).toContain(key);
    expect(args?.slice(0, 5)).toEqual(['send', '--as', 'fixture-lead', '--to', 'fixture-lead']);
    await expectCustody();
  });

  it('delivers exactly once when two processes relay the same pending report', async () => {
    fixtureMail.failBefore = true;
    const pending = await ingest();
    expect(pending.reportDelivery?.state).toBe('pending');
    const raceDir = join(env.tempDir, 'report-race');
    const mailboxDir = join(raceDir, 'mailbox');
    const requestsDir = join(raceDir, 'requests');
    mkdirSync(mailboxDir, { recursive: true });
    mkdirSync(requestsDir);
    // Resolve source like Vitest so fresh worktrees exercise the race without a build.
    const child = `
      import { existsSync, linkSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
      import { registerHooks } from 'node:module';
      import { join } from 'node:path';
      import { setTimeout as delay } from 'node:timers/promises';
      import { pathToFileURL } from 'node:url';
      import { transformSync } from ${JSON.stringify(import.meta.resolve('esbuild'))};
      const { cleoWorkspaceSubpathAliases } = await import(${JSON.stringify(new URL('../../../../../vitest-workspace-resolver.ts', import.meta.url).href)});
      const [alias] = cleoWorkspaceSubpathAliases();
      registerHooks({
        resolve(specifier, context, nextResolve) {
          const source = alias.customResolver(specifier);
          if (source) return nextResolve(pathToFileURL(source).href, context);
          if (specifier.startsWith('.') && specifier.endsWith('.js')) {
            const ts = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
            if (existsSync(ts) && !existsSync(new URL(specifier, context.parentURL))) return nextResolve(ts.href, context);
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          if (url.endsWith('.ts')) return { format: 'module', shortCircuit: true,
            source: transformSync(readFileSync(new URL(url), 'utf8'), { loader: 'ts', format: 'esm' }).code };
          return nextLoad(url, context);
        },
      });
      const { relayOrcaWorkerReport } = await import(${JSON.stringify(new URL('../orca-execution.ts', import.meta.url).href)});
      const { createAgentMbxClient } = await import(${JSON.stringify(new URL('../agentmbx.ts', import.meta.url).href)});
      const runner = async (args) => {
        if (args[0] !== 'send') throw new Error('Unexpected mailbox command: ' + args[0]);
        const key = args[args.indexOf('--idempotency-key') + 1];
        const body = args[args.indexOf('-m') + 1];
        if (!key || !body) throw new Error('Missing report key or body');
        writeFileSync(join(process.env.REPORT_REQUESTS, String(process.pid)), JSON.stringify(args));
        const deadline = Date.now() + 15000;
        while (readdirSync(process.env.REPORT_REQUESTS).length < 2) {
          if (Date.now() > deadline) throw new Error('Both relays must reach send before either returns');
          await delay(10);
        }
        const file = join(process.env.REPORT_MAILBOX, encodeURIComponent(key));
        const candidate = file + '.' + process.pid;
        writeFileSync(candidate, JSON.stringify({ id: 'mbx-' + process.pid, body }));
        let duplicate = false;
        try {
          linkSync(candidate, file);
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
          duplicate = true;
        } finally {
          unlinkSync(candidate);
        }
        const message = JSON.parse(readFileSync(file, 'utf8'));
        if (message.body !== body) throw new Error('Replayed key changed report bytes');
        return { missing: false, exitCode: 0, stderr: '', stdout: JSON.stringify({ id: message.id, duplicate }) };
      };
      const record = await relayOrcaWorkerReport(process.env.REPORT_RECORD, process.env.REPORT_PROJECT, createAgentMbxClient(runner));
      process.stdout.write(JSON.stringify(record.reportDelivery));
      process.exit(0);
    `;
    const results = await Promise.allSettled(
      [0, 1].map(() =>
        promisify(execFile)(process.execPath, ['--input-type=module', '--eval', child], {
          cwd: env.tempDir,
          encoding: 'utf8',
          timeout: 30_000,
          env: {
            ...process.env,
            REPORT_RECORD: record.recordId,
            REPORT_PROJECT: env.tempDir,
            REPORT_REQUESTS: requestsDir,
            REPORT_MAILBOX: mailboxDir,
          },
        }),
      ),
    );
    for (const result of results) {
      if (result.status === 'rejected') throw result.reason;
    }
    const [stored] = await listWorkerRecords(env.tempDir);
    expect(stored?.reportDelivery).toMatchObject({
      state: 'delivered',
      key: pending.reportDelivery?.key,
      lastError: null,
    });
    for (const result of results) {
      if (result.status === 'fulfilled')
        expect(JSON.parse(result.value.stdout)).toEqual(stored?.reportDelivery);
    }
    const requests = readdirSync(requestsDir);
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(JSON.parse(readFileSync(join(requestsDir, request), 'utf8'))).toEqual(
        expect.arrayContaining([pending.reportDelivery?.key, REPORT]),
      );
    const mail = readdirSync(mailboxDir);
    expect(mail).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(mailboxDir, mail[0] ?? ''), 'utf8'))).toEqual({
      id: stored?.reportDelivery?.messageId,
      body: REPORT,
    });
    await expectCustody();
  });

  it.each([
    'mailbox unavailable',
    'acknowledgement lost',
  ])('retries %s from the outbox after CLI restart and resource exit', async (failure) => {
    fixtureMail.failBefore = failure === 'mailbox unavailable';
    fixtureMail.loseAck = failure === 'acknowledgement lost';
    const first = await ingest();
    expect(first.reportDelivery?.state).toBe('pending');
    expect(first.reportDelivery?.lastError).toContain(failure);
    orcaFixture.show = fixtureReleasedShow();
    await observeOrcaWorker(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner));
    rmSync(join(launch.worktreePath, 'worker-report.txt'));
    fixtureRunner.mockClear();
    fixtureMail.failBefore = false;
    fixtureMail.loseAck = false;
    const delivered = await relayOrcaWorkerReport(
      record.recordId,
      env.tempDir,
      createAgentMbxClient(fixtureMbxRunner),
    );
    expect(delivered.reportDelivery).toMatchObject({
      state: 'delivered',
      key: first.reportDelivery?.key,
      lastError: null,
    });
    expect(delivered.resourceRelease).toBeDefined();
    expect(fixtureRunner).not.toHaveBeenCalled();
    expect(fixtureMail.bodies.size).toBe(1);
    expect(
      fixtureMbxRunner.mock.calls.map(([args]) => args[args.indexOf('--idempotency-key') + 1]),
    ).toEqual([first.reportDelivery?.key, first.reportDelivery?.key]);
  });

  it('replays the provider key after a crash between mail acceptance and saving its acknowledgement', async () => {
    const workers = await import('../worker-records.js');
    const crash = vi
      .spyOn(workers, 'recordWorkerReportDelivery')
      .mockRejectedValueOnce(new Error('simulated CLI crash'));
    await expect(ingest()).rejects.toThrow('simulated CLI crash');
    expect(fixtureMail.bodies.size).toBe(1);
    expect((await listWorkerRecords(env.tempDir))[0]?.reportDelivery?.state).toBe('pending');
    crash.mockRestore();
    const restored = await relayOrcaWorkerReport(
      record.recordId,
      env.tempDir,
      createAgentMbxClient(fixtureMbxRunner),
    );
    expect(restored.reportDelivery?.state).toBe('delivered');
    expect(fixtureMail.bodies.size).toBe(1);
    const delivery = restored.reportDelivery;
    if (!delivery) throw new Error('Missing delivery receipt');
    const unchanged = await workers.recordWorkerReportDelivery(
      record.recordId,
      {
        ...delivery,
        state: 'pending',
        messageId: null,
        deliveredAt: null,
        lastError: 'late failed acknowledgement',
      },
      env.tempDir,
    );
    expect(unchanged.reportDelivery).toEqual(delivery);
    await expect(
      workers.recordWorkerReportDelivery(
        record.recordId,
        { ...delivery, mailbox: 'another-lead' },
        env.tempDir,
      ),
    ).rejects.toThrow('does not match');
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
