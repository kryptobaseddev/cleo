/**
 * Local Orca execution, with no task-store, claim or filesystem disposal authority.
 * @packageDocumentation
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  OrcaAttempt,
  OrcaCommandReply,
  OrcaCommandResult,
  OrcaCommandRunner,
  OrcaContext,
  OrcaDiscovery,
  OrcaLaunch,
  OrcaLeadTerminal,
  OrcaLeadTerminalLaunch,
  OrcaReply,
  OrcaReportSource,
  OrcaRoutingAdapter,
  OrcaWorkerDone,
} from '@cleocode/contracts/orca-execution.js';
import {
  ORCA_LEAD_LAUNCH_REFUSAL,
  orcaAccountReplySchema,
  orcaCommandRegistrySchema,
  orcaContextSchema,
  orcaLaunchSchema,
  orcaReplySchema,
  orcaReportMessageSchema,
  orcaReportSourceSchema,
  orcaWorkerDonePayloadSchema,
} from '@cleocode/contracts/orca-execution.js';

const AGENTS = { 'claude-code': 'claude', codex: 'codex', opencode: 'opencode2', grok: 'grok' };
const MAX_DIAGNOSTIC_LENGTH = 4_096;
const MAX_RECEIPT_LENGTH = 65_536;
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

/** Runtime capability proving worker-stop enumerates every helper it stopped. */
const HELPER_STOP_CAPABILITY = 'orchestration.worker-stop-helpers.v1';

/** Bounded creator chain walk; a helper nested under another helper needs its own link. */
const HELPER_ANCESTRY_LIMIT = 8;

/**
 * What a stored receipt proves about the helpers a stopped worker started.
 * @remarks `settled` is affirmative evidence that no helper is still running;
 * `absent` is no trustworthy evidence at all (lost, malformed or non-stop
 * receipt); `empty` is a stop reply that listed no helpers; `unresolved` names
 * the helper Dispatches a stop reply could not settle.
 */
type HelperEvidence =
  | { readonly kind: 'absent' }
  | { readonly kind: 'empty' }
  | { readonly kind: 'settled' }
  | {
      readonly kind: 'unresolved';
      readonly dispatchIds: readonly string[];
      readonly reconcileable: boolean;
    };

/**
 * Read the helper evidence a stored receipt carries for exactly this attempt.
 * @remarks Only a stop reply speaks about helpers, and only a listing of each
 * helper proves it stopped. A lost, malformed or non-stop receipt is `absent`,
 * which never settles a stop. A receipt that belongs to another attempt (another
 * Dispatch, Run, runtime epoch or stop request key) is `absent` too, so a
 * mismatched stop reply can never be promoted later by a parent release. A stop
 * reply's `helperStopError` means the tree may be incomplete, so it is `absent`.
 * @param attempt - The attempt whose stop the retained receipt would settle.
 * @param receipt - Last stored raw receipt, or null when none was retained.
 * @returns The evidence class and any helper Dispatch ids still unresolved.
 * @example
 * ```ts
 * readHelperEvidence(attempt, '{"ok":true,"result":{"dispatchId":"ctx_1","processAction":"closed_agent_terminal","helpers":[],"mutation":{"requestId":"<issued stop key>"}}}');
 * ```
 */
function readHelperEvidence(attempt: OrcaAttempt, receipt: string | null): HelperEvidence {
  if (!receipt) return { kind: 'absent' };
  let reply: OrcaReply;
  try {
    const parsed = orcaReplySchema.safeParse(JSON.parse(receipt));
    if (!parsed.success) return { kind: 'absent' };
    reply = parsed.data;
  } catch {
    return { kind: 'absent' };
  }
  if (!receiptBelongsToAttempt(attempt, reply)) return { kind: 'absent' };
  const value = reply.result;
  const stopReply =
    value !== undefined &&
    (value.processAction !== undefined ||
      value.helpers !== undefined ||
      value.helperStopError !== undefined);
  if (!value || !stopReply) return { kind: 'absent' };
  if (value.helperStopError) return { kind: 'absent' };
  // A stop reply that omits the helper list enumerated nothing this client can read.
  if (value.helpers === undefined) return { kind: 'empty' };
  const unresolved = value.helpers.filter((helper) => !SETTLED_HELPER_OUTCOMES.has(helper.outcome));
  if (unresolved.length === 0) return { kind: 'settled' };
  return {
    kind: 'unresolved',
    dispatchIds: [
      ...new Set(
        unresolved
          .map((helper) => helper.dispatchId)
          .filter((dispatchId): dispatchId is string => dispatchId !== undefined),
      ),
    ],
    reconcileable: unresolved.every((helper) => helper.dispatchId !== undefined),
  };
}

