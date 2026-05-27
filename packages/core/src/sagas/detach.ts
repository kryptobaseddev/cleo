/**
 * saga.detach — remove a Saga member by clearing its `parentId` containment edge.
 *
 * Idempotent: re-running against a member that is no longer parented to the Saga succeeds
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
import { taskShow } from '../tasks/show.js';
import { coreTaskReparent } from '../tasks/task-reparent.js';

const log = getLogger('sagas:detach');

/** Relative path within project root for the saga-detach audit log. */
export const SAGA_DETACH_AUDIT_FILE = '.cleo/audit/saga-detach.jsonl';

/** Default human-readable reason recorded when the caller does not supply one. */
export const SAGA_DETACH_DEFAULT_REASON = 'ADR-073 I7 violation repair';

/** Input parameters for {@link detachSagaMember}. */
export interface DetachSagaMemberParams {
  /** Saga task ID whose member should be detached. */
  sagaId: string;
  /** Member Epic task ID to detach. */
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
  * Clear the `parentId` edge between a Saga and a member Epic.
  * Idempotent — if the member is not parented to the Saga the call still
 * succeeds with `removed: false`. Always appends an entry to
 * `.cleo/audit/saga-detach.jsonl`.
 *
 * Used to repair an ADR-073 §1.2 invariant I7 violation (a nested-saga
 * relation that bypassed `sagaAdd`'s pre-T10118 add path).
 *
 * @param projectRoot - Absolute path to the project root.
 * @param params - sagaId + memberId of the containment edge to remove.
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

  const sagaResult = await taskShow(projectRoot, sagaId);
  if (!sagaResult.success || !sagaResult.data) {
    return engineError('E_NOT_FOUND', `Saga not found: ${sagaId}`);
  }
  if (sagaResult.data.task.type !== 'saga') {
    return engineError(
      'E_INVALID_INPUT',
      `Task ${sagaId} has type='${String(sagaResult.data.task.type)}', expected type='saga'`,
    );
  }

  const memberResult = await taskShow(projectRoot, memberId);
  if (!memberResult.success || !memberResult.data) {
    return engineError('E_NOT_FOUND', `Saga member not found: ${memberId}`);
  }

  const removed = memberResult.data.task.parentId === sagaId;
  if (removed) {
    try {
      await coreTaskReparent(projectRoot, memberId, null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      appendSagaDetachAudit(projectRoot, {
        timestamp,
        sagaId,
        memberId,
        removed: false,
        reason: `${reason} (failed: ${message})`,
      });
      return engineError('E_GENERAL', `Failed to detach saga member: ${message}`);
    }
  }

  if (!removed && memberResult.data.task.parentId) {
    // Persist a failure-shaped audit entry so the attempted repair is still
    // recoverable from the journal when the caller targeted the wrong Saga.
    appendSagaDetachAudit(projectRoot, {
      timestamp,
      sagaId,
      memberId,
      removed: false,
      reason: `${reason} (no-op: member parent is ${memberResult.data.task.parentId})`,
    });
    return engineSuccess({ sagaId, memberId, removed: false, reason, timestamp });
  }

  appendSagaDetachAudit(projectRoot, { timestamp, sagaId, memberId, removed, reason });
  return engineSuccess({ sagaId, memberId, removed, reason, timestamp });
}
