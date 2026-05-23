/**
 * Unit tests for the saga enforcement guards (ADR-073 §1.2 invariants I3 / I5 / I7).
 *
 * The guards are pure functions — no DB, no filesystem. Tests synthesize
 * minimal {@link Task} fixtures and assert each guard accepts valid input
 * and throws a typed {@link SagaInvariantViolationError} (with stable
 * `.code` and structured `.diag`) on invariant breach.
 *
 * **Dual-shape window (T10330, Saga T10326)**: each gate is now retyped
 * against {@link SagaTask}, a discriminated union that accepts EITHER the
 * new-shape (`type === 'saga'`) row introduced by T10277, OR the old-shape
 * (`type === 'epic' && labels.includes('saga')`) row that pre-existed.
 * The `isSagaShape` predicate replaces the legacy soft early-return.
 *
 * Includes the T9831-nested-in-T9799 regression fixture for I7 — the
 * historical scenario where the orchestrator could have attempted to link a
 * saga (`T9831` SG-ARCH-SOLID) as a member of another saga (`T9799` skill
 * maintenance), which I7 forbids.
 *
 * @task T10115
 * @task T10330
 * @saga T10113
 * @saga T10326
 * @epic T10209
 * @epic T10277 — E-SAGA-TYPE-MIGRATION
 * @see ADR-073-above-epic-naming.md §1.2
 * @see ADR-083 §2.5 — Saga as first-class TaskType
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { SAGA_LABEL } from '../constants.js';
import {
  assertSagaInvariantI3,
  assertSagaInvariantI5,
  assertSagaInvariantI7,
  assertSagaInvariantI7Typed,
  E_SAGA_INVARIANT_VIOLATION_I3,
  E_SAGA_INVARIANT_VIOLATION_I5,
  E_SAGA_INVARIANT_VIOLATION_I7,
  isSagaInvariantViolationError,
  isSagaShape,
  SagaInvariantViolationError,
  type SagaTask,
} from '../enforcement.js';

/** Build a minimal {@link Task} fixture for guard tests. */
function makeTask(overrides: Partial<Task> & Pick<Task, 'id'>): Task {
  return {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    description: overrides.description ?? `Description for ${overrides.id}`,
    status: overrides.status ?? 'pending',
    priority: overrides.priority ?? 'medium',
    type: overrides.type ?? 'epic',
    parentId: overrides.parentId ?? null,
    labels: overrides.labels,
    depends: overrides.depends,
    ...overrides,
  };
}

/** Build a new-shape SagaTask fixture (post-T10277: `type === 'saga'`). */
function makeNewShapeSaga(overrides: Partial<Task> & Pick<Task, 'id'>): SagaTask {
  // The fixture is a SagaTask under the new-shape arm of the union.
  const task = makeTask({ ...overrides, type: 'saga' });
  // Narrow via the predicate — proves the fixture is dual-shape-acceptable.
  if (!isSagaShape(task)) {
    throw new Error('test fixture failed isSagaShape narrowing');
  }
  return task;
}

/** Build an old-shape SagaTask fixture (pre-T10277: `type === 'epic' + 'saga' label`). */
function makeOldShapeSaga(overrides: Partial<Task> & Pick<Task, 'id'>): SagaTask {
  // The fixture is a SagaTask under the old-shape arm of the union.
  const labels = overrides.labels ?? [SAGA_LABEL];
  const task = makeTask({ ...overrides, type: 'epic', labels });
  if (!isSagaShape(task)) {
    throw new Error('test fixture failed isSagaShape narrowing');
  }
  return task;
}

