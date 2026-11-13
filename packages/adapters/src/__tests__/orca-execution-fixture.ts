/** Recorded-shape fixtures; no command in this module reaches an Orca runtime. */
import type {
  OrcaAttempt,
  OrcaCommandResult,
  OrcaCommandRunner,
  OrcaContext,
  OrcaLaunch,
  OrcaWorkerDone,
} from '@cleocode/contracts/orca-execution.js';
import { orcaReplySchema, orcaReportSourceSchema } from '@cleocode/contracts/orca-execution.js';
import type { MbxRunner } from '@cleocode/core/orchestrate/agentmbx';
import { vi } from 'vitest';

/** Fake durable provider mailbox; retained while a fresh client simulates CLI restart. */
export const fixtureMail = { bodies: new Map<string, string>(), failBefore: false, loseAck: false };

/** AgentMBX held-identity reads and idempotent sends, with no real mailbox access. */
export const runMbxFixture: MbxRunner = async (args) => {
  if (args[0] === 'identity' && args[1] === 'list') {
    if (!args.includes('--project')) throw new Error('Mailbox inventory needs a project');
    return {
      missing: false,
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        identities: [
          {
            name: 'fixture-lead',
            registered: true,
            retired: false,
            state: 'held',
            holder: { cli: 'codex', session_id: 'ses_fixture_lead' },
          },
        ],
      }),
    };
  }
  if (args[0] === 'status' || (args[0] === 'identity' && args[1] === 'release')) {
    const held =
      args[0] === 'status' &&
      args[args.indexOf('--cli') + 1] === 'codex' &&
      args[args.indexOf('--session') + 1] === 'ses_fixture_lead';
    return {
      missing: false,
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        identity: {
          name: held ? 'fixture-lead' : null,
          role: held ? 'lead' : null,
          state: held ? 'bound' : 'unbound',
        },
        unread: 0,
      }),
    };
  }
  if (args[0] !== 'send') throw new Error(`Unexpected mailbox fixture command: ${args[0]}`);
  const key = args[args.indexOf('--idempotency-key') + 1];
  const body = args[args.indexOf('-m') + 1];
  if (!args.includes('--idempotency-key') || !key || !body)
    throw new Error('Missing logical mailbox key or canonical report');
  if (fixtureMail.failBefore)
    return { missing: false, exitCode: 1, stdout: '', stderr: 'mailbox unavailable' };
  if (fixtureMail.bodies.has(key) && fixtureMail.bodies.get(key) !== body)
    throw new Error('A logical mailbox key changed its report');
  fixtureMail.bodies.set(key, body);
  if (fixtureMail.loseAck)
    return {
      missing: false,
      exitCode: null,
      stdout: '',
      stderr: 'acknowledgement lost after durable send',
    };
  return {
    missing: false,
    exitCode: 0,
    stdout: JSON.stringify({ id: `mbx-${[...fixtureMail.bodies.keys()].indexOf(key) + 1}` }),
    stderr: '',
  };
};

/** Injected mailbox process boundary; never invokes the installed AgentMBX CLI. */
export const fixtureMbxRunner = vi.fn<MbxRunner>(runMbxFixture);

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
export function fixtureShow(
  dispatchId = 'ctx_fixture',
  failureCount = 0,
  creatorDispatchId?: string,
): OrcaCommandResult {
  return fixtureReply({
    dispatch: {
      id: dispatchId,
      runId: 'run_fixture',
      taskId: 'task_fixture',
      failureCount,
      ...(creatorDispatchId === undefined ? {} : { creatorDispatchId }),
    },
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

/**
 * A helper Dispatch whose process has exited but whose terminal is still retained.
 * @param dispatchId - Helper Dispatch to render as exited.
 * @param creatorDispatchId - Direct creator the helper must descend from.
 */
export function fixtureHelperExited(
  dispatchId: string,
  creatorDispatchId = 'ctx_fixture',
): OrcaCommandResult {
  const original = orcaReplySchema.parse(
    JSON.parse(fixtureShow(dispatchId, 0, creatorDispatchId).stdout),
  );
  return fixtureReply({
    ...original.result,
    worker: { ...original.result?.worker, state: 'succeeded', stage: 'settled' },
    observation: { status: 'exited', exactWorker: true },
    projection: { resource: { state: 'retained', terminalState: 'retained' } },
  });
}

/** Full inbox worker_done shape, with the canonical report carried only by a file pointer. */
export function fixtureReportInbox(
  overrides: Partial<OrcaWorkerDone> = {},
  newerMessages = 0,
): OrcaCommandResult {
  const event: OrcaWorkerDone = {
    messageId: 'msg_report',
    runtimeId: fixtureContext.runtimeId,
    runId: 'run_fixture',
    orcaTaskId: 'task_fixture',
    dispatchId: 'ctx_fixture',
    senderHandle: 'term_worker',
    outcome: 'succeeded',
    body: 'Implemented the change. Checks passed. Review remains.',
    reportPath: 'worker-report.txt',
    ...overrides,
  };
  return {
    exitCode: 0,
    stderr: '',
    stdout: JSON.stringify({
      ok: true,
      _meta: { runtimeId: event.runtimeId },
      result: {
        messages: Array.from({ length: newerMessages + 1 }, (_, index) => ({
          id: index === newerMessages ? event.messageId : `msg_newer_${index}`,
          run_id: event.runId,
          delivery_contract: 'current_delivery',
          from_handle: event.senderHandle,
          to_handle: `run:${event.runId}`,
          type: 'worker_done',
          body: event.body,
          payload: JSON.stringify({
            taskId: event.orcaTaskId,
            dispatchId: event.dispatchId,
            outcome: event.outcome,
            reportPath: event.reportPath,
          }),
          sender_pane_key: 'pane_worker',
        })),
      },
    }),
  };
}

/** dispatch-show's raw current-task mapping; distinct from worker-show's camel-case view. */
export function fixtureReportDispatch(
  dispatchId = 'ctx_fixture',
  status = 'completed',
): OrcaCommandResult {
  return fixtureReply({
    dispatch: {
      id: dispatchId,
      run_id: 'run_fixture',
      task_id: 'task_fixture',
      assignee_handle: 'term_worker',
      assignee_pane_key: 'pane_worker',
      status,
    },
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
  inbox: fixtureReportInbox(),
  currentDispatch: fixtureReportDispatch(),
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
          { command: 'terminal create', flags: ['command', 'worktree', 'title', 'environment'] },
          { command: 'terminal show', flags: ['terminal', 'environment'] },
          { command: 'terminal close', flags: ['terminal', 'environment'] },
          { command: 'terminal switch', flags: ['terminal', 'environment'] },
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
    case 'inbox':
      try {
        const source = orcaReportSourceSchema.parse(JSON.parse(orcaFixture.inbox.stdout));
        const limit = Number(args[args.indexOf('--limit') + 1]);
        if (source.result.messages) source.result.messages = source.result.messages.slice(0, limit);
        return { ...orcaFixture.inbox, stdout: JSON.stringify(source) };
      } catch {
        return orcaFixture.inbox;
      }
    case 'dispatch-show':
      return orcaFixture.currentDispatch;
    default:
      throw new Error(`Unexpected fixture command: ${args.join(' ')}`);
  }
};

/** Injected process spy, never the installed Orca executable. */
export const fixtureRunner = vi.fn<OrcaCommandRunner>(runOrcaFixture);
