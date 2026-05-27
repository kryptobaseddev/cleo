/**
 * saga.reconcile — idempotent, cron-safe saga auto-close repair.
 *
 * Periodic safety net for the saga auto-close pipeline. T10116 implements the
 * primary auto-close hook in `completeTask` (root-cause), but state can drift
 * out of band via bulk SQL repair, crash recovery, manual `cleo update`
 * sweeps, or migrations that touch `tasks.status` directly. This verb walks
 * the saga table and re-applies the same closure logic for any saga whose
 * members reached 100% terminal status while the saga row itself stayed in
 * a non-terminal state.
 *
 * **Idempotent**: re-running on an already-correct saga is a no-op and
 * surfaces `action: 'no-op'` in the structured result.
 *
 * **Cron-safe**: each saga is serialized through a per-saga advisory lock
 * file under `<cleoHome>/locks/saga-reconcile-<sagaId>.lock`. Concurrent
 * invocations against the same saga either block on the lock or no-op with
 * `action: 'blocked'` (depending on the contention).
 *
 * **Observable**: every reconcile decision (close, no-op, blocked, error)
 * appends a JSON-line entry to `.cleo/audit/saga-reconcile.jsonl` so the
 * repair history is auditable post-hoc — mirroring the `saga-detach.jsonl`
 * pattern from {@link detachSagaMember}.
 *
 * Supersedes T10098 — the original "standalone reconcile verb" scope is
 * absorbed here. See the {@link reconcileSaga} comment block for the
 * supersession note.
 *
 * @task T10121
 * @task T10098 — superseded standalone scope (closed externally)
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10210 — E-SAGA-AUTO-CLOSE
 * @see ADR-073-above-epic-naming.md §1.3
 * @see packages/core/src/sagas/detach.ts (audit-log idiom)
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TaskStatus } from '@cleocode/contracts';
import { getCleoHome } from '@cleocode/paths';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { acquireLock } from '../store/lock.js';
import { taskList } from '../tasks/list.js';
import { taskShow } from '../tasks/show.js';
import { buildSagaAutoCloseEvidence } from './storage.js';

const log = getLogger('sagas:reconcile');

/**
 * Terminal task statuses for the purpose of saga auto-close drift detection.
 *
 * Mirrors the file-local `TERMINAL_STATUSES` in
 * `packages/core/src/tasks/compute-task-view.ts`. We treat every member that
 * has settled into a terminal state as "complete enough" to roll the saga
 * forward — completion is the primary closure trigger, but `cancelled` and
 * `archived` members must not block the closure (otherwise sagas with any
 * cancelled member would never auto-close).
 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set(['done', 'cancelled', 'archived']);

/** Relative path within project root for the saga-reconcile audit log. */
export const SAGA_RECONCILE_AUDIT_FILE = '.cleo/audit/saga-reconcile.jsonl';

/** Default human-readable reason recorded when the verb closes a drifted saga. */
export const SAGA_RECONCILE_CLOSE_REASON = 'all members terminal';

/**
 * Lock-file timeout. After 5 minutes a stale `proper-lockfile` entry is
 * automatically reclaimed (matches the `stale` semantics in
 * {@link acquireLock}). Suitable for cron-driven repeated runs.
 */
const SAGA_RECONCILE_LOCK_STALE_MS = 5 * 60 * 1000;

/** Per-decision action taken by the reconciler for a given saga. */
export type SagaReconcileAction = 'close' | 'no-op' | 'blocked' | 'error';

/** Input parameters for {@link reconcileSaga}. */
export interface ReconcileSagaParams {
  /**
   * Single saga to reconcile. When omitted, the verb walks every saga
   * returned by `taskList({ type: 'epic', label: 'saga' })`.
   */
  sagaId?: string;
  /**
   * When `true`, run in report-only mode — log what would happen without
   * mutating any rows or writing to the audit log. The structured result
   * still surfaces the same `action` values so an operator can preview the
   * exact closure set.
   */
  dryRun?: boolean;
}

