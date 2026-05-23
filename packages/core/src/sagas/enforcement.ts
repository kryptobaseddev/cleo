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
 * Determine whether a task row carries the `'saga'` label.
 *
 * @param labels - The task's labels array (may be undefined / empty).
 * @returns True when `'saga'` appears in the label list.
 */
function hasSagaLabel(labels: readonly string[] | undefined): boolean {
  return Array.isArray(labels) && labels.includes(SAGA_LABEL);
}

/**
 * SagaTask — the narrowed Task shape the saga invariant gates operate on.
 *
 * This is a deprecation-window discriminated union (T10330, Saga T10326
 * SG-SUBSTRATE-RECONCILIATION). It accepts EITHER:
 *
 * - **New shape** (post-T10277): `type === 'saga'` — the first-class TaskType
 *   introduced by Wave 1 (T10328 contracts + T10329 schema migration).
 * - **Old shape** (deprecation window): `type === 'epic' && labels.includes('saga')`
 *   — the pre-T10277 storage shape, still present for not-yet-migrated rows
 *   in long-lived sessions. Removed in W3.C cutover (T10334).
 *
 * Callers narrow with {@link isSagaShape} before invoking the gates. The
 * gate bodies never read `type`, so the union is safe — they only check
 * `id`, `parentId`, `depends` which are common to both shapes.
 *
 * @see ADR-083 §2.5 — Saga as first-class TaskType
 * @see ADR-073 §1.2 — Invariants I3 / I5 / I7
 * @task T10330
 * @saga T10326
 */
export type SagaTask = (Task & { type: 'saga' }) | (Task & { type: 'epic' });

/**
 * Type predicate — true when `task` carries either the new-shape saga
 * discriminator (`type === 'saga'`) or the old-shape saga marker
 * (`type === 'epic' && labels.includes('saga')`).
 *
 * The deprecation-window dual acceptance is intentional: while not-yet-
 * migrated rows still exist in long-lived sessions, both shapes MUST be
 * recognised as sagas. W3.C cutover (T10334) drops the old-shape branch.
 *
 * Use this BEFORE passing a {@link Task} to the saga invariant gates —
 * replaces the legacy soft early-return on `labels.includes('saga')`.
 *
 * @param task - Task row to inspect.
 * @returns True when the task is a saga in either shape.
 *
 * @example
 * ```typescript
 * if (isSagaShape(task)) {
 *   // task is now narrowed to SagaTask — safe to pass to gates.
 *   assertSagaInvariantI3(task);
 *   assertSagaInvariantI5(task);
 * }
 * ```
 *
 * @task T10330
 * @saga T10326
 * @see ADR-083 §2.5
 */
export function isSagaShape(task: Task): task is SagaTask {
  // New shape — first-class 'saga' TaskType (T10277 cutover).
  if (task.type === 'saga') {
    return true;
  }
  // Old shape — labelled epic (deprecation-window dual acceptance, T10334 drops).
  if (task.type === 'epic' && hasSagaLabel(task.labels)) {
    return true;
  }
  return false;
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
 * ADR-073 §1.2 invariant **I3** — sagas link via
 * `task_relations.type='groups'` only.
 *
 * A saga MUST NOT carry `parentId` or any entries in `depends`. Member
 * discovery flows through `task_relations.type='groups'`; a parent or
 * depends edge would re-introduce the depth-budget consumption the saga
 * tier was created to avoid.
 *
 * The gate accepts a {@link SagaTask} (new or old shape — see
 * deprecation-window dual acceptance). Callers narrow via {@link isSagaShape}
 * before invoking — the soft `labels.includes('saga')` early-return that
 * previously lived in this function has been REMOVED in favour of
 * compile-time TypeScript narrowing (T10330, ADR-083 §2.5).
 *
 * @param saga - Saga-shaped task row, pre-narrowed by {@link isSagaShape}.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I3} when the row violates I3.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10330
 * @saga T10326
 */
export function assertSagaInvariantI3(saga: SagaTask): void {
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
 * `parentId` on a saga row is a storage corruption / import bug.
 *
 * The gate accepts a {@link SagaTask} (new or old shape — see
 * deprecation-window dual acceptance). Callers narrow via {@link isSagaShape}
 * before invoking — the soft `labels.includes('saga')` early-return that
 * previously lived in this function has been REMOVED in favour of
 * compile-time TypeScript narrowing (T10330, ADR-083 §2.5).
 *
 * @param saga - Saga-shaped task row, pre-narrowed by {@link isSagaShape}.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I5} when the row violates I5.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10330
 * @saga T10326
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
 * A saga-member candidate (i.e. a task being linked into a saga via
 * `task_relations.type='groups'`) MUST NOT itself be saga-shaped. Nested
 * sagas would re-introduce the multi-release grouping depth the tier was
 * created to flatten.
 *
 * The retained `(candidateId, candidateLabels, sagaId?)` signature exists
 * for caller compat during the Saga T10326 sweep — callers that hold only
 * an ID + labels (e.g. partial task rows from saga-audit) can still invoke
 * it directly. Internally the predicate runs both shapes:
 *
 * - **New shape**: `candidateType === 'saga'` (synthesised by the typed
 *   overload below).
 * - **Old shape**: `candidateLabels.includes('saga')` (deprecation window).
 *
 * The {@link assertSagaInvariantI7Typed} overload accepts a pre-narrowed
 * {@link SagaTask} for callers that already hold a full task — passing a
 * `SagaTask` is itself proof of the violation (the candidate IS saga-shaped),
 * so the typed overload always throws.
 *
 * @param candidateId - Task ID being considered as a saga member.
 * @param candidateLabels - The candidate's labels array.
 * @param sagaId - Optional ID of the saga the candidate would be linked into
 *   (surfaced in the diag payload when provided).
 * @param candidateType - Optional new-shape TaskType discriminator. When
 *   `'saga'` is supplied, the gate fires regardless of `candidateLabels`.
 * @throws {@link SagaInvariantViolationError} with
 *   {@link E_SAGA_INVARIANT_VIOLATION_I7} when the candidate is a saga
 *   under either shape.
 *
 * @see ADR-073-above-epic-naming.md §1.2
 * @task T10330
 * @saga T10326
 */
export function assertSagaInvariantI7(
  candidateId: string,
  candidateLabels: readonly string[],
  sagaId?: string,
  candidateType?: Task['type'],
): void {
  // New-shape acceptance: type='saga' discriminator (post-T10277 cutover).
  const isNewShapeSaga = candidateType === 'saga';
  // Old-shape acceptance: epic + 'saga' label (deprecation window — T10334 drops).
  const isOldShapeSaga = hasSagaLabel(candidateLabels);
  if (!isNewShapeSaga && !isOldShapeSaga) {
    return;
  }
  throw new SagaInvariantViolationError(
    E_SAGA_INVARIANT_VIOLATION_I7,
    `E_SAGA_INVARIANT_VIOLATION_I7: candidate '${candidateId}' already has label='${SAGA_LABEL}'; ` +
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
 * @task T10330
 * @saga T10326
 */
export function assertSagaInvariantI7Typed(candidate: SagaTask, sagaId?: string): void {
  assertSagaInvariantI7(candidate.id, candidate.labels ?? [], sagaId, candidate.type);
}
