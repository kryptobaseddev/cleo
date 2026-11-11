/**
 * Durable policy for prepared Orca assignments; no lifecycle settlement at launch.
 * @packageDocumentation
 */
import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  type OrcaAttempt,
  type OrcaContext,
  type OrcaExecutionAdapter,
  type OrcaLaunch,
  type OrcaWorkerRequest,
  orcaLaunchSchema,
  orcaWorkerRequestSchema,
} from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { readWorktreeTaskLock } from '@cleocode/worktree';
import { type EngineResult, engineError } from '../engine-result.js';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { isLiveClaim } from '../store/task-claim.js';
import {
  listWorkerRecords,
  newWorkerInstanceId,
  recordWorker,
  updateWorkerExecution,
  type WorkerRecord,
} from './worker-records.js';

/**
 * Launch a payload already prepared once by CLEO's canonical spawn path. The
 * worker claim and worktree lock remain held on every uncertain outcome.
 * Routing consumes this primitive; final report settlement remains separate.
 * @remarks Consumes canonical preparation once; never provisions another checkout.
 * @param input - Prepared task, prompt, session and worktree lock receipt.
 * @param context - Verified local Orca runtime and original coordinator.
 * @param backend - Process adapter, injectable for offline fixtures.
 * @param runId - Previously persisted Run for this exact coordinator, if known.
 * @returns The durable attempt after recording its start receipt.
 * @example
 * ```ts
 * const record = await launchOrcaWorker(prepared, context, backend);
 * ```
 */
export async function launchOrcaWorker(
  input: OrcaLaunch,
  context: OrcaContext,
  backend: OrcaExecutionAdapter,
  runId: string | null = null,
): Promise<WorkerRecord> {
  const launch = orcaLaunchSchema.parse(input);
  await validatePreparedAssignment(launch);
  const workspace = await backend.preflight(launch, context);
  await validatePreparedAssignment(launch);
  const execution: OrcaAttempt = {
    backend: 'orca',
    version: 1,
    revision: 0,
    context,
    launch,
    promptDigest: createHash('sha256').update(launch.prompt).digest('hex'),
    ...workspace,
    state: 'prepared',
    runId,
    orcaTaskId: null,
    dispatchId: null,
    retryOf: null,
    startBinding: { runId, orcaTaskId: null, retryOf: null },
    startRequestId: null,
    stopRequestId: null,
    failureCount: 0,
    resourceState: 'unknown',
    lastReceipt: null,
    lastError: null,
    observedAt: new Date().toISOString(),
  };
  const record = await recordWorker(
    {
      taskId: launch.taskId,
      instanceId: launch.instanceId,
      agentId: launch.agentId,
      provider: launch.harness,
      pid: null,
      pgid: null,
      worktree: launch.worktreePath,
      leadMailbox: launch.leadMailbox,
      sessionId: launch.workerSessionId,
      execution,
    },
    launch.projectRoot,
  );
  const reserved = await updateWorkerExecution(
    record,
    { ...execution, state: 'launching' },
    launch.projectRoot,
  );
  const result = await backend.start(requireExecution(reserved));
  return updateWorkerExecution(reserved, result, launch.projectRoot);
}

/**
 * Observe a stored exact Dispatch after a CLI restart.
 * @remarks Status hints never close the record or settle a CLEO task.
 * @param recordId - Existing local worker record id.
 * @param cwd - Owning CLEO project root.
 * @param backend - Process adapter for the recorded runtime.
 * @returns The record with a validated observation and a new CAS revision.
 * @example
 * ```ts
 * const observed = await observeOrcaWorker(record.recordId, projectRoot, backend);
 * ```
 */
