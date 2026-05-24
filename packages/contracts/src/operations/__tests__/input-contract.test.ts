/**
 * Type + construction tests for OperationInputContract, ValidationResult,
 * and ValidationError.
 *
 * These tests are intentionally minimal — the contracts package is a leaf
 * with zero runtime dependencies, so there is no validator to exercise
 * here. Instead, we assert:
 *
 *   1. ValidationResult narrows correctly via the `ok` discriminator.
 *   2. A typed OperationInputContract<T> can be constructed and its
 *      examples[0].value satisfies the generic.
 *   3. ValidationError can be constructed with all 6 required fields.
 *
 * The runtime validator that consumes these types ships under T9915.
 *
 * @epic T9855
 * @task T9914
 */

import { describe, expect, it } from 'vitest';
import type {
  JsonSchema,
  OperationInputContract,
  OperationInputContractRegistry,
  ValidationError,
  ValidationResult,
} from '../input-contract.js';

// ---------------------------------------------------------------------------
// ValidationResult discriminated-union narrowing
// ---------------------------------------------------------------------------

describe('ValidationResult<T>', () => {
  it('narrows to the success branch when ok is true', () => {
    // Constructor return type is widened so TS keeps both branches reachable
    // at the call site — that's the whole point of the discriminated union.
    const makeResult = (): ValidationResult<{ title: string }> => ({
      ok: true,
      value: { title: 'Ship E7' },
    });
    const result = makeResult();

    if (result.ok) {
      // Type-level: TypeScript narrows result.value to { title: string }.
      // Runtime: the value is exactly what we constructed.
      expect(result.value.title).toBe('Ship E7');
    } else {
      // Type-level: result.errors is ValidationError[].
      expect(result.errors).toEqual([]);
    }
  });

  it('narrows to the failure branch when ok is false', () => {
    const makeResult = (): ValidationResult<{ title: string }> => ({
      ok: false,
      errors: [
        {
          path: '/title',
          expected: 'string with minLength 1',
          received: 'empty string',
          fix: 'Provide a non-empty title.',
          errorCode: 'E_INPUT_MIN_LENGTH',
          schemaPath: '#/properties/title/minLength',
        },
      ],
    });
    const result = makeResult();

    if (result.ok) {
      expect(result.value).toBeDefined();
    } else {
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]?.errorCode).toBe('E_INPUT_MIN_LENGTH');
    }
  });
});

// ---------------------------------------------------------------------------
// OperationInputContract<T> construction
// ---------------------------------------------------------------------------

describe('OperationInputContract<T>', () => {
  it('builds a typed contract whose examples match the generic', () => {
    interface CreateTaskInput {
      title: string;
      acceptance: string;
    }

    const schema: JsonSchema = {
      type: 'object',
      required: ['title', 'acceptance'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        acceptance: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    };

    const contract: OperationInputContract<CreateTaskInput> = {
      operation: 'tasks.create',
      schema,
      examples: [
        {
          name: 'minimal',
          value: { title: 'Ship E7', acceptance: 'PR merged' },
          description: 'Smallest valid payload.',
        },
      ],
    };

    expect(contract.operation).toBe('tasks.create');
    expect(contract.schema).toBe(schema);
    expect(contract.examples).toHaveLength(1);

    const first = contract.examples[0];
    expect(first).toBeDefined();
    // Type-level: first.value is CreateTaskInput. Runtime sanity:
    expect(first?.value.title).toBe('Ship E7');
    expect(first?.value.acceptance).toBe('PR merged');
    expect(first?.name).toBe('minimal');
    expect(first?.description).toBe('Smallest valid payload.');
  });

  it('accepts a contract with an example that omits the optional description', () => {
    const contract: OperationInputContract<{ id: string }> = {
      operation: 'docs.fetch',
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      examples: [{ name: 'minimal', value: { id: 'adr-076' } }],
    };

    expect(contract.examples[0]?.description).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ValidationError shape
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('constructs with all 6 required fields', () => {
    const err: ValidationError = {
      path: '/owners/0/email',
      expected: 'string matching email format',
      received: 'string',
      fix: 'Use a valid email address (e.g. user@example.com).',
      errorCode: 'E_INPUT_FORMAT_EMAIL',
      schemaPath: '#/properties/owners/items/properties/email/format',
    };

    expect(err.path).toBe('/owners/0/email');
    expect(err.expected).toBe('string matching email format');
    expect(err.received).toBe('string');
    expect(err.fix).toBe('Use a valid email address (e.g. user@example.com).');
    expect(err.errorCode).toBe('E_INPUT_FORMAT_EMAIL');
    expect(err.schemaPath).toBe('#/properties/owners/items/properties/email/format');

    // All 6 fields present — no extras.
    expect(Object.keys(err).sort()).toEqual([
      'errorCode',
      'expected',
      'fix',
      'path',
      'received',
      'schemaPath',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('OperationInputContractRegistry', () => {
  it('keys contracts by their operation identifier', () => {
    const createTask: OperationInputContract<{ title: string }> = {
      operation: 'tasks.create',
      schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } },
      examples: [{ name: 'minimal', value: { title: 'a' } }],
    };

    const registry: OperationInputContractRegistry = {
      'tasks.create': createTask as OperationInputContract<unknown>,
    };

    expect(registry['tasks.create']?.operation).toBe('tasks.create');
    expect(registry['unknown.op']).toBeUndefined();
  });
});
