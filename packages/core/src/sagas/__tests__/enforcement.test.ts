/**
 * Unit tests for the saga enforcement guards (ADR-073 §1.2 invariants I3 / I5 / I7).
 *
 * After T10638, only `type='saga'` identifies a saga. The dual-shape
 * deprecation window is closed. Tests exercise only the canonical shape.
 *
 * @task T10115
 * @task T10638
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
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

function makeSaga(overrides: Partial<Task> & Pick<Task, 'id'>): SagaTask {
  const task = makeTask({ ...overrides, type: 'saga' });
  if (!isSagaShape(task)) {
    throw new Error('test fixture failed isSagaShape narrowing');
  }
  return task;
}

describe('isSagaShape', () => {
  it('returns true for type=saga', () => {
    expect(isSagaShape(makeTask({ id: 'T9000', type: 'saga' }))).toBe(true);
  });

  it('returns false for epic without saga type', () => {
    expect(isSagaShape(makeTask({ id: 'T9000', type: 'epic', labels: ['saga'] }))).toBe(false);
  });

  it('returns false for a regular task', () => {
    expect(isSagaShape(makeTask({ id: 'T9000', type: 'task' }))).toBe(false);
  });
});

describe('assertSagaInvariantI3 — sagas must be top-level', () => {
  it('accepts a valid saga with no parent and no depends edges', () => {
    const saga = makeSaga({ id: 'T9000', parentId: null });
    expect(() => assertSagaInvariantI3(saga)).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when saga has a parentId', () => {
    const saga = makeSaga({ id: 'T9000', parentId: 'T8000' });
    let caught: unknown;
    try { assertSagaInvariantI3(saga); } catch (err) { caught = err; }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I3);
    expect(error.diag.invariant).toBe('I3');
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when saga has depends edges', () => {
    const saga = makeSaga({ id: 'T9000', parentId: null, depends: ['T8100'] });
    expect(() => assertSagaInvariantI3(saga)).toThrow(SagaInvariantViolationError);
  });
});

describe('assertSagaInvariantI5 — saga.parentId MUST be NULL', () => {
  it('accepts a saga with parentId=null', () => {
    expect(() => assertSagaInvariantI5(makeSaga({ id: 'T9000', parentId: null }))).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I5 when saga has parentId != null', () => {
    const saga = makeSaga({ id: 'T9000', parentId: 'T8000' });
    expect(() => assertSagaInvariantI5(saga)).toThrow(SagaInvariantViolationError);
  });

  it('treats empty-string parentId as null', () => {
    expect(() => assertSagaInvariantI5(makeSaga({ id: 'T9000', parentId: '' }))).not.toThrow();
  });
});

describe('assertSagaInvariantI7 — no nested sagas', () => {
  it('accepts a regular epic candidate', () => {
    expect(() => assertSagaInvariantI7('T9100', [])).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I7 when candidate has type=saga', () => {
    expect(() => assertSagaInvariantI7('T9100', [], 'T9000', 'saga'))
      .toThrow(SagaInvariantViolationError);
  });

  it('regression: rejects linking a type=saga task as a member', () => {
    let caught: unknown;
    try { assertSagaInvariantI7('T9831', [], 'T9799', 'saga'); } catch (err) { caught = err; }
    expect(isSagaInvariantViolationError(caught)).toBe(true);
    const error = caught as SagaInvariantViolationError;
    expect(error.code).toBe(E_SAGA_INVARIANT_VIOLATION_I7);
    expect(error.diag).toEqual({ sagaId: 'T9799', offendingId: 'T9831', invariant: 'I7' });
  });
});

describe('assertSagaInvariantI7Typed — typed overload', () => {
  it('always throws when passed a SagaTask', () => {
    expect(() => assertSagaInvariantI7Typed(makeSaga({ id: 'T9831' }), 'T9799'))
      .toThrow(SagaInvariantViolationError);
  });
});

describe('SagaInvariantViolationError shape', () => {
  it('extends Error with name="SagaInvariantViolationError"', () => {
    const err = new SagaInvariantViolationError(E_SAGA_INVARIANT_VIOLATION_I3, 'test', { invariant: 'I3' });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SagaInvariantViolationError');
  });

  it('isSagaInvariantViolationError returns false for non-saga errors', () => {
    expect(isSagaInvariantViolationError(new Error('generic'))).toBe(false);
  });
});
