/**
 * Durable worker records (T14359).
 *
 * A detached worker outlives the CLI call that spawned it, so the spawn
 * adapter's in-memory process map is gone by the next `cleo` call. Each
 * running worker is therefore persisted as a `tasks_agent_instances` row
 * (`agent_type = 'executor'`, `metadata_json.kind === 'worker'`) carrying its
 * task, adapter instance id, pid/pgid, worktree, lead mailbox, provider and
 * start time. The table is `local-only` (a pid means nothing on another
 * device) and is written only through this module, on the `getDb` chokepoint
 * handle.
 *
 * Gated by `orchestrate.leadWorker.v1` (`isLeadWorkerV1Enabled`); with
 * the flag off, spawn keeps its old behaviour (SubagentStop at spawn).
 *
 * The record is written BEFORE the adapter spawns, under a pre-assigned
 * instance id, so a worker that dies at once still finds its record when its
 * exit hook runs. Completion is an event, never emitted at spawn. Primary
 * path: the worker runs `cleo orchestrate worker-exit` as its session ends
 * ({@link markWorkerExited}; the claude-code adapter installs it as a
 * `SessionEnd` hook).
 * Fallback for a worker that crashed before its hook ran:
 * {@link reconcileWorkerExits} probes each open record's pid (`cleo
 * orchestrate status` runs it). Both close the record with a compare-and-set
 * on `stopped_at`, and only the caller that closes it dispatches
 * SubagentStop, so it fires exactly once whichever path wins.
 *
 * @module orchestrate/worker-records
 * @packageDocumentation
 * @task T14359
 */

import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { AgentSuiteOwnership } from '@cleocode/contracts';
import {
  type OrcaAttempt,
  type OrcaReportDelivery,
  type OrcaWorkerReport,
  type OrcaWorkerSettlement,
  orcaAttemptSchema,
  orcaReportDeliverySchema,
  orcaWorkerReportSchema,
  orcaWorkerSettlementSchema,
} from '@cleocode/contracts/orca-execution.js';
import { and, eq, isNull } from 'drizzle-orm';
import { generateAgentId } from '../agents/registry.js';
import { hooks } from '../hooks/registry.js';
import { getLogger } from '../logger.js';
import { getTaskAccessor } from '../store/data-accessor.js';
import { tasksAgentInstances } from '../store/schema/cleo-project/runtime.js';
import { tasksTasks } from '../store/schema/cleo-project/tasks-core.js';
import { getDb } from '../store/sqlite.js';
import { claimFromColumns, isLiveClaim } from '../store/task-claim.js';

/**
 * A fresh adapter instance id, assigned before spawn so the record and the
 * worker's exit hook share it. Only `[A-Za-z0-9-]`, so it is safe in a shell
 * hook command.
 *
 * @param providerId - Spawn provider id, used as the prefix.
 * @returns The instance id.
 */
