import { beforeEach, describe, expect, it } from 'vitest';
import { OrcaExecutionBackend } from '../orca-execution.js';
import {
  fixtureAttempt,
  fixtureContext,
  fixtureLaunch,
  fixtureReply,
  fixtureRunner,
  fixtureShow,
  fixtureStart,
  orcaFixture,
  runOrcaFixture,
} from './orca-execution-fixture.js';

describe('Orca execution process boundary', () => {
  beforeEach(() => {
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
    orcaFixture.launch = { ...fixtureLaunch };
    orcaFixture.start = fixtureStart();
    orcaFixture.show = fixtureShow();
    orcaFixture.stop = fixtureReply(
      {
        dispatchId: 'ctx_fixture',
        state: 'stop_unknown',
        processAction: 'closed_agent_terminal',
        helpers: [],
      },
      1,
    );
    orcaFixture.request = fixtureReply({ state: 'completed', requestId: 'request-fixture' });
  });

  it('preflights the command registry and exact runtime/workspace, then starts once with inert stdin', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner, '/fixture/orca');
    const workspace = await backend.preflight(fixtureLaunch, fixtureContext);
    expect(workspace).toEqual({
      workspaceId: 'workspace-fixture',
      workspaceSelector: 'identity:workspace-fixture',
    });
    const result = await backend.start(fixtureAttempt(workspace));
    expect(result).toMatchObject({
      state: 'ready',
      runId: 'run_fixture',
      orcaTaskId: 'task_fixture',
      dispatchId: 'ctx_fixture',
      resourceState: 'owned',
    });
    const starts = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
    expect(starts).toEqual([
      [
        '/fixture/orca',
        [
          'orchestration',
          'worker-start',
          '--from',
          'term_fixture',
          '--worktree',
          'identity:workspace-fixture',
          '--agent',
          'codex',
          '--spec-file',
          '-',
          '--task-title',
          'project-fixture:T001:worker-fixture',
          '--environment',
          'local',
          '--json',
          '--full',
        ],
        '/fixture/project',
        fixtureLaunch.prompt,
      ],
    ]);
    expect(result.lastReceipt).toBe(orcaFixture.start.stdout);
  });

  it.each([
    'lead',
    'account',
    'kimi',
    'effort',
  ] as const)('refuses unsupported %s before any process call', async (constraint) => {
    const launch = { ...fixtureLaunch };
    if (constraint === 'lead') launch.role = 'lead';
    if (constraint === 'account') launch.accountId = 'requested-account';
    if (constraint === 'kimi') launch.harness = 'kimi';
    if (constraint === 'effort') {
      launch.harness = 'opencode';
      launch.model = 'explicit-model';
      launch.effort = 'high';
    }
    const backend = new OrcaExecutionBackend(fixtureRunner);
    await expect(backend.preflight(launch, fixtureContext)).rejects.toThrow();
    expect(fixtureRunner).not.toHaveBeenCalled();
    await expect(backend.start(fixtureAttempt({ launch }))).rejects.toThrow();
    expect(fixtureRunner).not.toHaveBeenCalled();
  });

  it('uses opencode2 without changing the selected harness identity', async () => {
    orcaFixture.start = fixtureReply({
      state: 'ready',
      dispatchId: 'ctx_fixture',
      taskId: 'task_fixture',
      runId: 'run_fixture',
      effects: [{ kind: 'worktree', id: 'workspace-fixture' }],
      launch: { effective: { agent: 'opencode2' } },
    });
    const result = await new OrcaExecutionBackend(fixtureRunner).start(
      fixtureAttempt({ launch: { ...fixtureLaunch, harness: 'opencode' } }),
    );
    expect(result.launch.harness).toBe('opencode');
    expect(result.state).toBe('ready');
    expect(fixtureRunner.mock.calls.find(([, args]) => args[1] === 'worker-start')?.[1]).toContain(
      'opencode2',
    );
  });

  it('refuses a changed runtime and an incomplete command registry before launch', async () => {
    fixtureRunner.mockImplementation(async (...args) =>
      args[1][0] === 'status'
        ? {
            stdout: JSON.stringify({
              ok: true,
              _meta: { runtimeId: 'different-runtime' },
              result: {},
            }),
            stderr: '',
            exitCode: 0,
          }
        : runOrcaFixture(...args),
    );
    await expect(
      new OrcaExecutionBackend(fixtureRunner).preflight(fixtureLaunch, fixtureContext),
    ).rejects.toThrow('runtime identity');
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
    fixtureRunner.mockReset().mockResolvedValue({
      stdout: JSON.stringify({ schemaVersion: 1, commands: [] }),
      stderr: '',
      exitCode: 0,
    });
    await expect(
      new OrcaExecutionBackend(fixtureRunner).preflight(fixtureLaunch, fixtureContext),
    ).rejects.toThrow('does not declare');
    expect(fixtureRunner).toHaveBeenCalledTimes(1);
  });

  it('requires the runtime model-override capability before accepting an explicit route', async () => {
    await expect(
      new OrcaExecutionBackend(fixtureRunner).preflight(
        { ...fixtureLaunch, model: 'requested-model' },
        fixtureContext,
      ),
    ).rejects.toThrow('runtime is unavailable or changed');
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
  });

  it.each([
    null,
    0,
  ])('refuses an unavailable or malformed CLI registry (exit %s) actionably', async (exitCode) => {
    fixtureRunner.mockResolvedValue({ stdout: '', stderr: 'unavailable fixture CLI', exitCode });
    await expect(
      new OrcaExecutionBackend(fixtureRunner).preflight(fixtureLaunch, fixtureContext),
    ).rejects.toMatchObject({
      code: exitCode === null ? 'E_ORCA_CONTEXT' : 'E_ORCA_COMMAND_UNSUPPORTED',
      fix: expect.stringContaining('selected Orca'),
    });
    expect(fixtureRunner).toHaveBeenCalledTimes(1);
  });

  it('keeps unobserved-turn starts in flight despite a nonzero full-view exit', async () => {
    orcaFixture.start = fixtureStart('outcome_unknown');
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const result = await backend.start(fixtureAttempt());
    expect(result).toMatchObject({ state: 'turn_unobserved', dispatchId: 'ctx_fixture' });
    await expect(backend.replayStart(result)).rejects.toThrow('No replayable');
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
  });

  it('fences lost receipts across new backend instances', async () => {
    orcaFixture.start = { stdout: '', stderr: 'timeout', exitCode: null };
    const result = await new OrcaExecutionBackend(fixtureRunner).start(fixtureAttempt());
    expect(result).toMatchObject({ state: 'outcome_unknown', dispatchId: null, lastReceipt: '' });
    await expect(new OrcaExecutionBackend(fixtureRunner).start(result)).rejects.toThrow(
      'cannot start another',
    );
    await expect(new OrcaExecutionBackend(fixtureRunner).replayStart(result)).rejects.toThrow(
      'No replayable',
    );
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
  });

  it('recovers an issued request only with identical placement, prompt and retry-request', async () => {
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
    const unknown = await new OrcaExecutionBackend(fixtureRunner).start(fixtureAttempt());
    expect(unknown).toMatchObject({ state: 'outcome_unknown', startRequestId: 'request-fixture' });
    orcaFixture.start = fixtureStart();
    const recovered = await new OrcaExecutionBackend(fixtureRunner).replayStart(unknown);
    expect(recovered.state).toBe('ready');
    const starts = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start');
    expect(starts[1]?.[1]).toEqual([
      ...starts[0]![1].slice(0, -4),
      '--retry-request',
      'request-fixture',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    expect(starts[1]?.[3]).toBe(fixtureLaunch.prompt);
  });

  it('does not replay an absent request or route around a circuit breaker', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    orcaFixture.request = fixtureReply({ state: 'absent' });
    await expect(
      backend.replayStart(
        fixtureAttempt({ state: 'outcome_unknown', startRequestId: 'request-fixture' }),
      ),
    ).rejects.toThrow('absence');
    orcaFixture.start = fixtureStart('failed', 3);
    const broken = await backend.start(fixtureAttempt());
    expect(broken).toMatchObject({ state: 'circuit_broken', failureCount: 3 });
    await expect(backend.start(broken)).rejects.toThrow('cannot start');
    await expect(
      backend.replayStart({
        ...broken,
        state: 'outcome_unknown',
        startRequestId: 'request-fixture',
      }),
    ).rejects.toThrow('No replayable');
  });

  it('retains an unknown receipt when workspace or effective harness is unproven', async () => {
    orcaFixture.start = fixtureReply({
      state: 'ready',
      dispatchId: 'ctx_other',
      taskId: 'task_other',
      runId: 'run_other',
      effects: [{ kind: 'worktree', id: 'other-workspace' }],
    });
    const result = await new OrcaExecutionBackend(fixtureRunner).start(fixtureAttempt());
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      dispatchId: 'ctx_other',
      lastReceipt: orcaFixture.start.stdout,
    });
  });

  it('pins observations to Dispatch, Run, Task, runtime and workspace after restart', async () => {
    const attempt = fixtureAttempt({
      state: 'ready',
      dispatchId: 'ctx_fixture',
      orcaTaskId: 'task_fixture',
      runId: 'run_fixture',
    });
    orcaFixture.show = fixtureShow('ctx_other');
    await expect(new OrcaExecutionBackend(fixtureRunner).show(attempt)).rejects.toThrow(
      'does not match',
    );
    orcaFixture.show = fixtureShow('ctx_fixture', 3);
    expect(await new OrcaExecutionBackend(fixtureRunner).show(attempt)).toMatchObject({
      state: 'circuit_broken',
      failureCount: 3,
    });
  });

  it('preserves stop_unknown even when Orca issued a terminal close', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const stopped = await backend.stop(
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
      }),
    );
    expect(stopped).toMatchObject({ state: 'stop_unknown', resourceState: 'unknown' });
    orcaFixture.show = fixtureShow('ctx_fixture', 3);
    expect((await backend.show(stopped)).state).toBe('stop_unknown');
    await expect(backend.stop(stopped)).rejects.toThrow('reserved');
    const stop = fixtureRunner.mock.calls.find(([, args]) => args[1] === 'worker-stop')?.[1];
    expect(stop).toEqual([
      'orchestration',
      'worker-stop',
      '--dispatch',
      'ctx_fixture',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
  });

  it('reads a bounded source-pinned page without consuming coordinator mail', async () => {
    const raw = await new OrcaExecutionBackend(fixtureRunner).read(
      fixtureAttempt({
        state: 'ready',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
      }),
      'exact-cursor',
    );
    expect(raw).toBe(orcaFixture.read.stdout);
    const args = fixtureRunner.mock.calls.at(-1)?.[1];
    expect(args).toEqual([
      'orchestration',
      'worker-read',
      '--dispatch',
      'ctx_fixture',
      '--source',
      'auto',
      '--limit',
      '200',
      '--cursor',
      'exact-cursor',
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
  });

  it('treats kept-open or unconfirmed helpers as unresolved cancellation', async () => {
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [{ outcome: 'kept_open' }],
    });
    const attempt = fixtureAttempt({
      state: 'stop_pending',
      dispatchId: 'ctx_fixture',
      orcaTaskId: 'task_fixture',
      runId: 'run_fixture',
    });
    expect((await new OrcaExecutionBackend(fixtureRunner).stop(attempt)).state).toBe(
      'stop_unknown',
    );
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    expect((await new OrcaExecutionBackend(fixtureRunner).stop(attempt)).state).toBe('stopped');
  });
});