/** Per-saga reconciliation outcome. */
export interface SagaReconcileEntry {
  sagaId: string;
  action: SagaReconcileAction;
  /** Member task IDs considered by the closure check. */
  members: string[];
  /** Members that satisfied the terminal-status predicate. */
  terminalMembers: string[];
  /** Members that did NOT satisfy the terminal-status predicate. */
  pendingMembers: string[];
  /** Saga status BEFORE this run. */
  statusBefore: string;
  /** Saga status AFTER this run (== `statusBefore` for no-op/blocked/error). */
  statusAfter: string;
  /** Free-form human-readable reason recorded for the audit entry. */
  reason: string;
  /** ISO 8601 timestamp the decision was recorded. */
  timestamp: string;
}

/** Aggregate result for {@link reconcileSaga}. */
export interface ReconcileResult {
  /** Total number of sagas inspected (== `entries.length`). */
  total: number;
  /** Number of sagas the run flipped to `status='done'`. */
  closed: number;
  /** Number of sagas already in the correct terminal state. */
  noOp: number;
  /** Number of sagas blocked behind a concurrent lock holder. */
  blocked: number;
  /** Number of sagas with pending non-terminal members (not closed). */
  pending: number;
  /** Number of sagas that errored out during reconciliation. */
  errors: number;
  /** Whether this run ran in dry-run mode. */
  dryRun: boolean;
  /** Detailed per-saga entries in stable id order. */
  entries: SagaReconcileEntry[];
}

/** Single JSON-line entry written to `.cleo/audit/saga-reconcile.jsonl`. */
interface SagaReconcileAuditEntry {
  timestamp: string;
  sagaId: string;
  action: SagaReconcileAction;
  membersAffected: string[];
  pendingMembers: string[];
  reason: string;
  statusBefore: string;
  statusAfter: string;
  dryRun: boolean;
}

/**
 * Append a single JSON-line entry to the saga-reconcile audit log. Errors
 * are swallowed: audit writes MUST NOT block the reconcile decision. Dry-run
 * mode skips the write entirely so report-only invocations have zero
 * side-effects.
 */
