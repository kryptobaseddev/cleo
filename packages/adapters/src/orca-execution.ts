/**
 * Local Orca execution, with no task-store, claim or filesystem disposal authority.
 * @packageDocumentation
 */
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import type {
  OrcaAttempt,
  OrcaCommandReply,
  OrcaCommandResult,
  OrcaCommandRunner,
  OrcaContext,
  OrcaDiscovery,
  OrcaLaunch,
  OrcaRoutingAdapter,
} from '@cleocode/contracts/orca-execution.js';
import {
  orcaAccountReplySchema,
  orcaCommandRegistrySchema,
  orcaContextSchema,
  orcaLaunchSchema,
  orcaReplySchema,
} from '@cleocode/contracts/orca-execution.js';

const AGENTS = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode2', grok: 'grok' };
const REQUIRED_COMMANDS = {
  'orchestration worker-start': [
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
  'orchestration worker-show': ['dispatch', 'full'],
  'orchestration worker-read': ['dispatch', 'source', 'limit', 'cursor', 'full'],
  'orchestration worker-stop': ['dispatch', 'retry-request', 'full'],
  'orchestration request-show': ['request', 'full'],
  'orchestration run-current': ['from', 'full'],
  'worktree show': ['worktree'],
};

/** Helper outcomes that prove Orca released the helper rather than leaving it running. */
const SETTLED_HELPER_OUTCOMES = new Set(['stopped', 'already_finished']);

/**
 * Decide whether a stored receipt proves a helper was kept open or its stop unconfirmed.
 * @remarks A worker-stop receipt is the only helper evidence Orca exposes; a receipt that
 * is not a stop reply carries none and never blocks exact parent release proof.
 * @param receipt - Last stored raw receipt, or null when none was retained.
 * @returns True when a helper outcome or the helper stop error stays unresolved.
 * @example
 * ```ts
 * receiptLeavesHelpersUnresolved('{"ok":true,"result":{"helpers":[{"outcome":"kept_open"}]}}');
 * ```
 */
function receiptLeavesHelpersUnresolved(receipt: string | null): boolean {
  if (!receipt) return false;
  try {
    const parsed = orcaReplySchema.safeParse(JSON.parse(receipt));
    if (!parsed.success) return false;
    const value = parsed.data.result;
    if (!value) return false;
    // Only a stop reply speaks about helpers; a start or show receipt proves nothing here.
    const stopReply =
      value.processAction !== undefined ||
      value.helpers !== undefined ||
      value.helperStopError !== undefined;
    if (!stopReply) return false;
    if (value.helperStopError) return true;
    // A stop reply without the helper list could not confirm every helper released.
    if (!value.helpers) return true;
    return value.helpers.some((helper) => !SETTLED_HELPER_OUTCOMES.has(helper.outcome));
  } catch {
    return false;
  }
}

/** Actionable refusal; callers must retain any attempt already sent to Orca. */
export class OrcaExecutionError extends Error {
  /** Numeric CLI refusal status, independent of a worker's exit. */
  readonly exitCode = 63;
  /** Stable refusal code. */
  readonly code: string;
  /** Recovery instruction that never disables the lead policy. */
  readonly fix: string;
  /** Original unparseable receipt, when available. */
  readonly receipt: string | null;

  /** Construct a refusal before any unsupported operation runs. */
  constructor(code: string, message: string, fix: string, receipt: string | null = null) {
    super(message);
    this.name = 'OrcaExecutionError';
    this.code = code;
    this.fix = fix;
    this.receipt = receipt;
  }
}

/** Bounded argv-only process runner; stdin carries the prepared prompt unchanged. */
export const runOrcaCommand: OrcaCommandRunner = (executable, args, cwd, input) =>
  new Promise((resolve) => {
    const child = execFile(
      executable,
      [...args],
      { cwd, encoding: 'utf8', timeout: 90_000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr: stderr || error?.message || '',
          exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        }),
    );
    // EPIPE is reported through the process result, never as evidence of worker exit.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(input);
  });

/**
 * Execution backend around a selected harness, deliberately absent from the
 * provider registry. Core persists each operation before invoking these methods.
 */
export class OrcaExecutionBackend implements OrcaRoutingAdapter {
  /** Public launch APIs cannot enforce denied tools or a strict MCP allowlist. */
  readonly leadToolStrip = 'unsupported';
  private readonly executable: string;