export function newWorkerInstanceId(providerId: string): string {
  const prefix = providerId.replace(/[^A-Za-z0-9-]/g, '-');
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/** A `tasks_agent_instances` row. */
type AgentInstanceRow = typeof tasksAgentInstances.$inferSelect;

/** A persisted record of one spawned worker process. */
export interface WorkerRecord extends OrcaWorkerSettlement {
  /** `tasks_agent_instances.id` of the record. */
  recordId: string;
  /** Task the worker runs. */
  taskId: string;
  /** Adapter instance id returned by `adapter.spawn`. */
  instanceId: string;
  /** Agent id the SubagentStart hook was dispatched with (SubagentStop reuses it). */
  agentId: string;
  /** Spawn provider id (e.g. `claude-code`). */
  provider: string;
  /** Root process id of the worker, when the adapter reported one. */
  pid: number | null;
  /** Process-group id of the worker suite, when the adapter reported one. */
  pgid: number | null;
  /** Working directory (worktree) the worker runs in. */
  worktree: string;
  /** AgentMBX mailbox of the spawning lead, when known. */
  leadMailbox: string | null;
  /** CLEO session the worker was spawned under. */
  sessionId: string | null;
  /** ISO time the worker was spawned. */
  startedAt: string;
  /** ISO time of observed exit or atomic retirement of a resource-free Orca predecessor. */
  stoppedAt: string | null;
  /** External execution custody; a nullable PID never settles this attempt. */
  execution?: OrcaAttempt;
  /** Canonical report settlement, independent of acceptance and resource release. */
  report?: OrcaWorkerReport;
}

/** Input for {@link recordWorker}: a {@link WorkerRecord} before it is stored. */
export type NewWorkerRecord = Omit<
  WorkerRecord,
  'recordId' | 'startedAt' | 'stoppedAt' | 'report' | keyof OrcaWorkerSettlement
>;

/** Metadata keys stored in `agent_instances.metadata_json` for a worker. */
interface WorkerMetadata extends OrcaWorkerSettlement {
  kind: 'worker';
  instanceId: string;
  agentId: string;
  provider: string;
  pid: number | null;
  pgid: number | null;
  worktree: string;
  leadMailbox?: string | null;
  execution?: OrcaAttempt;
  report?: OrcaWorkerReport;
}

/** Parse a worker row's metadata; null for any non-worker agent instance. */
function parseWorkerMetadata(row: AgentInstanceRow): WorkerMetadata | null {
  let meta: Partial<WorkerMetadata>;
  try {
    meta = JSON.parse(row.metadataJson ?? '{}') as Partial<WorkerMetadata>;
  } catch {
    return null;
  }
  if (
    meta === null ||
    typeof meta !== 'object' ||
    meta.kind !== 'worker' ||
    typeof meta.instanceId !== 'string'
  )
    return null;
  // Invalid external custody must fail a read, never disappear from the census.
  if (meta.execution !== undefined) meta.execution = orcaAttemptSchema.parse(meta.execution);
  if (meta.report !== undefined) meta.report = orcaWorkerReportSchema.parse(meta.report);
  Object.assign(meta, orcaWorkerSettlementSchema.parse(meta));
  return meta as WorkerMetadata;
}

/** Project an agent instance row onto a {@link WorkerRecord}. */
function toWorkerRecord(row: AgentInstanceRow, meta: WorkerMetadata): WorkerRecord {
  return {
    recordId: row.id,
    taskId: row.taskId ?? '',
    instanceId: meta.instanceId,
    agentId: meta.agentId,
    provider: meta.provider,
    pid: meta.pid ?? null,
    pgid: meta.pgid ?? null,
    worktree: meta.worktree,
    leadMailbox: meta.leadMailbox ?? null,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    ...(meta.execution ? { execution: meta.execution } : {}),
    ...(meta.report ? { report: meta.report } : {}),
    ...orcaWorkerSettlementSchema.parse(meta),
  };
}

/** Test-only pause point inside the retry reservation; `null` in production. */
let retryReservationProbe: (() => void) | null = null;

/**
 * Install a synchronous pause point that runs inside the retry reservation
 * transaction, after the predecessor check and immediately before the
 * `metadataJson` + `stoppedAt` CAS that retires the predecessor.
 *
 * @remarks Test seam only (T14494): a multi-process test parks two processes
 * here so both are about to run the CAS. Production code never installs one.
 * @param probe - Synchronous callback, or `null` to remove it.
 * @example
 * ```ts
 * setRetryReservationProbe(() => waitForBarrierSync());
 * ```
 */
export function setRetryReservationProbe(probe: (() => void) | null): void {
  retryReservationProbe = probe;
}

/**
 * Persist a record for a worker the adapter left running.
 *
 * @param worker - The worker to record.
 * @param cwd - Project root.
 * @param predecessor - Exact resource-free Orca attempt atomically replaced by its retry.
 * @returns The stored record.
 */
export async function recordWorker(
  worker: NewWorkerRecord,
  cwd?: string,
  predecessor?: WorkerRecord,
): Promise<WorkerRecord> {
  const metadata: WorkerMetadata = {
    kind: 'worker',
    instanceId: worker.instanceId,
    agentId: worker.agentId,
    provider: worker.provider,
    pid: worker.pid,
    pgid: worker.pgid,
    worktree: worker.worktree,
    leadMailbox: worker.leadMailbox,
    ...(worker.execution ? { execution: orcaAttemptSchema.parse(worker.execution) } : {}),
  };
  if (
    metadata.execution &&
    (metadata.execution.launch.taskId !== worker.taskId ||
      metadata.execution.launch.instanceId !== worker.instanceId ||
      metadata.execution.launch.agentId !== worker.agentId ||
      metadata.execution.launch.workerSessionId !== worker.sessionId ||
      metadata.execution.launch.harness !== worker.provider ||
      metadata.execution.launch.worktreePath !== worker.worktree ||
      worker.pid !== null ||
      worker.pgid !== null)
  ) {
    // @sync-invariant none:local-only external resource custody cannot acquire native PID ownership or another worker identity
    throw new Error('Orca attempt does not match its worker record.');
  }
  if (predecessor) {
    const previous = predecessor.execution;
    const next = metadata.execution;
    if (
      !previous ||
      !next ||
      predecessor.taskId !== worker.taskId ||
      !previous.dispatchId ||
      !previous.runId ||
      !previous.orcaTaskId ||
      !['failed', 'stopped'].includes(previous.state) ||
      previous.resourceState !== 'stopped' ||
      previous.failureCount >= 3 ||
      next.failureCount !== previous.failureCount ||
      next.state !== 'launching' ||
      next.dispatchId !== null ||
      !next.startRequestKey ||
      next.startRequestKey === previous.startRequestKey ||
      next.startRequestKey === previous.startRequestId ||
      next.startRequestId !== null ||
      next.stopRequestKey !== undefined ||
      next.stopRequestId !== null ||
      next.retryOf !== previous.dispatchId ||
      next.runId !== previous.runId ||
      next.orcaTaskId !== previous.orcaTaskId ||
      next.launch.instanceId === previous.launch.instanceId ||
      next.promptDigest !== previous.promptDigest ||
      next.workspaceId !== previous.workspaceId ||
      next.workspaceSelector !== previous.workspaceSelector ||
      JSON.stringify(next.context) !== JSON.stringify(previous.context) ||
      JSON.stringify({ ...next.launch, instanceId: previous.launch.instanceId }) !==
        JSON.stringify(previous.launch) ||
      JSON.stringify(next.startBinding) !==
        JSON.stringify({
          runId: previous.runId,
          orcaTaskId: previous.orcaTaskId,
          retryOf: previous.dispatchId,
        })
    ) {
      // @sync-invariant none:local-only replacement custody requires a resource-free exact predecessor and the same Task retry chain
      throw new Error('Orca retry cannot replace unresolved custody or change its assignment.');
    }
  }
  const now = new Date().toISOString();
  const row: AgentInstanceRow = {
    id: generateAgentId(),
    agentType: 'executor',
    status: 'active',
    sessionId: worker.sessionId,
    taskId: worker.taskId,
    startedAt: now,
    lastHeartbeat: now,
    stoppedAt: null,
    errorCount: 0,
    totalTasksCompleted: 0,
    // A busy worker has no spare capacity.
    capacity: '0',
    metadataJson: JSON.stringify(metadata),
    parentAgentId: null,
  };
  const db = await getDb(cwd);
  try {
    reserveWorkerRow(db, worker, row, predecessor, now);
  } catch (err) {
    if (predecessor && isSqliteSnapshotConflict(err)) {
      // @sync-invariant none:local-only another process committed after this reservation read; its retry owns the predecessor
      throw new Error('Orca retry reservation lost; no new launch is authorized.', { cause: err });
    }
    throw err;
  }
  return toWorkerRecord(row, metadata);
}

/** SQLITE_BUSY_SNAPSHOT: a read transaction's snapshot went stale before its first write. */
const SQLITE_BUSY_SNAPSHOT = 517;

/**
 * Whether an error, or the driver error it wraps, is a WAL snapshot conflict.
 * @param err - Thrown value; drizzle wraps the node:sqlite error in `cause`.
 * @returns `true` for `SQLITE_BUSY_SNAPSHOT`.
 */
function isSqliteSnapshotConflict(err: unknown): boolean {
  for (let current = err, depth = 0; current instanceof Error && depth < 3; depth++) {
    if ((current as { errcode?: number }).errcode === SQLITE_BUSY_SNAPSHOT) return true;
    current = current.cause;
  }
  return false;
}

/**
 * Insert one worker row in a single transaction, retiring the exact predecessor
 * first when this is a retry.
 * @remarks Runs as a deferred transaction: a process whose read snapshot goes
 * stale before its first write is refused by SQLite with `SQLITE_BUSY_SNAPSHOT`,
 * which {@link recordWorker} reports as a lost reservation.
 */
function reserveWorkerRow(
  db: Awaited<ReturnType<typeof getDb>>,
  worker: NewWorkerRecord,
  row: AgentInstanceRow,
  predecessor: WorkerRecord | undefined,
  now: string,
): void {
  db.transaction((tx) => {
    const open = tx
      .select()
      .from(tasksAgentInstances)
      .where(eq(tasksAgentInstances.taskId, worker.taskId))
      .all()
      .filter((existing) => {
        const meta = parseWorkerMetadata(existing);
        return (
          existing.stoppedAt === null ||
          (meta !== null && isCurrentOrcaWorker(toWorkerRecord(existing, meta)))
        );
      });
    if (predecessor) {
      const previous = open.find((existing) => existing.id === predecessor.recordId);
      if (
        open.length !== 1 ||
        !previous ||
        JSON.stringify(parseWorkerMetadata(previous)?.execution) !==
          JSON.stringify(predecessor.execution)
      ) {
        // @sync-invariant none:local-only a concurrent retry or observation invalidates this replacement reservation
        throw new Error('Orca predecessor changed; reload its exact worker record before retry.');
      }
      retryReservationProbe?.();
      const retired = tx
        .update(tasksAgentInstances)
        .set({
          status: 'stopped',
          stoppedAt: previous.stoppedAt ?? now,
          metadataJson: JSON.stringify({ ...parseWorkerMetadata(previous), retiredAt: now }),
        })
        .where(
          and(
            eq(tasksAgentInstances.id, predecessor.recordId),
            eq(tasksAgentInstances.metadataJson, previous.metadataJson ?? '{}'),
            previous.stoppedAt === null
              ? isNull(tasksAgentInstances.stoppedAt)
              : eq(tasksAgentInstances.stoppedAt, previous.stoppedAt),
          ),
        )
        .run();
      if (Number(retired.changes) !== 1) {
        // @sync-invariant none:local-only only one successor may acquire this exact predecessor's custody
        throw new Error('Orca retry reservation lost; no new launch is authorized.');
      }
    } else if (
      open.some((existing) => worker.execution || parseWorkerMetadata(existing)?.execution)
    ) {
      // @sync-invariant none:local-only duplicate local execution custody cannot start another editor
      throw new Error(
        `Execution custody already exists for ${worker.taskId}; inspect its worker record before recovery.`,
      );
    }
    tx.insert(tasksAgentInstances).values(row).run();
  });
}

/**
 * Compare-and-set external custody on an existing worker row. Concurrent CLI
 * calls cannot both reserve a stop or replay, or overwrite a newer receipt.
 * @remarks Preserves assignment identity and monotonic circuit-breaker history.
 * @param record - Last read worker record and expected CAS revision.
 * @param execution - New observation or operation reservation for the same attempt.
 * @param cwd - Owning CLEO project root.
 * @returns The updated record with its next local CAS revision.
 * @example
 * ```ts
 * const reserved = await updateWorkerExecution(record, pendingStop, projectRoot);
 * ```
 */
export async function updateWorkerExecution(
  record: WorkerRecord,
  execution: OrcaAttempt,
  cwd: string,
): Promise<WorkerRecord> {
  const expected = record.execution;
  const next = orcaAttemptSchema.parse({ ...execution, revision: (expected?.revision ?? 0) + 1 });
  if (
    !expected ||
    JSON.stringify(expected.launch) !== JSON.stringify(next.launch) ||
    JSON.stringify(expected.context) !== JSON.stringify(next.context) ||
    expected.promptDigest !== next.promptDigest ||
    expected.workspaceId !== next.workspaceId ||
    expected.workspaceSelector !== next.workspaceSelector ||
    next.failureCount < expected.failureCount ||
    expected.retryOf !== next.retryOf ||
    (expected.startRefusal !== undefined && expected.startRefusal !== next.startRefusal) ||
    JSON.stringify(expected.startBinding) !== JSON.stringify(next.startBinding) ||
    expected.startRequestKey !== next.startRequestKey ||
    (expected.startRequestKey !== undefined &&
      next.startRequestId !== null &&
      next.startRequestId !== expected.startRequestKey) ||
    (expected.startRequestId !== null && next.startRequestId !== expected.startRequestId) ||
    (expected.stopRequestKey !== undefined && next.stopRequestKey !== expected.stopRequestKey) ||
    (expected.stopRequestId !== null && next.stopRequestId !== expected.stopRequestId) ||
    (expected.runId !== null && next.runId !== expected.runId) ||
    (expected.orcaTaskId !== null && next.orcaTaskId !== expected.orcaTaskId) ||
    (expected.dispatchId !== null && next.dispatchId !== expected.dispatchId)
  ) {
    // @sync-invariant none:local-only external attempt identity and breaker history are immutable
    throw new Error('Cannot replace the identity or breaker history of an Orca attempt.');
  }
  const db = await getDb(cwd);
  const row = db
    .select()
    .from(tasksAgentInstances)
    .where(eq(tasksAgentInstances.id, record.recordId))
    .get();
  const meta = row ? parseWorkerMetadata(row) : null;
  if (
    !row ||
    !meta ||
    !isCurrentOrcaWorker(toWorkerRecord(row, meta)) ||
    JSON.stringify(meta.execution) !== JSON.stringify(expected)
  ) {
    // @sync-invariant none:local-only stale external custody updates cannot overwrite a newer observation
    throw new Error('Worker execution changed; reload the exact record before recovery.');
  }
  const result = db
    .update(tasksAgentInstances)
    .set({ metadataJson: JSON.stringify({ ...meta, execution: next }) })
    .where(
      and(
        eq(tasksAgentInstances.id, record.recordId),
        eq(tasksAgentInstances.metadataJson, row.metadataJson ?? '{}'),
        row.stoppedAt === null
          ? isNull(tasksAgentInstances.stoppedAt)
          : eq(tasksAgentInstances.stoppedAt, row.stoppedAt),
      ),
    )
    .run();
  if (Number(result.changes) !== 1) {
    // @sync-invariant none:local-only only one caller may reserve an external execution mutation
    throw new Error('Worker execution reservation lost; no new operation is authorized.');
  }
  return toWorkerRecord(row, { ...meta, execution: next });
}

/**
 * Persist one validated logical report on its exact worker without releasing custody.
 * @param record - Current worker and expected execution revision.
 * @param report - Original report bytes, transport identity and validated manifest link.
 * @param cwd - Owning project root.
 * @returns The stored record; identical duplicate reports retain the first receipt.
 * @throws When identity, content or a concurrent custody change conflicts.
 * @remarks Uses the existing local-only worker metadata transaction; no acceptance or resource hook is emitted.
 * @example
 * ```ts
 * const settled = await recordWorkerReport(record, validatedReport, projectRoot);
 * ```
 */
export async function recordWorkerReport(
  record: WorkerRecord,
  report: OrcaWorkerReport,
  cwd: string,
): Promise<WorkerRecord> {
  const receipt = orcaWorkerReportSchema.parse(report);
  const execution = record.execution;
  if (
    !execution ||
    receipt.event.runtimeId !== execution.context.runtimeId ||
    receipt.event.runId !== execution.runId ||
    receipt.event.orcaTaskId !== execution.orcaTaskId ||
    receipt.event.dispatchId !== execution.dispatchId ||
    receipt.reportDigest !== createHash('sha256').update(receipt.reportText).digest('hex')
  ) {
    // @sync-invariant none:local-only a report cannot change its exact worker identity or original bytes
    throw new Error('Worker report identity or digest does not match its record.');
  }
  const db = await getDb(cwd);
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(tasksAgentInstances)
      .where(eq(tasksAgentInstances.id, record.recordId))
      .get();
    const meta = row ? parseWorkerMetadata(row) : null;
    if (
      !row ||
      !meta ||
      !isCurrentOrcaWorker(toWorkerRecord(row, meta)) ||
      JSON.stringify(meta.execution) !== JSON.stringify(execution)
    ) {
      // @sync-invariant none:local-only retired or concurrently changed custody cannot receive a stale report
      throw new Error('Worker execution changed; reload the exact record before report ingestion.');
    }
    if (meta.report) {
      if (
        meta.report.reportDigest !== receipt.reportDigest ||
        meta.report.manifestId !== receipt.manifestId ||
        meta.report.manifestDigest !== receipt.manifestDigest
      ) {
        // @sync-invariant none:local-only a second delivery cannot replace the settled logical report
        throw new Error('A different worker report is already settled for this Dispatch.');
      }
      if (meta.reportDelivery) return toWorkerRecord(row, meta);
    }
    if (!meta.report) {
      const task = tx.select().from(tasksTasks).where(eq(tasksTasks.id, record.taskId)).get();
      const claim = task ? claimFromColumns(task) : undefined;
      if (
        !isLiveClaim(claim) ||
        claim?.sessionId !== record.sessionId ||
        claim?.agentId !== record.agentId
      ) {
        // @sync-invariant none:local-only report settlement must still own the exact claim at commit time
        throw new Error('Worker task claim changed before report settlement.');
      }
    }
    const canonical = meta.report ?? receipt;
    const event = canonical.event;
    const metadata: WorkerMetadata = {
      ...meta,
      report: canonical,
      reportDelivery: {
        key: `cleo-orca-report:${createHash('sha256')
          .update(JSON.stringify([event.runtimeId, event.runId, event.dispatchId, event.messageId]))
          .digest('hex')}`,
        mailbox: meta.leadMailbox ?? null,
        state: 'pending',
        messageId: null,
        deliveredAt: null,
        lastError: null,
      },
    };
    const updated = tx
      .update(tasksAgentInstances)
      .set({ metadataJson: JSON.stringify(metadata) })
      .where(
        and(
          eq(tasksAgentInstances.id, record.recordId),
          eq(tasksAgentInstances.metadataJson, row.metadataJson ?? '{}'),
          row.stoppedAt === null
            ? isNull(tasksAgentInstances.stoppedAt)
            : eq(tasksAgentInstances.stoppedAt, row.stoppedAt),
        ),
      )
      .run();
    if (Number(updated.changes) !== 1) {
      // @sync-invariant none:local-only report settlement has one winner and never changes task or resource state
      throw new Error('Worker report settlement lost; reload the exact record.');
    }
    return toWorkerRecord(row, metadata);
  });
}

