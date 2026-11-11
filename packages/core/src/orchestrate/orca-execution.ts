/**
 * Durable policy for prepared Orca assignments; no lifecycle settlement at launch.
 * @packageDocumentation
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { ExitCode } from '@cleocode/contracts/exit-codes.js';
import {
  type OrcaAttempt,
  type OrcaContext,
  type OrcaExecutionAdapter,
  type OrcaLaunch,
  orcaLaunchSchema,
} from '@cleocode/contracts/orca-execution.js';
import {
  computeProjectHash,
  readDeclaredProjectIdentity,
  resolveTaskWorktreePath,
} from '@cleocode/paths';
import { readWorktreeTaskLock } from '@cleocode/worktree';
import { CleoError } from '../errors.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { isLiveClaim } from '../store/task-claim.js';
import {
  listWorkerRecords,
  recordWorker,
  updateWorkerExecution,
  type WorkerRecord,
} from './worker-records.js';

/**
 * Launch a payload already prepared once by CLEO's canonical spawn path. The
 * worker claim and worktree lock remain held on every uncertain outcome.
 * Automatic entry-point selection and final report settlement are separate work.
 * @remarks Consumes canonical preparation once; never provisions another checkout.
 * @param input - Prepared task, prompt, session and worktree lock receipt.
 * @param context - Verified local Orca runtime and original coordinator.
 * @param backend - Process adapter, injectable for offline fixtures.
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
 * Replay an issued uncertain start request after a durable reservation.
 * @remarks A missing request receipt never authorizes an unkeyed replacement.
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
    !execution.startRequestId ||
    execution.failureCount >= 3
  ) {
    // @sync-invariant none:local-only only an issued unresolved operation may be replayed
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'No recoverable start request is stored for this attempt.',
      {
        fix: 'Inspect its original receipt; an absent receipt never authorizes a replacement worker.',
      },
    );
  }
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
 * Read one archived or live output page.
 * @remarks Does not consume coordinator mail; callers retain the source-pinned cursor.
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
  return backend.read(requireExecution(await loadOrcaWorker(recordId, cwd)), cursor);
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

async function loadOrcaWorker(recordId: string, cwd: string): Promise<WorkerRecord> {
  const record = (await listWorkerRecords(cwd, true)).find(
    (candidate) => candidate.recordId === recordId,
  );
  if (!record?.execution || record.stoppedAt !== null) {
    // @sync-invariant none:local-only recovery requires an open durable external attempt
    throw new CleoError(
      ExitCode.SPAWN_VALIDATION_FAILED,
      'No open Orca worker record matches that id.',
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
