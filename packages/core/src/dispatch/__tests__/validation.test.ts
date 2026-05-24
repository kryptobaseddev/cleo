/**
 * Tests for {@link validateOperationInput} (T9915 / Saga T9855 / E7).
 *
 * Covers the seven AC fixtures called out in the task brief: valid input,
 * missing-required, wrong-type, enum violation, deeply nested path
 * normalisation, custom `x-fix-hint` override, and compiled-validator
 * caching across calls.
 *
 * @task T9915
 */

import type { OperationInputContract } from '@cleocode/contracts';
import { describe, expect, it, vi } from 'vitest';
import { _resetValidationCache, validateOperationInput } from '../validation.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CreateTaskInput {
  title: string;
  acceptance: string;
}

const createTaskContract: OperationInputContract<CreateTaskInput> = {
  operation: 'tasks.create.v1',
  schema: {
    type: 'object',
    required: ['title', 'acceptance'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      acceptance: { type: 'string', minLength: 1 },
    },
  },
  examples: [
    {
      name: 'minimal',
      value: { title: 'Ship E7', acceptance: 'PR merged' },
    },
  ],
};

interface TaskWithStatus {
  status: 'pending' | 'active' | 'done';
}

const statusContract: OperationInputContract<TaskWithStatus> = {
  operation: 'tasks.status.v1',
  schema: {
    type: 'object',
    required: ['status'],
    properties: {
      status: { type: 'string', enum: ['pending', 'active', 'done'] },
    },
  },
  examples: [{ name: 'pending', value: { status: 'pending' } }],
};

interface NestedInput {
  items: Array<{ title: string }>;
}

const nestedContract: OperationInputContract<NestedInput> = {
  operation: 'tasks.nested.v1',
  schema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
          },
        },
      },
    },
  },
  examples: [{ name: 'one-item', value: { items: [{ title: 'a' }] } }],
};

interface HintInput {
  email: string;
}

