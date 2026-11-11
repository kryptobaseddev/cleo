import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaCommandResult, OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureHelperExited,
  fixtureLaunch,
  fixturePendingStart,
  fixtureReleasedShow,
  fixtureReply,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runOrcaFixture,
} from '../../../../adapters/src/__tests__/orca-execution-fixture.js';
import { hooks } from '../../hooks/registry.js';
import { requireSpawnSession } from '../../spawn/agent-identity.js';
import { createTestDb, seedTasks, type TestDbEnv } from '../../store/__tests__/test-db-helper.js';
import { setClaimClock } from '../../store/task-claim.js';
import {
  launchOrcaWorker,
  observeOrcaWorker,
  recoverOrcaWorkerStart,
  recoverOrcaWorkerStop,
  retryOrcaWorker,
  stopOrcaWorker,
} from '../orca-execution.js';
import {
  abandonWorkerRecord,
  listWorkerRecords,
  markWorkerExited,
  reconcileWorkerExits,
  settleWorkerAtSpawn,
  updateWorkerExecution,
} from '../worker-records.js';

describe('durable Orca execution custody', () => {
  let env: TestDbEnv;
  let launch: OrcaLaunch;

  beforeEach(async () => {
    vi.stubEnv('CLEO_ROOT', undefined);
    vi.stubEnv('CLEO_DIR', undefined);
    vi.stubEnv('CLEO_AGENT_ID', 'fixture-coordinator');
    env = await createTestDb();
    vi.stubEnv('CLEO_HOME', realpathSync(join(env.tempDir, '.cleo-home')));
    await seedTasks(env.accessor, [
      { id: 'T001', title: 'Canonical Orca assignment', status: 'pending', priority: 'medium' },
    ]);
    const session = await requireSpawnSession(env.tempDir, 'T001');
    if (!session.ok) throw new Error(session.message);
    const projectHash = computeProjectHash(env.tempDir);
    const worktreePath = resolveTaskWorktreePath(projectHash, 'T001');
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'dirty.txt'), 'uncommitted owner work');
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
    orcaFixture.helperShows = {};
    orcaFixture.capabilities = [
      'orchestration.contract.v1',
      'orchestration.worker-stop-helpers.v1',
    ];
    orcaFixture.request = fixtureReply({ state: 'completed', requestId: 'request-fixture' });
    orcaFixture.stop = fixtureReply(
      {
        dispatchId: 'ctx_fixture',
        state: 'stop_unknown',
        processAction: 'closed_agent_terminal',
        helpers: [],
      },
      1,
    );
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
  });

  afterEach(async () => {
    setClaimClock(null);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await env.cleanup();
  });

  it('persists pending custody before worker-start and a full binding before admitting ready', async () => {
    fixtureRunner.mockImplementation(async (...args) => {
      if (args[1][1] === 'worker-start') {
        const [pending] = await listWorkerRecords(env.tempDir);
        expect(pending).toMatchObject({
          taskId: 'T001',
          sessionId: launch.workerSessionId,
          pid: null,
          execution: { backend: 'orca', state: 'launching', dispatchId: null },
        });
      }
      return runOrcaFixture(...args);
    });
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(record).toMatchObject({
      provider: 'codex',
      pid: null,
      stoppedAt: null,
      execution: {
        state: 'ready',
        dispatchId: 'ctx_fixture',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        revision: 2,
      },
    });
    expect((await listWorkerRecords(env.tempDir))[0]).toEqual(record);
    const observed = await observeOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(observed.execution?.dispatchId).toBe(record.execution?.dispatchId);
    expect(observed.execution?.revision).toBe(3);
  });

  it('fences a lost receipt across restarts, duplicate calls and both native spawn paths', async () => {
    orcaFixture.start = { stdout: '', stderr: 'CLI timeout after launch', exitCode: null };
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(record.execution?.state).toBe('outcome_unknown');
    await expect(
      launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('custody already exists');
    await expect(
      recoverOrcaWorkerStart(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('No recoverable');
    const { orchestrateSpawn, orchestrateSpawnExecute } = await import('../spawn-ops.js');
    expect(await orchestrateSpawn('T001', undefined, undefined, env.tempDir)).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_ATTEMPT_FENCED' },
    });
    expect(await orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir)).toMatchObject({
      success: false,
      error: { code: 'E_ORCA_ATTEMPT_FENCED' },
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(
      launch.workerSessionId,
    );
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('times out a hanging execution custody read without dispatching or releasing the claim', async () => {
    const workers = await import('../worker-records.js');
    const { governor } = await import('../../resources/governor.js');
    const { orchestrateSpawnExecute, SPAWN_BUDGET_MS } = await import('../spawn-ops.js');
    const release = vi.fn(async () => undefined);
    vi.spyOn(governor, 'tryAcquire').mockResolvedValue({
      deferred: false,
      class: 'agent-session',
      slot: -1,
      acquiredAtMs: Date.now(),
      release,
    });
    const find = vi.spyOn(workers, 'findOrcaWorker');
    const readStarted = new Promise<void>((resolve) => {
      find.mockImplementationOnce(() => {
        resolve();
        return new Promise<never>(() => undefined);
      });
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      let settled = false;
      const startedAt = Date.now();
      const pending = orchestrateSpawnExecute('T001', undefined, undefined, env.tempDir).then(
        (result) => {
          settled = true;
          return result;
        },
      );
      await readStarted;
      await vi.advanceTimersByTimeAsync(SPAWN_BUDGET_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect(await pending).toMatchObject({ success: false, error: { code: 'E_TIMEOUT' } });
      expect(Date.now() - startedAt).toBe(SPAWN_BUDGET_MS);
      expect(release).toHaveBeenCalledOnce();
      expect(fixtureRunner).not.toHaveBeenCalled();
      expect((await env.accessor.loadSingleTask('T001'))?.claim?.sessionId).toBe(
        launch.workerSessionId,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays the saved request after a restart and preserves the original allocated identity', async () => {
    orcaFixture.start = {
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'runtime_timeout',
          message: 'lost reply',
          data: { orchestrationRequestId: 'request-fixture' },
        },
        _meta: { runtimeId: fixtureContext.runtimeId },
      }),
      stderr: '',
      exitCode: 1,
    };
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.start = fixtureStart();
    const recovered = await recoverOrcaWorkerStart(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(recovered).toMatchObject({
      recordId: record.recordId,
      sessionId: launch.workerSessionId,
      execution: { state: 'ready', startRequestId: 'request-fixture', dispatchId: 'ctx_fixture' },
    });
    const starts = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.[1]).toContain('--retry-request');
    expect(starts[1]?.[3]).toBe(launch.prompt);
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(1);
  });

  it('serializes concurrent stops and preserves stop_unknown, claims and dirty worktrees', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    const results = await Promise.allSettled([
      stopOrcaWorker(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
      stopOrcaWorker(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      1,
    );
    const [stored] = await listWorkerRecords(env.tempDir);
    expect(stored).toMatchObject({ stoppedAt: null, execution: { state: 'stop_unknown' } });
    await expect(
      stopOrcaWorker(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('already sent');
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('reserves exactly one successor on the same Task and retains its predecessor history', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(predecessor.execution).toMatchObject({ state: 'failed', resourceState: 'unknown' });
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    fixtureRunner.mockImplementation(async (...args) => {
      if (args[1][1] === 'worker-start') {
        const records = await listWorkerRecords(env.tempDir);
        expect(records.filter((record) => record.stoppedAt === null)).toMatchObject([
          { execution: { state: 'launching', retryOf: 'ctx_fixture', dispatchId: null } },
        ]);
      }
      return runOrcaFixture(...args);
    });
    const results = await Promise.allSettled([
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const records = await listWorkerRecords(env.tempDir);
    expect(records).toHaveLength(2);
    const previous = records.find((record) => record.recordId === predecessor.recordId);
    expect(previous?.execution).toMatchObject({
      launch: predecessor.execution?.launch,
      dispatchId: 'ctx_fixture',
      failureCount: 1,
      state: 'failed',
      resourceState: 'stopped',
    });
    expect(previous?.stoppedAt).not.toBeNull();
    expect(records.find((record) => record.stoppedAt === null)).toMatchObject({
      sessionId: launch.workerSessionId,
      agentId: launch.agentId,
      execution: {
        state: 'ready',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId: 'ctx_retry',
        retryOf: 'ctx_fixture',
        failureCount: 1,
      },
    });
    const starts = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
    expect(starts).toHaveLength(2);
    expect(starts[1]?.[1]).toContain('--retry-of');
    expect(starts[1]?.[1]).toContain('ctx_fixture');
    expect(starts[1]?.[1]).not.toContain('--spec-file');
    expect(starts[1]?.[3]).toBeUndefined();
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('fences a lost successor receipt across restarts without reopening its predecessor', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.start = { stdout: '', stderr: 'reply lost after dispatch', exitCode: null };
    orcaFixture.show = fixtureReleasedShow();
    const successor = await retryOrcaWorker(
      predecessor.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(successor.execution).toMatchObject({
      state: 'outcome_unknown',
      retryOf: 'ctx_fixture',
      failureCount: 1,
    });
    await expect(
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('No open');
    await expect(
      retryOrcaWorker(successor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('No complete Dispatch');
    await expect(
      launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('custody already exists');
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      2,
    );
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
  });

  it.each([
    'reservation',
    'receipt',
  ])('recovers a retry crash after %s with the same reserved key', async (crashPoint) => {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.show = fixtureReleasedShow();
    const requests = new Map<string, OrcaCommandResult>();
    let launches = 0;
    fixtureRunner.mockImplementation(async (...args) => {
      const argv = args[1];
      if (argv[1] === 'request-show') {
        const requestId = argv[argv.indexOf('--request') + 1];
        if (!requestId) throw new Error('Missing fixture request id');
        return fixtureReply({
          requestId,
          state: requests.has(requestId) ? 'completed' : 'absent',
        });
      }
      if (argv[1] === 'worker-start') {
        expect(argv).toContain('--retry-request');
        const key = argv[argv.indexOf('--retry-request') + 1];
        if (!key) throw new Error('Missing reserved fixture key');
        expect(argv).toEqual(
          expect.arrayContaining([
            '--task',
            'task_fixture',
            '--run',
            'run_fixture',
            '--retry-of',
            'ctx_fixture',
          ]),
        );
        const cached = requests.get(key);
        if (cached) return cached;
        launches += 1;
        const result = fixtureStart('ready', 1, 'ctx_retry');
        requests.set(key, result);
        return result;
      }
      return runOrcaFixture(...args);
    });
    const workers = await import('../worker-records.js');
    const persist = workers.recordWorker;
    const update = workers.updateWorkerExecution;
    const crash =
      crashPoint === 'reservation'
        ? vi.spyOn(workers, 'recordWorker').mockImplementationOnce(async (...args) => {
            await persist(...args);
            throw new Error('Injected retry crash');
          })
        : vi.spyOn(workers, 'updateWorkerExecution').mockImplementation(async (...args) => {
            if (args[0].execution?.retryOf) throw new Error('Injected retry crash');
            return update(...args);
          });
    await expect(
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('Injected retry crash');
    crash.mockRestore();
    const successor = (await listWorkerRecords(env.tempDir)).find(
      (record) => record.stoppedAt === null,
    );
    if (!successor?.execution?.startRequestKey) throw new Error('Missing reserved retry fixture');
    expect(successor.execution).toMatchObject({ state: 'launching', startRequestId: null });
    expect(launches).toBe(crashPoint === 'reservation' ? 0 : 1);
    const key = successor.execution.startRequestKey;
    await expect(
      updateWorkerExecution(
        successor,
        { ...successor.execution, startRequestKey: '00000000-0000-4000-8000-000000000000' },
        env.tempDir,
      ),
    ).rejects.toThrow('identity');
    if (crashPoint === 'reservation') {
      setClaimClock(() => Date.now() + 24 * 60 * 60 * 1000);
      await expect(
        recoverOrcaWorkerStart(
          successor.recordId,
          env.tempDir,
          new OrcaExecutionBackend(fixtureRunner),
        ),
      ).rejects.toThrow('unproven');
      expect(launches).toBe(0);
      setClaimClock(null);
    }
    const recovered = await recoverOrcaWorkerStart(
      successor.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(recovered.execution).toMatchObject({
      state: 'ready',
      dispatchId: 'ctx_retry',
      startRequestKey: key,
      startRequestId: key,
    });
    await expect(
      recoverOrcaWorkerStart(
        successor.recordId,
        env.tempDir,
        new OrcaExecutionBackend(fixtureRunner),
      ),
    ).rejects.toThrow('No recoverable');
    expect(launches).toBe(1);
    expect(
      (await listWorkerRecords(env.tempDir)).find(
        (record) => record.recordId === predecessor.recordId,
      )?.stoppedAt,
    ).not.toBeNull();
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('recovers a pending successor after restart so its exact Dispatch can be shown and stopped', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    const workers = await import('../worker-records.js');
    const update = workers.updateWorkerExecution;
    const crash = vi.spyOn(workers, 'updateWorkerExecution').mockImplementation(async (...args) => {
      if (args[0].execution?.retryOf) throw new Error('Injected crash before receipt');
      return update(...args);
    });
    await expect(
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('Injected crash before receipt');
    crash.mockRestore();
    const successor = (await listWorkerRecords(env.tempDir)).find(
      (record) => record.stoppedAt === null,
    );
    if (!successor?.execution?.startRequestKey) throw new Error('Missing reserved retry fixture');
    expect(successor.execution).toMatchObject({
      state: 'launching',
      dispatchId: null,
      startRequestId: null,
    });
    const key = successor.execution.startRequestKey;
    orcaFixture.request = fixtureReply({ state: 'pending', requestId: key });
    orcaFixture.start = fixturePendingStart('ctx_retry', key);
    const recovered = await recoverOrcaWorkerStart(
      successor.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(recovered).toMatchObject({
      recordId: successor.recordId,
      sessionId: launch.workerSessionId,
      execution: {
        state: 'outcome_unknown',
        dispatchId: 'ctx_retry',
        retryOf: 'ctx_fixture',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        failureCount: 1,
        resourceState: 'unknown',
        startRequestKey: key,
        startRequestId: key,
      },
    });
    orcaFixture.show = fixtureShow('ctx_retry', 1);
    expect(
      await observeOrcaWorker(
        successor.recordId,
        env.tempDir,
        new OrcaExecutionBackend(fixtureRunner),
      ),
    ).toMatchObject({ execution: { dispatchId: 'ctx_retry', resourceState: 'owned' } });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_retry',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    expect(
      await stopOrcaWorker(
        successor.recordId,
        env.tempDir,
        new OrcaExecutionBackend(fixtureRunner),
      ),
    ).toMatchObject({ execution: { state: 'stopped', resourceState: 'stopped' } });
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(2);
    const starts = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
    expect(starts).toHaveLength(3);
    expect(starts[2]?.[1]).toEqual(starts[1]?.[1]);
    expect(starts[2]?.[1]).toEqual(expect.arrayContaining(['--retry-request', key]));
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('retries a previously unobserved turn only after exact released-failure proof', async () => {
    orcaFixture.start = fixtureStart('outcome_unknown', 1);
    const unobserved = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(unobserved.execution?.state).toBe('turn_unobserved');
    orcaFixture.show = fixtureReleasedShow('ctx_fixture', 1);
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    const successor = await retryOrcaWorker(
      unobserved.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(successor.execution).toMatchObject({
      state: 'ready',
      retryOf: 'ctx_fixture',
      dispatchId: 'ctx_retry',
      failureCount: 1,
    });
    expect((await env.accessor.loadSingleTask('T001'))?.status).not.toBe('done');
  });

  it('carries the breaker count through successive attempts and refuses a fourth start', async () => {
    orcaFixture.start = fixtureStart('failed', 1);
    const first = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.start = fixtureStart('failed', 2, 'ctx_retry_two');
    orcaFixture.show = fixtureReleasedShow('ctx_fixture', 1);
    const second = await retryOrcaWorker(
      first.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.start = fixtureStart('failed', 3, 'ctx_retry_three');
    orcaFixture.show = fixtureReleasedShow('ctx_retry_two', 2);
    const third = await retryOrcaWorker(
      second.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(third.execution).toMatchObject({ state: 'circuit_broken', failureCount: 3 });
    orcaFixture.show = fixtureReleasedShow('ctx_retry_three', 3);
    await expect(
      retryOrcaWorker(third.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('no confirmed');
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      3,
    );
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(3);
  });

  it('retains a failed start with residual resources instead of replacing its custody', async () => {
    orcaFixture.start = fixtureReply({
      state: 'failed',
      failureCount: 1,
      dispatchId: 'ctx_fixture',
      runId: 'run_fixture',
      taskId: 'task_fixture',
      effects: [{ kind: 'worktree', id: 'workspace-fixture' }],
      residualResources: [{ kind: 'terminal', id: 'term_retained' }],
      launch: { effective: { agent: 'codex' } },
    });
    const predecessor = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    await expect(
      retryOrcaWorker(predecessor.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('no confirmed');
    expect((await listWorkerRecords(env.tempDir))[0]?.stoppedAt).toBeNull();
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
  });

  it('replays an issued stop after restart once, without releasing claims or disposing the checkout', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: {
          code: 'runtime_timeout',
          message: 'stop receipt lost',
          data: { orchestrationRequestId: 'request-fixture' },
        },
      }),
      stderr: '',
      exitCode: 1,
    };
    const pending = await stopOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(pending.execution).toMatchObject({
      state: 'stop_unknown',
      stopRequestId: 'request-fixture',
    });
    orcaFixture.request = fixtureReply({
      state: 'completed',
      requestId: pending.execution?.stopRequestKey,
    });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    const recovered = await Promise.allSettled([
      recoverOrcaWorkerStop(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
      recoverOrcaWorkerStop(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ]);
    expect(recovered.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await listWorkerRecords(env.tempDir))[0]).toMatchObject({
      stoppedAt: null,
      execution: { state: 'stopped', stopRequestId: 'request-fixture' },
    });
    const stops = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop');
    expect(stops).toHaveLength(2);
    expect(stops[1]?.[1]).toContain('--retry-request');
    expect((await env.accessor.loadSingleTask('T001'))?.claim?.agentId).toBe(launch.agentId);
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('replays a stop whose reply was lost without an id by its reserved key', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    const pending = await stopOrcaWorker(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    // The default fixture reply carries no issued id; the reserved key survives.
    expect(pending.execution).toMatchObject({ state: 'stop_unknown', stopRequestId: null });
    const key = pending.execution?.stopRequestKey;
    expect(key).toEqual(expect.any(String));
    const sent = fixtureRunner.mock.calls.find(([, args]) => args[1] === 'worker-stop')?.[1];
    expect(sent).toEqual(expect.arrayContaining(['--retry-request', key]));
    orcaFixture.request = fixtureReply({ state: 'absent', requestId: key });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    const recovered = await recoverOrcaWorkerStop(
      record.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(recovered.execution).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
      stopRequestKey: key,
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      2,
    );
  });

  it('fences a legacy stop_pending with no key or id, and show settles it to stop_unknown', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    const legacy = await updateWorkerExecution(
      record,
      { ...record.execution, state: 'stop_pending' },
      env.tempDir,
    );
    await expect(
      recoverOrcaWorkerStop(legacy.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('No recoverable');
    orcaFixture.show = fixtureShow();
    const observed = await observeOrcaWorker(
      legacy.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(observed.execution).toMatchObject({ state: 'stop_unknown', resourceState: 'owned' });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      0,
    );
  });

  it('settles a durable stop_pending from release proof plus an affirmative stop receipt so retry proceeds', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    const stopReceipt = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    }).stdout;
    // A crash between the durable stop reservation and its reply leaves stop_pending,
    // with the receipt that proved every helper stopped.
    const pending = await updateWorkerExecution(
      record,
      {
        ...record.execution,
        state: 'stop_pending',
        stopRequestKey: randomUUID(),
        lastReceipt: stopReceipt,
      },
      env.tempDir,
    );
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    const successor = await retryOrcaWorker(
      pending.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(successor.execution).toMatchObject({
      state: 'ready',
      retryOf: 'ctx_fixture',
      dispatchId: 'ctx_retry',
    });
    const records = await listWorkerRecords(env.tempDir);
    expect(records.find((candidate) => candidate.recordId === pending.recordId)).toMatchObject({
      execution: { state: 'stopped', resourceState: 'stopped' },
    });
    expect(
      records.find((candidate) => candidate.recordId === pending.recordId)?.stoppedAt,
    ).not.toBeNull();
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      0,
    );
  });

  it('refuses retry when the parent released but the stop left no helper evidence', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    // The receipt was lost, so only the start receipt survives; a released parent
    // alone can never prove its helpers stopped.
    const pending = await updateWorkerExecution(
      record,
      { ...record.execution, state: 'stop_pending', stopRequestKey: randomUUID() },
      env.tempDir,
    );
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    await expect(
      retryOrcaWorker(pending.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toMatchObject({
      fix: expect.stringContaining(`cleo orchestrate worker recover-stop ${pending.recordId}`),
    });
    const [stored] = await listWorkerRecords(env.tempDir);
    expect(stored).toMatchObject({
      stoppedAt: null,
      execution: { state: 'stop_unknown', resourceState: 'unknown' },
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
  });

  it('refuses retry when the parent released but the stop receipt kept a helper open', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    const helper = 'ctx_helper';
    const stopReceipt = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [
        {
          dispatchId: helper,
          creatorDispatchId: 'ctx_fixture',
          outcome: 'kept_open',
          state: 'ready',
        },
      ],
    }).stdout;
    const pending = await updateWorkerExecution(
      record,
      {
        ...record.execution,
        state: 'stop_pending',
        stopRequestKey: randomUUID(),
        lastReceipt: stopReceipt,
      },
      env.tempDir,
    );
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.helperShows = { [helper]: fixtureShow(helper) };
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    await expect(
      retryOrcaWorker(pending.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toMatchObject({
      fix: expect.stringContaining(`cleo orchestrate worker show ${pending.recordId}`),
    });
    const [stored] = await listWorkerRecords(env.tempDir);
    expect(stored).toMatchObject({
      stoppedAt: null,
      execution: { state: 'stop_unknown', lastReceipt: stopReceipt },
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
    // The helper finishes after the original stop; its current Orca state settles the
    // stop, so retry is admitted without replaying the completed stop key.
    orcaFixture.helperShows = { [helper]: fixtureHelperExited(helper) };
    const successor = await retryOrcaWorker(
      pending.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(successor.execution).toMatchObject({ state: 'ready', dispatchId: 'ctx_retry' });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      0,
    );
  });

  it('replays a lost stop by its reserved key, then admits the retry', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    const key = randomUUID();
    const pending = await updateWorkerExecution(
      record,
      { ...record.execution, state: 'stop_pending', stopRequestKey: key },
      env.tempDir,
    );
    orcaFixture.request = fixtureReply({ state: 'absent', requestId: key });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    const recovered = await recoverOrcaWorkerStop(
      pending.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(recovered.execution).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
      stopRequestKey: key,
    });
    const stops = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]?.[1]).toEqual(expect.arrayContaining(['--retry-request', key]));
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.start = fixtureStart('ready', 1, 'ctx_retry');
    const successor = await retryOrcaWorker(
      pending.recordId,
      env.tempDir,
      new OrcaExecutionBackend(fixtureRunner),
    );
    expect(successor.execution).toMatchObject({ state: 'ready', dispatchId: 'ctx_retry' });
  });

  it('refuses retry for an unresolved stop with the exact recovery commands', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    if (!record.execution) throw new Error('Missing execution fixture');
    const pending = await updateWorkerExecution(
      record,
      { ...record.execution, state: 'stop_pending', stopRequestKey: randomUUID() },
      env.tempDir,
    );
    orcaFixture.show = fixtureShow();
    await expect(
      retryOrcaWorker(pending.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toMatchObject({
      fix: expect.stringContaining(`cleo orchestrate worker recover-stop ${pending.recordId}`),
    });
    // show settled the reservation to stop_unknown instead of leaving it pending.
    expect((await listWorkerRecords(env.tempDir))[0]?.execution).toMatchObject({
      state: 'stop_unknown',
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop')).toHaveLength(
      0,
    );
  });

  it('never closes Orca records from PID sweeps, native exit hooks, failed launch hints or exit codes', async () => {
    const spy = vi.spyOn(hooks, 'dispatch');
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    await abandonWorkerRecord(record, env.tempDir);
    expect(
      await settleWorkerAtSpawn(
        record,
        { instanceId: launch.instanceId, running: false, stopStatus: 'complete' },
        env.tempDir,
      ),
    ).toBe(true);
    expect(
      await markWorkerExited({ instanceId: launch.instanceId }, 'complete', env.tempDir),
    ).toMatchObject({ emitted: false });
    expect(await reconcileWorkerExits(env.tempDir, () => false)).toEqual([]);
    expect(spy.mock.calls.filter(([event]) => event === 'SubagentStop')).toHaveLength(0);
    expect((await listWorkerRecords(env.tempDir))[0]?.stoppedAt).toBeNull();
    expect((await env.accessor.loadSingleTask('T001'))?.status).not.toBe('done');
    expect(readFileSync(join(launch.worktreePath, 'dirty.txt'), 'utf8')).toBe(
      'uncommitted owner work',
    );
  });

  it('retains breaker history and rejects stale concurrent updates', async () => {
    const record = await launchOrcaWorker(
      launch,
      fixtureContext,
      new OrcaExecutionBackend(fixtureRunner),
    );
    const execution = record.execution;
    if (!execution) throw new Error('Missing execution fixture');
    const broken = await updateWorkerExecution(
      record,
      { ...execution, state: 'circuit_broken', failureCount: 3 },
      env.tempDir,
    );
    await expect(updateWorkerExecution(record, execution, env.tempDir)).rejects.toThrow('changed');
    await expect(
      updateWorkerExecution(
        broken,
        { ...execution, state: 'launching', failureCount: 0 },
        env.tempDir,
      ),
    ).rejects.toThrow('breaker history');
    await expect(
      recoverOrcaWorkerStart(record.recordId, env.tempDir, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('No recoverable');
    expect((await listWorkerRecords(env.tempDir))[0]?.execution?.failureCount).toBe(3);
  });

  it('refuses a mismatched canonical lock or session before invoking Orca', async () => {
    await expect(
      launchOrcaWorker(
        { ...launch, lockToken: 'wrong-token' },
        fixtureContext,
        new OrcaExecutionBackend(fixtureRunner),
      ),
    ).rejects.toThrow('unproven');
    expect(fixtureRunner).not.toHaveBeenCalled();
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(0);
  });

  it('refuses an expired allocated claim before invoking Orca', async () => {
    setClaimClock(() => Date.now() + 24 * 60 * 60 * 1000);
    await expect(
      launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('unproven');
    expect(fixtureRunner).not.toHaveBeenCalled();
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(0);
  });

  it('rechecks the claim after host preflight before reserving a launch', async () => {
    fixtureRunner.mockImplementation(async (...args) => {
      const result = await runOrcaFixture(...args);
      if (args[1][0] === 'worktree') setClaimClock(() => Date.now() + 24 * 60 * 60 * 1000);
      return result;
    });
    await expect(
      launchOrcaWorker(launch, fixtureContext, new OrcaExecutionBackend(fixtureRunner)),
    ).rejects.toThrow('unproven');
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
    expect(await listWorkerRecords(env.tempDir)).toHaveLength(0);
  });
});