/**
 * Retire a confirmed `agent_unconfigured` refusal that created no Dispatch.
 * @remarks This releases no task, session or filesystem resource and emits no exit hook.
 * @param record - Exact persisted refusal, after recording its unusable route.
 * @param cwd - Owning project root.
 * @returns The archived pre-dispatch attempt, still readable for audit.
 */
export async function retireUnconfiguredOrcaWorker(
  record: WorkerRecord,
  cwd: string,
): Promise<WorkerRecord> {
  const execution = record.execution;
  if (
    execution?.startRefusal !== 'agent_unconfigured' ||
    execution.state !== 'failed' ||
    execution.resourceState !== 'stopped' ||
    execution.dispatchId !== null ||
    execution.orcaTaskId !== null ||
    execution.retryOf !== null ||
    execution.failureCount !== 0
  ) {
    // @sync-invariant none:local-only only a confirmed pre-dispatch route refusal can be retired without exit proof
    throw new Error('Cannot retire an unresolved or dispatched Orca attempt.');
  }
  const db = await getDb(cwd);
  const row = db
    .select()
    .from(tasksAgentInstances)
    .where(eq(tasksAgentInstances.id, record.recordId))
    .get();
  const meta = row ? parseWorkerMetadata(row) : null;
  if (!row || !meta || JSON.stringify(meta.execution) !== JSON.stringify(execution)) {
    // @sync-invariant none:local-only stale refusal receipts cannot retire newer custody
    throw new Error('Orca refusal changed; reload its exact record.');
  }
  const stoppedAt = new Date().toISOString();
  const result = db
    .update(tasksAgentInstances)
    .set({ stoppedAt, status: 'stopped' })
    .where(
      and(
        eq(tasksAgentInstances.id, record.recordId),
        eq(tasksAgentInstances.metadataJson, row.metadataJson ?? '{}'),
        isNull(tasksAgentInstances.stoppedAt),
      ),
    )
    .run();
  if (Number(result.changes) !== 1) {
    // @sync-invariant none:local-only one caller owns retirement of a confirmed refusal
    throw new Error('Orca refusal retirement lost; no replacement is authorized.');
  }
  return { ...record, stoppedAt };
}