const hintContract: OperationInputContract<HintInput> = {
  operation: 'users.create.v1',
  schema: {
    type: 'object',
    required: ['email'],
    properties: {
      email: {
        type: 'string',
        minLength: 5,
        'x-fix-hint': 'pass a fully-qualified email address (foo@bar.com)',
      },
    },
  },
  examples: [{ name: 'minimal', value: { email: 'a@b.io' } }],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validateOperationInput', () => {
  describe('success path', () => {
    it('returns { ok: true, value } when input matches the schema', () => {
      const result = validateOperationInput(createTaskContract, {
        title: 'Ship validator',
        acceptance: 'tests green',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual({
          title: 'Ship validator',
          acceptance: 'tests green',
        });
      }
    });

    it('narrows value to the contract generic T', () => {
      const result = validateOperationInput(createTaskContract, {
        title: 't',
        acceptance: 'a',
      });
      if (result.ok) {
        const checked: CreateTaskInput = result.value;
        expect(checked.title).toBe('t');
      } else {
        throw new Error('expected ok');
      }
    });
  });

  describe('missing required field', () => {
    it('emits E_VAL_REQUIRED with the missing field name in fix', () => {
      const result = validateOperationInput(createTaskContract, { title: 'has title' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const required = result.errors.find((e) => e.errorCode === 'E_VAL_REQUIRED');
        expect(required).toBeDefined();
        expect(required?.errorCode).toBe('E_VAL_REQUIRED');
        expect(required?.fix).toContain('acceptance');
        expect(required?.path).toBe('/acceptance');
        expect(required?.expected).toContain('acceptance');
        expect(required?.received).toBe('undefined');
      }
    });
  });

  describe('wrong type', () => {
    it('emits E_VAL_TYPE and a quotes-hint for strings', () => {
      const result = validateOperationInput(createTaskContract, {
        title: 123,
        acceptance: 'ok',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const typeErr = result.errors.find((e) => e.errorCode === 'E_VAL_TYPE');
        expect(typeErr).toBeDefined();
        expect(typeErr?.path).toBe('/title');
        expect(typeErr?.expected).toBe('string');
        expect(typeErr?.fix).toBe('wrap value in quotes');
        expect(typeErr?.received).toBe('number');
      }
    });
  });

  describe('enum violation', () => {
    it('emits E_VAL_ENUM listing allowed values', () => {
      const result = validateOperationInput(statusContract, { status: 'archived' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const enumErr = result.errors.find((e) => e.errorCode === 'E_VAL_ENUM');
        expect(enumErr).toBeDefined();
        expect(enumErr?.path).toBe('/status');
        expect(enumErr?.expected).toMatch(/pending/);
        expect(enumErr?.expected).toMatch(/active/);
        expect(enumErr?.expected).toMatch(/done/);
        expect(enumErr?.fix).toContain('pending');
        expect(enumErr?.fix).toContain('active');
        expect(enumErr?.fix).toContain('done');
      }
    });
  });

  describe('deeply nested error path', () => {
    it('normalises /items/2/title style paths verbatim from instancePath', () => {
      const result = validateOperationInput(nestedContract, {
        items: [{ title: 'a' }, { title: 'b' }, { title: 99 }],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const typeErr = result.errors.find((e) => e.path === '/items/2/title');
        expect(typeErr).toBeDefined();
        expect(typeErr?.errorCode).toBe('E_VAL_TYPE');
        expect(typeErr?.expected).toBe('string');
      }
    });

    it('synthesises a child pointer for required-keyword errors on nested objects', () => {
      const result = validateOperationInput(nestedContract, { items: [{}] });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const required = result.errors.find((e) => e.errorCode === 'E_VAL_REQUIRED');
        expect(required).toBeDefined();
        expect(required?.path).toBe('/items/0/title');
      }
    });
  });

  describe('custom x-fix-hint override', () => {
    it('prefers x-fix-hint over the generic per-keyword fix', () => {
      _resetValidationCache(); // ensure fresh compile picks up hint
      const result = validateOperationInput(hintContract, { email: 'a' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const lenErr = result.errors.find((e) => e.errorCode === 'E_VAL_MINLENGTH');
        expect(lenErr).toBeDefined();
        expect(lenErr?.fix).toBe('pass a fully-qualified email address (foo@bar.com)');
      }
    });
  });

  describe('compiled-validator cache', () => {
    it('compiles a contracts AJV validator exactly once across multiple calls', async () => {
      _resetValidationCache();
      const ajvMod = await import('ajv');
      const AjvCtor =
        (ajvMod.default as unknown as { default?: unknown }).default ?? ajvMod.default;
      const compileSpy = vi.spyOn(
        (AjvCtor as { prototype: { compile: () => unknown } }).prototype,
        'compile',
      );

      const contract: OperationInputContract<{ x: number }> = {
        operation: 'cache.test.v1',
        schema: {
          type: 'object',
          required: ['x'],
          properties: { x: { type: 'number' } },
        },
        examples: [{ name: 'one', value: { x: 1 } }],
      };

      const before = compileSpy.mock.calls.length;
      validateOperationInput(contract, { x: 1 });
      validateOperationInput(contract, { x: 2 });
      validateOperationInput(contract, { x: 3 });
      const after = compileSpy.mock.calls.length;

      expect(after - before).toBe(1);
      compileSpy.mockRestore();
    });
  });

  describe('additionalProperties rejection', () => {
    it('emits E_VAL_ADDITIONALPROPERTIES when extra fields are present', () => {
      const result = validateOperationInput(createTaskContract, {
        title: 't',
        acceptance: 'a',
        rogue: 1,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const extra = result.errors.find((e) => e.errorCode === 'E_VAL_ADDITIONALPROPERTIES');
        expect(extra).toBeDefined();
        expect(extra?.expected).toBe('no extra fields');
        expect(extra?.fix).toContain('rogue');
      }
    });
  });
});
