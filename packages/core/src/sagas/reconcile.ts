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
 * **Transactional**: a closure validates typed completion criteria and
 * writes the saga row plus a `saga_reconciled` `tasks_audit_log` receipt in
 * ONE write transaction — a failed receipt write rolls the closure back.
 *
 * **Observable**: every reconcile decision (close, no-op, blocked, error)
 * also appends a best-effort JSON-line entry to `.cleo/audit/saga-reconcile.jsonl` so the
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

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DataAccessor, Task, TaskStatus, TransactionAccessor } from '@cleocode/contracts';
import type { OperationExecutionContext } from '@cleocode/contracts/jobs';
import { getCleoHome } from '@cleocode/paths';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import {
  captureProjectScope,
  readProjectInfoAtDirectorySync,
  worktreeScope,
} from '../project-scope.js';
import { createOperationExecutionContext } from '../store/background-ops.js';
import { acquireLock } from '../store/lock.js';
import { readAllowCachedGates } from '../tasks/gate-result-cache.js';
import { validateTaskGateCompletion } from '../tasks/gate-runner.js';
import { taskList } from '../tasks/list.js';
import { isTerminalPipelineStage } from '../tasks/pipeline-stage.js';
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

/**
 * `tasks_audit_log.action` of the receipt written in the same transaction as a
 * reconcile closure. This DB row is the authoritative closure record; the
 * JSONL file above is a best-effort operational log of every decision.
 */
export const SAGA_RECONCILE_RECEIPT_ACTION = 'saga_reconciled';

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
   * mutating any rows, opening a write transaction, or writing to either
   * audit log. Typed completion criteria are still validated, so a saga
   * whose typed proof is unmet previews as `action: 'error'`. The structured result
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
 * Typed-completion validator shared by every saga reconciled in one run.
 *
 * Criteria are read from `criteriaSource` — the write transaction on the real
 * path, the plain accessor on the dry-run path — while canonical
 * `gate.verify.typed` receipts are read through `receiptSource` (the
 * `TransactionAccessor` contract is write-only apart from a few reads, so
 * `queryAuditLog` stays on the outer accessor, exactly as in
 * `tasks/complete.ts`). Resolves to the execution lifetime that validated the
 * saga, or `undefined` when the saga carries no typed criteria.
 */
type SagaTypedValidator = (
  task: Task,
  criteriaSource: Pick<TransactionAccessor, 'getAcRows'>,
  receiptSource: Pick<DataAccessor, 'queryAuditLog'>,
) => Promise<OperationExecutionContext | undefined>;

/**
 * Build the typed-completion validator for ONE saga of a reconcile run.
 *
 * When the caller supplied an execution lifetime it is used as-is and never
 * renewed. Otherwise the validator lazily owns a short-lived lifetime (2 s
 * budget, mirroring `tasks/complete.ts`) that starts when THIS saga's typed
 * check begins — not when the sweep was admitted — so a long multi-saga
 * sweep cannot starve later typed sagas of budget or abort the whole run.
 * `close()` releases the owned lifetime and must run once the saga settles.
 */
function createSagaTypedValidator(
  projectRoot: string,
  callerExecution: OperationExecutionContext | undefined,
): { validate: SagaTypedValidator; close: () => void } {
  let execution = callerExecution;
  let ownedExecution: OperationExecutionContext | undefined;
  const validate: SagaTypedValidator = async (task, criteriaSource, receiptSource) => {
    execution?.assertActive();
    const criteria = await criteriaSource.getAcRows(task.id);
    if (
      !(task.acceptance ?? []).some((item) => typeof item !== 'string') &&
      !criteria.some((row) => row.kind === 'evidence_bound')
    )
      return execution;
    if (!execution) {
      const info = readProjectInfoAtDirectorySync(projectRoot, join(projectRoot, '.cleo'));
      if (!info.projectId) throw new Error('Typed reconciliation requires stable project identity');
      ownedExecution = createOperationExecutionContext(
        {
          projectId: info.projectId,
          projectRoot,
          actor: process.env.CLEO_AGENT_ID ?? 'cleo',
          operation: 'tasks.saga.reconcile',
          idempotencyKey: `${task.id}:${randomUUID()}`,
        },
        { budgetMs: 2000 },
      );
      execution = ownedExecution;
    }
    await validateTaskGateCompletion(task, criteria, { projectRoot, execution }, receiptSource, {
      allowCachedGates: readAllowCachedGates(projectRoot),
    });
    execution.assertActive();
    return execution;
  };
  return { validate, close: () => ownedExecution?.close() };
}

/**
 * Check that the saga and its membership still match what the lock-guarded
 * read path observed, so a closure is never written against drifted state.
 */
function assertSagaUnchanged(
  sagaId: string,
  sagaTask: Task | null,
  currentMembers: readonly Task[],
  memberIds: readonly string[],
): asserts sagaTask is Task {
  if (!sagaTask || sagaTask.type !== 'saga')
    throw new Error(`Saga ${sagaId} disappeared or changed identity before closure`);
  if (sagaTask.status === 'done')
    throw new Error(`Saga ${sagaId} changed status before closure; retry reconciliation`);
  if (
    currentMembers.length !== memberIds.length ||
    currentMembers.some(
      (member) => !memberIds.includes(member.id) || !TERMINAL_STATUSES.has(member.status),
    )
  )
    throw new Error(`Saga ${sagaId} membership or terminal state changed before closure`);
}

