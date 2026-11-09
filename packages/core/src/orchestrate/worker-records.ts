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
 * Completion is an event, never emitted at spawn. Primary path: the worker
 * runs `cleo orchestrate worker-exit` as it stops ({@link markWorkerExited}).
 * Fallback for a worker that crashed before its hook ran:
 * {@link reconcileWorkerExits} probes each open record's pid (`cleo
 * orchestrate status` runs it). Both close the record with a compare-and-set
 * on `stopped_at`, and only the caller that closes it dispatches
 * SubagentStop, so it fires exactly once whichever path wins.
 *
 * @module orchestrate/worker-records
 * @task T14359
 */

import { and, eq, isNull } from 'drizzle-orm';
import { generateAgentId } from '../agents/registry.js';
import { hooks } from '../hooks/registry.js';
import { getLogger } from '../logger.js';
import { tasksAgentInstances } from '../store/schema/cleo-project/runtime.js';
import { getDb } from '../store/sqlite.js';

/** A `tasks_agent_instances` row. */
type AgentInstanceRow = typeof tasksAgentInstances.$inferSelect;

/** A persisted record of one spawned worker process. */
export interface WorkerRecord {
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
  /** ISO time the worker's exit was observed (SubagentStop emitted), else null. */
  stoppedAt: string | null;
}

/** Input for {@link recordWorker}: a {@link WorkerRecord} before it is stored. */
export type NewWorkerRecord = Omit<WorkerRecord, 'recordId' | 'startedAt' | 'stoppedAt'>;

/** Metadata keys stored in `agent_instances.metadata_json` for a worker. */
interface WorkerMetadata {
  kind: 'worker';
  instanceId: string;
  agentId: string;
  provider: string;
  pid: number | null;
  pgid: number | null;
  worktree: string;
  leadMailbox: string | null;
}

/** Parse a worker row's metadata; null for any non-worker agent instance. */
function parseWorkerMetadata(row: AgentInstanceRow): WorkerMetadata | null {
  try {
    const meta = JSON.parse(row.metadataJson ?? '{}') as Partial<WorkerMetadata>;
    return meta.kind === 'worker' && typeof meta.instanceId === 'string'
      ? (meta as WorkerMetadata)
      : null;
  } catch {
    return null;
  }
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
  };
}

/**
 * Persist a record for a worker the adapter left running.
 *
 * @param worker - The worker to record.
 * @param cwd - Project root.
 * @returns The stored record.
 */
export async function recordWorker(worker: NewWorkerRecord, cwd?: string): Promise<WorkerRecord> {
  const metadata: WorkerMetadata = {
    kind: 'worker',
    instanceId: worker.instanceId,
    agentId: worker.agentId,
    provider: worker.provider,
    pid: worker.pid,
    pgid: worker.pgid,
    worktree: worker.worktree,
    leadMailbox: worker.leadMailbox,
  };
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
  await db.insert(tasksAgentInstances).values(row).run();
  return toWorkerRecord(row, metadata);
}

/**
 * List every persisted worker record, newest first.
 *
 * @param cwd - Project root.
 * @returns All worker records, open and stopped.
 */
export async function listWorkerRecords(cwd?: string): Promise<WorkerRecord[]> {
  const db = await getDb(cwd);
  const rows = await db
    .select()
    .from(tasksAgentInstances)
    .where(eq(tasksAgentInstances.agentType, 'executor'))
    .all();
  const records: WorkerRecord[] = [];
  for (const row of rows) {
    const meta = parseWorkerMetadata(row);
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
 * Close an open record and dispatch its SubagentStop. Only the caller whose
 * compare-and-set closes the record dispatches, so the hook path and the pid
 * sweep can race and SubagentStop still fires once.
 *
 * @returns The closed record, or null when another caller closed it first.
 */
async function closeWorker(
  record: WorkerRecord,
  status: WorkerExitStatus,
  cwd: string,
): Promise<WorkerRecord | null> {
  const stoppedAt = await claimWorkerStop(record.recordId, cwd);
  if (stoppedAt === null) return null;
  await hooks
    .dispatch('SubagentStop', cwd, {
      timestamp: stoppedAt,
      taskId: record.taskId,
      agentId: record.agentId,
      status,
      metadata: { instanceId: record.instanceId, pid: record.pid },
    })
    .catch((err) => {
      getLogger('engine:orchestrate').warn(
        { taskId: record.taskId, err: String(err) },
        'SubagentStop hook failed for an exited worker',
      );
    });
  return { ...record, stoppedAt };
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
 * This is the primary completion path. A worker runs it as it stops (the
 * claude-code adapter installs it as the worker's Stop hook:
 * `cleo orchestrate worker-exit --instance <id>`). Idempotent: a repeat call,
 * or a pid sweep that got there first, emits nothing.
 *
 * @param target - The worker to close, by instance id or session id.
 * @param status - Completion status for the SubagentStop payload.
 * @param cwd - Project root.
 * @returns The matched record and whether this call emitted SubagentStop.
 */
export async function markWorkerExited(
  target: WorkerExitTarget,
  status: WorkerExitStatus,
  cwd: string,
): Promise<WorkerExitResult> {
  const records = await listWorkerRecords(cwd);
  const record =
    (target.instanceId !== undefined
      ? records.find((r) => r.instanceId === target.instanceId)
      : records.find((r) => r.stoppedAt === null && r.sessionId === target.sessionId)) ?? null;
  if (record === null || record.stoppedAt !== null) return { record, emitted: false };
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
 * Fallback for workers that died without running their stop hook: emit
 * SubagentStop once for every open record whose pid is gone.
 *
 * Records with no pid stay open: their exit cannot be observed. The status is
 * `partial` because a crashed worker's outcome is unknown; the task's own
 * status says how it ended.
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
    if (record.stoppedAt !== null || record.pid === null || isAlive(record.pid)) continue;
    const done = await closeWorker(record, 'partial', cwd);
    if (done) closed.push(done);
  }
  return closed;
}
