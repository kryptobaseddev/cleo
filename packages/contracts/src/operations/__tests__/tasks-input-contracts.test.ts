/**
 * Tests for T9917 — tasks.* OperationInputContract schemas.
 *
 * Asserts the contract pairs (operation id + schema + examples) are
 * constructible, that the schema's `additionalProperties: false` is
 * intentional (NOT dropped by accident), and that the worked examples'
 * shapes match the underlying `Params` types at compile time.
 *
 * Runtime validator behaviour is owned by T9915 and tested over in
 * `packages/core/src/dispatch/__tests__/validation.test.ts` — the
 * contracts package is intentionally a leaf with no runtime dep on AJV.
 *
 * @task T9917
 * @epic T9903
 * @saga T9855
 */

import { describe, expect, it } from 'vitest';
import {
  TASKS_ADD_BATCH_INPUT_SCHEMA,
  TASKS_ADD_INPUT_SCHEMA,
  TASKS_UPDATE_INPUT_SCHEMA,
  tasksAddBatchInputContract,
  tasksAddInputContract,
  tasksUpdateInputContract,
} from '../../index.js';

describe('tasksAddInputContract', () => {
  it('uses the canonical operation id', () => {
    expect(tasksAddInputContract.operation).toBe('tasks.add');
  });

  it('declares title as the only required field', () => {
    const schema = tasksAddInputContract.schema as { required: string[] };
    expect(schema.required).toEqual(['title']);
  });

  it('rejects unknown fields via additionalProperties: false', () => {
    expect(tasksAddInputContract.schema['additionalProperties']).toBe(false);
  });

  it('ships at least one worked example', () => {
    expect(tasksAddInputContract.examples.length).toBeGreaterThan(0);
    for (const ex of tasksAddInputContract.examples) {
      expect(typeof ex.name).toBe('string');
      expect(typeof ex.value.title).toBe('string');
    }
  });

  it('exports the raw schema constant for re-use', () => {
    expect(TASKS_ADD_INPUT_SCHEMA).toBe(tasksAddInputContract.schema);
  });
});

describe('tasksAddBatchInputContract', () => {
  it('uses the canonical operation id', () => {
    expect(tasksAddBatchInputContract.operation).toBe('tasks.add-batch');
  });

  it('requires the tasks array', () => {
    const schema = tasksAddBatchInputContract.schema as { required: string[] };
    expect(schema.required).toEqual(['tasks']);
  });

  it('rejects empty tasks arrays at the schema level (minItems: 1)', () => {
    const schema = tasksAddBatchInputContract.schema as {
      properties: { tasks: { minItems: number } };
    };
    expect(schema.properties.tasks.minItems).toBe(1);
  });

  it('rejects unknown root-level fields via additionalProperties: false', () => {
    expect(tasksAddBatchInputContract.schema['additionalProperties']).toBe(false);
  });

  it('keeps labels and acceptance canonical as arrays in the add-batch schema', () => {
    const schema = tasksAddBatchInputContract.schema as {
      properties: {
        tasks: {
          items: {
            properties: {
              labels: { type: string; items: { type: string }; 'x-fix-hint'?: string };
              acceptance: { type: string; items: { type: string }; 'x-fix-hint'?: string };
            };
          };
        };
      };
    };
    const entryProperties = schema.properties.tasks.items.properties;

    expect(entryProperties.labels).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(entryProperties.labels['x-fix-hint']).toContain('JSON array');
    expect(entryProperties.acceptance).toMatchObject({ type: 'array', items: { type: 'string' } });
    expect(entryProperties.acceptance['x-fix-hint']).toContain('not a pipe-delimited string');
  });

  it('ships add-batch examples with canonical labels and acceptance arrays', () => {
    const withArrays = tasksAddBatchInputContract.examples.find((ex) => ex.name === 'two-tasks');
    expect(withArrays).toBeDefined();
    const firstTask = withArrays?.value.tasks[0];

    expect(Array.isArray(firstTask?.labels)).toBe(true);
    expect(Array.isArray(firstTask?.acceptance)).toBe(true);
  });

  it('exports the raw schema constant for re-use', () => {
    expect(TASKS_ADD_BATCH_INPUT_SCHEMA).toBe(tasksAddBatchInputContract.schema);
  });
});

describe('tasksUpdateInputContract', () => {
  it('uses the canonical operation id', () => {
    expect(tasksUpdateInputContract.operation).toBe('tasks.update');
  });

  it('requires taskId', () => {
    const schema = tasksUpdateInputContract.schema as { required: string[] };
    expect(schema.required).toEqual(['taskId']);
  });

  it('rejects unknown fields via additionalProperties: false', () => {
    expect(tasksUpdateInputContract.schema['additionalProperties']).toBe(false);
  });

  it('allows parent to be either string or null (promote-to-root)', () => {
    const schema = tasksUpdateInputContract.schema as {
      properties: { parent: { type: string[] } };
    };
    expect(schema.properties.parent.type).toContain('string');
    expect(schema.properties.parent.type).toContain('null');
  });

  it('exports the raw schema constant for re-use', () => {
    expect(TASKS_UPDATE_INPUT_SCHEMA).toBe(tasksUpdateInputContract.schema);
  });
});