/**
 * Find external custody that forbids another spawn, including uncertain attempts.
 * @remarks Unreadable ownership for the same task refuses dispatch.
 * @param taskId - CLEO task whose external custody must be checked.
 * @param cwd - Owning CLEO project root.
 * @returns The retained Orca worker, or null when none exists.
 * @example
 * ```ts
 * const retained = await findOrcaWorker('T14455', projectRoot);
 * ```
 */
export async function findOrcaWorker(taskId: string, cwd: string): Promise<WorkerRecord | null> {
  const db = await getDb(cwd);
  const rows = db
    .select()
    .from(tasksAgentInstances)
    .where(
      and(eq(tasksAgentInstances.taskId, taskId), eq(tasksAgentInstances.agentType, 'executor')),
    )
    .all();
  for (const row of rows) {
    const meta = parseWorkerMetadata(row);
    if (!meta && row.stoppedAt !== null) continue;
    if (!meta) {
      // @sync-invariant none:local-only unreadable custody for the same task cannot authorize another editor
      throw new Error(
        `Worker ownership unavailable for ${row.id}; inspect it before spawning ${taskId}.`,
      );
    }
    const record = toWorkerRecord(row, meta);
    if (isCurrentOrcaWorker(record)) return record;
  }
  return null;
}

/**
 * Whether an Orca assignment still owns its execution mapping, even after physical exit.
 * @param record - Worker record to inspect.
 * @returns False for explicit retirement and legacy retired predecessors.
 * @remarks Physical exit does not authorize a replacement Run or Task.
 * @example
 * ```ts
 * if (isCurrentOrcaWorker(record)) retainItsExactDispatch(record);
 * ```
 */
