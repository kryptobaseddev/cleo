import { orcaReplySchema } from '@cleocode/contracts/orca-execution.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrcaExecutionBackend } from '../orca-execution.js';
import {
  fixtureAttempt,
  fixtureContext,
  fixtureLaunch,
  fixturePendingStart,
  fixtureReleasedShow,
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
    orcaFixture.currentRun = fixtureReply({ run: { id: 'run_fixture' } });
    orcaFixture.accounts = fixtureReply({
      codex: {
        accounts: [{ email: 'private@example.invalid', home: '/private/account' }],
        activeAccountId: 'managed-private-id',
      },
      opencode: { accounts: [], activeAccountId: null },
      claude: { accounts: [], activeAccountId: 'system' },
    });
    orcaFixture.caller = fixtureReply({
      terminal: {
        handle: fixtureContext.coordinatorHandle,
        executionHostId: 'local',
        connected: true,
        writable: true,
      },
    });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('ignores TERM_PROGRAM alone and proves the exact local caller before exposing account availability', async () => {
    for (const key of [
      'ORCA_TERMINAL_HANDLE',
      'ORCA_WORKTREE_ID',
      'ORCA_WORKSPACE_ID',
      'ORCA_RUNTIME_SOURCE_ID',
      'ORCA_APP_VERSION',
    ])
      vi.stubEnv(key, undefined);
    vi.stubEnv('TERM_PROGRAM', 'Orca');
    const backend = new OrcaExecutionBackend(fixtureRunner, '/fixture/orca');
    expect(backend.hasContextHints()).toBe(false);
    expect(await backend.discover(fixtureLaunch.projectRoot)).toBeNull();
    expect(fixtureRunner).not.toHaveBeenCalled();
    vi.stubEnv('ORCA_TERMINAL_HANDLE', fixtureContext.coordinatorHandle);
    expect(backend.hasContextHints()).toBe(true);
    const discovery = await backend.discover(fixtureLaunch.projectRoot);
    expect(discovery).toEqual({
      context: fixtureContext,
      accounts: [
        { provider: 'codex', accountCount: 1, activeAccountPresent: true },
        { provider: 'opencode', accountCount: 0, activeAccountPresent: false },
        { provider: 'claude', accountCount: 0, activeAccountPresent: true },
      ],
    });
    expect(JSON.stringify(discovery)).not.toMatch(/private|@|managed-/);
    expect(fixtureRunner.mock.calls.map(([, args]) => args)).toContainEqual([
      'terminal',
      'show',
      '--terminal',
      fixtureContext.coordinatorHandle,
      '--environment',
      'local',
      '--json',
    ]);
    expect(fixtureRunner.mock.calls.map(([, args]) => args)).toContainEqual([
      'account',
      'list',
      '--json',
    ]);
  });

  it.each([
    'run_fixture',
    null,
  ])('proves the coordinator Run binding %s without mutation', async (runId) => {
    orcaFixture.currentRun = fixtureReply({ run: runId === null ? null : { id: runId } });
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(await backend.currentRun(fixtureLaunch.projectRoot, fixtureContext)).toBe(runId);
    expect(fixtureRunner.mock.calls.map(([, args]) => args)).toContainEqual([
      'orchestration',
      'run-current',
      '--from',
      fixtureContext.coordinatorHandle,
      '--environment',
      'local',
      '--json',
      '--full',
    ]);
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
  });

  it.each(['missing', 'wrong-runtime'])('refuses an unproven %s Run binding', async (condition) => {
    orcaFixture.currentRun =
      condition === 'missing'
        ? fixtureReply({})
        : {
            stdout: JSON.stringify({
              ok: true,
              result: { run: null },
              _meta: { runtimeId: 'other' },
            }),
            stderr: '',
            exitCode: 0,
          };
    await expect(
      new OrcaExecutionBackend(fixtureRunner).currentRun(fixtureLaunch.projectRoot, fixtureContext),
    ).rejects.toMatchObject({
      code: 'E_ORCA_CONTEXT',
      fix: expect.any(String),
    });
  });

  it.each([
    'missing-handle',
    'different-caller',
    'remote-caller',
    'unavailable',
    'bad-accounts',
  ] as const)('refuses %s without launching, exposing private account data or selecting another runtime', async (condition) => {
    vi.stubEnv('ORCA_TERMINAL_HANDLE', fixtureContext.coordinatorHandle);
    vi.stubEnv('ORCA_WORKTREE_ID', 'workspace-fixture');
    if (condition === 'missing-handle') vi.stubEnv('ORCA_TERMINAL_HANDLE', undefined);
    if (condition === 'different-caller' || condition === 'remote-caller')
      orcaFixture.caller = fixtureReply({
        terminal: {
          handle:
            condition === 'different-caller' ? 'term_other' : fixtureContext.coordinatorHandle,
          executionHostId: condition === 'remote-caller' ? 'remote' : 'local',
          connected: true,
          writable: true,
        },
      });
    if (condition === 'unavailable')
      fixtureRunner.mockResolvedValue({ stdout: '', stderr: 'unreachable', exitCode: null });
    if (condition === 'bad-accounts')
      orcaFixture.accounts = {
        stdout: 'private@example.invalid /private/home',
        stderr: '',
        exitCode: 1,
      };
    const failure = await new OrcaExecutionBackend(fixtureRunner)
      .discover(fixtureLaunch.projectRoot)
      .catch((error: Error) => error);
    expect(failure).toMatchObject({
      code: expect.stringMatching(/^E_ORCA_/),
      fix: expect.any(String),
    });
    expect(String(failure)).not.toMatch(/private@example|\/private\/home/);
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
  });

  it('recognizes only a runtime-bound resource-free agent_unconfigured pre-dispatch refusal', async () => {
    const refused = {
      ok: false,
      error: { code: 'agent_unconfigured', message: 'Agent is disabled' },
      _meta: { runtimeId: fixtureContext.runtimeId },
    };
    orcaFixture.start = { stdout: JSON.stringify(refused), stderr: '', exitCode: 1 };
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(await backend.start(fixtureAttempt())).toMatchObject({
      state: 'failed',
      resourceState: 'stopped',
      startRefusal: 'agent_unconfigured',
      dispatchId: null,
    });
    orcaFixture.start = {
      ...orcaFixture.start,
      stdout: JSON.stringify({ ...refused, result: { dispatchId: 'ctx_unknown' } }),
    };
    expect(await backend.start(fixtureAttempt())).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'unknown',
    });
    orcaFixture.start = {
      ...orcaFixture.start,
      stdout: JSON.stringify({ ...refused, _meta: { runtimeId: 'other-runtime' } }),
    };
    expect(await backend.start(fixtureAttempt())).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'unknown',
    });
  });

  it('refuses ambiguous workspace resolution with an exact-selector fix before launch', async () => {
    fixtureRunner.mockImplementation(async (...args) =>
      args[1][0] === 'worktree'
        ? {
            stdout: JSON.stringify({
              ok: false,
              error: { code: 'ambiguous_selector', message: 'Several workspaces match' },
              _meta: { runtimeId: fixtureContext.runtimeId },
            }),
            stderr: '',
            exitCode: 1,
          }
        : runOrcaFixture(...args),
    );
    await expect(
      new OrcaExecutionBackend(fixtureRunner).preflight(fixtureLaunch, fixtureContext),
    ).rejects.toMatchObject({
      code: 'E_ORCA_WORKSPACE',
      message: 'Several workspaces match',
      fix: expect.stringContaining('<exact-selector>'),
    });
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
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

  it('fences a reserved key without an exact retry binding even when its request is absent', async () => {
    const key = '00000000-0000-4000-8000-000000000000';
    orcaFixture.request = fixtureReply({ state: 'absent', requestId: key });
    const backend = new OrcaExecutionBackend(fixtureRunner);
    await expect(backend.start(fixtureAttempt({ startRequestKey: key }))).rejects.toThrow(
      'exact retry binding',
    );
    await expect(
      backend.replayStart(fixtureAttempt({ state: 'outcome_unknown', startRequestKey: key })),
    ).rejects.toThrow('exact retry binding');
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-start')).toBe(false);
  });

  it('replays original spec argv even when a partial receipt supplied Run, Task and Dispatch ids', async () => {
    const partial = orcaReplySchema.parse(JSON.parse(fixtureStart('outcome_unknown').stdout));
    orcaFixture.start = {
      ...orcaFixture.start,
      stdout: JSON.stringify({
        ...partial,
        ok: false,
        error: {
          code: 'runtime_timeout',
          message: 'receipt lost after dispatch',
          data: { orchestrationRequestId: 'request-fixture' },
        },
      }),
      exitCode: 1,
    };
    const unknown = await new OrcaExecutionBackend(fixtureRunner).start(fixtureAttempt());
    expect(unknown).toMatchObject({
      state: 'outcome_unknown',
      dispatchId: 'ctx_fixture',
      startRequestId: 'request-fixture',
      startBinding: { runId: null, orcaTaskId: null, retryOf: null },
    });
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
    await expect(
      new OrcaExecutionBackend(fixtureRunner).start({ ...unknown, state: 'launching' }),
    ).rejects.toThrow('cannot start');
  });

  it('starts a retry on the same Run and Task with explicit placement and its predecessor', async () => {
    const result = await new OrcaExecutionBackend(fixtureRunner).start(
      fixtureAttempt({
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        retryOf: 'ctx_predecessor',
        failureCount: 2,
        startBinding: {
          runId: 'run_fixture',
          orcaTaskId: 'task_fixture',
          retryOf: 'ctx_predecessor',
        },
      }),
    );
    expect(result).toMatchObject({ state: 'ready', failureCount: 2, retryOf: 'ctx_predecessor' });
    expect(fixtureRunner.mock.calls.at(-1)).toEqual([
      expect.any(String),
      [
        'orchestration',
        'worker-start',
        '--from',
        'term_fixture',
        '--worktree',
        'identity:workspace-fixture',
        '--agent',
        'codex',
        '--task',
        'task_fixture',
        '--run',
        'run_fixture',
        '--retry-of',
        'ctx_predecessor',
        '--environment',
        'local',
        '--json',
        '--full',
      ],
      fixtureLaunch.projectRoot,
      undefined,
    ]);
  });

  it('refuses legacy launch replay when the original argv binding was not persisted', async () => {
    await expect(
      new OrcaExecutionBackend(fixtureRunner).replayStart(
        fixtureAttempt({
          state: 'outcome_unknown',
          startRequestId: 'request-fixture',
          startBinding: undefined,
        }),
      ),
    ).rejects.toThrow('No replayable');
    expect(fixtureRunner).not.toHaveBeenCalled();
  });

  it('does not adopt a different Dispatch from a replayed launch receipt', async () => {
    orcaFixture.start = fixtureStart('ready', 0, 'ctx_other');
    const result = await new OrcaExecutionBackend(fixtureRunner).replayStart(
      fixtureAttempt({
        state: 'outcome_unknown',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId: 'ctx_fixture',
        startRequestId: 'request-fixture',
      }),
    );
    expect(result).toMatchObject({ state: 'outcome_unknown', dispatchId: 'ctx_fixture' });
  });

  it.each([
    'issued',
    'reserved',
  ])('adopts a pending successor for the %s request key without admitting ready', async (keyState) => {
    const key = '00000000-0000-4000-8000-000000000001';
    orcaFixture.request = fixtureReply({ state: 'pending', requestId: key });
    orcaFixture.start = fixturePendingStart('ctx_retry', key);
    const recovered = await new OrcaExecutionBackend(fixtureRunner).replayStart(
      fixtureAttempt({
        state: 'outcome_unknown',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        retryOf: 'ctx_fixture',
        startRequestId: keyState === 'issued' ? key : null,
        startRequestKey: keyState === 'reserved' ? key : undefined,
        startBinding: {
          runId: 'run_fixture',
          orcaTaskId: 'task_fixture',
          retryOf: 'ctx_fixture',
        },
      }),
    );
    expect(recovered).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'unknown',
      dispatchId: 'ctx_retry',
      runId: 'run_fixture',
      orcaTaskId: 'task_fixture',
      startRequestId: key,
      lastReceipt: orcaFixture.start.stdout,
    });
    orcaFixture.show = fixtureShow('ctx_retry');
    expect(await new OrcaExecutionBackend(fixtureRunner).show(recovered)).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'owned',
      dispatchId: 'ctx_retry',
    });
    expect(fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-start')).toHaveLength(
      1,
    );
  });

  it.each([
    'request',
    'recovery_request',
    'missing_request',
    'missing_recovery_request',
    'runtime',
    'predecessor',
    'dispatch',
    'refusal',
  ])('does not adopt a pending refusal with a mismatched %s binding', async (mismatch) => {
    const key = '00000000-0000-4000-8000-000000000001';
    const reply = orcaReplySchema.parse(JSON.parse(fixturePendingStart('ctx_retry', key).stdout));
    if (!reply.error?.data || !reply._meta) throw new Error('Missing pending refusal fixture');
    if (mismatch === 'request') reply.error.data.requestId = 'other-request';
    if (mismatch === 'recovery_request') reply.error.data.orchestrationRequestId = 'other-request';
    if (mismatch === 'missing_request') delete reply.error.data.requestId;
    if (mismatch === 'missing_recovery_request') delete reply.error.data.orchestrationRequestId;
    if (mismatch === 'runtime') reply._meta.runtimeId = 'other-runtime';
    if (mismatch === 'predecessor') reply.error.data.dispatchId = 'ctx_predecessor';
    if (mismatch === 'refusal') reply.error.code = 'request_mismatch';
    orcaFixture.start = { stdout: JSON.stringify(reply), stderr: '', exitCode: 1 };
    orcaFixture.request = fixtureReply({ state: 'pending', requestId: key });
    const dispatchId = mismatch === 'dispatch' ? 'ctx_original' : null;
    const result = await new OrcaExecutionBackend(fixtureRunner).replayStart(
      fixtureAttempt({
        state: 'outcome_unknown',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId,
        retryOf: 'ctx_predecessor',
        startRequestId: null,
        startRequestKey: key,
        startBinding: {
          runId: 'run_fixture',
          orcaTaskId: 'task_fixture',
          retryOf: 'ctx_predecessor',
        },
      }),
    );
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'unknown',
      dispatchId,
      startRequestId: key,
    });
  });

  it.each([
    'owner',
    'observation',
    'terminal',
    'release',
    'state',
    'none',
  ])('requires exact exited and released resource proof before retry eligibility (%s)', async (missing) => {
    const reply = orcaReplySchema.parse(JSON.parse(fixtureReleasedShow().stdout));
    const resource = reply.result?.projection?.resource;
    const observation = reply.result?.observation;
    if (!resource || !observation) throw new Error('Missing resource fixture');
    if (missing === 'owner') resource.ownerDispatchId = 'ctx_other';
    if (missing === 'observation') observation.exactWorker = false;
    if (missing === 'terminal') resource.terminalState = 'release_unknown';
    if (missing === 'release') resource.releaseState = 'release_unknown';
    if (missing === 'state') resource.state = 'stopped';
    orcaFixture.show = { stdout: JSON.stringify(reply), stderr: '', exitCode: 0 };
    const result = await new OrcaExecutionBackend(fixtureRunner).show(
      fixtureAttempt({
        state: 'failed',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId: 'ctx_fixture',
      }),
    );
    expect(result.resourceState).toBe(missing === 'none' ? 'stopped' : 'unknown');
  });

  it.each([
    'absent',
    'wrong_request',
    'wrong_runtime',
  ])('fences stop replay on %s without sending another cancellation', async (reason) => {
    orcaFixture.request =
      reason === 'wrong_runtime'
        ? {
            stdout: JSON.stringify({
              ok: true,
              _meta: { runtimeId: 'other-runtime' },
              result: { state: 'completed', requestId: 'request-fixture' },
            }),
            stderr: '',
            exitCode: 0,
          }
        : fixtureReply({
            state: reason === 'absent' ? 'absent' : 'completed',
            requestId: reason === 'wrong_request' ? 'request-other' : 'request-fixture',
          });
    await expect(
      new OrcaExecutionBackend(fixtureRunner).replayStop(
        fixtureAttempt({
          state: 'stop_unknown',
          runId: 'run_fixture',
          orcaTaskId: 'task_fixture',
          dispatchId: 'ctx_fixture',
          stopRequestId: 'request-fixture',
        }),
      ),
    ).rejects.toThrow();
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('replays only the original cancellation request after a lost stop receipt', async () => {
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: {
          code: 'runtime_timeout',
          message: 'lost stop reply',
          data: { orchestrationRequestId: 'request-fixture' },
        },
      }),
      stderr: '',
      exitCode: 1,
    };
    const unknown = await new OrcaExecutionBackend(fixtureRunner).stop(
      fixtureAttempt({
        state: 'stop_pending',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        dispatchId: 'ctx_fixture',
      }),
    );
    expect(unknown).toMatchObject({ state: 'stop_unknown', stopRequestId: 'request-fixture' });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    const recovered = await new OrcaExecutionBackend(fixtureRunner).replayStop(unknown);
    expect(recovered).toMatchObject({ state: 'stopped', resourceState: 'stopped' });
    const stops = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop');
    expect(stops[1]?.[1]).toEqual([
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
