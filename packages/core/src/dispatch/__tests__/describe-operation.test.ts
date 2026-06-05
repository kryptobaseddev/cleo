/**
 * Tests for the SDK describeOperation() introspection surface (T11692 / DHQ-057).
 *
 * Asserts that describeOperation composes the INPUT + OUTPUT contracts for an
 * operation, that the output contract for `tasks.show` encodes the correct
 * `/data/task/title` pointer (the bug), and — for DHQ-033 — that the input
 * contract validator rejects an unknown `relates` key on `tasks.add-batch`
 * LOUDLY rather than silently dropping it.
 *
 * Pure module tests — no DB, no active session.
 *
 * @task T11692
 * @epic T11679
 */

import { describe, expect, it } from 'vitest';
import { INPUT_CONTRACTS } from '../contracts/input-contracts.js';
import { describeOperation } from '../describe-operation.js';
import { _resetValidationCache, validateOperationInput } from '../validation.js';

describe('describeOperation (T11692 · DHQ-057)', () => {
  it('returns null for an unknown operation', () => {
    expect(describeOperation('tasks.definitely-not-real')).toBeNull();
    expect(describeOperation('nope')).toBeNull();
  });

  it('resolves identity + params + I/O contracts for tasks.show', () => {
    const d = describeOperation('tasks.show');
    expect(d).not.toBeNull();
    if (d === null) return;
    expect(d.operation).toBe('tasks.show');
    expect(d.gateway).toBe('query');
    expect(d.params.operation).toBe('tasks.show');
    // OUTPUT contract is registered for the proof set.
    expect(d.outputContract).not.toBeNull();
  });

  it('exposes the correct --field pointer (/data/task/title) for tasks.show', () => {
    const d = describeOperation('tasks.show');
    expect(d?.outputContract?.fieldPointers).toContain('/data/task/title');
    // The exact pointer agents previously guessed (and got E_FIELD_NOT_FOUND).
    expect(d?.outputContract?.fieldPointers).not.toContain('/data/title');
  });

  it('surfaces the INPUT contract for tasks.add-batch (accepts depends)', () => {
    const d = describeOperation('tasks.add-batch');
    expect(d?.inputContract).not.toBeNull();
    expect(d?.inputContract?.operation).toBe('tasks.add-batch');
  });

  it('resolves a dotted operation name (tasks.add) correctly', () => {
    const d = describeOperation('tasks.add');
    expect(d?.operation).toBe('tasks.add');
    expect(d?.gateway).toBe('mutate');
  });
});

describe('tasks.add-batch input contract rejects unknown keys (DHQ-033)', () => {
  it('rejects a per-task `relates` field LOUDLY (additionalProperties: false)', () => {
    _resetValidationCache();
    const contract = INPUT_CONTRACTS['tasks.add-batch'];
    expect(contract).toBeDefined();
    if (!contract) return;

    const result = validateOperationInput(contract, {
      tasks: [
        {
          title: 'a task',
          // `relates` is NOT an accepted per-task field — only `depends` is.
          relates: [{ taskId: 'T1', type: 'related' }],
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The rejection must be LOUD: a structured additionalProperties error that
    // (a) is anchored at the offending per-task entry, (b) carries the
    // additionalProperties error code, and (c) names `relates` in the fix hint.
    const err = result.errors.find((e) => e.errorCode === 'E_VAL_ADDITIONALPROPERTIES');
    expect(err, 'expected an additionalProperties rejection').toBeDefined();
    expect(err?.path).toBe('/tasks/0');
    expect(err?.fix).toContain('relates');
  });

  it('accepts a per-task `depends` field (the supported edge)', () => {
    _resetValidationCache();
    const contract = INPUT_CONTRACTS['tasks.add-batch'];
    if (!contract) return;
    const result = validateOperationInput(contract, {
      tasks: [{ title: 'a task', depends: ['T1', 'T2'] }],
    });
    expect(result.ok).toBe(true);
  });
});
