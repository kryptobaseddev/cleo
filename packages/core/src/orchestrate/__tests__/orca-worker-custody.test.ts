import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrcaExecutionBackend } from '@cleocode/adapters/orca-execution';
import type { OrcaLaunch } from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { acquireWorktreeTaskLock } from '@cleocode/worktree';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fixtureContext,
  fixtureLaunch,
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