describe('isSagaShape — dual-shape predicate', () => {
  it('returns true for new-shape saga (type=saga)', () => {
    const task = makeTask({ id: 'T9000', type: 'saga' });
    expect(isSagaShape(task)).toBe(true);
  });

  it('returns true for new-shape saga even without saga label', () => {
    const task = makeTask({ id: 'T9000', type: 'saga', labels: [] });
    expect(isSagaShape(task)).toBe(true);
  });

  it('returns true for old-shape saga (epic + saga label)', () => {
    const task = makeTask({ id: 'T9000', type: 'epic', labels: [SAGA_LABEL] });
    expect(isSagaShape(task)).toBe(true);
  });

  it('returns false for an epic without saga label', () => {
    const task = makeTask({ id: 'T9000', type: 'epic', labels: ['feature'] });
    expect(isSagaShape(task)).toBe(false);
  });

  it('returns false for a regular task', () => {
    const task = makeTask({ id: 'T9000', type: 'task' });
    expect(isSagaShape(task)).toBe(false);
  });

  it('returns false for a subtask', () => {
    const task = makeTask({ id: 'T9000', type: 'subtask' });
    expect(isSagaShape(task)).toBe(false);
  });

  it('returns false when labels is undefined and type=epic', () => {
    const task = makeTask({ id: 'T9000', type: 'epic', labels: undefined });
    expect(isSagaShape(task)).toBe(false);
  });
});

describe('assertSagaInvariantI3 — sagas link via groups only', () => {
  it('accepts a valid new-shape saga with no parent and no depends edges', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI3(saga)).not.toThrow();
  });

  it('accepts a valid old-shape saga with no parent and no depends edges', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI3(saga)).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when a new-shape saga has a parentId', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let caught: unknown;
    try {
      assertSagaInvariantI3(saga);
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
    expect(error.diag.invariant).toBe('I3');
    expect(error.diag.sagaId).toBe('T9000');
    expect(error.diag.offendingId).toBe('T9000');
    expect(error.message).toContain('T9000');
    expect(error.message).toContain('parentId');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when an old-shape saga has a parentId', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let caught: unknown;
    try {
      assertSagaInvariantI3(saga);
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
    expect(error.diag.invariant).toBe('I3');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when a saga has depends edges (new shape)', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: null, depends: ['T8100'] });
    expect(() => assertSagaInvariantI3(saga)).toThrow(SagaInvariantViolationError);
    try {
      assertSagaInvariantI3(saga);
    } catch (err) {
      const error = err as SagaInvariantViolationError;
      expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
      expect(error.diag.invariant).toBe('I3');
      expect(error.message).toContain('depends');
    }
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when a saga has depends edges (old shape)', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: null, depends: ['T8100'] });
    expect(() => assertSagaInvariantI3(saga)).toThrow(SagaInvariantViolationError);
  });
});