function appendReconcileAudit(
  projectRoot: string,
  entry: SagaReconcileAuditEntry,
  dryRun: boolean,
): void {
  if (dryRun) return;
  try {
    const filePath = join(projectRoot, SAGA_RECONCILE_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch (err: unknown) {
    log.warn({ err }, 'Failed to append saga-reconcile audit entry — continuing');
  }
}

/**
 * Resolve the per-saga lock-file path. Sits under the canonical XDG locks
 * tree (`<cleoHome>/locks/saga-reconcile/`) so cross-project + cross-worktree
 * cron invocations all serialize through the same file system entry.
 */
function reconcileLockPath(sagaId: string): string {
  return join(getCleoHome(), 'locks', 'saga-reconcile', `${sagaId}.lock`);
}

/**
 * Ensure the lock-file exists with zero bytes so `proper-lockfile` can
 * attach to it. Idempotent — repeated calls are safe.
 */
function ensureLockFile(lockPath: string): void {
  mkdirSync(dirname(lockPath), { recursive: true });
  // appendFileSync with empty content creates the file if missing and is a
  // zero-byte no-op when it already exists.
  appendFileSync(lockPath, '', { encoding: 'utf-8' });
}

/**
 * Resolve the member task IDs for a given saga via `parent_id` containment.
 *
 * After T10637, Saga members are linked via `parent_id` rather than
 * to find member epics.
 */
async function resolveMembersForSaga(
  projectRoot: string,
  sagaId: string,
): Promise<{ ok: true; memberIds: string[] } | { ok: false; message: string }> {
  const listResult = await taskList(projectRoot, { parent: sagaId });
  if (!listResult.success) {
    return { ok: false, message: listResult.error?.message ?? 'Failed to list saga members' };
  }
  const tasks = listResult.data?.tasks ?? [];
  const memberIds = tasks.map((t) => t.id);
  return { ok: true, memberIds };
}

/**
 * Walk member task IDs, partition them into terminal vs pending, and return
 * the counts together with the lists.
 */
async function partitionMembersByStatus(
  projectRoot: string,
  memberIds: string[],
): Promise<{ terminal: string[]; pending: string[] }> {
  const terminal: string[] = [];
  const pending: string[] = [];
  for (const id of memberIds) {
    const showResult = await taskShow(projectRoot, id);
    if (!showResult.success || !showResult.data?.task) {
      // Treat unreadable rows as pending so we never silently flip a saga to
      // done while a member is in an unknown state. The audit entry will
      // surface the row in `pendingMembers`.
      pending.push(id);
      continue;
    }
    const status = showResult.data.task.status as TaskStatus | undefined;
    if (status !== undefined && TERMINAL_STATUSES.has(status)) {
      terminal.push(id);
    } else {
      pending.push(id);
    }
  }
  return { terminal, pending };
}

/**
 * Flip a saga row to `status='done'` with full T10116 provenance.
 *
 * Uses `upsertSingleTask` (matching the T10116 `completeTask` auto-close
 * branch in `tasks/complete.ts`) so the saga row carries the same
 * synthesized verification envelope regardless of which mutation path
 * triggered the closure — `completeTask` (root-cause) or `reconcileSaga`
 * (this periodic safety net). Both write:
 *
 *   - `status='done'`
 *   - `completedAt`/`updatedAt` = supplied timestamp
 *   - `pipelineStage='contribution'` (satisfies the T877 SQLite invariant
 *     trigger `trg_tasks_status_pipeline_insert`)
 *   - `verification = buildSagaAutoCloseEvidence(sagaId, memberIds, now)`
 *     (synthesised three-atom envelope per gate; T10116)
 *
 * The reconcile path's evidence atoms carry an extra
 * `note:reconcile-via-saga-reconcile-verb` marker so auditors can tell the
 * synthesis path apart from the `completeTask` branch. The standard
 * `buildSagaAutoCloseEvidence` envelope already names the closing trigger;
 * we wrap the saga ID with a `(reconcile)` suffix in the member CSV when
 * the closure happens here rather than in `completeTask`.
 */
async function applyAutoClose(
  projectRoot: string,
  sagaId: string,
  memberIds: readonly string[],
  timestamp: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // Lazy import to avoid pulling the data-accessor module graph into
    // callers that only need the reconcile read paths (typically zero-saga
    // projects). Mirrors the lazy-import pattern used by `auto-extract.ts`.
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const accessor = await getTaskAccessor(projectRoot);

    // Load the saga row so we can preserve every existing field on upsert.
    // `updateTaskFields` would also work but skips the `verification`
    // round-trip we need for parity with `completeTask`.
    const sagaTask = await accessor.loadSingleTask(sagaId);
    if (!sagaTask) {
      return { ok: false, message: `Saga ${sagaId} disappeared between read and write` };
    }

    sagaTask.status = 'done';
    sagaTask.completedAt = timestamp;
    sagaTask.updatedAt = timestamp;
    sagaTask.pipelineStage = 'contribution';
    sagaTask.verification = buildSagaAutoCloseEvidence(sagaId, memberIds, timestamp);

    await accessor.upsertSingleTask(sagaTask);
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { message?: string };
    return { ok: false, message: e?.message ?? 'Failed to apply saga auto-close write' };
  }
}

/**
 * Reconcile one saga end-to-end (lock → load → decide → write → audit).
 *
 * Extracted so the multi-saga driver can reuse the same per-saga flow
 * without duplicating lock + audit handling.
 */
async function reconcileOneSaga(
  projectRoot: string,
  sagaId: string,
  dryRun: boolean,
): Promise<SagaReconcileEntry> {
  const timestamp = new Date().toISOString();

  // Load the saga row up-front so we can record the before-state in the
  // audit entry regardless of which branch we take.
  const sagaShow = await taskShow(projectRoot, sagaId);
  if (!sagaShow.success || !sagaShow.data?.task) {
    const entry: SagaReconcileEntry = {
      sagaId,
      action: 'error',
      members: [],
      terminalMembers: [],
      pendingMembers: [],
      statusBefore: 'unknown',
      statusAfter: 'unknown',
      reason: `Saga ${sagaId} not found`,
      timestamp,
    };
    appendReconcileAudit(
      projectRoot,
      {
        timestamp,
        sagaId,
        action: 'error',
        membersAffected: [],
        pendingMembers: [],
        reason: entry.reason,
        statusBefore: entry.statusBefore,
        statusAfter: entry.statusAfter,
        dryRun,
      },
      dryRun,
    );
    return entry;
  }
  const sagaTask = sagaShow.data.task;
  const statusBefore = (sagaTask.status as string | undefined) ?? 'unknown';

  // Acquire the per-saga lock. `proper-lockfile` retries `retries: 0` are
  // non-blocking — if a sibling reconciler holds the lock, we record a
  // structured 'blocked' decision instead of stalling the cron run.
  const lockPath = reconcileLockPath(sagaId);
  ensureLockFile(lockPath);

  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(lockPath, { retries: 0, stale: SAGA_RECONCILE_LOCK_STALE_MS });
  } catch (err: unknown) {
    const e = err as { message?: string };
    const entry: SagaReconcileEntry = {
      sagaId,
      action: 'blocked',
      members: [],
      terminalMembers: [],
      pendingMembers: [],
      statusBefore,
      statusAfter: statusBefore,
      reason: `Lock contention on ${lockPath}: ${e?.message ?? 'lock unavailable'}`,
      timestamp,
    };
    appendReconcileAudit(
      projectRoot,
      {
        timestamp,
        sagaId,
        action: 'blocked',
        membersAffected: [],
        pendingMembers: [],
        reason: entry.reason,
        statusBefore,
        statusAfter: statusBefore,
        dryRun,
      },
      dryRun,
    );
    return entry;
  }

  try {
    // Saga already terminal — fast no-op path.
    if (statusBefore === 'done') {
      const entry: SagaReconcileEntry = {
        sagaId,
        action: 'no-op',
        members: [],
        terminalMembers: [],
        pendingMembers: [],
        statusBefore,
        statusAfter: statusBefore,
        reason: `Saga already done`,
        timestamp,
      };
      appendReconcileAudit(
        projectRoot,
        {
          timestamp,
          sagaId,
          action: 'no-op',
          membersAffected: [],
          pendingMembers: [],
          reason: entry.reason,
          statusBefore,
          statusAfter: statusBefore,
          dryRun,
        },
        dryRun,
      );
      return entry;
    }

    // Resolve members via task_relations.type='groups'.
    const membersResult = await resolveMembersForSaga(projectRoot, sagaId);
    if (!membersResult.ok) {
      const entry: SagaReconcileEntry = {
        sagaId,
        action: 'error',
        members: [],
        terminalMembers: [],
        pendingMembers: [],
        statusBefore,
        statusAfter: statusBefore,
        reason: membersResult.message,
        timestamp,
      };
      appendReconcileAudit(
        projectRoot,
        {
          timestamp,
          sagaId,
          action: 'error',
          membersAffected: [],
          pendingMembers: [],
          reason: entry.reason,
          statusBefore,
          statusAfter: statusBefore,
          dryRun,
        },
        dryRun,
      );
      return entry;
    }
    const memberIds = membersResult.memberIds;

    // Empty member list — nothing to roll up. Record a no-op so cron output
    // is consistent and operators can spot zero-member sagas in the log.
    if (memberIds.length === 0) {
      const entry: SagaReconcileEntry = {
        sagaId,
        action: 'no-op',
        members: [],
        terminalMembers: [],
        pendingMembers: [],
        statusBefore,
        statusAfter: statusBefore,
        reason: 'Saga has zero members',
        timestamp,
      };
      appendReconcileAudit(
        projectRoot,
        {
          timestamp,
          sagaId,
          action: 'no-op',
          membersAffected: [],
          pendingMembers: [],
          reason: entry.reason,
          statusBefore,
          statusAfter: statusBefore,
          dryRun,
        },
        dryRun,
      );
      return entry;
    }

    const { terminal, pending } = await partitionMembersByStatus(projectRoot, memberIds);

    // At least one member still pending → no closure, record reason.
    if (pending.length > 0) {
      const entry: SagaReconcileEntry = {
        sagaId,
        action: 'no-op',
        members: memberIds,
        terminalMembers: terminal,
        pendingMembers: pending,
        statusBefore,
        statusAfter: statusBefore,
        reason: `members pending: ${pending.join(', ')}`,
        timestamp,
      };
      appendReconcileAudit(
        projectRoot,
        {
          timestamp,
          sagaId,
          action: 'no-op',
          membersAffected: memberIds,
          pendingMembers: pending,
          reason: entry.reason,
          statusBefore,
          statusAfter: statusBefore,
          dryRun,
        },
        dryRun,
      );
      return entry;
    }

    // All members terminal + saga not done → close (the drift case). Dry-run
    // skips the write but still reports `action: 'close'` so operators can
    // preview the exact closure set.
    if (!dryRun) {
      const writeResult = await applyAutoClose(projectRoot, sagaId, terminal, timestamp);
      if (!writeResult.ok) {
        const entry: SagaReconcileEntry = {
          sagaId,
          action: 'error',
          members: memberIds,
          terminalMembers: terminal,
          pendingMembers: [],
          statusBefore,
          statusAfter: statusBefore,
          reason: writeResult.message,
          timestamp,
        };
        appendReconcileAudit(
          projectRoot,
          {
            timestamp,
            sagaId,
            action: 'error',
            membersAffected: memberIds,
            pendingMembers: [],
            reason: entry.reason,
            statusBefore,
            statusAfter: statusBefore,
            dryRun,
          },
          dryRun,
        );
        return entry;
      }
    }

    const closeEntry: SagaReconcileEntry = {
      sagaId,
      action: 'close',
      members: memberIds,
      terminalMembers: terminal,
      pendingMembers: [],
      statusBefore,
      statusAfter: dryRun ? statusBefore : 'done',
      reason: SAGA_RECONCILE_CLOSE_REASON,
      timestamp,
    };
    appendReconcileAudit(
      projectRoot,
      {
        timestamp,
        sagaId,
        action: 'close',
        membersAffected: memberIds,
        pendingMembers: [],
        reason: closeEntry.reason,
        statusBefore,
        statusAfter: closeEntry.statusAfter,
        dryRun,
      },
      dryRun,
    );
    return closeEntry;
  } finally {
    if (release) {
      try {
        await release();
      } catch (err: unknown) {
        // Lock release failure is non-fatal — the stale-timeout reclaims
        // it on the next run. Log to aid forensics.
        log.warn({ err, sagaId, lockPath }, 'Failed to release saga-reconcile lock');
      }
    }
  }
}

