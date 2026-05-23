/**
 * Saga enforcement — pure-function runtime gates for ADR-073 invariants.
 *
 * Each guard accepts already-loaded task data and throws
 * {@link SagaInvariantViolationError} when an invariant is breached. The
 * guards perform NO database access — callers (dispatch handlers, doctor
 * audits) are responsible for resolving rows first and passing them in.
 *
 * Wiring into the saga-write paths (`sagaAdd`, `sagaCreate`, ...) is the
 * scope of T10118. Wiring into the doctor audit is T10119. This module
 * exposes the guards in isolation so they can be unit-tested without a
 * database fixture and reused by both runtime + audit callers.
 *
 * @task T10115
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type { Task } from '@cleocode/contracts';
import { SAGA_LABEL } from './constants.js';

/**
 * LAFS error code for a saga-labeled epic that carries forbidden parent or
 * `depends` edges (ADR-073 §1.2 invariant I3).
 */
export const E_SAGA_INVARIANT_VIOLATION_I3 = 'E_SAGA_INVARIANT_VIOLATION_I3' as const;

/**
 * LAFS error code for a saga row whose `parentId` is non-null
 * (ADR-073 §1.2 invariant I5).
 */
export const E_SAGA_INVARIANT_VIOLATION_I5 = 'E_SAGA_INVARIANT_VIOLATION_I5' as const;

/**
 * LAFS error code for a saga-member candidate that is itself a saga
 * (ADR-073 §1.2 invariant I7 — no nested sagas).
 */
export const E_SAGA_INVARIANT_VIOLATION_I7 = 'E_SAGA_INVARIANT_VIOLATION_I7' as const;

/**
 * Union of stable error codes emitted by the saga enforcement guards.
 */
export type SagaInvariantCode =
  | typeof E_SAGA_INVARIANT_VIOLATION_I3
  | typeof E_SAGA_INVARIANT_VIOLATION_I5
  | typeof E_SAGA_INVARIANT_VIOLATION_I7;

/**
 * Structured diagnostic payload attached to every saga invariant violation.
 *
 * Mirrors the LAFS `meta` shape so dispatch handlers can forward it into the
 * envelope without re-shaping.
 */
export interface SagaInvariantDiag {
  /** Saga task ID (when known). */
  sagaId?: string;
  /** Offending task ID — the row that violated the invariant. */
  offendingId?: string;
  /** Stable invariant identifier (e.g. `'I3'`, `'I5'`, `'I7'`). */
  invariant: 'I3' | 'I5' | 'I7';
}

/**
 * Thrown by the saga enforcement guards when an ADR-073 §1.2 invariant is
 * violated. Carries a stable `.code` and a structured `.diag` payload so
 * dispatch handlers can surface a typed LAFS error rather than a generic
 * `Error`.
 *
 * @example
 * ```typescript
 * try {
 *   assertSagaInvariantI3(saga);
 * } catch (err) {
 *   if (err instanceof SagaInvariantViolationError) {
 *     // err.code === 'E_SAGA_INVARIANT_VIOLATION_I3'
 *     // err.diag.invariant === 'I3'
 *   }
 * }
 * ```
 */
export class SagaInvariantViolationError extends Error {
  /**
   * @param code - Stable LAFS error code for the violated invariant.
   * @param message - Human-readable description of the violation.
   * @param diag - Structured diagnostic payload (saga / offending IDs, invariant tag).
   */
  constructor(
    public readonly code: SagaInvariantCode,
    message: string,
    public readonly diag: SagaInvariantDiag,
  ) {
    super(message);
    this.name = 'SagaInvariantViolationError';
  }
}

/**
 * Type guard — true when `value` is a {@link SagaInvariantViolationError}.
 *
 * Useful in dispatch handlers that need to forward `.code` + `.diag` into a
 * LAFS envelope without instanceof-ing across module boundaries.
 *
 * @param value - Any thrown value.
 * @returns True when the value is a SagaInvariantViolationError.
 */
export function isSagaInvariantViolationError(
  value: unknown,
): value is SagaInvariantViolationError {
  return value instanceof SagaInvariantViolationError;
}

