/**
 * Saga enforcement — pure-function runtime gates for ADR-073 invariants.
 *
 * Each guard accepts already-loaded task data and throws
 * {@link SagaInvariantViolationError} when an invariant is breached. The
 * guards perform NO database access — callers (dispatch handlers, doctor
 * audits) are responsible for resolving rows first and passing them in.
 *
 * After T10636 (E10.W5 type=saga migration) and T10638 (legacy fallback
 * removal), Sagas are identified solely by `type='saga'`. The legacy
 * `labels.includes('saga')` fallback, `hasSagaLabel` helper, and
 * `SagaTask` discriminated union have been removed.
 *
 * @task T10115
 * @task T10638 — E10.W5 legacy fallback removal
 * @saga T10113 — SG-SAGA-FIRST-CLASS
 * @epic T10209 — E-SAGA-ENFORCEMENT
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type { Task } from '@cleocode/contracts';

/**
 * SagaTask — the narrowed Task shape the saga invariant gates operate on.
 *
 * After T10638, only `type='saga'` rows are recognised as sagas.
 * Callers narrow with {@link isSagaShape} before invoking the gates.
 *
 * @see ADR-083 §2.5 — Saga as first-class TaskType
 * @see ADR-073 §1.2 — Invariants I3 / I5 / I7
 * @task T10638
 */
export type SagaTask = Task & { type: 'saga' };

/**
 * Type predicate — true when `task.type === 'saga'`.
 *
 * After T10638, only the canonical `type='saga'` shape is recognised.
 * Use this BEFORE passing a {@link Task} to the saga invariant gates.
 *
 * @param task - Task row to inspect.
 * @returns True when the task is a saga.
 *
 * @task T10638
 * @see ADR-083 §2.5
 */
export function isSagaShape(task: Task): task is SagaTask {
  return task.type === 'saga';
}

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
 * ADR-073 §1.2 invariant **I3** — sagas are top-level, no parent/depends edges.
 *
 * A saga MUST NOT carry `parentId` or any entries in `depends`. Member
 * Epics link to the saga via `parent_id` containment (T10637 migration).
 *
 * @param saga - Saga-shaped task row, pre-narrowed by {@link isSagaShape}.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I3} when the row violates I3.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10638
 */
export function assertSagaInvariantI3(saga: SagaTask): void {
  if (saga.parentId != null && saga.parentId !== '') {
    throw new SagaInvariantViolationError(
      E_SAGA_INVARIANT_VIOLATION_I3,
      `E_SAGA_INVARIANT_VIOLATION_I3: saga '${saga.id}' has parentId='${saga.parentId}'; ` +
        'sagas MUST be top-level (ADR-073 §1.2 I3).',
      { sagaId: saga.id, offendingId: saga.id, invariant: 'I3' },
    );
  }
  if (Array.isArray(saga.depends) && saga.depends.length > 0) {
    throw new SagaInvariantViolationError(
      E_SAGA_INVARIANT_VIOLATION_I3,
      `E_SAGA_INVARIANT_VIOLATION_I3: saga '${saga.id}' has ${saga.depends.length} depends edge(s); ` +
        'sagas MUST be top-level (ADR-073 §1.2 I3).',
      { sagaId: saga.id, offendingId: saga.id, invariant: 'I3' },
    );
  }
}

/**
 * ADR-073 §1.2 invariant **I5** — a saga row's `parentId` MUST be NULL.
 *
 * Sagas are top-level groupings; they do not nest under any task. A non-null
 * `parentId` on a saga row is a storage corruption / import bug.
 *
 * @param saga - Saga-shaped task row, pre-narrowed by {@link isSagaShape}.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I5} when the row violates I5.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10638
 */
export function assertSagaInvariantI5(saga: SagaTask): void {
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
 * A saga-member candidate MUST NOT itself be saga-shaped (`type='saga'`).
 * Nested sagas would re-introduce the multi-release grouping depth the
 * tier was created to flatten.
 *
 * After T10638, only `candidateType === 'saga'` triggers the guard.
 *
 * @param candidateId - Task ID being considered as a saga member.
 * @param _candidateLabels - Deprecated; no longer used post-T10638.
 * @param sagaId - Optional ID of the saga the candidate would be linked into.
 * @param candidateType - The candidate's TaskType discriminator.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I7} when the candidate is a saga.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10638
 */
export function assertSagaInvariantI7(
  candidateId: string,
  _candidateLabels: readonly string[],
  sagaId?: string,
  candidateType?: Task['type'],
): void {
  if (candidateType !== 'saga') return;
  throw new SagaInvariantViolationError(
    E_SAGA_INVARIANT_VIOLATION_I7,
    `E_SAGA_INVARIANT_VIOLATION_I7: candidate '${candidateId}' has type='saga'; ` +
      'nested sagas are forbidden (ADR-073 §1.2 I7).',
    { sagaId, offendingId: candidateId, invariant: 'I7' },
  );
}

/**
 * Typed overload of {@link assertSagaInvariantI7} — accepts a pre-narrowed
 * {@link SagaTask}. Passing a `SagaTask` is itself proof of I7 violation
 * (the candidate IS saga-shaped), so this overload always throws.
 *
 * Prefer this entry point when the caller already holds a full task row
 * and has narrowed via {@link isSagaShape}.
 *
 * @param candidate - Pre-narrowed saga-shaped candidate task.
 * @param sagaId - Optional ID of the saga the candidate would be linked into.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I7} — always, since input is saga-shaped.
 *
 * @task T10638
 */
export function assertSagaInvariantI7Typed(candidate: SagaTask, sagaId?: string): void {
  assertSagaInvariantI7(candidate.id, candidate.labels ?? [], sagaId, candidate.type);
}