export function isCurrentOrcaWorker(record: WorkerRecord): boolean {
  return Boolean(
    record.execution && !record.retiredAt && (record.stoppedAt === null || record.resourceRelease),
  );
}

/**
 * Record an AgentMBX send result without changing report, task or resource settlement.
 * @param recordId - Worker holding the durable outbox entry.
 * @param delivery - Result for its immutable logical key and lead mailbox.
 * @param cwd - Owning project root.
 * @returns The current worker; delivery acknowledgements never regress.
 * @remarks A lost acknowledgement is replayed through the same provider idempotency key.
 * @example
 * ```ts
 * await recordWorkerReportDelivery(recordId, acknowledged, projectRoot);
 * ```
 */
export async function recordWorkerReportDelivery(
  recordId: string,
  delivery: OrcaReportDelivery,
  cwd: string,
): Promise<WorkerRecord> {
  const next = orcaReportDeliverySchema.parse(delivery);
  const db = await getDb(cwd);
  return db.transaction((tx) => {
    const row = tx
      .select()
      .from(tasksAgentInstances)
      .where(eq(tasksAgentInstances.id, recordId))
      .get();
    const meta = row ? parseWorkerMetadata(row) : null;
    if (
      !row ||
      !meta?.report ||
      !meta.reportDelivery ||
      meta.reportDelivery.key !== next.key ||
      meta.reportDelivery.mailbox !== next.mailbox ||
      (next.state === 'delivered' && (!next.messageId || !next.deliveredAt))
    ) {
      // @sync-invariant none:local-only only the stored report's exact outbox entry may be acknowledged
      throw new Error('Worker report delivery does not match its durable outbox.');
    }
    if (meta.reportDelivery.state === 'delivered') return toWorkerRecord(row, meta);
    const metadata = { ...meta, reportDelivery: next };
    const updated = tx
      .update(tasksAgentInstances)
      .set({ metadataJson: JSON.stringify(metadata) })
      .where(
        and(
          eq(tasksAgentInstances.id, recordId),
          eq(tasksAgentInstances.metadataJson, row.metadataJson ?? '{}'),
        ),
      )
      .run();
    if (Number(updated.changes) !== 1) {
      // @sync-invariant none:local-only concurrent transport acknowledgements cannot replace newer settlement
      throw new Error('Worker report delivery changed; retry its stored logical key.');
    }
    return toWorkerRecord(row, metadata);
  });
}

