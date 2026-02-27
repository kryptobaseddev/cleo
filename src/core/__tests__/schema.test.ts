import { describe, expect, it } from 'vitest';
import {
  clearSchemaCache,
  validateSchema,
  validateTask,
} from '../validation/schema-validator.js';
import {
  validateAgainstSchema,
  checkSchema,
} from '../schema.js';

describe('core schema validation', () => {
  it('validates config data through canonical AJV path', () => {
    clearSchemaCache();

    const result = validateSchema('config', {
      version: '1.0.0',
      _meta: {
        schemaVersion: '2.10.0',
      },
    });

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for invalid config schema type payload', () => {
    clearSchemaCache();
    const result = validateSchema('config', 'not-an-object');

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates task payload required fields', () => {
    const valid = validateTask({
      id: 'T999',
      title: 'Valid task',
      status: 'pending',
      priority: 'medium',
      createdAt: new Date().toISOString(),
    });
    const invalid = validateTask({ id: 'T999' });

    expect(valid.valid).toBe(true);
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.some((error) => error.path === '/title')).toBe(true);
  });

  it('supports throw and non-throw inline schema helpers', () => {
    const inlineSchema = {
      type: 'object',
      required: ['foo'],
      properties: {
        foo: { type: 'string' },
      },
    } as const;

    expect(() => validateAgainstSchema({ foo: 'bar' }, inlineSchema)).not.toThrow();
    expect(() => validateAgainstSchema({}, inlineSchema)).toThrow();

    const errors = checkSchema({}, inlineSchema);
    expect(errors.length).toBeGreaterThan(0);
  });
});