/**
 * Determine whether a task row carries the `'saga'` label.
 *
 * @param labels - The task's labels array (may be undefined / empty).
 * @returns True when `'saga'` appears in the label list.
 */
function hasSagaLabel(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(SAGA_LABEL);
}

/**
 * ADR-073 §1.2 invariant **I3** — sagas link via
 * `task_relations.type='groups'` only.
 *
 * A saga-labeled epic MUST NOT carry `parentId` or any entries in `depends`.
 * Member discovery flows through `task_relations.type='groups'`; a parent or
 * depends edge would re-introduce the depth-budget consumption the saga tier
 * was created to avoid.
 *
 * The guard is a no-op when the input is not a saga (no `'saga'` label) —
 * callers can pass any task without first filtering.
 *
 * @param saga - Task row to check.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I3} when the row violates I3.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 */
export function assertSagaInvariantI3(saga: Task): void {
  if (!hasSagaLabel(saga.labels)) {
    return;
  }
  if (saga.parentId != null && saga.parentId !== '') {
    throw new SagaInvariantViolationError(
      E_SAGA_INVARIANT_VIOLATION_I3,
      `E_SAGA_INVARIANT_VIOLATION_I3: saga '${saga.id}' has parentId='${saga.parentId}'; ` +
        "sagas MUST link to members via task_relations.type='groups' (ADR-073 §1.2 I3).",
      { sagaId: saga.id, offendingId: saga.id, invariant: 'I3' },
    );
  }
  if (Array.isArray(saga.depends) && saga.depends.length > 0) {
    throw new SagaInvariantViolationError(
      E_SAGA_INVARIANT_VIOLATION_I3,
      `E_SAGA_INVARIANT_VIOLATION_I3: saga '${saga.id}' has ${saga.depends.length} depends edge(s); ` +
        "sagas MUST link only via task_relations.type='groups' (ADR-073 §1.2 I3).",
      { sagaId: saga.id, offendingId: saga.id, invariant: 'I3' },
    );
  }
}

/**
 * ADR-073 §1.2 invariant **I5** — a saga row's `parentId` MUST be NULL.
 *
 * Sagas are top-level groupings; they do not nest under any task. A non-null
 * `parentId` on a saga-labeled row is a storage corruption / import bug.
 *
 * The guard is a no-op when the input is not a saga (no `'saga'` label).
 *
 * @param saga - Task row to check.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I5} when the row violates I5.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 */
export function assertSagaInvariantI5(saga: Task): void {
  if (!hasSagaLabel(saga.labels)) {
    return;
  }
  if (saga.parentId != null && saga.parentId !== '') {
    throw new SagaInvariantViolationError(
      E_SAGA_INVARIANT_VIOLATION_I5,
      `E_SAGA_INVARIANT_VIOLATION_I5: saga '${saga.id}' has parentId='${saga.parentId}', expected NULL ` +
        '(ADR-073 §1.2 I5 — sagas are top-level).',
      { sagaId: saga.id, offendingId: saga.id, invariant: 'I5' },
    );
  }
}

/**
 * ADR-073 §1.2 invariant **I7** — no nested sagas.
 *
 * A saga-member candidate (i.e. a task being linked into a saga via
 * `task_relations.type='groups'`) MUST NOT itself carry the `'saga'` label.
 * Nested sagas would re-introduce the multi-release grouping depth the tier
 * was created to flatten.
 *
 * @param candidateId - Task ID being considered as a saga member.
 * @param candidateLabels - The candidate's labels array.
 * @param sagaId - Optional ID of the saga the candidate would be linked into
 *   (surfaced in the diag payload when provided).
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I7} when the candidate is a saga.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 */
export function assertSagaInvariantI7(
  candidateId: string,
  candidateLabels: readonly string[],
  sagaId?: string,
): void {
  if (!hasSagaLabel(candidateLabels)) {
    return;
  }
  throw new SagaInvariantViolationError(
    E_SAGA_INVARIANT_VIOLATION_I7,
    `E_SAGA_INVARIANT_VIOLATION_I7: candidate '${candidateId}' already has label='${SAGA_LABEL}'; ` +
      'nested sagas are forbidden (ADR-073 §1.2 I7).',
    { sagaId, offendingId: candidateId, invariant: 'I7' },
  );
}
