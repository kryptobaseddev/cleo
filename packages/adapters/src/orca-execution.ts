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
  OrcaLaunch,
} from '@cleocode/contracts/orca-execution.js';
import {
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
  'worktree show': ['worktree'],
};

/** Actionable refusal; callers must retain any attempt already sent to Orca. */
export class OrcaExecutionError extends Error {
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
export class OrcaExecutionBackend {
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
    const registry = orcaCommandRegistrySchema.parse(JSON.parse(registryResult.stdout));
    for (const [command, flags] of Object.entries(REQUIRED_COMMANDS)) {
      const declared = registry.commands.find((entry) => entry.command === command);
      if (
        registryResult.exitCode !== 0 ||
        !declared ||
        flags.some((flag) => !declared.flags.includes(flag))
      ) {
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
    );
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
    if (attempt.state !== 'launching' || attempt.failureCount >= 3) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'This attempt cannot start another worker.',
        'Inspect the stored exact Dispatch; recover an uncertain request by its issued id.',
      );
    }
    return this.startCommand(attempt);
  }

  /** Recover only an issued request on the same runtime/caller, never a fresh start. */
  async replayStart(attempt: OrcaAttempt): Promise<OrcaAttempt> {
    if (
      attempt.state !== 'outcome_unknown' ||
      !attempt.startRequestId ||
      attempt.failureCount >= 3
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'No replayable uncertain start request is retained.',
        'Inspect the original operation; never substitute a fresh Run, Task or launch.',
      );
    }
    const receipt = await this.query(
      ['orchestration', 'request-show', '--request', attempt.startRequestId],
      attempt.launch.projectRoot,
      attempt.context,
    );
    if (!['pending', 'completed'].includes(receipt.result?.state ?? '')) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'Request absence does not prove that nothing launched.',
        'Retain the claim and inspect the exact original operation before owner-directed recovery.',
      );
    }
    return this.startCommand(attempt, attempt.startRequestId);
  }

  /** Inspect exactly this attempt, preserving uncertain stop and resource custody. */
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
    return {
      ...attempt,
      state: ['stop_pending', 'stop_unknown', 'stopped'].includes(attempt.state)
        ? attempt.state
        : failureCount >= 3
          ? 'circuit_broken'
          : attempt.state,
      failureCount,
      resourceState: value.projection?.resource?.state ?? 'unknown',
      lastReceipt: reply.rawReceipt,
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
    const dispatchId = this.requireDispatch(attempt);
    if (attempt.state !== 'stop_pending') {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'Stop must be durably reserved before it is sent.',
        'Inspect stop_unknown with worker-show; do not blindly repeat a stop.',
      );
    }
    try {
      await this.verifyRuntime(attempt.launch.projectRoot, attempt.context);
      const result = await this.invoke(
        ['orchestration', 'worker-stop', '--dispatch', dispatchId],
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
        stopRequestId: result.error?.data?.orchestrationRequestId ?? attempt.stopRequestId,
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
    const args = [
      'orchestration',
      'worker-start',
      '--from',
      attempt.context.coordinatorHandle,
      '--worktree',
      attempt.workspaceSelector,
      '--agent',
      AGENTS[launch.harness],
      ...(attempt.orcaTaskId
        ? ['--task', attempt.orcaTaskId]
        : [
            '--spec-file',
            '-',
            '--task-title',
            `${launch.projectId}:${launch.taskId}:${launch.instanceId}`,
          ]),
      ...(attempt.runId ? ['--run', attempt.runId] : []),
      ...(attempt.retryOf ? ['--retry-of', attempt.retryOf] : []),
      ...(launch.model ? ['--model', launch.model] : []),
      ...(launch.effort ? ['--effort', launch.effort] : []),
      ...(requestId ? ['--retry-request', requestId] : []),
    ];
    try {
      await this.verifyRuntime(launch.projectRoot, attempt.context, launch.model !== undefined);
      const reply = await this.invoke(
        args,
        launch.projectRoot,
        attempt.orcaTaskId ? undefined : launch.prompt,
      );
      const value = reply.result;
      const workspace = value?.effects?.filter((effect) => effect.kind === 'worktree');
      const bound =
        reply._meta?.runtimeId === attempt.context.runtimeId &&
        value?.dispatchId &&
        value.taskId &&
        (value.runId || value.run?.id) &&
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
      return {
        ...attempt,
        state: failureCount >= 3 ? 'circuit_broken' : state,
        runId: bound ? (value.runId ?? value.run?.id ?? null) : attempt.runId,
        orcaTaskId: bound ? (value.taskId ?? null) : attempt.orcaTaskId,
        dispatchId: bound ? (value.dispatchId ?? null) : attempt.dispatchId,
        startRequestId: reply.error?.data?.orchestrationRequestId ?? attempt.startRequestId,
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