describe('assertSagaInvariantI5 — saga.parentId MUST be NULL', () => {
  it('accepts a valid new-shape saga with parentId=null', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('accepts a valid old-shape saga with parentId=null', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('accepts a valid saga with parentId omitted (new shape)', () => {
    const saga = makeNewShapeSaga({ id: 'T9000' });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I5 when a new-shape saga has parentId != null', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let caught: unknown;
    try {
      assertSagaInvariantI5(saga);
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
    expect(error.diag.invariant).toBe('I5');
    expect(error.diag.sagaId).toBe('T9000');
    expect(error.diag.offendingId).toBe('T9000');
    expect(error.message).toContain('T9000');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I5 when an old-shape saga has parentId != null', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let caught: unknown;
    try {
      assertSagaInvariantI5(saga);
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
  });

  it('treats empty-string parentId as null on saga (new shape)', () => {
    const saga = makeNewShapeSaga({ id: 'T9000', parentId: '' });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('treats empty-string parentId as null on saga (old shape)', () => {
    const saga = makeOldShapeSaga({ id: 'T9000', parentId: '' });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });
});

describe('assertSagaInvariantI7 — no nested sagas', () => {
  it('accepts a regular epic candidate (no saga label, no saga type)', () => {
    expect(() => assertSagaInvariantI7('T9100', ['feature'])).not.toThrow();
  });

  it('accepts a candidate with empty labels', () => {
    expect(() => assertSagaInvariantI7('T9100', [])).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I7 when the candidate has the saga label (old shape)', () => {
    let caught: unknown;
    try {
      assertSagaInvariantI7('T9100', [SAGA_LABEL], 'T9000');
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag.invariant).toBe('I7');
    expect(error.diag.sagaId).toBe('T9000');
    expect(error.diag.offendingId).toBe('T9100');
    expect(error.message).toContain('T9100');
    expect(error.message).toContain('nested');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I7 when the candidate has type=saga (new shape)', () => {
    let caught: unknown;
    try {
      assertSagaInvariantI7('T9100', [], 'T9000', 'saga');
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag.invariant).toBe('I7');
    expect(error.diag.sagaId).toBe('T9000');
    expect(error.diag.offendingId).toBe('T9100');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I7 when BOTH new and old shape markers present', () => {
    // Belt + braces — type=saga AND label=saga should still fire exactly once.
    expect(() => assertSagaInvariantI7('T9100', [SAGA_LABEL], 'T9000', 'saga')).toThrow(
      SagaInvariantViolationError,
    );
  });

  it('omits sagaId from diag when not provided', () => {
    try {
      assertSagaInvariantI7('T9100', [SAGA_LABEL]);
    } catch (err) {
      const error = err as SagaInvariantViolationError;
      expect(error.diag.sagaId).toBeUndefined();
      expect(error.diag.offendingId).toBe('T9100');
    }
  });

  // ──────────────────────────────────────────────────────────────────────
  // T9831-nested-in-T9799 regression fixture
  //
  // Historical context (see MEMORY.md, Saga T9831 SG-ARCH-SOLID + Saga
  // T9799 skill maintenance discipline). Both T9831 and T9799 are sagas.
  // If a future code path attempted to link T9831 as a member of T9799,
  // I7 must reject it — a saga cannot itself be a saga member.
  // ──────────────────────────────────────────────────────────────────────
  it('regression: rejects linking saga T9831 as a member of saga T9799 (T9831-nested-in-T9799)', () => {
    // T9831 is itself a saga ('SG-ARCH-SOLID') — labels contain 'saga'.
    const candidateLabels = [SAGA_LABEL] as const;
    let caught: unknown;
    try {
      assertSagaInvariantI7('T9831', candidateLabels, 'T9799');
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag).toEqual({
      sagaId: 'T9799',
      offendingId: 'T9831',
      invariant: 'I7',
    });
    expect(error.message).toContain('T9831');
    expect(error.message).toContain(SAGA_LABEL);
  });

  it('regression (new shape): rejects linking a type=saga T9831 as a member of T9799', () => {
    // Post-T10277 migration, T9831 would be stored as type='saga' with no label.
    let caught: unknown;
    try {
      assertSagaInvariantI7('T9831', [], 'T9799', 'saga');
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag).toEqual({
      sagaId: 'T9799',
      offendingId: 'T9831',
      invariant: 'I7',
    });
  });
});

describe('assertSagaInvariantI7Typed — typed overload', () => {
  it('always throws when passed a new-shape SagaTask', () => {
    const candidate = makeNewShapeSaga({ id: 'T9831' });
    let caught: unknown;
    try {
      assertSagaInvariantI7Typed(candidate, 'T9799');
    } catch (err) {
      caught = err;
    }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag.sagaId).toBe('T9799');
    expect(error.diag.offendingId).toBe('T9831');
  });

  it('always throws when passed an old-shape SagaTask', () => {
    const candidate = makeOldShapeSaga({ id: 'T9831' });
    expect(() => assertSagaInvariantI7Typed(candidate, 'T9799')).toThrow(
      SagaInvariantViolationError,
    );
  });

  it('throws with sagaId undefined when not provided', () => {
    const candidate = makeNewShapeSaga({ id: 'T9831' });
    try {
      assertSagaInvariantI7Typed(candidate);
    } catch (err) {
      const error = err as SagaInvariantViolationError;
      expect(error.diag.sagaId).toBeUndefined();
      expect(error.diag.offendingId).toBe('T9831');
    }
  });
});

describe('dual-shape acceptance — identical pass/fail outcomes across shapes', () => {
  it('I3: new and old shape produce identical OK outcome for valid saga', () => {
    const newShape = makeNewShapeSaga({ id: 'T9000', parentId: null });
    const oldShape = makeOldShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI3(newShape)).not.toThrow();
    expect(() => assertSagaInvariantI3(oldShape)).not.toThrow();
  });

  it('I3: new and old shape produce identical FAIL outcome on parentId violation', () => {
    const newShape = makeNewShapeSaga({ id: 'T9000', parentId: 'T8000' });
    const oldShape = makeOldShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let newErr: SagaInvariantViolationError | undefined;
    let oldErr: SagaInvariantViolationError | undefined;
    try {
      assertSagaInvariantI3(newShape);
    } catch (e) {
      newErr = e as SagaInvariantViolationError;
    }
    try {
      assertSagaInvariantI3(oldShape);
    } catch (e) {
      oldErr = e as SagaInvariantViolationError;
    }
    expect(newErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
    expect(oldErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
    expect(newErr?.diag).toEqual(oldErr?.diag);
  });

  it('I5: new and old shape produce identical OK outcome for valid saga', () => {
    const newShape = makeNewShapeSaga({ id: 'T9000', parentId: null });
    const oldShape = makeOldShapeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI5(newShape)).not.toThrow();
    expect(() => assertSagaInvariantI5(oldShape)).not.toThrow();
  });

  it('I5: new and old shape produce identical FAIL outcome on parentId violation', () => {
    const newShape = makeNewShapeSaga({ id: 'T9000', parentId: 'T8000' });
    const oldShape = makeOldShapeSaga({ id: 'T9000', parentId: 'T8000' });
    let newErr: SagaInvariantViolationError | undefined;
    let oldErr: SagaInvariantViolationError | undefined;
    try {
      assertSagaInvariantI5(newShape);
    } catch (e) {
      newErr = e as SagaInvariantViolationError;
    }
    try {
      assertSagaInvariantI5(oldShape);
    } catch (e) {
      oldErr = e as SagaInvariantViolationError;
    }
    expect(newErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
    expect(oldErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I5);
    expect(newErr?.diag).toEqual(oldErr?.diag);
  });

  it('I7: new and old shape candidates produce identical violation outcome', () => {
    let newErr: SagaInvariantViolationError | undefined;
    let oldErr: SagaInvariantViolationError | undefined;
    try {
      assertSagaInvariantI7('T9100', [], 'T9000', 'saga');
    } catch (e) {
      newErr = e as SagaInvariantViolationError;
    }
    try {
      assertSagaInvariantI7('T9100', [SAGA_LABEL], 'T9000');
    } catch (e) {
      oldErr = e as SagaInvariantViolationError;
    }
    expect(newErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(oldErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(newErr?.diag).toEqual(oldErr?.diag);
  });

  it('I7: typed overload produces identical violation outcome across shapes', () => {
    const newShape = makeNewShapeSaga({ id: 'T9100' });
    const oldShape = makeOldShapeSaga({ id: 'T9100' });
    let newErr: SagaInvariantViolationError | undefined;
    let oldErr: SagaInvariantViolationError | undefined;
    try {
      assertSagaInvariantI7Typed(newShape, 'T9000');
    } catch (e) {
      newErr = e as SagaInvariantViolationError;
    }
    try {
      assertSagaInvariantI7Typed(oldShape, 'T9000');
    } catch (e) {
      oldErr = e as SagaInvariantViolationError;
    }
    expect(newErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(oldErr?.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(newErr?.diag).toEqual(oldErr?.diag);
  });
});

describe('SagaInvariantViolationError shape', () => {
  it('extends Error and carries name="SagaInvariantViolationError"', () => {
    const err = new SagaInvariantViolationError(E_SAGA_INVARIANT_VIOLATION_I3, 'test', {
      invariant: 'I3',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SagaInvariantViolationError');
    expect(err.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
  });

  it('isSagaInvariantViolationError returns false for non-saga errors', () => {
    expect(isSagaInvariantViolationError(new Error('generic'))).toBe(false);
    expect(isSagaInvariantViolationError('string')).toBe(false);
    expect(isSagaInvariantViolationError(null)).toBe(false);
    expect(isSagaInvariantViolationError(undefined)).toBe(false);
  });
});