/**
 * Close physical Orca resources only after an exact provider observation proves release.
 * @param record - Worker after the adapter's verified worker-show observation.
 * @param cwd - Owning project root.
 * @returns Its physical exit receipt; concurrent observations emit one stop hook.
 * @remarks Keeps report, claim, checkout and retry-chain custody independent of exit.
 * @example
 * ```ts
 * const exited = await settleOrcaWorkerResource(observed, projectRoot);
 * ```
 */
export async function settleOrcaWorkerResource(
  record: WorkerRecord,
  cwd: string,
): Promise<WorkerRecord> {
  const execution = record.execution;
  if (record.resourceRelease || execution?.resourceState !== 'stopped') return record;
  const dispatchId = execution.dispatchId;
  const receipt = execution.lastReceipt;
  if (!dispatchId || !receipt || !isCurrentOrcaWorker(record)) {
    // @sync-invariant none:local-only only a current provider-proven exact resource exit can close a worker
    throw new Error('No exact Orca resource release proof is stored.');
  }
  const db = await getDb(cwd);
  const releasedAt = new Date().toISOString();
  const closed = db.transaction((tx) => {
    const row = tx
      .select()
      .from(tasksAgentInstances)
      .where(eq(tasksAgentInstances.id, record.recordId))
      .get();
    const meta = row ? parseWorkerMetadata(row) : null;
    if (
      !row ||
      !meta ||
      JSON.stringify(meta.execution) !== JSON.stringify(execution) ||
      !isCurrentOrcaWorker(toWorkerRecord(row, meta))
    ) {
      // @sync-invariant none:local-only stale release observations cannot close replacement custody
      throw new Error('Orca resource observation changed; reload the exact worker.');
    }
    if (meta.resourceRelease) return null;
    const metadata = {
      ...meta,
      resourceRelease: {
        dispatchId,
        releasedAt,
        receiptDigest: createHash('sha256').update(receipt).digest('hex'),
        receipt,
      },
    };
    const updated = tx
      .update(tasksAgentInstances)
      .set({ status: 'stopped', stoppedAt: releasedAt, metadataJson: JSON.stringify(metadata) })
      .where(
        and(
          eq(tasksAgentInstances.id, row.id),
          eq(tasksAgentInstances.metadataJson, row.metadataJson ?? '{}'),
          isNull(tasksAgentInstances.stoppedAt),
        ),
      )
      .run();
    if (Number(updated.changes) !== 1) return null;
    return toWorkerRecord({ ...row, stoppedAt: releasedAt }, metadata);
  });
  if (!closed)
    return (
      (await listWorkerRecords(cwd, true)).find((worker) => worker.recordId === record.recordId) ??
      record
    );
  await dispatchWorkerStop(closed, releasedAt, undefined, cwd);
  return closed;
}

