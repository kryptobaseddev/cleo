/**
 * Unit tests for the saga enforcement guards (ADR-073 §1.2 invariants I3 / I5 / I7).
 *
 * The guards are pure functions — no DB, no filesystem. Tests synthesize
 * minimal {@link Task} fixtures and assert each guard accepts valid input
 * and throws a typed {@link SagaInvariantViolationError} (with stable
 * `.code` and structured `.diag`) on invariant breach.
 *
 * Includes the T9831-nested-in-T9799 regression fixture for I7 — the
 * historical scenario where the orchestrator could have attempted to link a
 * saga (`T9831` SG-ARCH-SOLID) as a member of another saga (`T9799` skill
 * maintenance), which I7 forbids.
 *
 * @task T10115
 * @saga T10113
 * @epic T10209
 * @see ADR-073-above-epic-naming.md §1.2
 */

import type { Task } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { SAGA_LABEL } from '../constants.js';
import {
  assertSagaInvariantI3,
  assertSagaInvariantI5,
  assertSagaInvariantI7,
  E_SAGA_INVARIANT_VIOLATION_I3,
  E_SAGA_INVARIANT_VIOLATION_I5,
  E_SAGA_INVARIANT_VIOLATION_I7,
  isSagaInvariantViolationError,
  SagaInvariantViolationError,
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

describe('assertSagaInvariantI3 — sagas link via groups only', () => {
  it('accepts a valid saga with no parent and no depends edges', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: null,
    });
    expect(() => assertSagaInvariantI3(saga)).not.toThrow();
  });

  it('is a no-op for a non-saga task (no saga label)', () => {
    const epic = makeTask({
      id: 'T9001',
      labels: [],
      parentId: 'T9000',
      depends: ['T9100'],
    });
    expect(() => assertSagaInvariantI3(epic)).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when a saga has a parentId', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: 'T8000',
    });
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

  it('throws E_SAGA_INVARIANT_VIOLATION_I3 when a saga has depends edges', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: null,
      depends: ['T8100'],
    });
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
});

describe('assertSagaInvariantI5 — saga.parentId MUST be NULL', () => {
  it('accepts a valid saga with parentId=null', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: null,
    });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('accepts a valid saga with parentId omitted', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
    });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });

  it('is a no-op for a non-saga task with a parentId', () => {
    const epic = makeTask({
      id: 'T9001',
      labels: ['feature'],
      parentId: 'T9000',
    });
    expect(() => assertSagaInvariantI5(epic)).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I5 when a saga has parentId != null', () => {
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: 'T8000',
    });
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

  it('throws E_SAGA_INVARIANT_VIOLATION_I5 when a saga has empty-string parentId only on truthy non-null', () => {
    // Empty string is a degenerate case we treat as null (see guard logic).
    const saga = makeTask({
      id: 'T9000',
      labels: [SAGA_LABEL],
      parentId: '',
    });
    expect(() => assertSagaInvariantI5(saga)).not.toThrow();
  });
});

describe('assertSagaInvariantI7 — no nested sagas', () => {
  it('accepts a regular epic candidate (no saga label)', () => {
    expect(() => assertSagaInvariantI7('T9100', ['feature'])).not.toThrow();
  });

  it('accepts a candidate with empty labels', () => {
    expect(() => assertSagaInvariantI7('T9100', [])).not.toThrow();
  });

  it('throws E_SAGA_INVARIANT_VIOLATION_I7 when the candidate has the saga label', () => {
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