  /** Resolve the session executable once; never fall through to another runtime. */
  constructor(
    private readonly runner: OrcaCommandRunner = runOrcaCommand,
    executable = process.env.ORCA_CLI_COMMAND ||
      (process.env.ORCA_DEV_REPO_ROOT
        ? 'orca-dev'
        : process.platform === 'linux'
          ? 'orca-ide'
          : 'orca'),
  ) {
    this.executable = executable;
  }

  /** Inspect hints without spawning a process; this cannot select an execution backend. */
  hasContextHints(): boolean {
    return Boolean(
      process.env.ORCA_TERMINAL_HANDLE ||
        process.env.ORCA_WORKTREE_ID ||
        process.env.ORCA_WORKSPACE_ID ||
        process.env.ORCA_RUNTIME_SOURCE_ID ||
        process.env.ORCA_APP_VERSION,
    );
  }

  /** Verify the local caller before returning a sanitized account inventory. */
  async discover(projectRoot: string): Promise<OrcaDiscovery | null> {
    if (!this.hasContextHints()) return null;
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if (!handle) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'Orca environment hints have no runtime-issued coordinator handle.',
        'Run this command in the intended Orca agent session with its ORCA_TERMINAL_HANDLE; TERM_PROGRAM alone cannot select a caller.',
      );
    }
    const status = await this.invoke(['status'], projectRoot);
    const runtimeId = status._meta?.runtimeId;
    if (!status.ok || !runtimeId) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'The selected local Orca runtime cannot verify this caller.',
        'Inspect orca status --json in the intended Orca session and restore that runtime before dispatch.',
      );
    }
    const context: OrcaContext = { runtimeId, coordinatorHandle: handle, executionHostId: 'local' };
    await this.verifyRuntime(projectRoot, context);
    const caller = await this.query(
      ['terminal', 'show', '--terminal', handle],
      projectRoot,
      context,
    );
    const terminal = caller.result?.terminal;
    if (
      terminal?.handle !== handle ||
      terminal.executionHostId !== 'local' ||
      !terminal.connected ||
      !terminal.writable
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'Orca did not prove a unique connected local coordinator.',
        'Inspect orca terminal show --terminal <handle> --json and run from that live local Orca session; do not substitute a different caller.',
      );
    }
    // account list is host-local and rejects --environment; never retain its private stdout.
    try {
      const accounts = await this.runner(
        this.executable,
        ['account', 'list', '--json'],
        projectRoot,
      );
      if (accounts.exitCode !== 0) throw new Error('inventory unavailable');
      const { result, _meta } = orcaAccountReplySchema.parse(JSON.parse(accounts.stdout));
      if (_meta.runtimeId !== context.runtimeId) throw new Error('account runtime changed');
      return {
        context,
        accounts: (['codex', 'opencode', 'claude'] as const).map((provider) => ({
          provider,
          accountCount: result[provider].accounts.length,
          activeAccountPresent: result[provider].activeAccountId !== null,
        })),
      };
    } catch {
      throw new OrcaExecutionError(
        'E_ORCA_ACCOUNT_UNAVAILABLE',
        'Orca returned no verifiable local account availability.',
        'Inspect orca account list --json locally and select an active account for an agent in orchestrate.orca.agents.',
      );
    }
  }

  /** Read the Run currently bound to the original local coordinator, without mutation. */
  async currentRun(projectRoot: string, context: OrcaContext): Promise<string | null> {
    await this.verifyRuntime(projectRoot, context);
    const reply = await this.query(
      ['orchestration', 'run-current', '--from', context.coordinatorHandle],
      projectRoot,
      context,
    );
    const run = reply.result?.run;
    if (run === undefined) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'Orca did not prove the coordinator Run binding.',
        'Inspect orca orchestration run-current --from <handle> --json in the original local runtime before dispatch.',
      );
    }
    return run?.id ?? null;
  }

  /** Verify supported commands, exact runtime and existing canonical workspace. */
  async preflight(
    launch: OrcaLaunch,
    context: OrcaContext,
  ): Promise<Pick<OrcaAttempt, 'workspaceId' | 'workspaceSelector'>> {
    this.validateLaunch(launch, context);
    const registryResult = await this.runner(
      this.executable,
      ['agent-context', '--json'],
      launch.projectRoot,
    );
    if (registryResult.exitCode !== 0) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'The selected Orca CLI is unavailable.',
        'Inspect the selected Orca executable and runtime; do not substitute a native launch.',
        registryResult.stdout,
      );
    }
    let registry: ReturnType<typeof orcaCommandRegistrySchema.parse>;
    try {
      registry = orcaCommandRegistrySchema.parse(JSON.parse(registryResult.stdout));
    } catch {
      throw new OrcaExecutionError(
        'E_ORCA_COMMAND_UNSUPPORTED',
        'The selected Orca CLI returned no valid command registry.',
        'Update the selected Orca CLI and runtime together, then repeat read-only preflight.',
        registryResult.stdout,
      );
    }
    for (const [command, flags] of Object.entries(REQUIRED_COMMANDS)) {
      const declared = registry.commands.find((entry) => entry.command === command);
      if (!declared || flags.some((flag) => !declared.flags.includes(flag))) {
        throw new OrcaExecutionError(
          'E_ORCA_COMMAND_UNSUPPORTED',
          `Installed Orca does not declare ${command} with required flags.`,
          'Update the selected Orca CLI and runtime together, then repeat read-only preflight.',
        );
      }
    }
    await this.verifyRuntime(launch.projectRoot, context, launch.model !== undefined);
    const workspace = await this.query(
      ['worktree', 'show', '--worktree', `path:${launch.worktreePath}`],
      launch.projectRoot,
      context,
    ).catch((error: Error) => {
      throw new OrcaExecutionError(
        'E_ORCA_WORKSPACE',
        error.message,
        'Inspect orca status --json and orca worktree show --worktree <exact-selector> --json; resolve ambiguous entries for the existing canonical checkout before dispatch. Do not create a replacement checkout.',
      );
    });
    const tree = workspace.result?.worktree;
    if (
      !tree ||
      tree.path !== launch.worktreePath ||
      tree.hostId !== context.executionHostId ||
      tree.branch.replace(/^refs\/heads\//, '') !== launch.worktreeBranch
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_WORKSPACE',
        'Orca did not resolve the exact local CLEO worktree.',
        'Register the existing canonical checkout in Orca and resolve duplicate workspace entries explicitly.',
      );
    }
    return { workspaceId: tree.id, workspaceSelector: tree.address?.worktree ?? `id:${tree.id}` };
  }

  private validateLaunch(launch: OrcaLaunch, context: OrcaContext): void {
    if (
      !orcaLaunchSchema.safeParse(launch).success ||
      !orcaContextSchema.safeParse(context).success
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'The prepared assignment or explicit Orca caller is incomplete.',
        'Use canonical CLEO preparation and an explicitly verified local runtime and coordinator handle.',
      );
    }
    if (launch.role === 'lead') {
      throw new OrcaExecutionError(
        'E_LEAD_TOOLS_UNSTRIPPED',
        'Orca cannot enforce the lead denied tools, strict MCP allowlist and owner channel before launch.',
        'Use an enforced native lead route until Orca exposes constrained launch; keep leadWorker.v1 enabled.',
      );
    }
    if (launch.accountId !== undefined) {
      throw new OrcaExecutionError(
        'E_ORCA_ACCOUNT_UNSUPPORTED',
        'Exact per-worker account placement is unavailable.',
        'Omit the account constraint to use Orca’s active account for the selected harness.',
      );
    }
    if (launch.harness === 'kimi') {
      throw new OrcaExecutionError(
        'E_ORCA_HARNESS_UNSUPPORTED',
        'Kimi requires a proven terminal adoption path.',
        'Use a supported Orca harness or the separately supervised Kimi terminal pilot.',
      );
    }
    if (!isAbsolute(launch.worktreePath) || launch.worktreeBranch !== `task/${launch.taskId}`) {
      throw new OrcaExecutionError(
        'E_ORCA_WORKSPACE',
        'The assignment does not name a canonical task checkout.',
        'Prepare the task once through cleo orchestrate spawn and preserve its worktree binding.',
      );
    }
    if (launch.effort && (!launch.model || launch.harness === 'opencode')) {
      throw new OrcaExecutionError(
        'E_ORCA_MODEL_UNSUPPORTED',
        'Effort requires a model and is unsupported for OpenCode.',
        'Omit effort or select a supported harness/model route explicitly.',
      );
    }
  }

  /** Start only a persisted launching attempt; no exit code is worker completion. */
  async start(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    if (
      attempt.state !== 'launching' ||
      attempt.startRequestId ||
      attempt.dispatchId ||
      attempt.failureCount >= 3
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'This attempt cannot start another worker.',
        'Inspect the stored exact Dispatch; recover an uncertain request by its issued id.',
      );
    }
    return this.startCommand(attempt, attempt.startRequestKey);
  }

  /** Replay an issued or pre-reserved retry key on the same runtime and caller. */
  async replayStart(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    const requestId = attempt.startRequestKey ?? attempt.startRequestId;
    if (
      attempt.state !== 'outcome_unknown' ||
      !requestId ||
      !attempt.startBinding ||
      attempt.failureCount >= 3
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'No replayable uncertain start request is retained.',
        'Inspect the original operation; never substitute a fresh Run, Task or launch.',
      );
    }
    await this.verifyRequest(attempt, requestId);
    return this.startCommand(attempt, requestId);
  }

  /** Inspect exactly this attempt, settling a reserved stop only on release proof. */
  async show(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    const dispatchId = this.requireDispatch(attempt);
    const reply = await this.query(
      ['orchestration', 'worker-show', '--dispatch', dispatchId],
      attempt.launch.projectRoot,
      attempt.context,
    );
    const value = reply.result;
    if (
      !value?.dispatch ||
      !value.worker ||
      value.dispatch.id !== dispatchId ||
      value.worker.dispatchId !== dispatchId ||
      value.dispatch.taskId !== attempt.orcaTaskId ||
      value.dispatch.runId !== attempt.runId ||
      value.worker.runtimeEpoch !== attempt.context.runtimeId ||
      value.worker.worktreeId !== attempt.workspaceId
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_IDENTITY',
        'Worker observation does not match the stored Dispatch binding.',
        'Retain custody and inspect the stored runtime, Run, Task and workspace; do not use newest-record guesses.',
      );
    }
    const failureCount = Math.max(attempt.failureCount, value.dispatch.failureCount);
    const resource = value.projection?.resource;
    const released =
      value.observation?.exactWorker === true &&
      value.observation.status === 'exited' &&
      resource?.ownerDispatchId === dispatchId &&
      resource.state === 'released' &&
      resource.releaseState === 'released' &&
      resource.terminalState === 'released';
    // A worker-show reply never carries helper outcomes, so the stored stop receipt is
    // the only helper evidence. A parent release alone must not override it: a helper
    // kept open or unconfirmed still runs, so the stop stays fenced and unsettled.
    const helpersUnresolved = receiptLeavesHelpersUnresolved(attempt.lastReceipt);
    const settled = released && !helpersUnresolved;
    // Anything less than parent plus helper release proof stays uncertain rather than
    // repeating or guessing at the original cancellation.
    const requestedStop = ['stop_pending', 'stop_unknown'].includes(attempt.state);
    return {
      ...attempt,
      state: requestedStop
        ? settled
          ? 'stopped'
          : 'stop_unknown'
        : attempt.state === 'stopped'
          ? 'stopped'
          : failureCount >= 3
            ? 'circuit_broken'
            : released && value.worker.state === 'failed'
              ? 'failed'
              : attempt.state,
      failureCount,
      resourceState: settled ? 'stopped' : resource?.state === 'owned' ? 'owned' : 'unknown',
      // Retain the stop receipt that names the unresolved helper; the observation
      // cannot replace it without losing the only proof of what is still running.
      lastReceipt: helpersUnresolved ? attempt.lastReceipt : reply.rawReceipt,
      observedAt: new Date().toISOString(),
    };
  }

  /** Read one bounded page; retain the returned source-pinned cursor verbatim. */
  async read(attempt: OrcaAttempt, cursor?: string): Promise<string> {
    const dispatchId = this.requireDispatch(attempt);
    const reply = await this.query(
      [
        'orchestration',
        'worker-read',
        '--dispatch',
        dispatchId,
        '--source',
        'auto',
        '--limit',
        '200',
        ...(cursor ? ['--cursor', cursor] : []),
      ],
      attempt.launch.projectRoot,
      attempt.context,
    );
    return reply.rawReceipt;
  }

  /** Request guarded cancellation; a closed terminal action alone is not exit proof. */
  async stop(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    if (attempt.state !== 'stop_pending' || attempt.stopRequestId) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'Stop must be durably reserved before it is sent.',
        'Inspect stop_unknown with worker-show; do not blindly repeat a stop.',
      );
    }
    // The reserved key makes the first send idempotent, so a lost reply reuses it.
    return this.stopCommand(attempt, attempt.stopRequestKey);
  }

  /** Recover a reserved or issued cancellation without sending an unkeyed second stop. */
  async replayStop(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    this.requireDispatch(attempt);
    const requestId = attempt.stopRequestKey ?? attempt.stopRequestId;
    if (!['stop_pending', 'stop_unknown'].includes(attempt.state) || !requestId) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'No replayable uncertain stop request is retained.',
        'Inspect the exact Dispatch and original stop receipt; never repeat an unkeyed stop.',
      );
    }
    await this.verifyRequest(attempt, requestId);
    return this.stopCommand(attempt, requestId);
  }

  private async stopCommand(attempt: OrcaAttempt, requestId?: string): Promise<OrcaAttempt> {
    const dispatchId = this.requireDispatch(attempt);
    try {
      await this.verifyRuntime(attempt.launch.projectRoot, attempt.context);
      const result = await this.invoke(
        [
          'orchestration',
          'worker-stop',
          '--dispatch',
          dispatchId,
          ...(requestId ? ['--retry-request', requestId] : []),
        ],
        attempt.launch.projectRoot,
      );
      const value = result.result;
      const confirmed =
        result.ok &&
        result._meta?.runtimeId === attempt.context.runtimeId &&
        value?.dispatchId === dispatchId &&
        value.state === 'stopped' &&
        value.processAction === 'closed_agent_terminal' &&
        !value.helperStopError &&
        value.helpers?.every((helper) => ['stopped', 'already_finished'].includes(helper.outcome));
      return {
        ...attempt,
        state: confirmed ? 'stopped' : 'stop_unknown',
        stopRequestId:
          attempt.stopRequestId ??
          (result._meta?.runtimeId === attempt.context.runtimeId
            ? (result.error?.data?.orchestrationRequestId ?? null)
            : null),
        resourceState: confirmed ? 'stopped' : 'unknown',
        lastReceipt: result.rawReceipt,
        lastError: result.error?.message ?? value?.lastError ?? null,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...attempt,
        state: 'stop_unknown',
        lastError: String(error),
        lastReceipt:
          error instanceof OrcaExecutionError
            ? (error.receipt ?? attempt.lastReceipt)
            : attempt.lastReceipt,
        observedAt: new Date().toISOString(),
      };
    }
  }

  private async startCommand(attempt: OrcaAttempt, requestId?: string): Promise<OrcaAttempt> {
    const launch = attempt.launch;
    this.validateLaunch(launch, attempt.context);
    if (launch.harness === 'kimi') {
      throw new OrcaExecutionError(
        'E_ORCA_HARNESS_UNSUPPORTED',
        'Kimi has no direct Orca launch route.',
        'Use a supervised terminal adoption path.',
      );
    }
    const binding = attempt.startBinding ?? attempt;
    if (
      attempt.startRequestKey &&
      (!binding.runId ||
        !binding.orcaTaskId ||
        !binding.retryOf ||
        binding.runId !== attempt.runId ||
        binding.orcaTaskId !== attempt.orcaTaskId ||
        binding.retryOf !== attempt.retryOf ||
        requestId !== attempt.startRequestKey ||
        (attempt.startRequestId !== null && attempt.startRequestId !== attempt.startRequestKey))
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'A reserved start key requires the original exact retry binding.',
        'Retain custody and inspect the reserved key, Run, Task and predecessor; never send an unkeyed replacement.',
      );
    }
    const args = [
      'orchestration',
      'worker-start',
      '--from',
      attempt.context.coordinatorHandle,
      '--worktree',
      attempt.workspaceSelector,
      '--agent',
      AGENTS[launch.harness],
      ...(binding.orcaTaskId
        ? ['--task', binding.orcaTaskId]
        : [
            '--spec-file',
            '-',
            '--task-title',
            `${launch.projectId}:${launch.taskId}:${launch.instanceId}`,
          ]),
      ...(binding.runId ? ['--run', binding.runId] : []),
      ...(binding.retryOf ? ['--retry-of', binding.retryOf] : []),
      ...(launch.model ? ['--model', launch.model] : []),
      ...(launch.effort ? ['--effort', launch.effort] : []),
      ...(requestId ? ['--retry-request', requestId] : []),
    ];
    try {
      await this.verifyRuntime(launch.projectRoot, attempt.context, launch.model !== undefined);
      const reply = await this.invoke(
        args,
        launch.projectRoot,
        binding.orcaTaskId ? undefined : launch.prompt,
      );
      if (
        !reply.ok &&
        reply.error?.code === 'agent_unconfigured' &&
        reply._meta?.runtimeId === attempt.context.runtimeId &&
        !binding.orcaTaskId &&
        !binding.retryOf &&
        !reply.error.data?.dispatchId &&
        !reply.result?.dispatchId &&
        !reply.result?.taskId &&
        !reply.result?.runId &&
        !reply.result?.run &&
        !reply.result?.failureCount &&
        !reply.result?.residualResources?.length &&
        (!reply.result?.effects?.length ||
          reply.result.effects.every(
            (effect) =>
              effect.kind === 'worktree' &&
              effect.action === 'reused' &&
              effect.id === attempt.workspaceId,
          ))
      ) {
        return {
          ...attempt,
          state: 'failed',
          resourceState: 'stopped',
          startRefusal: 'agent_unconfigured',
          startRequestId: reply.error.data?.orchestrationRequestId ?? null,
          lastReceipt: reply.rawReceipt,
          lastError: 'agent_unconfigured',
          observedAt: new Date().toISOString(),
        };
      }
      const value = reply.result;
      const workspace = value?.effects?.filter((effect) => effect.kind === 'worktree');
      const bound =
        reply._meta?.runtimeId === attempt.context.runtimeId &&
        value?.dispatchId &&
        value.taskId &&
        (value.runId || value.run?.id) &&
        value.dispatchId !== attempt.retryOf &&
        (!attempt.dispatchId || attempt.dispatchId === value.dispatchId) &&
        (!attempt.orcaTaskId || attempt.orcaTaskId === value.taskId) &&
        (!attempt.runId || attempt.runId === (value.runId ?? value.run?.id));
      const matches =
        bound &&
        workspace?.length === 1 &&
        workspace[0]?.id === attempt.workspaceId &&
        value.launch?.effective?.agent === AGENTS[launch.harness] &&
        (!launch.model || launch.model === value.launch.effective.model) &&
        (!launch.effort || launch.effort === value.launch.effective.effort);
      let state: OrcaAttempt['state'] = 'outcome_unknown';
      if (matches && reply.ok) {
        if (value.state === 'ready') state = 'ready';
        else if (
          value.state === 'outcome_unknown' &&
          (value.turnStart === 'unobserved' || value.stage === 'turn_start_unobserved')
        )
          state = 'turn_unobserved';
        else if (value.state === 'failed') state = 'failed';
      }
      const failureCount = Math.max(attempt.failureCount, value?.failureCount ?? 0);
      const pending = reply.error?.data;
      const recoveredDispatchId =
        !reply.ok &&
        reply.error?.code === 'operation_unknown' &&
        reply._meta?.runtimeId === attempt.context.runtimeId &&
        requestId &&
        requestId === (attempt.startRequestKey ?? attempt.startRequestId) &&
        pending?.requestId === requestId &&
        pending.orchestrationRequestId === requestId &&
        pending.dispatchId !== attempt.retryOf &&
        (!attempt.dispatchId || attempt.dispatchId === pending.dispatchId)
          ? pending.dispatchId
          : null;
      return {
        ...attempt,
        state: failureCount >= 3 ? 'circuit_broken' : state,
        runId: bound ? (value.runId ?? value.run?.id ?? null) : attempt.runId,
        orcaTaskId: bound ? (value.taskId ?? null) : attempt.orcaTaskId,
        dispatchId: bound
          ? (value.dispatchId ?? null)
          : (recoveredDispatchId ?? attempt.dispatchId),
        startRequestId:
          attempt.startRequestKey ??
          attempt.startRequestId ??
          (reply._meta?.runtimeId === attempt.context.runtimeId
            ? (reply.error?.data?.orchestrationRequestId ?? null)
            : null),
        failureCount,
        resourceState: matches && state === 'ready' ? 'owned' : 'unknown',
        lastReceipt: reply.rawReceipt,
        lastError:
          reply.error?.message ??
          value?.lastError ??
          (matches ? null : 'Receipt identity or effective harness is unproven'),
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...attempt,
        state: 'outcome_unknown',
        lastError: String(error),
        lastReceipt:
          error instanceof OrcaExecutionError
            ? (error.receipt ?? attempt.lastReceipt)
            : attempt.lastReceipt,
        observedAt: new Date().toISOString(),
      };
    }
  }

  private async verifyRequest(attempt: OrcaAttempt, requestId: string): Promise<void> {
    await this.verifyRuntime(attempt.launch.projectRoot, attempt.context);
    const receipt = await this.query(
      ['orchestration', 'request-show', '--request', requestId],
      attempt.launch.projectRoot,
      attempt.context,
    );
    // Reserved keys keep their identity; Orca atomically refuses a second mutation
    // even if its receipt was pruned, so an absent receipt is never proof of absence.
    const reserved = requestId === attempt.startRequestKey || requestId === attempt.stopRequestKey;
    const states = reserved ? ['pending', 'completed', 'absent'] : ['pending', 'completed'];
    if (receipt.result?.requestId !== requestId || !states.includes(receipt.result.state ?? '')) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'Request absence or a mismatched receipt does not prove that nothing happened.',
        'Retain custody and inspect the original request on its original runtime and caller.',
      );
    }
  }

  private requireDispatch(attempt: OrcaAttempt): string {
    if (!attempt.dispatchId || !attempt.runId || !attempt.orcaTaskId) {
      throw new OrcaExecutionError(
        'E_ORCA_IDENTITY',
        'No complete Dispatch binding is available.',
        'Recover the issued start request, retaining the pending worker record and claim.',
      );
    }
    return attempt.dispatchId;
  }

  private async verifyRuntime(
    cwd: string,
    context: OrcaContext,
    modelRequested = false,
  ): Promise<void> {
    const reply = await this.query(['status'], cwd, context);
    const runtime = reply.result?.runtime;
    if (
      !runtime?.reachable ||
      runtime.state !== 'ready' ||
      runtime.runtimeId !== context.runtimeId ||
      !runtime.capabilities.includes('orchestration.contract.v1') ||
      (modelRequested &&
        !runtime.capabilities.includes('orchestration.worker-launch-preferences.v1'))
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        'The selected Orca runtime is unavailable or changed.',
        'Inspect Orca status and retain unresolved attempts; explicitly reconcile their original runtime before relaunch.',
      );
    }
  }

  private async query(
    args: string[],
    cwd: string,
    context: OrcaContext,
  ): Promise<OrcaCommandReply> {
    const reply = await this.invoke(args, cwd);
    if (!reply.ok || reply._meta?.runtimeId !== context.runtimeId) {
      throw new OrcaExecutionError(
        'E_ORCA_CONTEXT',
        reply.error?.message ?? 'Orca returned an unproven runtime identity.',
        'Inspect the explicitly selected runtime; preserve pending operations and do not fall back to a native launch.',
      );
    }
    return reply;
  }

  private async invoke(args: string[], cwd: string, input?: string): Promise<OrcaCommandReply> {
    const result: OrcaCommandResult = await this.runner(
      this.executable,
      [
        ...args,
        '--environment',
        'local',
        '--json',
        ...(args[0] === 'orchestration' ? ['--full'] : []),
      ],
      cwd,
      input,
    );
    try {
      return { ...orcaReplySchema.parse(JSON.parse(result.stdout)), rawReceipt: result.stdout };
    } catch {
      throw new OrcaExecutionError(
        'E_ORCA_RECEIPT',
        'Orca returned no parseable receipt.',
        'Preserve pending custody and inspect the original operation; a CLI exit is not worker exit proof.',
        result.stdout,
      );
    }
  }
}
