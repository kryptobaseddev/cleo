/** Real CLI parsing and durable custody; the injected process runner never reaches Orca. */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock, readWorktreeTaskLock } from '@cleocode/worktree';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureLaunch,
  fixtureReleasedShow,
  fixtureReply,
  fixtureReportDispatch,
  fixtureReportInbox,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runOrcaFixture,
} from '../../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { pipelineManifestAppend } from '../../../../../core/src/memory/pipeline-manifest-sqlite.js';
import { launchOrcaWorker } from '../../../../../core/src/orchestrate/orca-execution.js';
import { listWorkerRecords } from '../../../../../core/src/orchestrate/worker-records.js';
import { requireSpawnSession } from '../../../../../core/src/spawn/agent-identity.js';
import {
  createTestDb,
  seedTasks,
  type TestDbEnv,
} from '../../../../../core/src/store/__tests__/test-db-helper.js';

const { project } = vi.hoisted(() => ({
  project: { root: '' },
}));

vi.mock('@cleocode/core/project-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cleocode/core/project-scope')>()),
  getProjectRoot: () => project.root,
}));
vi.mock('@cleocode/adapters/orca-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cleocode/adapters/orca-execution')>();
  const { fixtureRunner } = await import(
    '../../../../../adapters/src/__tests__/orca-execution-fixture.js'
  );
  return {
    ...actual,
    OrcaExecutionBackend: class extends actual.OrcaExecutionBackend {
      constructor() {
        super(fixtureRunner, 'orca-fixture');
      }
    },
  };
});

import { orchestrateCommand } from '../orchestrate.js';