/**
 * List every persisted worker record, newest first.
 *
 * @param cwd - Project root.
 * @param strict - Refuse incomplete ownership metadata before destructive cleanup.
 * @returns All worker records, open and stopped.
 */
export async function listWorkerRecords(cwd?: string, strict = false): Promise<WorkerRecord[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(tasksAgentInstances)
    .where(eq(tasksAgentInstances.agentType, 'executor'))
    .all();
  const records: WorkerRecord[] = [];
  for (const row of rows) {
    const meta = parseWorkerMetadata(row);
    if (
      strict &&
      row.stoppedAt === null &&
      (!meta || typeof meta.worktree !== 'string' || !isAbsolute(meta.worktree))
    ) {
      // @sync-invariant none:local-only unreadable local worker ownership forbids worktree cleanup
      throw new Error(`Worker ownership unavailable for ${row.id}`);
    }
    if (meta) records.push(toWorkerRecord(row, meta));
  }
  return records.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Close a worker record exactly once: set `stopped` and `stopped_at` only
 * while `stopped_at` is unset, so of several concurrent callers one wins.
 *
 * @returns The stop time this call recorded, or null when already closed.
 */
async function claimWorkerStop(recordId: string, cwd: string): Promise<string | null> {
  const db = await getDb(cwd);
  const now = new Date().toISOString();
  const result = await db
    .update(tasksAgentInstances)
    .set({ status: 'stopped', stoppedAt: now })
    .where(and(eq(tasksAgentInstances.id, recordId), isNull(tasksAgentInstances.stoppedAt)))
    .run();
  return Number(result.changes) > 0 ? now : null;
}

/**
 * Update a record with what the adapter reported once spawn returned: the
 * instance id it actually used and the worker's pid/pgid.
 */
async function updateWorkerSpawn(
  record: WorkerRecord,
  spawned: { instanceId: string; pid: number | null; pgid: number | null },
  cwd: string,
): Promise<WorkerRecord> {
  const metadata: WorkerMetadata = {
    kind: 'worker',
    instanceId: spawned.instanceId,
    agentId: record.agentId,
    provider: record.provider,
    pid: spawned.pid,
    pgid: spawned.pgid,
    worktree: record.worktree,
    leadMailbox: record.leadMailbox,
  };
  const db = await getDb(cwd);
  await db
    .update(tasksAgentInstances)
    .set({ metadataJson: JSON.stringify(metadata) })
    .where(eq(tasksAgentInstances.id, record.recordId))
    .run();
  return { ...record, ...spawned };
}

/** What {@link settleWorkerAtSpawn} needs from the adapter's spawn result. */
export interface SpawnedWorker {
  /** Instance id the adapter returned. */
  instanceId: string;
  /** Whether the adapter left the worker running (`running` or `pending`). */
  running: boolean;
  /** Containment handle of the worker, when the adapter reported one. */
  ownership?: AgentSuiteOwnership;
  /** SubagentStop status to report when the record is closed at spawn. */
  stopStatus: WorkerExitStatus;
}

/**
 * Settle a pre-spawn record once the adapter returns.
 *
 * The record stays open only when its exit can be observed: the adapter
 * adopted the pre-assigned instance id (so it installed the worker-exit
 * hook) or reported a pid for the sweep. Otherwise (a spawn that already
 * ended, or a running worker with neither) the record is closed now and
 * SubagentStop fires at spawn, as before T14359: fail closed rather than a
 * record that never closes.
 *
 * @param record - The record written before spawn.
 * @param spawned - What the adapter reported.
 * @param cwd - Project root.
 * @returns True when the worker is tracked (its stop comes later).
 */
export async function settleWorkerAtSpawn(
  record: WorkerRecord,
  spawned: SpawnedWorker,
  cwd: string,
): Promise<boolean> {
  if (record.execution) return true;
  const pid = spawned.ownership?.pid ?? null;
  const hasExitHook = spawned.instanceId === record.instanceId;
  const updated = await updateWorkerSpawn(
    record,
    { instanceId: spawned.instanceId, pid, pgid: spawned.ownership?.pgid ?? null },
    cwd,
  );
  if (spawned.running && (hasExitHook || pid !== null)) return true;
  await closeWorker(updated, spawned.stopStatus, cwd);
  return false;
}

/**
 * Close a pre-spawn record whose spawn threw: the worker never ran.
 *
 * @param record - The record written before spawn.
 * @param cwd - Project root.
 */
export async function abandonWorkerRecord(record: WorkerRecord, cwd: string): Promise<void> {
  if (record.execution) return;
  await closeWorker(record, 'failed', cwd);
}

/** SubagentStop completion status a worker exit reports. */
export type WorkerExitStatus = 'complete' | 'partial' | 'blocked' | 'failed';

/** Accepted values of {@link WorkerExitStatus}, for input validation. */
export const WORKER_EXIT_STATUSES: readonly WorkerExitStatus[] = [
  'complete',
  'partial',
  'blocked',
  'failed',
];

/**
 * The stop status a worker's task implies. A process exit is not task
 * completion: an auth error, max turns or a crash also ends the session, so
 * only a task the worker finished reports `complete`; a still-active task
 * reports `partial`.
 *
 * @param taskId - The worker's task.
 * @param cwd - Project root.
 * @returns The derived status (`partial` when the task cannot be read).
 */
export async function deriveWorkerExitStatus(
  taskId: string,
  cwd: string,
): Promise<WorkerExitStatus> {
  try {
    const task = await (await getTaskAccessor(cwd)).loadSingleTask(taskId);
    switch (task?.status) {
      case 'done':
        return 'complete';
      case 'blocked':
      case 'cancelled':
        return 'blocked';
      default:
        return 'partial';
    }
  } catch {
    return 'partial';
  }
}

/**
 * Close an open record and dispatch its SubagentStop. Only the caller whose
 * compare-and-set closes the record dispatches, so the hook path and the pid
 * sweep can race and SubagentStop still fires once.
 *
 * @returns The closed record, or null when another caller closed it first.
 */
async function closeWorker(
  record: WorkerRecord,
  explicitStatus: WorkerExitStatus | undefined,
  cwd: string,
): Promise<WorkerRecord | null> {
  const stoppedAt = await claimWorkerStop(record.recordId, cwd);
  if (stoppedAt === null) return null;
  await dispatchWorkerStop(record, stoppedAt, explicitStatus, cwd);
  return { ...record, stoppedAt };
}

/** Send the existing lifecycle hook after the relevant durable exit CAS wins. */
async function dispatchWorkerStop(
  record: WorkerRecord,
  stoppedAt: string,
  explicitStatus: WorkerExitStatus | undefined,
  cwd: string,
): Promise<void> {
  const status = explicitStatus ?? (await deriveWorkerExitStatus(record.taskId, cwd));
  await hooks
    .dispatch('SubagentStop', cwd, {
      timestamp: stoppedAt,
      taskId: record.taskId,
      agentId: record.agentId,
      status,
      metadata: {
        instanceId: record.instanceId,
        pid: record.pid,
        ...(record.execution
          ? {
              backend: 'orca',
              dispatchId: record.execution.dispatchId,
              runtimeId: record.execution.context.runtimeId,
            }
          : {}),
      },
    })
    .catch((err) => {
      getLogger('engine:orchestrate').warn(
        { taskId: record.taskId, err: String(err) },
        'SubagentStop hook failed for an exited worker',
      );
    });
}

/** Which worker a {@link markWorkerExited} call names. */
export interface WorkerExitTarget {
  /** Adapter instance id of the worker (preferred). */
  instanceId?: string;
  /** The worker's own CLEO session; used when no instance id is given. */
  sessionId?: string;
}

/** Result of {@link markWorkerExited}. */
export interface WorkerExitResult {
  /** The matched record, or null when none matched. */
  record: WorkerRecord | null;
  /** True when this call closed the record and dispatched SubagentStop. */
  emitted: boolean;
}

/**
 * The worker's own completion signal: close its record and fire SubagentStop.
 *
 * This is the primary completion path. A worker runs it as its session ends
 * (the claude-code adapter installs it as the worker's `SessionEnd` hook:
 * `cleo orchestrate worker-exit --instance <id>`). Idempotent: a repeat call,
 * or a pid sweep that got there first, emits nothing.
 *
 * @param target - The worker to close, by instance id or session id.
 * @param status - Completion status for the SubagentStop payload; when
 *   omitted it is derived from the task ({@link deriveWorkerExitStatus}).
 * @param cwd - Project root.
 * @returns The matched record and whether this call emitted SubagentStop.
 */
export async function markWorkerExited(
  target: WorkerExitTarget,
  status: WorkerExitStatus | undefined,
  cwd: string,
): Promise<WorkerExitResult> {
  const records = await listWorkerRecords(cwd);
  const record =
    (target.instanceId !== undefined
      ? records.find((r) => r.instanceId === target.instanceId)
      : records.find((r) => r.stoppedAt === null && r.sessionId === target.sessionId)) ?? null;
  if (record === null || record.stoppedAt !== null || record.execution)
    return { record, emitted: false };
  const closed = await closeWorker(record, status, cwd);
  return closed ? { record: closed, emitted: true } : { record, emitted: false };
}

/**
 * True while a process with this pid exists (EPERM means it exists but
 * belongs to another user).
 *
 * shortcut: a pid the OS reused after the worker exited reads as alive, so
 * the stop is delayed until that process exits too; upgrade to comparing the
 * process start time when that shows up in practice.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fallback for workers that died without running their exit hook: emit
 * SubagentStop once for every open record whose pid is gone.
 *
 * A record with no pid waits for its exit hook ({@link settleWorkerAtSpawn}
 * closes at spawn any record that has neither). The status is derived from
 * the task ({@link deriveWorkerExitStatus}): a crashed worker whose task is
 * still active reports `partial`.
 *
 * @param cwd - Project root.
 * @param isAlive - Liveness probe (injectable for tests).
 * @returns The records this call closed.
 */
export async function reconcileWorkerExits(
  cwd: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<WorkerRecord[]> {
  const closed: WorkerRecord[] = [];
  for (const record of await listWorkerRecords(cwd)) {
    if (record.execution || record.stoppedAt !== null || record.pid === null || isAlive(record.pid))
      continue;
    const done = await closeWorker(record, undefined, cwd);
    if (done) closed.push(done);
  }
  return closed;
}