/**
 * Prove a retained reply was produced by this attempt's own mutation.
 * @remarks The runtime epoch, target Dispatch, Run (when the reply names one)
 * and the issued stop request key must all match the stored binding. A refusal
 * names the key under `error.data.orchestrationRequestId`; a successful mutation
 * names it under `result.mutation.requestId` (installed Orca stamps the ledger
 * identity on every successful result), so a successful receipt with no key or
 * another attempt's key is never evidence either. Anything that fails is another
 * attempt's receipt and never evidence.
 * @param attempt - The attempt the receipt is being read for.
 * @param reply - Parsed reply from the retained receipt.
 * @returns True only when every identity the reply carries matches this attempt.
 */
function receiptBelongsToAttempt(attempt: OrcaAttempt, reply: OrcaReply): boolean {
  if (reply._meta?.runtimeId !== attempt.context.runtimeId) return false;
  const value = reply.result;
  const dispatchId = value?.dispatchId ?? reply.error?.data?.dispatchId;
  if (!attempt.dispatchId || dispatchId !== attempt.dispatchId) return false;
  if (value?.runId !== undefined && value.runId !== attempt.runId) return false;
  const refusedKey = reply.error?.data?.orchestrationRequestId;
  if (refusedKey !== undefined) return stopsThisAttempt(attempt, refusedKey);
  if (reply.ok) {
    // A successful mutation always carries its ledger key; only the stop key this
    // attempt issued may settle it, so another mutation on the same Dispatch cannot.
    const succeededKey = value?.mutation?.requestId;
    return succeededKey !== undefined && stopsThisAttempt(attempt, succeededKey);
  }
  return true;
}

/**
 * Compare a reply's request key with the stop key this attempt issued.
 * @param attempt - The attempt whose stop key would be settled.
 * @param requestId - Request key the reply reports.
 * @returns True when the reply belongs to this attempt's own stop request.
 */
function stopsThisAttempt(attempt: OrcaAttempt, requestId: string): boolean {
  return requestId === attempt.stopRequestKey || requestId === attempt.stopRequestId;
}

/** Actionable refusal; callers must retain any attempt already sent to Orca. */
export class OrcaExecutionError extends Error {
  /** Numeric CLI refusal status, independent of a worker's exit. */
  readonly exitCode = 63;
  /** Stable refusal code. */
  readonly code: string;
  /** Recovery instruction that never disables the lead policy. */
  readonly fix: string;
  /** Bounded original receipt, when available; oversized receipts are diagnostic only. */
  readonly receipt: string | null;