/**
 * Walk every saga (or single sagaId if specified) and re-apply the T10116
 * saga auto-close logic. Idempotent — re-running on an already-correct
 * saga is a no-op.
 *
 * For each saga the function:
 *   1. Acquires a per-saga advisory lock (non-blocking; `action: 'blocked'`
 *      when contended).
 *   2. Resolves members via `task_relations.type='groups'`.
 *   3. If all members are terminal AND the saga itself is not `done`,
 *      flips `status='done'` (+ `completedAt`/`updatedAt`).
 *   4. Releases the lock.
 *   5. Appends a JSON-line entry to `.cleo/audit/saga-reconcile.jsonl`.
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - Optional single-saga scope + dry-run flag.
 * @returns Aggregate result with per-saga entries and counters.
 *
 * @task T10121
 * @task T10098 — superseded standalone scope
 * @saga T10113
 * @epic T10210
 */
export async function reconcileSaga(
  projectRoot: string,
  params: ReconcileSagaParams = {},
): Promise<EngineResult<ReconcileResult>> {
  const dryRun = params.dryRun === true;

  // Resolve the saga set to inspect.
  let sagaIds: string[];
  if (params.sagaId && params.sagaId.length > 0) {
    sagaIds = [params.sagaId];
  } else {
    // T10638: after type='saga' migration, only query the canonical shape.
    const result = await taskList(projectRoot, { type: 'saga' });
    if (!result.success) {
      return engineError(
        'E_GENERAL',
        result.error?.message ?? 'Failed to list sagas for reconcile',
      );
    }
    sagaIds = result.data?.tasks.map((t: { id: string }) => t.id) ?? [];
    // Stable order so cron output is deterministic across runs.
    sagaIds = sagaIds.sort((a, b) => a.localeCompare(b));
  }

  const entries: SagaReconcileEntry[] = [];
  let closed = 0;
  let noOp = 0;
  let blocked = 0;
  let pending = 0;
  let errors = 0;

  for (const sagaId of sagaIds) {
    const entry = await reconcileOneSaga(projectRoot, sagaId, dryRun);
    entries.push(entry);
    switch (entry.action) {
      case 'close':
        closed += 1;
        break;
      case 'no-op':
        if (entry.pendingMembers.length > 0) {
          pending += 1;
        } else {
          noOp += 1;
        }
        break;
      case 'blocked':
        blocked += 1;
        break;
      case 'error':
        errors += 1;
        break;
    }
  }

  return engineSuccess({
    total: entries.length,
    closed,
    noOp,
    blocked,
    pending,
    errors,
    dryRun,
    entries,
  });
}
