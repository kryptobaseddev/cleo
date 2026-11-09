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
 * Completion: SubagentStop is emitted by {@link reconcileWorkerExits}, never at
 * spawn. It probes each open record's pid and, for a worker that has exited,
 * sets `stopped_at` with a compare-and-set so exactly one caller emits the
 * hook. Because the state lives in the store, the signal
 * survives the spawning CLI exiting; it fires on the first reconcile after the
 * exit (`cleo orchestrate status` runs one).
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
 * Emit SubagentStop once for every recorded worker that has exited.
 *
 * Open records (`stopped_at` unset) whose pid is gone are closed with a
 * compare-and-set, and only the caller that closes a record dispatches the
 * hook, so concurrent or repeated reconciles never emit twice. Records with
 * no pid stay open: their exit cannot be observed.
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
    const stoppedAt = await claimWorkerStop(record.recordId, cwd);
    if (stoppedAt === null) continue;
    closed.push({ ...record, stoppedAt });
    await hooks
      .dispatch('SubagentStop', cwd, {
        timestamp: stoppedAt,
        taskId: record.taskId,
        agentId: record.agentId,
        // The exit code of a detached worker is not observable after the
        // spawning process is gone; the task's own status says how it ended.
        status: 'partial',
        metadata: { instanceId: record.instanceId, pid: record.pid },
      })
      .catch((err) => {
        getLogger('engine:orchestrate').warn(
          { taskId: record.taskId, err: String(err) },
          'SubagentStop hook failed for an exited worker',
        );
      });
  }
  return closed;
}