  /** Construct a refusal before any unsupported operation runs. */
  constructor(code: string, message: string, fix: string, receipt: string | null = null) {
    super(message.slice(0, MAX_DIAGNOSTIC_LENGTH));
    this.name = 'OrcaExecutionError';
    this.code = code;
    this.fix = fix;
    const truncated = '[truncated]\n';
    this.receipt =
      receipt !== null && receipt.length > MAX_RECEIPT_LENGTH
        ? truncated + receipt.slice(0, MAX_RECEIPT_LENGTH - truncated.length)
        : receipt;
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
  /** Worker launch APIs cannot enforce denied tools or a strict MCP allowlist. */
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

  /**
   * Host Claude Code's prepared guard argv in a local Orca terminal. The shell
   * waits for a private release file, so a missing receipt, wrong runtime or
   * disconnected owner terminal cannot start a model turn. Never retry create.
   * @param launch - The provider's guarded command and private startup directory.
   * @param onStarted - Persists the PID before any model turn is allowed.
   * @returns The verified terminal handle and provider PID.
   */
  async startLead(
    launch: OrcaLeadTerminalLaunch,
    onStarted: (pid: number) => void,
  ): Promise<OrcaLeadTerminal> {
    const refuse = (message: string) =>
      new OrcaExecutionError(
        ORCA_LEAD_LAUNCH_REFUSAL.code,
        message,
        'Restore a connected local Orca terminal and use --adapter claude-code; keep orchestrate.leadWorker.v1 enabled.',
      );
    const handle = process.env.ORCA_TERMINAL_HANDLE;
    if (
      process.platform === 'win32' ||
      !handle ||
      !isAbsolute(launch.command) ||
      !isAbsolute(launch.tempDir) ||
      !launch.env.CLEO_SESSION_ID ||
      !launch.env.CLEO_AGENT_ID ||
      launch.env.CLEO_AGENT_ROLE !== 'lead'
    ) {
      throw refuse(
        'The guarded Orca lead requires a local POSIX terminal and an absolute provider binary.',
      );
    }
    const registryResult = await this.runner(
      this.executable,
      ['agent-context', '--json'],
      launch.cwd,
    );
    const registry = orcaCommandRegistrySchema.parse(JSON.parse(registryResult.stdout));
    const create = registry.commands.find((entry) => entry.command === 'terminal create');
    const show = registry.commands.find((entry) => entry.command === 'terminal show');
    if (
      registryResult.exitCode !== 0 ||
      !create ||
      !['command', 'worktree', 'title', 'environment'].every((flag) =>
        create.flags.includes(flag),
      ) ||
      !show ||
      !['terminal', 'environment'].every((flag) => show.flags.includes(flag))
    ) {
      throw refuse('Orca does not declare the guarded terminal command transport.');
    }
    const status = await this.invoke(['status'], launch.cwd);
    const runtimeId = status._meta?.runtimeId;
    if (!status.ok || !runtimeId) throw refuse('Orca did not prove a local runtime.');
    const context: OrcaContext = { runtimeId, coordinatorHandle: handle, executionHostId: 'local' };
    await this.verifyRuntime(launch.cwd, context);
    const caller = (
      await this.query(['terminal', 'show', '--terminal', handle], launch.cwd, context)
    ).result?.terminal;
    const workspace = (
      await this.query(
        ['worktree', 'show', '--worktree', `path:${launch.cwd}`],
        launch.cwd,
        context,
      )
    ).result?.worktree;
    if (
      caller?.handle !== handle ||
      !caller.connected ||
      !caller.writable ||
      caller.executionHostId !== 'local' ||
      !workspace ||
      workspace.path !== launch.cwd ||
      workspace.hostId !== 'local'
    ) {
      throw refuse('Orca did not prove the local caller and existing lead workspace.');
    }

    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    for (const key of Object.keys(launch.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw refuse('Invalid lead environment key.');
    }
    const dir = await mkdtemp(join(launch.tempDir, 'orca-terminal-'));
    const script = join(dir, 'launch.sh');
    const pidFile = join(dir, 'pid');
    const release = join(dir, 'release');
    try {
      await writeFile(
        script,
        [
          '#!/bin/sh',
          'umask 077',
          `trap ${quote(`rm -rf -- ${quote(dir)}`)} EXIT`,
          `printf '%s' "$$" > ${quote(pidFile)}`,
          'attempt=0',
          `while [ ! -f ${quote(release)} ]; do`,
          '  attempt=$((attempt + 1)); [ "$attempt" -le 600 ] || exit 1',
          '  sleep 0.1',
          'done',
          `cd ${quote(launch.cwd)} || exit 1`,
          ...Object.entries(launch.env).map(([key, value]) => `export ${quote(`${key}=${value}`)}`),
          `exec ${[launch.command, ...launch.args].map(quote).join(' ')}`,
          '',
        ].join('\n'),
        { mode: 0o600 },
      );
      const created = await this.query(
        [
          'terminal',
          'create',
          '--worktree',
          workspace.address?.worktree ?? `id:${workspace.id}`,
          '--title',
          'CLEO no-hands lead',
          '--command',
          `exec /bin/sh ${quote(script)}`,
        ],
        launch.cwd,
        context,
      );
      const terminal = created.result?.terminal;
      if (
        !terminal ||
        terminal.handle === handle ||
        terminal.executionHostId !== 'local' ||
        terminal.surface !== 'visible' ||
        terminal.hostPlatform !== process.platform
      ) {
        throw refuse('Orca returned no new local lead terminal; its first-turn gate stays closed.');
      }
      let pid = 0;
      for (let attempt = 0; attempt < 100; attempt++) {
        const text = await readFile(pidFile, 'utf8').catch(() => '');
        if (/^[1-9][0-9]*$/.test(text)) {
          pid = Number(text);
          break;
        }
        await delay(100);
      }
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== terminal.processId) {
        throw refuse('The guarded terminal supervisor did not prove its startup PID.');
      }
      const owner = (
        await this.query(['terminal', 'show', '--terminal', terminal.handle], launch.cwd, context)
      ).result?.terminal;
      if (
        owner?.handle !== terminal.handle ||
        !owner.connected ||
        !owner.writable ||
        owner.executionHostId !== 'local' ||
        owner.worktreePath !== launch.cwd
      ) {
        throw refuse('The lead has no verified owner terminal; its first-turn gate stays closed.');
      }
      onStarted(pid);
      await writeFile(`${release}.tmp`, '', { mode: 0o600 });
      await rename(`${release}.tmp`, release);
      return { runtimeId, terminalHandle: terminal.handle, pid };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
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
        ORCA_LEAD_LAUNCH_REFUSAL.code,
        ORCA_LEAD_LAUNCH_REFUSAL.message,
        ORCA_LEAD_LAUNCH_REFUSAL.fix,
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

  /** Replay an issued or pre-reserved launch key on the same runtime and caller. */
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

  /**
   * Inspect exactly this attempt, settling a reserved stop only on release proof.
   * @remarks A stop settles only when the parent's exact release and affirmative
   * helper evidence agree. A lost, malformed or non-stop receipt is never helper
   * evidence; each helper the receipt names is re-read from Orca, so one that
   * finishes later can still settle the stop.
   */
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
    // A worker-show reply never carries helper outcomes, so only a stop receipt can
    // name the helpers this worker started. A parent release alone must never override
    // that evidence: a helper kept open or unconfirmed still runs, so the stop stays
    // fenced and unsettled.
    const requestedStop = ['stop_pending', 'stop_unknown'].includes(attempt.state);
    const helpersSettled =
      !requestedStop ||
      (released &&
        (await this.helpersAffirmativelyStopped(
          attempt,
          readHelperEvidence(attempt, attempt.lastReceipt),
        )));
    const settled = released && helpersSettled;
    // Anything less than parent plus helper release proof stays uncertain rather than
    // repeating or guessing at the original cancellation. The stop receipt keeps the
    // only proof of what is still running, so it is replaced only once the stop settles.
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
      lastReceipt: requestedStop && !settled ? attempt.lastReceipt : reply.rawReceipt,
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

  /** Fetch one full report pointer after a wake; never acknowledge or poll coordinator mail. */
  async readReport(attempt: OrcaAttempt, messageId: string): Promise<OrcaWorkerDone> {
    const dispatchId = this.requireDispatch(attempt);
    const { runId, orcaTaskId } = attempt;
    if (!runId || !orcaTaskId) {
      throw new OrcaExecutionError(
        'E_ORCA_IDENTITY',
        'No complete report binding is stored.',
        'Recover the original start receipt before ingesting a worker report.',
      );
    }
    let message: ReturnType<typeof orcaReportMessageSchema.parse> | undefined;
    let source: OrcaReportSource | undefined;
    let exhausted = false;
    // shortcut: Orca has no inbox cursor; widen up to 12,800 rows until it offers paging or exact lookup.
    for (let limit = 200; limit <= 12_800; limit *= 2) {
      source = await this.reportSource(
        ['orchestration', 'inbox', '--terminal', `run:${runId}`, '--limit', String(limit)],
        attempt,
      );
      const rows = source.result.messages ?? [];
      const row = rows.find(
        (entry) =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          entry.id === messageId,
      );
      if (row) {
        const parsed = orcaReportMessageSchema.safeParse(row);
        if (!parsed.success) {
          throw this.reportSourceRefusal(
            source.command,
            `The requested inbox row is malformed: ${parsed.error.message}`,
            'Inspect the exact message in the original full Run inbox and restore its transport fields before retrying.',
          );
        }
        message = parsed.data;
        break;
      }
      exhausted = rows.length < limit;
      if (exhausted) break;
    }
    if (!message || !source) {
      throw new OrcaExecutionError(
        'E_ORCA_REPORT_SOURCE',
        exhausted
          ? `Message ${messageId} is absent from the exhausted Run inbox.`
          : `The Run inbox lookup reached 12,800 messages without finding ${messageId}; older history remains unsearched.`,
        exhausted
          ? `Inspect orca orchestration inbox --terminal run:${runId} --limit 12800 --environment local --json --full and use the original worker_done id for this Run.`
          : `Inspect orca orchestration inbox --terminal run:${runId} --limit 25600 --environment local --json --full for the exact id; update Orca to support paged or exact lookup before retrying older history. Retain the worker record.`,
      );
    }
    if (
      message.type !== 'worker_done' ||
      message.delivery_contract !== 'current_delivery' ||
      message.run_id !== runId ||
      message.to_handle !== `run:${runId}`
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_REPORT_SOURCE',
        'The requested message is not a current worker_done for this Run.',
        'Use the exact worker_done id from the original Run; a wake or prose body is not a report.',
      );
    }
    let payload: ReturnType<typeof orcaWorkerDonePayloadSchema.parse>;
    try {
      payload = orcaWorkerDonePayloadSchema.parse(JSON.parse(message.payload ?? 'null'));
    } catch (error) {
      throw this.reportSourceRefusal(
        source.command,
        `worker_done has no valid report-path payload: ${error instanceof Error ? error.message : String(error)}`,
        'Supply the original canonical report through worker_done --report-path.',
      );
    }
    if (payload.taskId !== orcaTaskId || payload.dispatchId !== dispatchId) {
      throw new OrcaExecutionError(
        'E_ORCA_REPORT_IDENTITY',
        'The report pointer does not match this exact Task and Dispatch.',
        'Retain stale delivery as history; use the current worker record and its report-path.',
      );
    }
    const current = await this.reportSource(
      [
        'orchestration',
        'dispatch-show',
        '--task',
        orcaTaskId,
        '--from',
        attempt.context.coordinatorHandle,
      ],
      attempt,
    );
    const dispatch = current.result.dispatch;
    if (
      dispatch?.id !== dispatchId ||
      dispatch.run_id !== runId ||
      dispatch.task_id !== orcaTaskId ||
      dispatch.status !== 'completed' ||
      !(
        message.from_handle === dispatch.assignee_handle ||
        (message.sender_pane_key && message.sender_pane_key === dispatch.assignee_pane_key)
      )
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_REPORT_IDENTITY',
        'The current Dispatch and its report sender are unproven or unsettled.',
        'Inspect the exact current Dispatch; old, cancelled or superseded deliveries cannot settle this worker.',
      );
    }
    return {
      messageId,
      runtimeId: attempt.context.runtimeId,
      runId,
      orcaTaskId,
      dispatchId,
      senderHandle: message.from_handle,
      outcome: payload.outcome,
      body: message.body,
      reportPath: payload.reportPath,
    };
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

  /**
   * Recover a reserved or issued cancellation without sending an unkeyed second stop.
   * @remarks A completed key replays Orca's recorded outcome, which cannot reflect a
   * helper that finished after the original stop; `show` reconciles those helpers.
   */
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
      const capabilities = await this.verifyRuntime(attempt.launch.projectRoot, attempt.context);
      await this.show(attempt);
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
      // An omitted helper list is affirmative only when this runtime enumerates the
      // helper tree; otherwise helpers could still run and the stop stays unknown.
      const helpersStopped =
        value?.helpers !== undefined
          ? value.helpers.every((helper) => SETTLED_HELPER_OUTCOMES.has(helper.outcome))
          : capabilities.includes(HELPER_STOP_CAPABILITY);
      const confirmed =
        result.ok &&
        result._meta?.runtimeId === attempt.context.runtimeId &&
        value?.dispatchId === dispatchId &&
        value.state === 'stopped' &&
        value.processAction === 'closed_agent_terminal' &&
        !value.helperStopError &&
        helpersStopped;
      return {
        ...attempt,
        state: confirmed ? 'stopped' : 'stop_unknown',
        stopRequestId:
          attempt.stopRequestId ??
          (result._meta?.runtimeId === attempt.context.runtimeId
            ? (result.error?.data?.orchestrationRequestId ?? null)
            : null),
        // Record that this runtime enumerated helpers, so an omitted list in its reply
        // is latent affirmative evidence rather than an unknown helper tree. Only a
        // proven stopped parent from this exact runtime, Dispatch and request can prove
        // it cannot start a new helper after this reply.
        stopHelperEvidence:
          confirmed && value?.helpers === undefined ? 'enumerated' : attempt.stopHelperEvidence,
        resourceState: confirmed ? 'stopped' : 'unknown',
        lastReceipt: result.rawReceipt,
        lastError: result.error?.message ?? value?.lastError ?? null,
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        ...attempt,
        state: 'stop_unknown',
        lastError: String(error).slice(0, MAX_DIAGNOSTIC_LENGTH),
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
      (!attempt.startBinding ||
        (binding.retryOf !== null && (!binding.runId || !binding.orcaTaskId)) ||
        (binding.runId !== null && binding.runId !== attempt.runId) ||
        (binding.orcaTaskId !== null && binding.orcaTaskId !== attempt.orcaTaskId) ||
        binding.retryOf !== attempt.retryOf ||
        requestId !== attempt.startRequestKey ||
        (attempt.startRequestId !== null && attempt.startRequestId !== attempt.startRequestKey))
    ) {
      throw new OrcaExecutionError(
        'E_ORCA_ATTEMPT_FENCED',
        'A reserved start key requires the original exact launch binding.',
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
        requestId &&
        [
          reply.result?.requestId,
          reply.result?.mutation?.requestId,
          reply.error?.data?.requestId,
          reply.error?.data?.orchestrationRequestId,
        ].some((returnedId) => returnedId !== undefined && returnedId !== requestId)
      ) {
        throw new OrcaExecutionError(
          'E_ORCA_REQUEST_MISMATCH',
          'Orca returned a different start request id from the reserved or issued key.',
          'Retain custody and inspect the original request on its original runtime; do not adopt this receipt or start a replacement.',
          reply.rawReceipt,
        );
      }
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
          startRequestId: requestId ?? reply.error.data?.orchestrationRequestId ?? null,
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
      if (error instanceof OrcaExecutionError && error.code === 'E_ORCA_REQUEST_MISMATCH')
        throw error;
      return {
        ...attempt,
        state: 'outcome_unknown',
        lastError: String(error).slice(0, MAX_DIAGNOSTIC_LENGTH),
        lastReceipt:
          error instanceof OrcaExecutionError
            ? (error.receipt ?? attempt.lastReceipt)
            : attempt.lastReceipt,
        observedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Decide whether current Orca evidence proves every helper stopped or finished.
   * @remarks An absent receipt or an incomplete helper tree never settles; a
   * listed helper is settled only by its own exact Dispatch showing an exited
   * process. A completed stop key replays its recorded outcome, so unresolved
   * helpers are re-read rather than replayed.
   */
  private async helpersAffirmativelyStopped(
    attempt: OrcaAttempt,
    evidence: HelperEvidence,
  ): Promise<boolean> {
    switch (evidence.kind) {
      case 'settled':
        return true;
      case 'absent':
        return false;
      case 'empty':
        // Only a stop reply from a runtime that proved it enumerates helpers turns an
        // omitted list into affirmative "this worker started no helper" evidence.
        return attempt.stopHelperEvidence === 'enumerated';
      case 'unresolved': {
        if (!evidence.reconcileable) return false;
        for (const helperDispatchId of evidence.dispatchIds) {
          if (!(await this.helperFinished(attempt, helperDispatchId))) return false;
        }
        return true;
      }
    }
  }

  /**
   * Prove one helper Dispatch's process exited under this exact attempt's ancestry.
   * @remarks A helper counts only when its own Dispatch is on this Run and runtime,
   * its process exited, and its creator chain reaches this attempt's Dispatch. An
   * unrelated helper in the same Run therefore never settles this stop.
   */
  private async helperFinished(attempt: OrcaAttempt, helperDispatchId: string): Promise<boolean> {
    const observation = await this.exactWorkerObservation(attempt, helperDispatchId);
    if (
      !observation ||
      observation.observation?.exactWorker !== true ||
      observation.observation.status !== 'exited'
    ) {
      return false;
    }
    return this.descendsFromAttempt(attempt, observation.dispatch?.creatorDispatchId ?? null);
  }

  /** Walk the bounded creator chain of a helper back to this attempt's Dispatch. */
  private async descendsFromAttempt(
    attempt: OrcaAttempt,
    creatorDispatchId: string | null,
  ): Promise<boolean> {
    let creator = creatorDispatchId;
    for (let hop = 0; hop < HELPER_ANCESTRY_LIMIT; hop += 1) {
      if (creator === attempt.dispatchId) return true;
      if (!creator) return false;
      const parent = await this.exactWorkerObservation(attempt, creator);
      creator = parent?.dispatch?.creatorDispatchId ?? null;
    }
    return false;
  }

  /** Read one exact worker observation, refusing any other Dispatch, Run or epoch. */
  private async exactWorkerObservation(
    attempt: OrcaAttempt,
    dispatchId: string,
  ): Promise<OrcaReply['result'] | null> {
    const reply = await this.query(
      ['orchestration', 'worker-show', '--dispatch', dispatchId],
      attempt.launch.projectRoot,
      attempt.context,
    ).catch(() => null);
    const value = reply?.result;
    if (
      !value?.dispatch ||
      !value.worker ||
      value.dispatch.id !== dispatchId ||
      value.dispatch.runId !== attempt.runId ||
      value.worker.dispatchId !== dispatchId ||
      value.worker.runtimeEpoch !== attempt.context.runtimeId
    ) {
      return null;
    }
    return value;
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
  ): Promise<string[]> {
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
    return runtime.capabilities;
  }

  private async reportSource(args: string[], attempt: OrcaAttempt): Promise<OrcaReportSource> {
    const reply = await this.runner(
      this.executable,
      [...args, '--environment', 'local', '--json', '--full'],
      attempt.launch.projectRoot,
    );
    try {
      const source = orcaReportSourceSchema.parse(JSON.parse(reply.stdout));
      if (reply.exitCode !== 0)
        throw new Error('The report source command did not exit successfully.');
      if (source._meta.runtimeId !== attempt.context.runtimeId)
        throw new Error(
          `Report source runtime ${source._meta.runtimeId} differs from ${attempt.context.runtimeId}.`,
        );
      if (args[1] === 'inbox' && !source.result.messages)
        throw new Error('The Run inbox omitted its messages array.');
      return { ...source, command: reply };
    } catch (error) {
      throw this.reportSourceRefusal(
        reply,
        error instanceof Error ? error.message : String(error),
        'Inspect the original runtime and full Run inbox; retain the worker record.',
      );
    }
  }

  private reportSourceRefusal(
    command: OrcaCommandResult,
    issues: string,
    fix: string,
  ): OrcaExecutionError {
    return new OrcaExecutionError(
      'E_ORCA_REPORT_SOURCE',
      `Orca returned no verified report source: ${JSON.stringify({
        exitCode: command.exitCode,
        stderr: command.stderr.slice(0, MAX_DIAGNOSTIC_LENGTH / 2),
        issues: issues.slice(0, MAX_DIAGNOSTIC_LENGTH / 2),
      })}`,
      fix,
      command.stdout,
    );
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
    if (result.stdout.length > MAX_RECEIPT_LENGTH) {
      throw new OrcaExecutionError(
        'E_ORCA_RECEIPT',
        'Orca returned an oversized receipt; its retained prefix is diagnostic only.',
        'Inspect the full original operation in Orca; retain custody until a bounded exact receipt can be verified.',
        result.stdout,
      );
    }
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
