/** Recorded-shape fixtures; no command in this module reaches an Orca runtime. */
import type {
  OrcaAttempt,
  OrcaCommandResult,
  OrcaCommandRunner,
  OrcaContext,
  OrcaLaunch,
} from '@cleocode/contracts/orca-execution.js';
import { orcaReplySchema } from '@cleocode/contracts/orca-execution.js';
import { vi } from 'vitest';

/** Explicit fictitious caller, independent of the developer's running Orca. */
export const fixtureContext: OrcaContext = {
  runtimeId: 'runtime-fixture',
  coordinatorHandle: 'term_fixture',
  executionHostId: 'local',
};

/** Prepared assignment containing inert shell metacharacters. */
export const fixtureLaunch: OrcaLaunch = {
  projectId: 'project-fixture',
  projectRoot: '/fixture/project',
  taskId: 'T001',
  instanceId: 'worker-fixture',
  workerSessionId: 'ses_fixture',
  agentId: 'agent-t001',
  role: 'worker',
  protocol: 'implementation',
  worktreePath: '/fixture/canonical/T001',
  worktreeBranch: 'task/T001',
  projectHash: 'fixture-hash',
  lockToken: 'fixture-token',
  prompt: 'Do the task. Preserve `literal backticks` and $(literal); CLEO_SESSION_ID=ses_fixture',
  harness: 'codex',
  leadMailbox: 'fixture-lead',
};

/** Wrap a wire result without using its process exit as lifecycle evidence. */
export function fixtureReply(result: object, exitCode = 0): OrcaCommandResult {
  return {
    stdout: JSON.stringify({ ok: true, result, _meta: { runtimeId: fixtureContext.runtimeId } }),
    stderr: '',
    exitCode,
  };
}

/** Full worker-start response fields from the installed CLI contract. */
export function fixtureStart(
  state = 'ready',
  failureCount = 0,
  dispatchId = 'ctx_fixture',
): OrcaCommandResult {
  return fixtureReply(
    {
      state,
      failureCount,
      stage: state === 'outcome_unknown' ? 'turn_start_unobserved' : 'input_accepted',
      dispatchId,
      runId: 'run_fixture',
      taskId: 'task_fixture',
      effects: [{ kind: 'worktree', action: 'reused', id: 'workspace-fixture' }],
      residualResources: [],
      launch: { effective: { agent: 'codex', model: null, effort: null } },
    },
    state === 'ready' ? 0 : 1,
  );
}

/**
 * Orca 1.4.255 pending workerStart refusal after accept/receipt restart.
 * Source: installed out/main/chunks/orcad-retained-source-*.js mutation ledger
 * and out/cli/runtime/client-error-recovery.js attachMutationRecovery.
 */
export function fixturePendingStart(
  dispatchId = 'ctx_retry',
  requestId = 'request-fixture',
): OrcaCommandResult {
  return {
    stdout: JSON.stringify({
      ok: false,
      error: {
        code: 'operation_unknown',
        message:
          `Worker start ${requestId} was accepted as Dispatch ${dispatchId} before restart. ` +
          `Inspect that Dispatch; do not start another worker. Orchestration mutation request ID: ${requestId}.`,
        data: {
          requestId,
          dispatchId,
          recoveryCommand: `orca orchestration worker-show --dispatch ${dispatchId} --json`,
          orchestrationRequestId: requestId,
        },
      },
      _meta: { runtimeId: fixtureContext.runtimeId },
    }),
    stderr: '',
    exitCode: 1,
  };
}

/** Full exact-dispatch observation; a status hint alone is never a worker report. */
export function fixtureShow(dispatchId = 'ctx_fixture', failureCount = 0): OrcaCommandResult {
  return fixtureReply({
    dispatch: { id: dispatchId, runId: 'run_fixture', taskId: 'task_fixture', failureCount },
    worker: {
      dispatchId,
      runtimeEpoch: fixtureContext.runtimeId,
      state: 'ready',
      stage: 'input_accepted',
      worktreeId: 'workspace-fixture',
    },
    observation: { status: 'live', exactWorker: true },
    projection: { resource: { state: 'owned', terminalState: 'active' } },
  });
}

/** Recorded resource-release proof, independent of worker launch and Task status. */
export function fixtureReleasedShow(
  dispatchId = 'ctx_fixture',
  failureCount = 0,
): OrcaCommandResult {
  const original = orcaReplySchema.parse(JSON.parse(fixtureShow(dispatchId, failureCount).stdout));
  return fixtureReply({
    ...original.result,
    worker: { ...original.result?.worker, state: 'failed', stage: 'settled' },
    observation: { status: 'exited', exactWorker: true },
    projection: {
      resource: {
        state: 'released',
        terminalState: 'released',
        releaseState: 'released',
        ownerDispatchId: dispatchId,
      },
    },
  });
}

/** A helper Dispatch whose process has exited but whose terminal is still retained. */
export function fixtureHelperExited(dispatchId: string): OrcaCommandResult {
  const original = orcaReplySchema.parse(JSON.parse(fixtureShow(dispatchId).stdout));
  return fixtureReply({
    ...original.result,
    worker: { ...original.result?.worker, state: 'succeeded', stage: 'settled' },
    observation: { status: 'exited', exactWorker: true },
    projection: { resource: { state: 'retained', terminalState: 'retained' } },
  });
}

