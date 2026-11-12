import type {
  OrcaAttempt,
  OrcaLeadTerminal,
  OrcaReply,
} from '@cleocode/contracts/orca-execution.js';
import { ORCA_AGENT_HARNESSES, orcaReplySchema } from '@cleocode/contracts/orca-execution.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrcaExecutionBackend } from '../orca-execution.js';
import {
  fixtureAttempt,
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
} from './orca-execution-fixture.js';

describe('Orca execution process boundary', () => {
  beforeEach(() => {
    fixtureRunner.mockReset().mockImplementation(runOrcaFixture);
    orcaFixture.launch = { ...fixtureLaunch };
    orcaFixture.start = fixtureStart();
    orcaFixture.show = fixtureShow();
    orcaFixture.helperShows = {};
    orcaFixture.capabilities = [
      'orchestration.contract.v1',
      'orchestration.worker-stop-helpers.v1',
    ];
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

  it.each(
    Object.values(ORCA_AGENT_HARNESSES),
  )('refuses an explicit Orca %s lead before a failed account inventory can mask its guard', async (harness) => {
    orcaFixture.accounts = { stdout: '', stderr: 'inventory unavailable', exitCode: 1 };
    const launch = { ...fixtureLaunch, role: 'lead' as const, harness };
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(backend.leadToolStrip).toBe('unsupported');
    for (const invoke of [
      () => backend.preflight(launch, fixtureContext),
      () => backend.start(fixtureAttempt({ launch })),
    ]) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'E_LEAD_TOOLS_UNSTRIPPED',
        exitCode: 63,
        message: expect.stringMatching(
          /--tools.*--permission-mode.*strict MCP.*owner channel.*--session-id/,
        ),
        fix: expect.stringContaining('keep orchestrate.leadWorker.v1 enabled'),
      });
    }
    expect(fixtureRunner).not.toHaveBeenCalled();
  });

  it
    .skipIf(process.platform === 'win32')
    .each([
      'ready',
      'login-wrapper',
      'ps-from-path',
      'ps-fallback',
      'ps-newer-parent',
      'ps-invalid-start',
      'ps-failed',
      'disconnected',
      'background',
      'hidden-after-create',
      'cleanup-unverified',
      'not-navigated',
      'pid-mismatch',
      'missing-terminal-pid',
      'recorder-failed',
      'wrong-runtime',
      'lost-receipt',
    ] as const)(
    'gates the exact terminal argv before a model turn: %s (inert executable only)',
    async (condition) => {
      vi.stubEnv('ORCA_TERMINAL_HANDLE', fixtureContext.coordinatorHandle);
      const root = mkdtempSync(join(tmpdir(), 'orca-lead-fixture-'));
      const cwd = join(root, "project ' `literal` $(literal)");
      mkdirSync(cwd);
      const psCapture = join(root, 'ps-calls.json');
      if (condition.startsWith('ps-')) {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        for (const name of ['sleep', 'rm']) symlinkSync(`/bin/${name}`, join(bin, name));
        if (condition !== 'ps-fallback')
          writeFileSync(
            join(bin, 'ps'),
            `#!${process.execPath}
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(psCapture)}, JSON.stringify({TZ:process.env.TZ, LC_ALL:process.env.LC_ALL, LANG:process.env.LANG}));
const condition = ${JSON.stringify(condition)};
if (condition === 'ps-failed') process.exit(1);
if (condition === 'ps-from-path') process.stdout.write(execFileSync('/bin/ps', process.argv.slice(2), {encoding:'utf8'}));
else {
  const [pid, terminal] = process.argv.at(-1).split(',');
  const start = condition === 'ps-invalid-start' ? 'unreadable' : 'Thu Jan 01 00:00:00 2026';
  process.stdout.write(pid+' '+terminal+' '+start+'\\n'+terminal+' 1 Fri Jan 02 00:00:00 2026\\n');
}
`,
            { mode: 0o700 },
          );
        vi.stubEnv('PATH', condition === 'ps-fallback' ? bin : `${bin}:${process.env.PATH}`);
      }
      const capture = join(root, 'captured.json');
      const binary = join(root, 'claude');
      writeFileSync(
        binary,
        `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(capture)}, JSON.stringify({args:process.argv.slice(2),session:process.env.CLEO_SESSION_ID,role:process.env.CLEO_AGENT_ROLE,cwd:process.cwd()}));\n`,
        { mode: 0o700 },
      );
      const args = [
        '--restricted',
        '--setting-sources',
        '',
        "literal ' `backticks` $(touch injected)",
      ];
      let child: ChildProcess | undefined;
      let exit: Promise<void> | undefined;
      const started = vi.fn<(pid: number, terminal?: OrcaLeadTerminal) => Promise<void>>(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 250));
          expect(existsSync(capture)).toBe(false);
          if (condition === 'recorder-failed') throw new Error('Lifecycle recorder unavailable');
        },
      );
      fixtureRunner.mockImplementation(async (...params) => {
        const argv = params[1];
        if (argv[0] === 'worktree')
          return fixtureReply({
            worktree: { id: 'workspace-fixture', path: cwd, branch: 'main', hostId: 'local' },
          });
        if (argv[0] === 'terminal' && argv[1] === 'create') {
          const command = argv[argv.indexOf('--command') + 1];
          child = spawn(
            '/bin/sh',
            [
              '-c',
              condition === 'login-wrapper' || condition === 'ps-newer-parent'
                ? `${command} & wait`
                : (command ?? 'exit 99'),
            ],
            { stdio: 'ignore' },
          );
          exit = new Promise<void>((resolve) => child?.once('exit', () => resolve()));
          if (condition === 'lost-receipt') return { stdout: '', stderr: 'lost', exitCode: null };
          return fixtureReply({
            terminal: {
              handle: 'term_lead',
              processId:
                condition === 'missing-terminal-pid'
                  ? undefined
                  : condition === 'pid-mismatch'
                    ? (child.pid ?? 100) + 1
                    : child.pid,
              // Orca 1.4.256 live reply: processId is /usr/bin/login, parent of the exec'd shell.
              tabId: 'tab-lead',
              paneKey: 'tab-lead:leaf-lead',
              ptyId: 'workspace-fixture@@lead',
              worktreeId: 'workspace-fixture',
              title: 'CLEO no-hands lead',
              executionHostId: 'local',
              incarnationId: 'incarnation-lead',
              hostPlatform: process.platform,
              surface: condition === 'background' ? 'background' : 'visible',
            },
          });
        }
        if (argv[0] === 'terminal' && argv[1] === 'close') {
          child?.kill('SIGTERM');
          return fixtureReply({
            close: { handle: 'term_lead', ptyKilled: condition !== 'cleanup-unverified' },
          });
        }
        if (argv[0] === 'terminal' && argv[1] === 'switch') {
          return fixtureReply({
            focus: {
              handle: 'term_lead',
              tabId: 'tab-lead',
              worktreeId: 'workspace-fixture',
              navigated: condition !== 'not-navigated',
            },
          });
        }
        if (argv[0] === 'terminal' && argv.includes('term_lead')) {
          const reply = fixtureReply({
            terminal: {
              handle: 'term_lead',
              connected: true,
              writable: condition !== 'disconnected' && condition !== 'cleanup-unverified',
              executionHostId: 'local',
              worktreePath: cwd,
              tabId: 'tab-lead',
              surface: condition === 'hidden-after-create' ? 'background' : undefined,
            },
          });
          return condition === 'wrong-runtime'
            ? { ...reply, stdout: reply.stdout.replace(fixtureContext.runtimeId, 'other-runtime') }
            : reply;
        }
        return runOrcaFixture(...params);
      });
      try {
        const result = new OrcaExecutionBackend(fixtureRunner).startLead(
          {
            command: binary,
            args,
            cwd,
            tempDir: root,
            env: {
              CLEO_SESSION_ID: 'ses_own',
              CLEO_AGENT_ID: 'agent-own',
              CLEO_AGENT_ROLE: 'lead',
            },
          },
          started,
        );
        const ready = ['ready', 'login-wrapper', 'ps-from-path', 'ps-fallback'].includes(condition);
        if (!ready) {
          await expect(result).rejects.toThrow();
          if (condition === 'pid-mismatch')
            await expect(result).rejects.toMatchObject({
              details: {
                terminalHandle: 'term_lead',
                expectedTerminalPid: (child?.pid ?? 100) + 1,
                observedSupervisorPid: child?.pid,
                observedParentPid: process.pid,
              },
            });
          if (condition === 'cleanup-unverified')
            await expect(result).rejects.toMatchObject({
              code: 'E_LEAD_TOOLS_UNSTRIPPED',
              message: expect.stringContaining('cleanup is unverified'),
              fix: expect.stringContaining('term_lead'),
              details: expect.objectContaining({
                terminalHandle: 'term_lead',
                observedSupervisorPid: child?.pid,
              }),
            });
          expect(started).toHaveBeenCalledTimes(condition === 'recorder-failed' ? 1 : 0);
          expect(existsSync(capture)).toBe(false);
        } else {
          expect(await result).toMatchObject({
            terminalHandle: 'term_lead',
            pid: started.mock.calls[0]?.[0],
            runtimeId: fixtureContext.runtimeId,
          });
          expect(started).toHaveBeenCalledOnce();
          expect(started.mock.calls[0]?.[1]).toMatchObject({
            terminalHandle: 'term_lead',
            pid: started.mock.calls[0]?.[0],
          });
          if (condition === 'login-wrapper')
            expect(started.mock.calls[0]?.[0]).not.toBe(child?.pid);
          await exit;
          expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
            args,
            session: 'ses_own',
            role: 'lead',
            cwd,
          });
          expect(existsSync(join(cwd, 'injected'))).toBe(false);
        }
        if (condition.startsWith('ps-') && condition !== 'ps-fallback')
          expect(JSON.parse(readFileSync(psCapture, 'utf8'))).toEqual({
            TZ: 'UTC',
            LC_ALL: 'C',
            LANG: 'C',
          });
        expect(
          fixtureRunner.mock.calls.some(
            ([, argv]) => argv[0] === 'account' || argv[1] === 'worker-start',
          ),
        ).toBe(false);
        expect(fixtureRunner.mock.calls.filter(([, argv]) => argv[1] === 'create')).toHaveLength(1);
        expect(fixtureRunner.mock.calls.filter(([, argv]) => argv[1] === 'close')).toHaveLength(
          ready || condition === 'lost-receipt' ? 0 : 1,
        );
        if (condition === 'lost-receipt')
          await expect.poll(() => child?.exitCode, { timeout: 1500 }).toBeTypeOf('number');
      } finally {
        child?.kill('SIGTERM');
        await exit;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    'Windows',
    'missing-handle',
    'remote-workspace',
  ] as const)('refuses %s before creating a terminal or admitting a lead', async (reason) => {
    const originalPlatform = process.platform;
    vi.stubEnv(
      'ORCA_TERMINAL_HANDLE',
      reason === 'missing-handle' ? undefined : fixtureContext.coordinatorHandle,
    );
    vi.stubEnv('ORCA_WORKTREE_ID', 'partial-context');
    if (reason === 'Windows')
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    if (reason === 'remote-workspace')
      fixtureRunner.mockImplementation(async (...args) =>
        args[1][0] === 'worktree'
          ? fixtureReply({
              worktree: {
                id: 'remote',
                path: '/fixture/project',
                branch: 'main',
                hostId: 'ssh-host',
              },
            })
          : runOrcaFixture(...args),
      );
    const admitted = vi.fn<(pid: number) => void>();
    try {
      await expect(
        new OrcaExecutionBackend(fixtureRunner).startLead(
          {
            command: '/fixture/claude',
            args: [],
            cwd: '/fixture/project',
            tempDir: '/fixture/spawn',
            env: {
              CLEO_SESSION_ID: 'ses_own',
              CLEO_AGENT_ID: 'agent-own',
              CLEO_AGENT_ROLE: 'lead',
            },
          },
          admitted,
        ),
      ).rejects.toMatchObject({
        code: reason === 'missing-handle' ? 'E_ORCA_CONTEXT' : 'E_LEAD_TOOLS_UNSTRIPPED',
        exitCode: 63,
        fix: expect.stringContaining('keep orchestrate.leadWorker.v1 enabled'),
      });
      expect(admitted).not.toHaveBeenCalled();
      expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'create')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
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

  it('fences a reserved key without its original launch binding even when its request is absent', async () => {
    const key = '00000000-0000-4000-8000-000000000000';
    orcaFixture.request = fixtureReply({ state: 'absent', requestId: key });
    const backend = new OrcaExecutionBackend(fixtureRunner);
    await expect(
      backend.start(fixtureAttempt({ startRequestKey: key, startBinding: undefined })),
    ).rejects.toThrow('exact launch binding');
    await expect(
      backend.replayStart(
        fixtureAttempt({ state: 'outcome_unknown', startRequestKey: key, startBinding: undefined }),
      ),
    ).rejects.toThrow('No replayable');
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
    const recovery = new OrcaExecutionBackend(fixtureRunner).replayStart(
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
    if (mismatch === 'request' || mismatch === 'recovery_request') {
      await expect(recovery).rejects.toMatchObject({
        code: 'E_ORCA_REQUEST_MISMATCH',
        receipt: orcaFixture.start.stdout,
      });
      return;
    }
    const result = await recovery;
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      resourceState: 'unknown',
      dispatchId,
      startRequestId: key,
    });
  });

  it.each([
    'request',
    'mutation',
    'error_request',
    'error_recovery',
  ])('rejects a differing returned %s id instead of assigning the reserved key to its receipt', async (field) => {
    const key = '00000000-0000-4000-8000-000000000001';
    const reply = orcaReplySchema.parse(JSON.parse(fixtureStart().stdout));
    if (!reply.result) throw new Error('Missing launch fixture');
    if (field === 'request') reply.result.requestId = 'other-request';
    if (field === 'mutation') reply.result.mutation = { requestId: 'other-request' };
    if (field === 'error_request')
      reply.error = {
        code: 'operation_unknown',
        message: 'pending',
        data: { requestId: 'other-request' },
      };
    if (field === 'error_recovery')
      reply.error = {
        code: 'operation_unknown',
        message: 'pending',
        data: { orchestrationRequestId: 'other-request' },
      };
    orcaFixture.start = { stdout: JSON.stringify(reply), stderr: '', exitCode: 0 };
    await expect(
      new OrcaExecutionBackend(fixtureRunner).start(fixtureAttempt({ startRequestKey: key })),
    ).rejects.toMatchObject({ code: 'E_ORCA_REQUEST_MISMATCH', receipt: orcaFixture.start.stdout });
  });

  it.each([
    { data: null },
    { data: 'malformed' },
    { data: [] },
    { data: { dispatchId: '' } },
    { data: { requestId: '' } },
    { data: { orchestrationRequestId: '' } },
  ])('keeps malformed pending error.data fenced (%j)', async ({ data }) => {
    const key = '00000000-0000-4000-8000-000000000001';
    orcaFixture.request = fixtureReply({ state: 'pending', requestId: key });
    orcaFixture.start = {
      stdout: JSON.stringify({
        ok: false,
        error: { code: 'operation_unknown', message: 'pending', data },
        _meta: { runtimeId: fixtureContext.runtimeId },
      }),
      stderr: '',
      exitCode: 1,
    };
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const result = await backend.replayStart(
      fixtureAttempt({ state: 'outcome_unknown', startRequestKey: key, startRequestId: key }),
    );
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      dispatchId: null,
      resourceState: 'unknown',
      startRequestId: key,
      lastReceipt: orcaFixture.start.stdout,
    });
    await expect(backend.show(result)).rejects.toThrow('No complete Dispatch binding');
    await expect(backend.stop({ ...result, state: 'stop_pending' })).rejects.toThrow(
      'No complete Dispatch binding',
    );
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it.each([
    'runId',
    'taskId',
  ] as const)('revalidates %s before stopping an adopted Dispatch', async (field) => {
    const key = '00000000-0000-4000-8000-000000000001';
    orcaFixture.request = fixtureReply({ state: 'pending', requestId: key });
    orcaFixture.start = fixturePendingStart('ctx_retry', key);
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const adopted = await backend.replayStart(
      fixtureAttempt({
        state: 'outcome_unknown',
        runId: 'run_fixture',
        orcaTaskId: 'task_fixture',
        retryOf: 'ctx_fixture',
        startRequestKey: key,
        startBinding: { runId: 'run_fixture', orcaTaskId: 'task_fixture', retryOf: 'ctx_fixture' },
      }),
    );
    const foreign = orcaReplySchema.parse(JSON.parse(fixtureShow('ctx_retry').stdout));
    if (!foreign.result?.dispatch) throw new Error('Missing Dispatch fixture');
    foreign.result.dispatch[field] = 'other-binding';
    orcaFixture.show = { stdout: JSON.stringify(foreign), stderr: '', exitCode: 0 };
    await expect(backend.show(adopted)).rejects.toThrow('does not match');
    expect(await backend.stop({ ...adopted, state: 'stop_pending' })).toMatchObject({
      state: 'stop_unknown',
      lastError: expect.stringContaining('does not match'),
    });
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('bounds refusal diagnostics and refuses oversized receipts without adopting them', async () => {
    const oversized = fixtureStart().stdout + ' '.repeat(100_000);
    const backend = new OrcaExecutionBackend(fixtureRunner);
    orcaFixture.start = { stdout: oversized, stderr: oversized, exitCode: 1 };
    const result = await backend.start(fixtureAttempt());
    expect(result).toMatchObject({
      state: 'outcome_unknown',
      dispatchId: null,
      lastError: expect.stringContaining('oversized receipt'),
    });
    expect(result.lastReceipt?.length).toBeLessThanOrEqual(65_536);
    expect(result.lastReceipt).toMatch(/^\[truncated\]/);
    expect(() => JSON.parse(result.lastReceipt ?? '')).toThrow();
    orcaFixture.inbox = { stdout: oversized, stderr: oversized, exitCode: 1 };
    fixtureRunner.mockImplementation(async (...args) =>
      args[1][1] === 'inbox' ? orcaFixture.inbox : runOrcaFixture(...args),
    );
    await expect(
      backend.readReport(
        fixtureAttempt({
          runId: 'run_fixture',
          orcaTaskId: 'task_fixture',
          dispatchId: 'ctx_fixture',
        }),
        'msg_report',
      ),
    ).rejects.toMatchObject({
      code: 'E_ORCA_REPORT_SOURCE',
      message: expect.stringMatching(/^Orca returned no verified report source:[\s\S]{0,4058}$/),
      receipt: expect.stringMatching(/^\[truncated\]/),
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

  it('settles a durable stop_pending only from release proof plus affirmative helper evidence', async () => {
    const pending = (lastReceipt: string | null): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000001',
        lastReceipt,
      });
    const stopReceipt = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
      mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000001', replayed: false },
    }).stdout;
    const backend = new OrcaExecutionBackend(fixtureRunner);
    orcaFixture.show = fixtureReleasedShow();
    expect(await backend.show(pending(stopReceipt))).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
      lastReceipt: orcaFixture.show.stdout,
    });
    // A lost receipt is not helper evidence: exact parent release alone never settles,
    // and the record keeps whatever receipt it had for later recovery.
    expect(await backend.show(pending(null))).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'unknown',
      lastReceipt: null,
    });
    // A non-stop receipt proves nothing about helpers either.
    const startReceipt = fixtureStart().stdout;
    expect(await backend.show(pending(startReceipt))).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'unknown',
      lastReceipt: startReceipt,
    });
    orcaFixture.show = fixtureShow();
    expect(await backend.show(pending(stopReceipt))).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'owned',
    });
    expect(
      await backend.show(fixtureAttempt({ ...pending(stopReceipt), state: 'stop_unknown' })),
    ).toMatchObject({ state: 'stop_unknown' });
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('treats an omitted helper list as affirmative only when the stop recorded helper enumeration', async () => {
    const pending = (stopHelperEvidence?: 'enumerated'): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000011',
        // Installed Orca omits the list when the worker started no helper.
        lastReceipt: fixtureReply({
          dispatchId: 'ctx_fixture',
          state: 'stopped',
          processAction: 'closed_agent_terminal',
          mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000011', replayed: false },
        }).stdout,
        stopHelperEvidence,
      });
    orcaFixture.show = fixtureReleasedShow();
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(await backend.show(pending('enumerated'))).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
    });
    // Without the stop-time proof an omitted list stays an unknown helper tree.
    expect(await backend.show(pending())).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'unknown',
    });
  });

  it('records helper enumeration only when a capable stop reply omits the helper list', async () => {
    const stop = (): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000012',
      });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
    });
    const backend = new OrcaExecutionBackend(fixtureRunner);
    expect(await backend.stop(stop())).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
      stopHelperEvidence: 'enumerated',
    });
    // A failed parent stop may still start helpers, so it never records enumeration.
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stop_unknown',
      processAction: 'closed_agent_terminal',
    });
    expect((await backend.stop(stop())).stopHelperEvidence).toBeUndefined();
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
    });
    orcaFixture.capabilities = ['orchestration.contract.v1'];
    const unproven = await backend.stop(stop());
    expect(unproven).toMatchObject({ state: 'stop_unknown', resourceState: 'unknown' });
    expect(unproven.stopHelperEvidence).toBeUndefined();
  });

  it('replays a lost stop by its reserved key and fences a stop with neither key nor id', async () => {
    const key = '4f7d2f8e-0000-4000-8000-000000000002';
    const backend = new OrcaExecutionBackend(fixtureRunner);
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: { code: 'runtime_timeout', message: 'lost stop reply' },
      }),
      stderr: '',
      exitCode: 1,
    };
    const unknown = await backend.stop(
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: key,
      }),
    );
    expect(unknown).toMatchObject({
      state: 'stop_unknown',
      stopRequestId: null,
      stopRequestKey: key,
    });
    const [first] = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop');
    expect(first?.[1]).toEqual(expect.arrayContaining(['--retry-request', key]));
    orcaFixture.request = fixtureReply({ state: 'absent', requestId: key });
    orcaFixture.stop = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [],
    });
    const recovered = await backend.replayStop({ ...unknown, state: 'stop_pending' });
    expect(recovered).toMatchObject({ state: 'stopped', resourceState: 'stopped' });
    const stops = fixtureRunner.mock.calls.filter(([, args]) => args[1] === 'worker-stop');
    expect(stops[1]?.[1]).toEqual(expect.arrayContaining(['--retry-request', key]));
    await expect(
      backend.replayStop(
        fixtureAttempt({
          state: 'stop_pending',
          dispatchId: 'ctx_fixture',
          orcaTaskId: 'task_fixture',
          runId: 'run_fixture',
        }),
      ),
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

  it('does not settle a released parent while its stop receipt leaves a helper unresolved', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const stopReceipt = (helpers: string[], helperStopError?: string): string =>
      fixtureReply({
        dispatchId: 'ctx_fixture',
        state: 'stopped',
        processAction: 'closed_agent_terminal',
        helpers: helpers.map((outcome) => ({ outcome })),
        mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000003', replayed: false },
        ...(helperStopError ? { helperStopError } : {}),
      }).stdout;
    orcaFixture.show = fixtureReleasedShow();
    const pending = (lastReceipt: string): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000003',
        lastReceipt,
      });
    for (const unresolved of [
      stopReceipt(['kept_open']),
      stopReceipt(['unconfirmed']),
      stopReceipt([], 'helper stop error'),
    ]) {
      expect(await backend.show(pending(unresolved))).toMatchObject({
        state: 'stop_unknown',
        resourceState: 'unknown',
        lastReceipt: unresolved,
      });
    }
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('settles a stop once its kept-open helper finishes later, without replaying the stop', async () => {
    const helper = 'ctx_helper';
    const backend = new OrcaExecutionBackend(fixtureRunner);
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
      mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000003', replayed: false },
    }).stdout;
    const pending = (lastReceipt: string): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000003',
        lastReceipt,
      });
    orcaFixture.show = fixtureReleasedShow();
    orcaFixture.helperShows = { [helper]: fixtureShow(helper) };
    expect(await backend.show(pending(stopReceipt))).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'unknown',
      lastReceipt: stopReceipt,
    });
    // The completed stop key would replay the same kept-open outcome forever, so the
    // helper's own current state settles the stop instead.
    orcaFixture.helperShows = { [helper]: fixtureHelperExited(helper) };
    expect(await backend.show(pending(stopReceipt))).toMatchObject({
      state: 'stopped',
      resourceState: 'stopped',
      lastReceipt: orcaFixture.show.stdout,
    });
    expect(
      fixtureRunner.mock.calls.some(
        ([, args]) => args[1] === 'worker-show' && args.includes(helper),
      ),
    ).toBe(true);
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('ignores a stop receipt that belongs to another dispatch, run or request key', async () => {
    const backend = new OrcaExecutionBackend(fixtureRunner);
    orcaFixture.show = fixtureReleasedShow();
    const pending = (lastReceipt: string): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000031',
        lastReceipt,
      });
    const stopReply = (overrides: Partial<NonNullable<OrcaReply['result']>> = {}): string =>
      fixtureReply({
        dispatchId: 'ctx_fixture',
        state: 'stopped',
        processAction: 'closed_agent_terminal',
        helpers: [],
        mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000031', replayed: false },
        ...overrides,
      }).stdout;
    const foreign = [
      // Another Dispatch in the same Run.
      stopReply({ dispatchId: 'ctx_other' }),
      // The same Dispatch id, but another Run.
      stopReply({ runId: 'run_other' }),
      // This Dispatch refused under a stop key this attempt never issued.
      JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        error: {
          code: 'operation_unknown',
          message: 'another attempt cancelled this Dispatch',
          data: {
            dispatchId: 'ctx_fixture',
            orchestrationRequestId: '4f7d2f8e-0000-4000-8000-000000000032',
          },
        },
      }),
      // This Dispatch stopped successfully under a stop key this attempt never issued.
      stopReply({
        mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000032', replayed: false },
      }),
      // This Dispatch stopped on another runtime epoch.
      JSON.stringify({
        ok: true,
        _meta: { runtimeId: 'runtime-other' },
        result: {
          dispatchId: 'ctx_fixture',
          state: 'stopped',
          processAction: 'closed_agent_terminal',
          helpers: [],
          mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000031', replayed: false },
        },
      }),
    ];
    for (const receipt of foreign) {
      expect(await backend.show(pending(receipt))).toMatchObject({
        state: 'stop_unknown',
        resourceState: 'unknown',
        lastReceipt: receipt,
      });
      // Repeated reads never promote a mismatched receipt by a later release.
      expect(await backend.show(pending(receipt))).toMatchObject({ state: 'stop_unknown' });
    }
    expect(fixtureRunner.mock.calls.some(([, args]) => args[1] === 'worker-stop')).toBe(false);
  });

  it('does not settle a stop from an exited helper that another Dispatch created', async () => {
    const helper = 'ctx_unrelated';
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const stopReceipt = fixtureReply({
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
      helpers: [
        {
          dispatchId: helper,
          creatorDispatchId: 'ctx_other',
          outcome: 'kept_open',
          state: 'ready',
        },
      ],
      mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000033', replayed: false },
    }).stdout;
    const pending = (lastReceipt: string): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000033',
        lastReceipt,
      });
    orcaFixture.show = fixtureReleasedShow();
    // The helper exited, but its creator chain never reaches this worker.
    orcaFixture.helperShows = {
      [helper]: fixtureHelperExited(helper, 'ctx_other'),
      ctx_other: fixtureShow('ctx_other'),
    };
    expect(await backend.show(pending(stopReceipt))).toMatchObject({
      state: 'stop_unknown',
      resourceState: 'unknown',
      lastReceipt: stopReceipt,
    });
    // A nested helper whose chain does reach this worker still settles the stop.
    const nested = 'ctx_nested';
    orcaFixture.helperShows = {
      [nested]: fixtureHelperExited(nested, helper),
      [helper]: fixtureShow(helper, 0, 'ctx_fixture'),
    };
    expect(
      await backend.show(
        pending(
          fixtureReply({
            dispatchId: 'ctx_fixture',
            state: 'stopped',
            processAction: 'closed_agent_terminal',
            helpers: [
              {
                dispatchId: nested,
                creatorDispatchId: helper,
                outcome: 'kept_open',
                state: 'ready',
              },
            ],
            mutation: { requestId: '4f7d2f8e-0000-4000-8000-000000000033', replayed: false },
          }).stdout,
        ),
      ),
    ).toMatchObject({ state: 'stopped', resourceState: 'stopped' });
  });

  it('records helper enumeration only from a proven stop reply from this exact runtime', async () => {
    const stop = (): OrcaAttempt =>
      fixtureAttempt({
        state: 'stop_pending',
        dispatchId: 'ctx_fixture',
        orcaTaskId: 'task_fixture',
        runId: 'run_fixture',
        stopRequestKey: '4f7d2f8e-0000-4000-8000-000000000034',
      });
    const backend = new OrcaExecutionBackend(fixtureRunner);
    const stoppedReply = {
      dispatchId: 'ctx_fixture',
      state: 'stopped',
      processAction: 'closed_agent_terminal',
    };
    // A refused reply that still carried a stopped result never proves enumeration.
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: false,
        _meta: { runtimeId: fixtureContext.runtimeId },
        this: 'not-a-reply-field',
        result: stoppedReply,
      }),
      stderr: '',
      exitCode: 1,
    };
    // Unparseable extras are ignored by the wire schema, so the refusal alone must not mint.
    expect((await backend.stop(stop())).stopHelperEvidence).toBeUndefined();
    // Another runtime epoch is not this attempt's proof.
    orcaFixture.stop = {
      stdout: JSON.stringify({
        ok: true,
        _meta: { runtimeId: 'runtime-other' },
        result: stoppedReply,
      }),
      stderr: '',
      exitCode: 0,
    };
    expect(await backend.stop(stop())).toMatchObject({
      state: 'stop_unknown',
      stopHelperEvidence: undefined,
    });
    // A reply for another Dispatch is not this attempt's proof either.
    orcaFixture.stop = fixtureReply({ ...stoppedReply, dispatchId: 'ctx_other' });
    expect(await backend.stop(stop())).toMatchObject({
      state: 'stop_unknown',
      stopHelperEvidence: undefined,
    });
    // Only the exact runtime, Dispatch and stopped parent records enumeration.
    orcaFixture.stop = fixtureReply(stoppedReply);
    expect(await backend.stop(stop())).toMatchObject({
      state: 'stopped',
      stopHelperEvidence: 'enumerated',
    });
  });
});

import { type ChildProcess, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