export async function observeOrcaWorker(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<WorkerRecord> {
  const record = await loadOrcaWorker(recordId, cwd);
  return updateWorkerExecution(record, await backend.show(requireExecution(record)), cwd);
}

/**
 * Replay an issued or pre-reserved start request after a durable reservation.
 * @remarks A missing receipt never authorizes an unkeyed replacement; reserved
 * retries must still hold the original live claim and canonical checkout lock.
 * @param recordId - Exact pending worker record id.
 * @param cwd - Owning CLEO project root.
 * @param backend - Process adapter for the original runtime and caller.
 * @returns The same worker record with the replayed receipt.
 * @example
 * ```ts
 * const recovered = await recoverOrcaWorkerStart(record.recordId, projectRoot, backend);
 * ```
 */
export async function recoverOrcaWorkerStart(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<WorkerRecord> {
  const record = await loadOrcaWorker(recordId, cwd);
  const execution = requireExecution(record);
  if (
    !['outcome_unknown', 'launching'].includes(execution.state) ||
    !(execution.startRequestId || execution.startRequestKey) ||
    !execution.startBinding ||
    execution.failureCount >= 3
  ) {
    // @sync-invariant none:local-only only an issued or pre-reserved unresolved operation may be replayed
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'No recoverable start request is stored for this attempt.',
      {
        fix: 'Inspect its original receipt; an absent receipt never authorizes a replacement worker.',
      },
    );
  }
  if (execution.startRequestKey) await validatePreparedAssignment(execution.launch);
  const reserved = await updateWorkerExecution(record, { ...execution, state: 'launching' }, cwd);
  try {
    const result = await backend.replayStart({ ...execution, state: 'outcome_unknown' });
    return await updateWorkerExecution(reserved, result, cwd);
  } catch (error) {
    await updateWorkerExecution(
      reserved,
      { ...execution, state: 'outcome_unknown', lastError: String(error) },
      cwd,
    );
    throw error;
  }
}

/**
 * Retry a confirmed failed or stopped attempt on the same Orca Task and Run.
 * @remarks Atomically retires the predecessor and reserves its successor before launch;
 * uncertain outcomes and breaker history retain custody, claims and the checkout.
 * @param recordId - Exact predecessor record, with no remaining agent resources.
 * @param cwd - Owning CLEO project root.
 * @param backend - Adapter for the predecessor's runtime and caller.
 * @returns The durably reserved successor and its full launch receipt.
 * @example
 * ```ts
 * const successor = await retryOrcaWorker(record.recordId, projectRoot, backend);
 * ```
 */
export async function retryOrcaWorker(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<WorkerRecord> {
  const predecessor = await observeOrcaWorker(recordId, cwd, backend);
  const execution = requireExecution(predecessor);
  if (
    !execution.dispatchId ||
    !execution.runId ||
    !execution.orcaTaskId ||
    !['failed', 'stopped'].includes(execution.state) ||
    execution.resourceState !== 'stopped' ||
    execution.failureCount >= 3
  ) {
    // @sync-invariant none:local-only a retry cannot evade uncertain custody or the original Task's breaker
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'The predecessor has no confirmed resource-free failure or stop eligible for retry.',
      {
        fix: 'Inspect its exact Dispatch and recover any issued stop; retain custody until confirmed.',
      },
    );
  }
  await validatePreparedAssignment(execution.launch);
  const workspace = await backend.preflight(execution.launch, execution.context);
  if (
    workspace.workspaceId !== execution.workspaceId ||
    workspace.workspaceSelector !== execution.workspaceSelector
  ) {
    // @sync-invariant none:local-only retries must attach the original exact canonical workspace
    throw new CleoError(ExitCode.SPAWN_VALIDATION_FAILED, 'The retry workspace binding changed.', {
      fix: 'Resolve the original workspace explicitly; do not substitute another checkout.',
    });
  }
  await validatePreparedAssignment(execution.launch);
  const launch = {
    ...execution.launch,
    instanceId: newWorkerInstanceId(execution.launch.harness),
  };
  const retry: OrcaAttempt = {
    ...execution,
    revision: 0,
    launch,
    state: 'launching',
    dispatchId: null,
    retryOf: execution.dispatchId,
    startBinding: {
      runId: execution.runId,
      orcaTaskId: execution.orcaTaskId,
      retryOf: execution.dispatchId,
    },
    startRequestKey: randomUUID(),
    startRequestId: null,
    stopRequestId: null,
    resourceState: 'unknown',
    lastReceipt: null,
    lastError: null,
    observedAt: new Date().toISOString(),
  };
  const reserved = await recordWorker(
    { ...predecessor, instanceId: launch.instanceId, execution: retry },
    cwd,
    predecessor,
  );
  return updateWorkerExecution(reserved, await backend.start(retry), cwd);
}

/**
 * Read one archived or live output page.
 * @remarks Retired predecessors remain readable without changing custody.
 * Does not consume coordinator mail; callers retain the source-pinned cursor.
 * @param recordId - Exact worker record id.
 * @param cwd - Owning CLEO project root.
 * @param backend - Process adapter for the recorded runtime.
 * @param cursor - Cursor from the preceding output page, if any.
 * @returns Original bounded JSON receipt, including output and pagination.
 * @example
 * ```ts
 * const page = await readOrcaWorker(record.recordId, projectRoot, backend, undefined);
 * ```
 */
export async function readOrcaWorker(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
  cursor?: string,
): Promise<string> {
  return backend.read(requireExecution(await loadOrcaWorker(recordId, cwd, true)), cursor);
}

/**
 * Explicit cancellation of an exact attempt. stop_unknown fences another stop;
 * neither a stopped result nor a launch hint disposes a checkout or closes a task.
 * @remarks Requires an explicit cancellation request; uncertainty retains custody.
 * @param recordId - Exact worker record id to cancel.
 * @param cwd - Owning CLEO project root.
 * @param backend - Process adapter for the recorded runtime.
 * @returns The persisted stop receipt, including an unresolved stop_unknown.
 * @example
 * ```ts
 * const stopped = await stopOrcaWorker(record.recordId, projectRoot, backend);
 * ```
 */
export async function stopOrcaWorker(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<WorkerRecord> {
  const record = await loadOrcaWorker(recordId, cwd);
  const execution = requireExecution(record);
  if (!execution.dispatchId || !execution.runId || !execution.orcaTaskId) {
    // @sync-invariant none:local-only an unresolved start with no exact dispatch cannot authorize cancellation
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'No exact Dispatch binding is stored for cancellation.',
      { fix: 'Recover the original issued start request before requesting a guarded stop.' },
    );
  }
  if (['stop_pending', 'stop_unknown', 'stopped'].includes(execution.state)) {
    // @sync-invariant none:local-only an uncertain stop cannot be replaced by another unkeyed stop
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'The stored stop is already sent or settled.',
      {
        fix: 'Inspect the exact Dispatch and original stop request; do not repeat cancellation blindly.',
      },
    );
  }
  const reserved = await updateWorkerExecution(
    record,
    { ...execution, state: 'stop_pending' },
    cwd,
  );
  return updateWorkerExecution(reserved, await backend.stop(requireExecution(reserved)), cwd);
}

