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

import type { TasksAddParams, TasksUpdateQueryParams } from '@cleocode/contracts';
import { describe, expect, it } from 'vitest';
import { toTaskAddOptions } from '../../tasks/add.js';
import { toTaskUpdateOptions } from '../../tasks/update.js';
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

describe('tasks.update noAutoComplete schema (T12258)', () => {
  it.each([true, false])('accepts explicit boolean %s', (noAutoComplete) => {
    const contract = INPUT_CONTRACTS['tasks.update'];
    if (!contract) throw new Error('tasks.update missing');
    expect(validateOperationInput(contract, { taskId: 'T12258', noAutoComplete }).ok).toBe(true);
  });

  it.each(['true', 1, null])('rejects non-boolean %s', (noAutoComplete) => {
    const contract = INPUT_CONTRACTS['tasks.update'];
    if (!contract) throw new Error('tasks.update missing');
    expect(validateOperationInput(contract, { taskId: 'T12258', noAutoComplete }).ok).toBe(false);
  });
});

it('accepts dependency waiver provenance in canonical creation input', () => {
  const contract = INPUT_CONTRACTS['tasks.add'];
  if (!contract) throw new Error('tasks.add missing');
  expect(
    validateOperationInput(contract, {
      title: 'Independent critical repair',
      priority: 'critical',
      dependsWaiver: 'No prerequisites',
    }).ok,
  ).toBe(true);
  expect(
    validateOperationInput(contract, {
      title: 'Independent critical repair',
      priority: 'critical',
      dependsWaiver: '',
    }).ok,
  ).toBe(false);
});

// Complete independent fixtures ratchet accepted schema keys and forwarding. A
// newly accepted field requires an explicit sample and expectation here.
it('covers every accepted add field at the canonical mapper boundary', () => {
  const input: Required<Omit<TasksAddParams, 'parentSource'>> = {
    title: 'Full add input',
    description: 'Distinct field forwarding samples',
    parent: 'T010',
    depends: ['T020'],
    dependsWaiver: 'Independent repair',
    priority: 'critical',
    labels: ['sample'],
    type: 'task',
    acceptance: ['literal a|b'],
    phase: 'verification',
    size: 'small',
    notes: 'Evidence note',
    files: ['src/entry.ts'],
    dryRun: true,
    parentSearch: 'epic sample',
    kind: 'bug',
    scope: 'unit',
    severity: 'P1',
    forceDuplicate: true,
  };
  const contract = INPUT_CONTRACTS['tasks.add'];
  if (!contract) throw new Error('tasks.add missing');
  expect(Object.keys(contract.schema.properties ?? {}).sort()).toEqual(Object.keys(input).sort());
  expect(validateOperationInput(contract, input).ok).toBe(true);
  const { parent, ...fields } = input;
  expect(toTaskAddOptions(input)).toMatchObject({ ...fields, parentId: parent });
});

it('covers every accepted update field at the canonical mapper boundary', () => {
  const input: Required<TasksUpdateQueryParams> = {
    taskId: 'T010',
    title: 'Full update input',
    description: 'Distinct update samples',
    status: 'pending',
    priority: 'critical',
    phase: 'verification',
    notes: 'Evidence note',
    labels: ['first'],
    addLabels: ['second'],
    removeLabels: ['third'],
    depends: ['T020'],
    addDepends: ['T021'],
    removeDepends: ['T022'],
    acceptance: ['literal a|b'],
    parent: 'T001',
    type: 'task',
    size: 'small',
    files: ['one.ts'],
    addFiles: ['two.ts'],
    removeFiles: ['three.ts'],
    pipelineStage: 'research',
    kind: 'bug',
    scope: 'unit',
    severity: 'P2',
    reason: 'Approved correction',
    dependsWaiver: 'Independent repair',
    blockedBy: 'Awaiting service',
    clearBlockedBy: true,
    noAutoComplete: false,
    relates: [{ taskId: 'T030', type: 'related', reason: 'Shared evidence' }],
    addRelates: [{ taskId: 'T031', type: 'blocks', reason: 'Precondition' }],
    removeRelates: ['T032'],
  };
  const contract = INPUT_CONTRACTS['tasks.update'];
  if (!contract) throw new Error('tasks.update missing');
  expect(Object.keys(contract.schema.properties ?? {}).sort()).toEqual(Object.keys(input).sort());
  expect(validateOperationInput(contract, input).ok).toBe(true);
  const { parent, ...fields } = input;
  expect(toTaskUpdateOptions(input)).toMatchObject({ ...fields, parentId: parent });
});
