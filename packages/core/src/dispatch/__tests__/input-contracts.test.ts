/**
 * Tests for T9917 — INPUT_CONTRACTS SSoT registry.
 *
 * Asserts that the registry surfaces each tasks.* contract under its
 * canonical operation id, and that calling validateOperationInput against
 * each registry entry round-trips successfully on the worked example
 * payload that every contract is required to ship (T9914 invariant).
 *
 * @task T9917
 * @epic T9903
 * @saga T9855
 */

import { describe, expect, it } from 'vitest';
import { INPUT_CONTRACTS } from '../contracts/input-contracts.js';
import { _resetValidationCache, validateOperationInput } from '../validation.js';

describe('INPUT_CONTRACTS registry', () => {
  it('exposes tasks.add under its canonical operation id', () => {
    const contract = INPUT_CONTRACTS['tasks.add'];
    expect(contract).toBeDefined();
    expect(contract?.operation).toBe('tasks.add');
  });

  it('exposes tasks.add-batch under its canonical operation id', () => {
    const contract = INPUT_CONTRACTS['tasks.add-batch'];
    expect(contract).toBeDefined();
    expect(contract?.operation).toBe('tasks.add-batch');
  });

  it('exposes tasks.update under its canonical operation id', () => {
    const contract = INPUT_CONTRACTS['tasks.update'];
    expect(contract).toBeDefined();
    expect(contract?.operation).toBe('tasks.update');
  });
});

describe('INPUT_CONTRACTS example round-trip', () => {
  it('validates every shipped example for tasks.add successfully', () => {
    _resetValidationCache();
    const contract = INPUT_CONTRACTS['tasks.add'];
    if (!contract) throw new Error('tasks.add missing');
    for (const ex of contract.examples) {
      const result = validateOperationInput(contract, ex.value);
      if (!result.ok) {
        throw new Error(
          `example "${ex.name}" failed validation: ${JSON.stringify(result.errors, null, 2)}`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });

  it('validates every shipped example for tasks.add-batch successfully', () => {
    _resetValidationCache();
    const contract = INPUT_CONTRACTS['tasks.add-batch'];
    if (!contract) throw new Error('tasks.add-batch missing');
    for (const ex of contract.examples) {
      const result = validateOperationInput(contract, ex.value);
      if (!result.ok) {
        throw new Error(
          `example "${ex.name}" failed validation: ${JSON.stringify(result.errors, null, 2)}`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });

  it('validates every shipped example for tasks.update successfully', () => {
    _resetValidationCache();
    const contract = INPUT_CONTRACTS['tasks.update'];
    if (!contract) throw new Error('tasks.update missing');
    for (const ex of contract.examples) {
      const result = validateOperationInput(contract, ex.value);
      if (!result.ok) {
        throw new Error(
          `example "${ex.name}" failed validation: ${JSON.stringify(result.errors, null, 2)}`,
        );
      }
      expect(result.ok).toBe(true);
    }
  });
});
