/** Recorded-shape fixtures; no command in this module reaches an Orca runtime. */
import type {
  OrcaAttempt,
  OrcaCommandResult,
  OrcaCommandRunner,
  OrcaContext,
  OrcaLaunch,
} from '@cleocode/contracts/orca-execution.js';
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
export function fixtureStart(state = 'ready', failureCount = 0): OrcaCommandResult {
  return fixtureReply(
    {
      state,
      failureCount,
      stage: state === 'outcome_unknown' ? 'turn_start_unobserved' : 'input_accepted',
      dispatchId: 'ctx_fixture',
      runId: 'run_fixture',
      taskId: 'task_fixture',
      effects: [{ kind: 'worktree', action: 'reused', id: 'workspace-fixture' }],
      residualResources: [],
      launch: { effective: { agent: 'codex', model: null, effort: null } },
    },
    state === 'ready' ? 0 : 1,
  );
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
};

/** Pure CLI fixture dispatcher; unexpected verbs fail instead of launching anything. */
export const runOrcaFixture: OrcaCommandRunner = async (_executable, args) => {
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
        capabilities: ['orchestration.contract.v1'],
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
    case 'worker-show':
      return orcaFixture.show;
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