/**
 * Validate — and, unless `dryRun`, close — one saga whose members are all
 * terminal.
 *
 * **Real run**: everything happens inside ONE `BEGIN IMMEDIATE` write
 * transaction (the same boundary `completeTask` uses, T10595): the saga row
 * and its members are re-read after the write lock is held, typed completion
 * is validated against the transaction's criteria rows, and the saga upsert
 * plus the `saga_reconciled` receipt in `tasks_audit_log` commit or roll back
 * together. A failed receipt write therefore leaves the saga untouched.
 *
 * Reads inside the transaction go through the outer accessor: the
 * `TransactionAccessor` contract exposes no `loadSingleTask`, and the outer
 * accessor shares the transaction's native handle, so those reads observe the
 * locked, current state (identical to `completeTask`).
 *
 * **Dry run**: performs the same drift and typed-completion checks WITHOUT
 * opening a write transaction. A report-only preview must not take the tasks
 * DB write lock and serialize real writers behind it; the price is that the
 * preview reads an ordinary snapshot, which is all a preview can promise.
 */
async function applyAutoClose(
  projectRoot: string,
  sagaId: string,
  memberIds: readonly string[],
  timestamp: string,
  dryRun: boolean,
  validateTyped: SagaTypedValidator,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    // Lazy import keeps the data-accessor graph out of read-only discovery.
    const { getTaskAccessor } = await import('../store/data-accessor.js');
    const accessor = await getTaskAccessor(projectRoot);

    if (dryRun) {
      const sagaTask = await accessor.loadSingleTask(sagaId);
      assertSagaUnchanged(sagaId, sagaTask, await accessor.getChildren(sagaId), memberIds);
      await validateTyped(sagaTask, accessor, accessor);
      return { ok: true };
    }

    await accessor.transaction(async (tx) => {
      const sagaTask = await accessor.loadSingleTask(sagaId);
      assertSagaUnchanged(sagaId, sagaTask, await tx.getChildren(sagaId), memberIds);
      const execution = await validateTyped(sagaTask, tx, accessor);
      const statusBefore = sagaTask.status;
      const gateResults = sagaTask.verification?.gateResults;
      sagaTask.status = 'done';
      sagaTask.completedAt = timestamp;
      sagaTask.updatedAt = timestamp;
      // T871: keep pipelineStage aligned with status='done' without
      // overwriting an already-terminal stage (mirrors completeTask).
      if (!isTerminalPipelineStage(sagaTask.pipelineStage)) {
        sagaTask.pipelineStage = 'contribution';
      }
      // Preserve authentic typed results so the closed saga still proves them.
      sagaTask.verification = {
        ...buildSagaAutoCloseEvidence(sagaId, memberIds, timestamp),
        ...(gateResults ? { gateResults } : {}),
      };
      const commit = async (): Promise<void> => {
        // Re-validate the row actually being written, as completeTask does.
        await validateTyped(sagaTask, tx, accessor);
        execution?.assertActive();
        await tx.upsertSingleTask(sagaTask);
        await tx.appendLog({
          id: `log-${randomUUID()}`,
          timestamp,
          action: SAGA_RECONCILE_RECEIPT_ACTION,
          taskId: sagaId,
          actor: execution?.identity.actor ?? 'system',
          details: { members: [...memberIds], reason: SAGA_RECONCILE_CLOSE_REASON },
          before: { status: statusBefore },
          after: { status: 'done' },
        });
        execution?.assertActive();
      };
      if (execution)
        await worktreeScope.run(
          captureProjectScope(projectRoot, {
            ...captureProjectScope(projectRoot, worktreeScope.getStore()),
            execution,
          }),
          commit,
        );
      else await commit();
    });
    return { ok: true };
  } catch (error) {
    // A cancelled/expired caller lifetime is an operation failure, never a
    // per-saga error entry.
    worktreeScope.getStore()?.execution?.assertActive();
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
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
  validateTyped: SagaTypedValidator,
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

    // Resolve members via parent_id containment.
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

    // Dry-run uses the same current authority check; it omits only the writes.
    {
      const writeResult = await applyAutoClose(
        projectRoot,
        sagaId,
        terminal,
        timestamp,
        dryRun,
        validateTyped,
      );
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
 *   2. Resolves members via `parent_id` containment.
 *   3. If all members are terminal AND the saga itself is not `done`,
 *      validates the saga's typed completion criteria and flips
 *      `status='done'` inside one write transaction that also writes a
 *      `saga_reconciled` receipt to `tasks_audit_log` (all-or-nothing).
 *   4. Releases the lock.
 *   5. Appends a JSON-line entry to `.cleo/audit/saga-reconcile.jsonl`.
 *
 * Typed validation runs under the caller's execution lifetime when one is
 * in scope; a cancelled or expired caller lifetime rejects the whole call
 * rather than being renewed. Without one, each typed saga gets its own
 * short-lived lifetime (2 s budget from the start of its typed check); an
 * expired owned lifetime fails only that saga (`action: 'error'`).
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
  projectRoot = resolve(projectRoot);
  const inherited = captureProjectScope(projectRoot, worktreeScope.getStore());
  const callerExecution = inherited.execution;
  return worktreeScope.run(inherited, async () => {
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
      callerExecution?.assertActive();
      const typed = createSagaTypedValidator(projectRoot, callerExecution);
      let entry: SagaReconcileEntry;
      try {
        entry = await reconcileOneSaga(projectRoot, sagaId, dryRun, typed.validate);
      } finally {
        typed.close();
      }
      // Only the CALLER's lifetime can abort the sweep; a per-saga owned
      // lifetime that expired has already surfaced as that saga's error.
      callerExecution?.assertActive();
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
  });
}