/**
 * Replay a previously issued uncertain cancellation after a CLI restart.
 * @remarks Missing request ids remain fenced; recovery never sends a fresh stop.
 * @param recordId - Exact open worker record containing the issued stop request.
 * @param cwd - Owning CLEO project root.
 * @param backend - Adapter for the original runtime and caller.
 * @returns The same record with its replayed stop receipt.
 * @example
 * ```ts
 * const recovered = await recoverOrcaWorkerStop(record.recordId, projectRoot, backend);
 * ```
 */
export async function recoverOrcaWorkerStop(
  recordId: string,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<WorkerRecord> {
  const record = await loadOrcaWorker(recordId, cwd);
  const execution = requireExecution(record);
  if (!['stop_unknown', 'stop_pending'].includes(execution.state) || !execution.stopRequestId) {
    // @sync-invariant none:local-only only the original issued cancellation may be replayed
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'No recoverable stop request is stored for this attempt.',
      { fix: 'Inspect the exact Dispatch and original receipt; do not repeat an unkeyed stop.' },
    );
  }
  const reserved = await updateWorkerExecution(
    record,
    { ...execution, state: 'stop_pending' },
    cwd,
  );
  try {
    const result = await backend.replayStop({ ...execution, state: 'stop_unknown' });
    return await updateWorkerExecution(reserved, result, cwd);
  } catch (error) {
    await updateWorkerExecution(
      reserved,
      { ...execution, state: 'stop_unknown', lastError: String(error) },
      cwd,
    );
    throw error;
  }
}

/**
 * Inspect or recover an exact durable worker through the supplied execution port.
 * @remarks Every invocation reloads the record; no current environment, newest
 * Run, native PID or launch status can replace its saved dispatch addressing.
 * @param request - Exact record, operation and optional source-pinned read cursor.
 * @param cwd - Owning CLEO project root.
 * @param backend - Process adapter, injected at the CLI boundary.
 * @returns The persisted record or original output receipt, or an actionable refusal.
 * @example
 * ```ts
 * const request: OrcaWorkerRequest = { action: 'show', recordId };
 * const result = await orchestrateOrcaWorker(request, root, backend);
 * ```
 */
