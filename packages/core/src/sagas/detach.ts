/**
 * saga.detach — remove a `task_relations.type='groups'` edge between a Saga
 * and a member.
 *
 * Idempotent: re-running against a relation that no longer exists succeeds
 * with `removed: false`. Every invocation (whether or not it removed a row)
 * appends a single JSON line to `.cleo/audit/saga-detach.jsonl` so the
 * repair history is auditable — mirroring the append-only pattern used by
 * `appendContractViolation` in `audit.ts`.
 *
 * Primary use case: repair ADR-073 §1.2 invariant I7 violations (a saga
 * accidentally linked as a member of another saga — historical
 * T9831-nested-in-T9799 scenario). Dogfooded in the T10118 ship PR.
 *
 * @task T10118
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1.2
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type EngineResult, engineError, engineSuccess } from '../engine-result.js';
import { getLogger } from '../logger.js';
import { taskRelates, taskRelatesRemove } from '../tasks/task-ops.js';
import { SAGA_GROUPS_RELATION } from './constants.js';

const log = getLogger('sagas:detach');

/** Relative path within project root for the saga-detach audit log. */
export const SAGA_DETACH_AUDIT_FILE = '.cleo/audit/saga-detach.jsonl';

/** Default human-readable reason recorded when the caller does not supply one. */
export const SAGA_DETACH_DEFAULT_REASON = 'ADR-073 I7 violation repair';

/** Input parameters for {@link detachSagaMember}. */
export interface DetachSagaMemberParams {
  /** Saga task ID (the `from` side of the groups relation). */
  sagaId: string;
  /** Member task ID (the `to` side of the groups relation). */
  memberId: string;
  /** Optional human-readable reason recorded in the audit entry. */
  reason?: string;
}

/** Result payload for {@link detachSagaMember}. */
export interface DetachResult {
  sagaId: string;
  memberId: string;
  /** True when an actual row was removed; false on idempotent no-op. */
  removed: boolean;
  /** Reason recorded in the audit log entry. */
  reason: string;
  /** ISO 8601 timestamp recorded in the audit log entry. */
  timestamp: string;
}

/** Single JSON-line entry written to `.cleo/audit/saga-detach.jsonl`. */
interface SagaDetachAuditEntry {
  timestamp: string;
  sagaId: string;
  memberId: string;
  removed: boolean;
  reason: string;
}

/**
 * Append a single JSON-line entry to the saga-detach audit log. Errors are
 * swallowed: audit writes MUST NOT block the operation.
 */
function appendSagaDetachAudit(projectRoot: string, entry: SagaDetachAuditEntry): void {
  try {
    const filePath = join(projectRoot, SAGA_DETACH_AUDIT_FILE);
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { encoding: 'utf-8' });
  } catch (err: unknown) {
    log.warn({ err }, 'Failed to append saga-detach audit entry — continuing');
  }
}

/**
 * Remove a single `task_relations.type='groups'` row between a Saga and a
 * member. Idempotent — if the relation does not exist the call still
 * succeeds with `removed: false`. Always appends an entry to
 * `.cleo/audit/saga-detach.jsonl`.
 *
 * Used to repair an ADR-073 §1.2 invariant I7 violation (a nested-saga
 * relation that bypassed `sagaAdd`'s pre-T10118 add path).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - sagaId + memberId of the groups relation to remove.
 * @returns EngineResult with `{ sagaId, memberId, removed, reason, timestamp }`.
 *
 * @example
 * ```typescript
 * const result = await detachSagaMember('/repo', {
 *   sagaId: 'T9799',
 *   memberId: 'T9831',
 *   reason: 'ADR-073 I7 violation repair',
 * });
 * // result.data.removed === true on first call, false on subsequent calls.
 * ```
 */
export async function detachSagaMember(
  projectRoot: string,
  params: DetachSagaMemberParams,
): Promise<EngineResult<DetachResult>> {
  const sagaId = params.sagaId;
  const memberId = params.memberId;
  if (!sagaId || !memberId) {
    return engineError('E_INVALID_INPUT', 'sagaId and memberId are required');
  }
  const reason = params.reason ?? SAGA_DETACH_DEFAULT_REASON;
  const timestamp = new Date().toISOString();

  // Detect existing-relation state BEFORE deletion. `taskRelatesRemove`
  // returns `removed: true` whether or not a row actually existed (the
  // underlying drizzle DELETE is a no-op when 0 rows match) — so we
  // inspect the saga's current relations to report idempotency accurately.
  const relationsBefore = await taskRelates(projectRoot, sagaId);
  if (!relationsBefore.success) {
    return engineError(
      'E_GENERAL',
      relationsBefore.error?.message ?? 'Failed to read saga relations before detach',
    );
  }
  const existedBefore =
    relationsBefore.data?.relations?.some(
      (r) => r.type === SAGA_GROUPS_RELATION && r.taskId === memberId,
    ) ?? false;

  const relResult = await taskRelatesRemove(projectRoot, sagaId, memberId, SAGA_GROUPS_RELATION);
  if (!relResult.success) {
    // Persist a failure-shaped audit entry so the attempted repair is still
    // recoverable from the journal even on the error path.
    appendSagaDetachAudit(projectRoot, {
      timestamp,
      sagaId,
      memberId,
      removed: false,
      reason: `${reason} (failed: ${relResult.error?.message ?? 'unknown error'})`,
    });
    return engineError(
      'E_GENERAL',
      relResult.error?.message ?? 'Failed to remove saga member relation',
    );
  }

  // `removed` reflects ACTUAL state change, not just success.
  const removed = existedBefore;
  appendSagaDetachAudit(projectRoot, { timestamp, sagaId, memberId, removed, reason });
  return engineSuccess({ sagaId, memberId, removed, reason, timestamp });
}