/** Durable attempt suitable for testing supervision independently of the store. */
export function fixtureAttempt(overrides: Partial<OrcaAttempt> = {}): OrcaAttempt {
  return {
    backend: 'orca',
    version: 1,
    revision: 0,
    context: fixtureContext,
    launch: fixtureLaunch,
    promptDigest: 'a'.repeat(64),
    workspaceId: 'workspace-fixture',
    workspaceSelector: 'identity:workspace-fixture',
    state: 'launching',
    runId: null,
    orcaTaskId: null,
    dispatchId: null,
    retryOf: null,
    startBinding: { runId: null, orcaTaskId: null, retryOf: null },
    startRequestId: null,
    stopRequestId: null,
    failureCount: 0,
    resourceState: 'unknown',
    lastReceipt: null,
    lastError: null,
    observedAt: '2026-11-11T00:00:00Z',
    ...overrides,
  };
}

/** Mutable response selections reset by each test; requests remain argv-only. */
export const orcaFixture = {
  launch: { ...fixtureLaunch },
  start: fixtureStart(),
  show: fixtureShow(),
  /** Per-helper Dispatch observations; a missing key falls back to `show`. */
  helperShows: {} as Record<string, OrcaCommandResult>,
  capabilities: ['orchestration.contract.v1', 'orchestration.worker-stop-helpers.v1'],
  stop: fixtureReply(
    {
      dispatchId: 'ctx_fixture',
      state: 'stop_unknown',
      processAction: 'closed_agent_terminal',
      helpers: [],
    },
    1,
  ),
  request: fixtureReply({ state: 'completed', requestId: 'request-fixture' }),
  read: fixtureReply({ text: 'original output', nextCursor: 'source-pinned-cursor' }),
  accounts: fixtureReply({
    codex: { accounts: [], activeAccountId: 'system' },
    opencode: { accounts: [], activeAccountId: 'system' },
    claude: { accounts: [], activeAccountId: 'system' },
  }),
  caller: fixtureReply({
    terminal: {
      handle: fixtureContext.coordinatorHandle,
      executionHostId: 'local',
      connected: true,
      writable: true,
    },
  }),
  currentRun: fixtureReply({ run: { id: 'run_fixture' } }),
};

/** Pure CLI fixture dispatcher; unexpected verbs fail instead of launching anything. */
export const runOrcaFixture: OrcaCommandRunner = async (_executable, args) => {
  if (args[0] === 'account') return orcaFixture.accounts;
  if (args[0] === 'terminal') return orcaFixture.caller;
  if (args[1] === 'run-current') return orcaFixture.currentRun;
  if (args[0] === 'agent-context') {
    return {
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        schemaVersion: 1,
        commands: [
          {
            command: 'orchestration worker-start',
            flags: [
              'from',
              'spec-file',
              'task',
              'run',
              'worktree',
              'agent',
              'retry-of',
              'retry-request',
              'full',
              'model',
              'effort',
            ],
          },
          { command: 'orchestration worker-show', flags: ['dispatch', 'full'] },
          {
            command: 'orchestration worker-read',
            flags: ['dispatch', 'source', 'limit', 'cursor', 'full'],
          },
          { command: 'orchestration worker-stop', flags: ['dispatch', 'retry-request', 'full'] },
          { command: 'orchestration request-show', flags: ['request', 'full'] },
          { command: 'orchestration run-current', flags: ['from', 'full'] },
          { command: 'worktree show', flags: ['worktree'] },
        ],
      }),
    };
  }
  if (args[0] === 'status')
    return fixtureReply({
      runtime: {
        runtimeId: fixtureContext.runtimeId,
        reachable: true,
        state: 'ready',
        capabilities: orcaFixture.capabilities,
      },
    });
  if (args[0] === 'worktree')
    return fixtureReply({
      worktree: {
        id: 'workspace-fixture',
        path: orcaFixture.launch.worktreePath,
        branch: `refs/heads/${orcaFixture.launch.worktreeBranch}`,
        hostId: 'local',
        address: { worktree: 'identity:workspace-fixture' },
      },
    });
  switch (args[1]) {
    case 'worker-start':
      return orcaFixture.start;
    case 'worker-show': {
      const dispatchIndex = args.indexOf('--dispatch');
      const dispatchId = dispatchIndex === -1 ? undefined : args[dispatchIndex + 1];
      return dispatchId
        ? (orcaFixture.helperShows[dispatchId] ?? orcaFixture.show)
        : orcaFixture.show;
    }
    case 'worker-stop':
      return orcaFixture.stop;
    case 'request-show':
      return orcaFixture.request;
    case 'worker-read':
      return orcaFixture.read;
    default:
      throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  }
};

/** Injected process spy, never the installed Orca executable. */
export const fixtureRunner = vi.fn<OrcaCommandRunner>(runOrcaFixture);