export async function orchestrateOrcaWorker(
  request: OrcaWorkerRequest,
  cwd: string,
  backend: OrcaExecutionAdapter,
): Promise<EngineResult<WorkerRecord | string>> {
  const parsed = orcaWorkerRequestSchema.safeParse(request);
  if (!parsed.success) {
    // @sync-invariant none:input-shape an invalid supervision request cannot reach the execution port
    return engineError('E_INVALID_INPUT', parsed.error.message, {
      exitCode: ExitCode.VALIDATION_ERROR,
      fix: 'Use cleo orchestrate worker --help; read alone accepts a source-pinned cursor.',
    });
  }
  const { action, recordId, cursor } = parsed.data;
  const operations = {
    show: observeOrcaWorker,
    read: readOrcaWorker,
    'recover-start': recoverOrcaWorkerStart,
    'recover-stop': recoverOrcaWorkerStop,
    retry: retryOrcaWorker,
    stop: stopOrcaWorker,
  };
  try {
    return { success: true, data: await operations[action](recordId, cwd, backend, cursor) };
  } catch (error) {
    const code =
      error instanceof CleoError
        ? error.toLAFSError().code
        : error instanceof Error && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'E_ORCA_WORKER_FAILED';
    const fix =
      error instanceof Error && 'fix' in error && typeof error.fix === 'string'
        ? error.fix
        : `Inspect the stored record ${recordId} with cleo orchestrate status; retain its claim and worktree until its exact operation is resolved.`;
    // @sync-invariant none:local-only refused recovery retains the original durable custody
    return engineError(code, error instanceof Error ? error.message : String(error), {
      exitCode: error instanceof CleoError ? error.code : ExitCode.SPAWN_VALIDATION_FAILED,
      fix,
      details: { recordId, action },
    });
  }
}

async function loadOrcaWorker(
  recordId: string,
  cwd: string,
  includeRetired = false,
): Promise<WorkerRecord> {
  const record = (await listWorkerRecords(cwd, true)).find(
    (candidate) => candidate.recordId === recordId,
  );
  if (!record?.execution || (!includeRetired && record.stoppedAt !== null)) {
    // @sync-invariant none:local-only only archived output reads may address a retired attempt
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      `No ${includeRetired ? '' : 'open '}Orca worker record matches that id.`,
      { fix: 'Inspect the existing worker records and use the exact record id.' },
    );
  }
  return record;
}

function requireExecution(record: WorkerRecord): OrcaAttempt {
  if (!record.execution) {
    // @sync-invariant none:local-only native process records are never adopted as Orca attempts
    throw new CleoError(ExitCode.SPAWN_VALIDATION_FAILED, 'Worker record has no Orca binding.', {
      fix: 'Use its recorded execution backend.',
    });
  }
  if (
    createHash('sha256').update(record.execution.launch.prompt).digest('hex') !==
    record.execution.promptDigest
  ) {
    // @sync-invariant none:local-only recovery must replay the original prepared prompt bytes
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'The stored prompt no longer matches its launch digest.',
      { fix: 'Retain custody and inspect the original prepared assignment before recovery.' },
    );
  }
  return record.execution;
}

/** Recheck custody after read-only host preflight, which may outlive a claim. */
async function validatePreparedAssignment(launch: OrcaLaunch): Promise<void> {
  const expectedPath = resolveTaskWorktreePath(
    computeProjectHash(launch.projectRoot),
    launch.taskId,
  );
  const lock = readWorktreeTaskLock(launch.projectHash, launch.taskId);
  const task = await (await getTaskAccessor(launch.projectRoot)).loadSingleTask(launch.taskId);
  if (
    readDeclaredProjectIdentity(launch.projectRoot)?.projectId !== launch.projectId ||
    launch.worktreePath !== expectedPath ||
    realpathSync(launch.worktreePath) !== expectedPath ||
    launch.projectHash !== computeProjectHash(launch.projectRoot) ||
    launch.worktreeBranch !== `task/${launch.taskId}` ||
    !lock ||
    lock.token !== launch.lockToken ||
    lock.sessionId !== launch.workerSessionId ||
    lock.agentId !== launch.agentId ||
    !task?.claim ||
    !isLiveClaim(task.claim) ||
    task.claim.sessionId !== launch.workerSessionId ||
    task.claim.agentId !== launch.agentId
  ) {
    // @sync-invariant none:local-only an Orca launch must retain the canonical checkout and its allocated claim
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'The canonical worktree, lock or allocated task claim is unproven.',
      {
        fix: 'Prepare the task once through cleo orchestrate spawn and pass its exact worker identity and lock receipt.',
      },
    );
  }
}