describe('orchestrate worker — restart recovery through the CLI', () => {
  let env: TestDbEnv;
  let launch: OrcaLaunch;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_AGENT_ID', 'fixture-coordinator');
    env = await createTestDb();
    project.root = env.tempDir;
    vi.stubEnv('CLEO_HOME', realpathSync(join(env.tempDir, '.cleo-home')));
    await seedTasks(env.accessor, [
      {
        id: 'T001',
        title: 'Recover an exact Orca dispatch',
        status: 'pending',
        priority: 'medium',
      },
    ]);
    const session = await requireSpawnSession(env.tempDir, 'T001');
    if (!session.ok) throw new Error(session.message);
    const projectHash = computeProjectHash(env.tempDir);
    const worktreePath = resolveTaskWorktreePath(projectHash, 'T001');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'dirty.txt'), 'owner work');
    const lock = acquireWorktreeTaskLock({
      projectHash,
      taskId: 'T001',
      holder: { sessionId: session.identity.sessionId, agentId: session.identity.agentId },
    });
    launch = {
      ...fixtureLaunch,
      projectId: readDeclaredProjectIdentity(env.tempDir)?.projectId ?? 'missing-project',
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
    orcaFixture.request = fixtureReply({ state: 'completed', requestId: 'request-fixture' });
    orcaFixture.read = fixtureReply({
      text: 'original output',
      nextCursor: 'source-pinned-cursor',
    });
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
    process.exitCode = 0;
  });

  afterEach(async () => {
    process.exitCode = 0;
    if (env) await env.cleanup();
    vi.unstubAllEnvs();
  });

  async function run(...args: string[]): Promise<string> {
    let output = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    try {
      await runCommand(orchestrateCommand, { rawArgs: ['worker', ...args] });
      return output;
    } finally {
      write.mockRestore();
    }
  }

  async function start() {
    return launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend());
  }

  async function expectCustody(): Promise<void> {
    expect((await env.accessor.loadSingleTask('T001'))?.claim).toMatchObject({
      sessionId: launch.workerSessionId,
      agentId: launch.agentId,
    });
    expect(readWorktreeTaskLock(launch.projectHash, 'T001')?.token).toBe(launch.lockToken);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe('owner work');
  }

  it('ingests an exact worker_done id through CLI parsing and returns the same durable report on restart', async () => {
    const record = await start();
    const report =
      'Implementation complete. manifest:cli-report\nconclusion: Implemented the change.\nblocker: none\nproof: vitest worker.test.ts => exit 0';
    writeFileSync(join(launch.worktreePath, 'worker-report.txt'), report);
    const manifest = await pipelineManifestAppend(
      {
        id: 'cli-report',
        file: 'cli-report.md',
        title: 'CLI worker result',
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
    orcaFixture.inbox = fixtureReportInbox();
    orcaFixture.currentDispatch = fixtureReportDispatch();
    fixtureRunner.mockClear();
    for (let delivery = 0; delivery < 2; delivery++) {
      const output = await run('ingest-report', record.recordId, '--message-id', 'msg_report');
      expect(JSON.parse(output)).toMatchObject({
        success: true,
        data: {
          recordId: record.recordId,
          stoppedAt: null,
          report: {
            manifestId: 'cli-report',
            reportText: report,
            event: { messageId: 'msg_report' },
          },
        },
      });
      expect(process.exitCode).toBe(0);
    }
    expect(fixtureRunner.mock.calls.map(([, args]) => args[1])).toEqual([
      'inbox',
      'dispatch-show',
      'inbox',
      'dispatch-show',
    ]);
    expect((await env.accessor.loadSingleTask('T001'))?.verification?.gates?.implemented).not.toBe(
      true,
    );
    await expectCustody();
  });

  it('shows the stored dispatch and forwards a source-pinned read cursor without consuming mail', async () => {
    const record = await start();
    fixtureRunner.mockClear();
    const shown = await run('show', record.recordId);
    expect(JSON.parse(shown)).toMatchObject({
      success: true,
      data: {
        recordId: record.recordId,
        execution: { dispatchId: 'ctx_fixture' },
      },
    });
    const read = await run('read', record.recordId, '--cursor', 'source-pinned-cursor');
    expect(JSON.parse(read)).toMatchObject({ success: true, data: orcaFixture.read.stdout });
    expect(fixtureRunner.mock.calls.map(([, args]) => args)).toEqual([
      [
        'orchestration',
        'worker-show',
        '--dispatch',
        'ctx_fixture',
        '--environment',
        'local',
        '--json',
        '--full',
      ],
      [
        'orchestration',
        'worker-read',
        '--dispatch',
        'ctx_fixture',
        '--source',
        'auto',
        '--limit',
        '200',
        '--cursor',
        'source-pinned-cursor',
        '--environment',
        'local',
        '--json',
        '--full',
      ],
    ]);
    await expectCustody();
  });

  it('replays a lost start receipt from storage using the original caller and request id', async () => {
    orcaFixture.start = {
      exitCode: 1,
      stderr: '',
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: {
          code: 'runtime_timeout',
          message: 'lost reply',
          data: { orchestrationRequestId: 'request-fixture' },
        },
      }),
    };
    const record = await start();
    expect(record.execution?.state).toBe('outcome_unknown');
    orcaFixture.start = fixtureStart();
    fixtureRunner.mockClear();
    await run('recover-start', record.recordId);
    const [saved] = await listWorkerRecords(env.tempDir);
    expect(saved).toMatchObject({
      recordId: record.recordId,
      sessionId: launch.workerSessionId,
      execution: { state: 'ready', dispatchId: 'ctx_fixture', startRequestId: 'request-fixture' },
    });
    const call = fixtureRunner.mock.calls.find(([, args]) => args[1] === 'worker-start');
    expect(call?.[1]).toEqual([
      'orchestration',
      'worker-start',
      '--from',
      fixtureContext.coordinatorHandle,
      '--worktree',
      'identity:workspace-fixture',
      '--agent',
      'codex',
      '--spec-file',
      '-',
      '--task-title',
      `${launch.projectId}:T001:${launch.instanceId}`,
      '--retry-request',
      'request-fixture',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    expect(call?.[3]).toBe(launch.prompt);
    await expectCustody();
  });

  it('refuses recovery without a saved replay identity and never falls back to a fresh launch', async () => {
    orcaFixture.start = { stdout: '', stderr: 'transport lost', exitCode: null };
    const record = await start();
    fixtureRunner.mockClear();
    const output = await run('recover-start', record.recordId);
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      error: {
        code: 'E_CLEO_SPAWN_FAILED',
        message: 'No recoverable start request is stored for this attempt.',
        fix: expect.stringContaining('absent receipt'),
        details: { recordId: record.recordId, action: 'recover-start' },
      },
    });
    expect(process.exitCode).toBe(63);
    expect(fixtureRunner).not.toHaveBeenCalled();
    await expectCustody();
  });

  it('retries only a confirmed resource-free predecessor, reserving the new exact request before send', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const record = await start();
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    let requestKey: string | undefined;
    fixtureRunner.mockImplementation(async (...args) => {
      if (args[1][1] === 'worker-start') {
        const records = await listWorkerRecords(env.tempDir, true);
        const reserved = records.find((r) => r.recordId !== record.recordId);
        requestKey = reserved?.execution?.startRequestKey;
        expect(requestKey).toBeTruthy();
        expect(reserved?.execution).toMatchObject({
          state: 'launching',
          retryOf: 'ctx_fixture',
          dispatchId: null,
        });
        expect(records.find((r) => r.recordId === record.recordId)?.stoppedAt).not.toBeNull();
      }
      return runOrcaFixture(...args);
    });
    await run('retry', record.recordId);
    const [successor] = await listWorkerRecords(env.tempDir);
    expect(successor?.execution).toMatchObject({
      dispatchId: 'ctx_retry',
      retryOf: 'ctx_fixture',
      startRequestKey: requestKey,
    });
    expect(fixtureRunner.mock.calls.at(-1)?.[1]).toEqual([
      'orchestration',
      'worker-start',
      '--from',
      fixtureContext.coordinatorHandle,
      '--worktree',
      'identity:workspace-fixture',
      '--agent',
      'codex',
      '--task',
      'task_fixture',
      '--run',
      'run_fixture',
      '--retry-of',
      'ctx_fixture',
      '--retry-request',
      requestKey,
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    await expectCustody();
  });

  it('keeps stop_unknown fenced until an exact saved stop is replayed, preserving dirty work', async () => {
    const record = await start();
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: {
          code: 'runtime_timeout',
          message: 'stop reply lost',
          data: { orchestrationRequestId: 'request-fixture', dispatchId: 'ctx_fixture' },
        },
      }),
      stderr: '',
      exitCode: 1,
    };
    fixtureRunner.mockClear();
    await run('stop', record.recordId);
    expect((await listWorkerRecords(env.tempDir))[0]?.execution?.state).toBe('stop_unknown');
    const refused = await run('stop', record.recordId);
    expect(JSON.parse(refused)).toMatchObject({
      success: false,
      error: { code: 'E_CLEO_SPAWN_FAILED', fix: expect.stringContaining('do not repeat') },
    });
    expect(process.exitCode).toBe(63);
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      1,
    );
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    process.exitCode = 0;
    await run('recover-stop', record.recordId);
    expect((await listWorkerRecords(env.tempDir))[0]).toMatchObject({
      stoppedAt: null,
      execution: { state: 'stopped', resourceState: 'stopped', stopRequestId: 'request-fixture' },
    });
    expect(fixtureRunner.mock.calls.at(-1)?.[1]).toEqual([
      'orchestration',
      'worker-stop',
      '--dispatch',
      'ctx_fixture',
      '--retry-request',
      'request-fixture',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    await expectCustody();
  });

  it('honors the breaker after restart without starting a replacement', async () => {
    const record = await start();
    orcaFixture.show = fixtureReleasedShow('ctx_fixture', 3);
    fixtureRunner.mockClear();
    const output = await run('retry', record.recordId);
    expect(JSON.parse(output)).toMatchObject({
      success: false,
      error: {
        code: 'E_CLEO_SPAWN_FAILED',
        message:
          'The predecessor has no confirmed resource-free failure or stop eligible for retry.',
        fix: expect.stringContaining('Inspect its exact Dispatch'),
      },
    });
    expect(process.exitCode).toBe(63);
    expect(fixtureRunner.mock.calls.map(([, args]) => args[1])).toEqual(['worker-show']);
    expect((await listWorkerRecords(env.tempDir))[0]?.execution).toMatchObject({
      state: 'circuit_broken',
      failureCount: 3,
    });
    await expectCustody();
  });

  it('does not guess a record from a task id or accept an invalid operation/cursor', async () => {
    await start();
    fixtureRunner.mockClear();
    const missing = await run('show', 'T001');
    expect(JSON.parse(missing)).toMatchObject({
      success: false,
      error: { code: 'E_CLEO_SPAWN_FAILED', fix: expect.stringContaining('exact record id') },
    });
    expect(process.exitCode).toBe(63);
    expect(fixtureRunner).not.toHaveBeenCalled();
    for (const argv of [
      ['restart', 'T001'],
      ['retry', 'T001', '--cursor', 'source-pinned-cursor'],
    ]) {
      const invalid = await run(...argv);
      expect(JSON.parse(invalid)).toMatchObject({
        success: false,
        error: { code: 'E_INVALID_INPUT', fix: 'Use cleo orchestrate worker --help.' },
      });
      expect(process.exitCode).toBe(6);
    }
    expect(fixtureRunner).not.toHaveBeenCalled();
    await expectCustody();
  });

  it('reads a retired predecessor without changing custody or permitting another operation on it', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await start();
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    await run('retry', predecessor.recordId);
    const before = await listWorkerRecords(env.tempDir, true);
    expect(before.find((r) => r.recordId === predecessor.recordId)?.stoppedAt).not.toBeNull();
    fixtureRunner.mockClear();
    const output = await run('read', predecessor.recordId, '--cursor', 'source-pinned-cursor');
    expect(JSON.parse(output)).toMatchObject({ success: true, data: orcaFixture.read.stdout });
    expect(fixtureRunner.mock.calls).toHaveLength(1);
    expect(fixtureRunner.mock.calls[0]?.[1]).toEqual([
      'orchestration',
      'worker-read',
      '--dispatch',
      'ctx_fixture',
      '--source',
      'auto',
      '--limit',
      '200',
      '--cursor',
      'source-pinned-cursor',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    for (const action of ['show', 'stop', 'retry', 'recover-start', 'recover-stop']) {
      const refused = await run(action, predecessor.recordId);
      expect(JSON.parse(refused)).toMatchObject({
        success: false,
        error: { code: 'E_CLEO_SPAWN_FAILED', fix: expect.stringContaining('exact record id') },
      });
      expect(process.exitCode).toBe(63);
    }
    expect(fixtureRunner.mock.calls).toHaveLength(1);
    expect(await listWorkerRecords(env.tempDir, true)).toEqual(before);
    await expectCustody();
  });
});
